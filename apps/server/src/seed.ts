/**
 * KBL Manager — DB 시드 (새 게임 시작)
 *
 * 2026-27 시즌 시작 시점의 리그를 만든다.
 *  - 팀/선수/능력치: players_enriched.json(실측 기록) + roster.csv(2026-27 로스터)
 *    · KBL 경험 없는 외국선수는 해외리그 기록 × 리그 강도로 환산해 평가 (leagueData.loadForeignEstimates)
 *  - 시뮬레이션 프로필(실제 슛 확률 등): player_sim_profile
 *  - 계약(2026-27 보수, FA 년도): data/processed/contracts_2026_27.csv
 *  - AI 감독: coaches.ts
 *  - 일정: 2026-10-03 개막 ~ 2027-04-11 종료, 개막전 대진(KCC-LG, 소노-가스공사, 정관장-현대모비스)
 *
 * CLI: `npm run seed` (기본 팀: 첫 번째 팀) / API: POST /api/new-game { teamId }
 */
import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { loadLeagueData, loadForeignEstimates } from "./leagueData";
import { generateKblCalendarSchedule } from "../../../packages/simulation-engine/seasonScheduler";
import { COACHES } from "./coaches";
import { computeRatings, AttributeRow } from "./ratings";
import { simProfileFromAttrs } from "./generatedPlayers";
import { insertSchedule } from "./offseason";

const SEASON_YEAR = 2026;
const SEASON_LABEL = "2026-2027";
const SEASON_START = "2026-10-03";
const SEASON_END = "2027-04-11";
const GAME_START_DATE = "2026-10-01"; // 개막 이틀 전부터 시작 (훈련 가능)
const OPENING_GAMES = [
  { home: "부산 KCC 이지스", away: "창원 LG 세이커스" },
  { home: "고양 소노 스카이거너스", away: "대구 한국가스공사 페가수스" },
  { home: "안양 정관장 레드부스터스", away: "울산 현대모비스 피버스" },
];
const BREAKS = [
  { from: "2026-11-23", to: "2026-11-29" },
  { from: "2027-01-16", to: "2027-01-19" },
  { from: "2027-02-22", to: "2027-03-01" },
];

const CONTRACTS_CSV = path.join(__dirname, "../../../data/processed/contracts_2026_27.csv");

/** 이름 기반 결정적 난수 (성실성 등 기록으로 알 수 없는 값의 초기치) */
function hashUnit(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

function readContracts() {
  const lines = fs.readFileSync(CONTRACTS_CSV, "utf-8").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const idx = (k: string) => header.indexOf(k);
  const map = new Map<string, { type: string; krw: number | null; usd: number | null; faYear: number; source: string }>();
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    map.set(c[idx("name")], {
      type: c[idx("contract_type")],
      krw: c[idx("salary_krw_10k")] ? Number(c[idx("salary_krw_10k")]) : null,
      usd: c[idx("salary_usd")] ? Number(c[idx("salary_usd")]) : null,
      faYear: Number(c[idx("fa_year")]),
      source: c[idx("source")],
    });
  }
  return map;
}

/** 새 게임에서 고를 수 있는 팀 목록 — DB가 비어 있어도(최초 설치 직후) 데이터 파일에서 바로 읽는다 */
export function availableTeams(): { name: string; coach: string; style: string; description: string }[] {
  const { teamNames } = loadLeagueData();
  return teamNames.map((name) => {
    const c = COACHES.find((x) => x.teamName === name);
    return { name, coach: c?.name ?? "-", style: c?.style ?? "", description: c?.description ?? "" };
  });
}

/** @param userTeam 운영할 팀 (팀 이름 권장, 기존 호환용으로 DB id도 허용) */
export async function seedDatabase(pool: Pool, userTeam?: number | string, log: (m: string) => void = () => {}): Promise<{ userTeamId: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    log("[seed] 기존 세이브 초기화...");
    await client.query(`
      TRUNCATE transactions, fa_offers, negotiations, development_log, player_training_focus, training_plans,
               game_plans, coaches, player_condition, player_sim_profile, contracts, player_growth,
               season_growth_checkpoints, player_roster_settings, team_tactics, player_game_stats, games,
               playoff_series, franchise, player_attributes, players, seasons, teams RESTART IDENTITY CASCADE`);

    log("[seed] players_enriched.json / roster.csv 로딩...");
    const { raw, derivedMap, teamNames, rosterCsv, teamIdx, nameIdx, posIdx, buildTeamRoster } = loadLeagueData();
    const contracts = readContracts();

    const teamIdByName = new Map<string, number>();
    for (const teamName of teamNames) {
      const res = await client.query(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [teamName]);
      teamIdByName.set(teamName, res.rows[0].id);
    }

    const seasonRes = await client.query(
      `INSERT INTO seasons (label, start_date, year) VALUES ($1,$2,$3) RETURNING id`,
      [SEASON_LABEL, SEASON_START, SEASON_YEAR]
    );
    const seasonId = seasonRes.rows[0].id;

    // 실측 기반 시뮬레이션 내부값 (팀 로스터 빌더를 통해 이름별로 수집)
    const simByName = new Map<string, { internals: any; hasRecord: boolean }>();
    for (const t of teamNames) {
      for (const p of buildTeamRoster(t)) {
        const hasRecord = raw.some((r) => r.name === p.name && r.seasons.length > 0);
        simByName.set(p.name, { internals: p.internals, hasRecord });
      }
    }

    log("[seed] 선수/능력치/계약 삽입...");
    // ⚠️ 라건아는 국적상 KOR(귀화)이지만 KBL 규정상 외국선수 — 계약도 외국선수(USD)로 관리
    const FOREIGN_OVERRIDE_NAMES = new Set(["라건아"]);
    const natIdx = rosterCsv.header.indexOf("nationality");
    const rosterMeta = new Map<string, { team: string; position: string; nationality: string }>();
    rosterCsv.rows.forEach((cols) => {
      rosterMeta.set(cols[nameIdx], { team: cols[teamIdx], position: cols[posIdx], nationality: cols[natIdx] });
    });
    const kblStatsForForeignComparison = raw
      .filter((p) => p.seasons.length > 0)
      .map((p) => {
        const s = p.seasons[p.seasons.length - 1];
        return { PTS: s.PTS, REB: s.REB, AST: s.AST, BLK: s.BLK, STL: s.STL, FGPct: s["FG%"] / 100, ThreePct: s["3P%"] / 100, FTPct: s["FT%"] / 100 };
      });
    const foreignEstimates = loadForeignEstimates(kblStatsForForeignComparison);

    for (const [name, meta] of rosterMeta.entries()) {
      const teamId = teamIdByName.get(meta.team) ?? null;
      const p = raw.find((r) => r.name === name);
      const estimate = foreignEstimates.get(name);
      const positionGroup = meta.position?.includes("센터") ? "C" : meta.position?.includes("가드") ? "G" : "F";
      const contract = contracts.get(name);
      const isForeign = FOREIGN_OVERRIDE_NAMES.has(name) || (meta.nationality !== "KOR" && meta.nationality !== "PHI");

      const playerRes = await client.query(
        `INSERT INTO players (name, team_id, nationality, position, position_group, height_cm, weight_kg, birth_date, is_foreign_import, draft_year, draft_overall_pick, draft_category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          name, teamId, meta.nationality, meta.position, positionGroup,
          p?.heightCm ?? null, p?.weightKg ?? null, p?.birthDate ?? null, isForeign,
          p?.draftInfo?.kind === "picked" ? ((p as any)?.draftYear ?? null) : null,
          p?.draftInfo?.kind === "picked" ? (p.draftInfo as any).overallPick : null,
          p?.draftInfo?.kind ?? null,
        ]
      );
      const playerId = playerRes.rows[0].id;

      const d = p ? derivedMap.get(p.playerId) : undefined;
      let attrs: AttributeRow;
      let potential: number | null;
      let injury = 50;
      if (d) {
        attrs = {
          finishing: d.finishing, dunking: d.dunking, mid_range_shooting: d.midRangeShooting, three_point_shooting: d.threePointShooting,
          free_throw_shooting: d.freeThrowShooting, ball_handling: d.ballHandling, passing: d.passing, steal: d.steal,
          shot_blocking: d.shotBlocking, defensive_rebounding: d.defensiveRebounding, offensive_rebounding: d.offensiveRebounding,
          stamina: d.stamina, strength: d.strength, speed: d.speed,
        };
        potential = d.potential;
        injury = d.injuryProneness;
      } else if (estimate) {
        const a = estimate.attrs;
        attrs = {
          finishing: a.finishing, dunking: a.dunking, mid_range_shooting: a.midRangeShooting, three_point_shooting: a.threePointShooting,
          free_throw_shooting: a.freeThrowShooting, ball_handling: a.ballHandling, passing: a.passing, steal: a.steal,
          shot_blocking: a.shotBlocking, defensive_rebounding: a.defensiveRebounding, offensive_rebounding: a.offensiveRebounding,
          stamina: a.stamina, strength: a.strength, speed: estimate.speedTier,
        };
        potential = null;
      } else {
        // 기록이 거의 없는 국내 벤치 선수 — 스케일 최하단(50) (기존 정책 유지)
        attrs = {
          finishing: 50, dunking: 50, mid_range_shooting: 50, three_point_shooting: 50, free_throw_shooting: 50, ball_handling: 50,
          passing: 50, steal: 50, shot_blocking: 50, defensive_rebounding: 50, offensive_rebounding: 50, stamina: 50, strength: 50, speed: 50,
        };
        potential = 50;
      }
      const workEthic = Math.round(55 + hashUnit(name) * 37);
      await client.query(
        `INSERT INTO player_attributes (player_id, season_id, finishing, dunking, mid_range_shooting, three_point_shooting,
           free_throw_shooting, ball_handling, passing, steal, shot_blocking, defensive_rebounding, offensive_rebounding,
           stamina, injury_proneness, strength, speed, potential, work_ethic)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [playerId, seasonId, attrs.finishing, attrs.dunking, attrs.mid_range_shooting, attrs.three_point_shooting,
          attrs.free_throw_shooting, attrs.ball_handling, attrs.passing, attrs.steal, attrs.shot_blocking,
          attrs.defensive_rebounding, attrs.offensive_rebounding, attrs.stamina, injury, attrs.strength, attrs.speed,
          potential, workEthic]
      );

      const sim = simByName.get(name);
      const offense = computeRatings(attrs, positionGroup).offense;
      if (sim && (sim.hasRecord || estimate)) {
        const i = sim.internals;
        await client.query(
          `INSERT INTO player_sim_profile (player_id, paint_accuracy, mid_accuracy, three_accuracy, ft_accuracy, usage_percentile, pts_percentile, base_attrs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [playerId, i.paintAccuracy, i.midAccuracy, i.threeAccuracy, i.ftAccuracy, i.usagePercentile, i.ptsPercentile, JSON.stringify({ ...attrs, offense })]
        );
      } else {
        const sp = simProfileFromAttrs(attrs, positionGroup);
        await client.query(
          `INSERT INTO player_sim_profile (player_id, paint_accuracy, mid_accuracy, three_accuracy, ft_accuracy, usage_percentile, pts_percentile, base_attrs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [playerId, sp.paint_accuracy, sp.mid_accuracy, sp.three_accuracy, sp.ft_accuracy, sp.usage_percentile, sp.pts_percentile, JSON.stringify(sp.base_attrs)]
        );
      }

      const type = contract?.type ?? (isForeign ? "foreign" : meta.nationality === "PHI" ? "asia" : "domestic");
      await client.query(
        `INSERT INTO contracts (player_id, contract_type, salary_krw, salary_usd, fa_year, source, signed_year) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [playerId, type, type === "domestic" ? contract?.krw ?? 4200 : null, type !== "domestic" ? contract?.usd ?? 300000 : null,
          contract?.faYear ?? 2027, contract?.source ?? "estimated", SEASON_YEAR]
      );
      await client.query(`INSERT INTO player_condition (player_id) VALUES ($1)`, [playerId]);
    }

    log("[seed] 감독 정보...");
    for (const c of COACHES) {
      const tid = teamIdByName.get(c.teamName);
      if (!tid) continue;
      await client.query(
        `INSERT INTO coaches (team_id, name, style, description, pace_style, three_point_reliance, defense_scheme, rotation_depth, youth_preference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tid, c.name, c.style, c.description, c.paceStyle, c.threePointReliance, c.defenseScheme, c.rotationDepth, c.youthPreference]
      );
    }

    log("[seed] 2026-27 정규시즌 일정 생성...");
    const schedule = generateKblCalendarSchedule(teamNames, { startDate: SEASON_START, endDate: SEASON_END, openingGames: OPENING_GAMES, breaks: BREAKS });
    await insertSchedule(client, seasonId, schedule, SEASON_START, teamIdByName);

    const chosen = typeof userTeam === "string" && teamIdByName.has(userTeam) ? teamIdByName.get(userTeam)!
      : typeof userTeam === "number" && [...teamIdByName.values()].includes(userTeam) ? userTeam
      : teamIdByName.get(teamNames[0])!;
    await client.query(
      `INSERT INTO franchise (season_id, user_team_id, current_round, phase, game_date) VALUES ($1,$2,0,'regular',$3)`,
      [seasonId, chosen, GAME_START_DATE]
    );
    await client.query("COMMIT");
    log(`[seed] 완료! 선수 ${rosterMeta.size}명, 경기 ${schedule.length}개`);
    return { userTeamId: chosen };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pool } = require("./db") as { pool: Pool };
  seedDatabase(pool, undefined, console.log)
    .catch((e) => {
      console.error("[seed] 실패:", e);
      process.exit(1);
    })
    .finally(() => pool.end());
}
