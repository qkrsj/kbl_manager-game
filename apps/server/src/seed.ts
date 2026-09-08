/**
 * KBL Manager — DB 시드 스크립트 (매니저 모드용)
 * 선수/능력치/팀 정보를 채우고, 시즌 "일정"만 생성한다 (경기 결과는 아직 없음).
 * 실제 경기 시뮬레이션은 /api/franchise/advance-round 호출 시 라운드 단위로 진행됨.
 */
import { pool } from "./db";
import { loadLeagueData, loadForeignEstimates } from "./leagueData";
import { generateRoundRobinSchedule } from "../../../packages/simulation-engine/seasonScheduler";

const SEASON_LABEL = "2025-2026";

async function main() {
  console.log("[seed] players_enriched.json / roster.csv 로딩...");
  const { raw, derivedMap, teamNames, rosterCsv, teamIdx, nameIdx, posIdx } = loadLeagueData();

  console.log("[seed] 팀 목록 삽입...");
  const teamIdByName = new Map<string, number>();
  for (const teamName of teamNames) {
    const res = await pool.query(
      `INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [teamName]
    );
    teamIdByName.set(teamName, res.rows[0].id);
  }

  console.log("[seed] 시즌 삽입...");
  const seasonRes = await pool.query(
    `INSERT INTO seasons (label, start_date) VALUES ($1, CURRENT_DATE)
     ON CONFLICT (label) DO UPDATE SET label=EXCLUDED.label RETURNING id`,
    [SEASON_LABEL]
  );
  const seasonId = seasonRes.rows[0].id;

  console.log("[seed] 선수/능력치 삽입...");
  // ⚠️ 라건아는 국적상 KOR(귀화)이지만 lineup.ts의 FOREIGN_OVERRIDE_NAMES에서 이미
  // 용병으로 예외처리하고 있음. is_foreign_import 값도 같은 예외를 적용해야
  // DB 표시값과 실제 엔진 동작(용병 쿼터 계산)이 일치함 — roster.csv 순회로 바꾸면서
  // 이 예외가 빠져서 DB 컬럼만 KOR로 잘못 표시되던 버그 발견, 수정.
  const FOREIGN_OVERRIDE_NAMES = new Set(["라건아"]);
  const rosterMeta = new Map<string, { team: string; position: string; nationality: string }>();
  const natIdx = rosterCsv.header.indexOf("nationality");
  rosterCsv.rows.forEach((cols) => {
    rosterMeta.set(cols[nameIdx], { team: cols[teamIdx], position: cols[posIdx], nationality: cols[natIdx] });
  });
  const kblStatsForForeignComparison = raw
    .filter((p) => p.seasons.length > 0)
    .map((p) => {
      const s = p.seasons[p.seasons.length - 1];
      return {
        PTS: s.PTS, REB: s.REB, AST: s.AST, BLK: s.BLK, STL: s.STL,
        FGPct: s["FG%"] / 100, ThreePct: s["3P%"] / 100, FTPct: s["FT%"] / 100,
      };
    });
  const foreignEstimates = loadForeignEstimates(kblStatsForForeignComparison);

  // ⚠️ 예전엔 raw(players_enriched.json, 174명)만 순회해서, KBL 첫 시즌이라 실측기록이
  // 없는 신규 외국인 선수 7명이 DB players 테이블에 아예 안 들어가는 버그가 있었음
  // (실측 검증 중 발견). roster.csv 전체(174+7=181명 이상)를 기준으로 순회하도록 수정.
  let playerCount = 0;
  for (const [name, meta] of rosterMeta.entries()) {
    const teamId = teamIdByName.get(meta.team) ?? null;
    const p = raw.find((r) => r.name === name);
    const estimate = foreignEstimates.get(name);

    const playerRes = await pool.query(
      `INSERT INTO players (name, team_id, nationality, position, position_group, height_cm, weight_kg, birth_date, is_foreign_import, draft_year, draft_overall_pick, draft_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (name, team_id) DO UPDATE SET nationality=EXCLUDED.nationality
       RETURNING id`,
      [
        name, teamId, meta.nationality, meta.position,
        meta.position?.includes("센터") ? "C" : meta.position?.includes("가드") ? "G" : "F",
        p?.heightCm ?? null, p?.weightKg ?? null, p?.birthDate ?? null,
        FOREIGN_OVERRIDE_NAMES.has(name) || (meta.nationality !== "KOR" && meta.nationality !== "PHI"),
        p?.draftInfo?.kind === "picked" ? ((p as any)?.draftYear ?? null) : null,
        p?.draftInfo?.kind === "picked" ? (p.draftInfo as any).overallPick : null,
        p?.draftInfo?.kind ?? null,
      ]
    );
    const playerId = playerRes.rows[0].id;
    playerCount++;

    if (p) {
      const d = derivedMap.get(p.playerId);
      if (!d) continue;
      await pool.query(
        `INSERT INTO player_attributes (
          player_id, season_id, finishing, dunking, mid_range_shooting, three_point_shooting,
          free_throw_shooting, ball_handling, passing, steal, shot_blocking, defensive_rebounding,
          offensive_rebounding, stamina, injury_proneness, strength, speed, potential
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (player_id, season_id) DO UPDATE SET finishing=EXCLUDED.finishing`,
        [
          playerId, seasonId, d.finishing, d.dunking, d.midRangeShooting, d.threePointShooting,
          d.freeThrowShooting, d.ballHandling, d.passing, d.steal, d.shotBlocking, d.defensiveRebounding,
          d.offensiveRebounding, d.stamina, d.injuryProneness, d.strength, d.speed, d.potential,
        ]
      );
    } else if (estimate) {
      // KBL 첫 시즌 외국인 — 실제 해외리그 기록 기반 근사치를 player_attributes에 저장
      // (potential은 용병이라 NULL)
      const a = estimate.attrs;
      await pool.query(
        `INSERT INTO player_attributes (
          player_id, season_id, finishing, dunking, mid_range_shooting, three_point_shooting,
          free_throw_shooting, ball_handling, passing, steal, shot_blocking, defensive_rebounding,
          offensive_rebounding, stamina, injury_proneness, strength, speed, potential
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NULL)
        ON CONFLICT (player_id, season_id) DO UPDATE SET finishing=EXCLUDED.finishing`,
        [
          playerId, seasonId, a.finishing, a.dunking, a.midRangeShooting, a.threePointShooting,
          a.freeThrowShooting, a.ballHandling, a.passing, a.steal, a.shotBlocking, a.defensiveRebounding,
          a.offensiveRebounding, a.stamina, 50, a.strength, estimate.speedTier,
        ]
      );
    } else {
      // ⚠️ 국내선수인데 기록 자체가 없는 벤치/2군 선수 — 신인/포텐셜 유망주가 아니라
      // "실력이 부족해서 출전을 거의 못 받은" 선수라는 지적으로 발견. 중립값(평균) 대신
      // 스케일 최하단(50, 현재 스케일은 50~99라서 50=최약체) 명시적으로 부여.
      // 잠재력도 마찬가지로 낮게(50) — 검증된 잠재력이 없는 선수이니 중립 취급 안 함.
      await pool.query(
        `INSERT INTO player_attributes (
          player_id, season_id, finishing, dunking, mid_range_shooting, three_point_shooting,
          free_throw_shooting, ball_handling, passing, steal, shot_blocking, defensive_rebounding,
          offensive_rebounding, stamina, injury_proneness, strength, speed, potential
        ) VALUES ($1,$2,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50)
        ON CONFLICT (player_id, season_id) DO UPDATE SET finishing=EXCLUDED.finishing`,
        [playerId, seasonId]
      );
    }
  }
  console.log(`[seed] 선수 ${playerCount}명 삽입 완료 (기록기반 ${raw.length}명 + 정성평가 ${foreignEstimates.size}명)`);

  console.log("[seed] 시즌 일정 생성 (아직 시뮬레이션은 안 함)...");
  const schedule = generateRoundRobinSchedule(teamNames, 6);

  console.log(`[seed] 예정 경기 ${schedule.length}개 삽입 중 (스코어 NULL)...`);
  for (const game of schedule) {
    const homeTeamId = teamIdByName.get(game.home)!;
    const awayTeamId = teamIdByName.get(game.away)!;
    await pool.query(
      `INSERT INTO games (season_id, round, day_offset, home_team_id, away_team_id, home_score, away_score, went_to_ot, ot_periods)
       VALUES ($1,$2,$3,$4,$5,NULL,NULL,FALSE,0)`,
      [seasonId, game.round, game.day, homeTeamId, awayTeamId]
    );
  }

  console.log("[seed] franchise 세이브 슬롯 생성 (기본: 첫 팀 선택)...");
  const defaultTeam = teamNames[0];
  const userTeamId = teamIdByName.get(defaultTeam)!;
  await pool.query(
    `INSERT INTO franchise (season_id, user_team_id, current_round) VALUES ($1,$2,0)`,
    [seasonId, userTeamId]
  );

  console.log("[seed] 완료! (경기는 아직 시뮬레이션 전 — /api/franchise/advance-round로 진행)");
}

main()
  .catch((e) => {
    console.error("[seed] 실패:", e);
    process.exit(1);
  })
  .finally(() => pool.end());
