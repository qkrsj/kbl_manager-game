/**
 * KBL Manager — DB 시드 스크립트
 * data/processed/players_enriched.json + roster.csv로 선수/능력치를 채우고,
 * simulation-engine으로 시즌 전체를 시뮬레이션해서 경기결과/박스스코어까지 DB에 넣는다.
 */
import * as fs from "fs";
import * as path from "path";
import { pool } from "./db";
import { computeLeagueDerivedAttributes, PlayerInput } from "../../../packages/attribute-pipeline/attributeConversion";
import { toLineupPlayer, RosterPlayer } from "../../../packages/simulation-engine/lineup";
import { computeSimulationInternals, SimStatLine } from "../../../packages/simulation-engine/simulationInternals";
import { SimPlayer, DisplayAttrs } from "../../../packages/simulation-engine/possession";
import { generateRoundRobinSchedule, runSeason } from "../../../packages/simulation-engine/seasonScheduler";

const DATA_DIR = path.join(__dirname, "../../../data/processed");
const SEASON_LABEL = "2025-2026";

function parseCsv(content: string): { header: string[]; rows: string[][] } {
  const lines = content.trim().split("\n");
  const header = lines[0].split(",");
  const rows = lines.slice(1).map((l) => l.split(","));
  return { header, rows };
}

async function main() {
  console.log("[seed] players_enriched.json / roster.csv 로딩...");
  const raw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "players_enriched.json"), "utf-8")
  ) as (PlayerInput & { nationality: string; birthDate?: string })[];

  const rosterCsv = parseCsv(fs.readFileSync(path.join(DATA_DIR, "roster.csv"), "utf-8"));
  const teamIdx = rosterCsv.header.indexOf("team");
  const nameIdx = rosterCsv.header.indexOf("name");
  const posIdx = rosterCsv.header.indexOf("position");

  const rosterMeta = new Map<string, { team: string; position: string }>();
  rosterCsv.rows.forEach((cols) => {
    rosterMeta.set(cols[nameIdx], { team: cols[teamIdx], position: cols[posIdx] });
  });

  console.log("[seed] 능력치 계산 중...");
  const derivedMap = computeLeagueDerivedAttributes(raw);

  console.log("[seed] 팀 목록 삽입...");
  const teamNames = Array.from(new Set(Array.from(rosterMeta.values()).map((m) => m.team)));
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
  const playerIdByName = new Map<string, number>();
  for (const p of raw) {
    const meta = rosterMeta.get(p.name);
    const teamId = meta ? teamIdByName.get(meta.team) : null;

    const playerRes = await pool.query(
      `INSERT INTO players (name, team_id, nationality, position, position_group, height_cm, weight_kg, birth_date, is_foreign_import)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (name, team_id) DO UPDATE SET nationality=EXCLUDED.nationality
       RETURNING id`,
      [
        p.name,
        teamId,
        p.nationality,
        meta?.position ?? null,
        meta?.position?.includes("센터") ? "C" : meta?.position?.includes("가드") ? "G" : "F",
        p.heightCm,
        p.weightKg,
        p.birthDate ?? null,
        p.nationality !== "KOR" && p.nationality !== "PHI",
      ]
    );
    const playerId = playerRes.rows[0].id;
    playerIdByName.set(p.name, playerId);

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
  }
  console.log(`[seed] 선수 ${playerIdByName.size}명 삽입 완료`);

  console.log("[seed] 시즌 시뮬레이션 실행...");
  const internalsInput = raw
    .filter((p) => p.seasons.length > 0)
    .map((p) => {
      const s = p.seasons[p.seasons.length - 1];
      return {
        playerId: p.playerId,
        stat: {
          G: s.G, PTS: s.PTS, FGA: s.FGA, FTA: s.FTA, TO: s.TO, PP: s.PP, PPA: s.PPA,
          "2PM": s["2PM"], "2PA": s["2PA"], "3PM": s["3PM"], "3PA": s["3PA"], FTM: s.FTM,
        } as SimStatLine,
      };
    });
  const internalsMap = computeSimulationInternals(internalsInput);

  function buildTeamRoster(teamName: string): SimPlayer[] {
    const players: RosterPlayer[] = [];
    rosterCsv.rows.forEach((cols) => {
      if (cols[teamIdx] === teamName) {
        const name = cols[nameIdx];
        const player = raw.find((p) => p.name === name);
        const perGameMin = player && player.seasons.length > 0 ? player.seasons[player.seasons.length - 1].Min : 10;
        players.push({ name, position: cols[posIdx], nationality: player?.nationality ?? "KOR", perGameMin });
      }
    });
    return players.map(toLineupPlayer).map((lp) => {
      const player = raw.find((p) => p.name === lp.name);
      const derived = player ? derivedMap.get(player.playerId) : undefined;
      const internals = player ? internalsMap.get(player.playerId) : undefined;
      const attrs: DisplayAttrs = derived
        ? {
            finishing: derived.finishing, dunking: derived.dunking, midRangeShooting: derived.midRangeShooting,
            threePointShooting: derived.threePointShooting, freeThrowShooting: derived.freeThrowShooting,
            ballHandling: derived.ballHandling, passing: derived.passing, steal: derived.steal,
            shotBlocking: derived.shotBlocking, defensiveRebounding: derived.defensiveRebounding,
            offensiveRebounding: derived.offensiveRebounding, strength: derived.strength, stamina: derived.stamina,
          }
        : {
            finishing: 50, dunking: 50, midRangeShooting: 50, threePointShooting: 50, freeThrowShooting: 50,
            ballHandling: 50, passing: 50, steal: 50, shotBlocking: 50, defensiveRebounding: 50,
            offensiveRebounding: 50, strength: 50, stamina: 50,
          };
      return {
        ...lp,
        attrs,
        internals: internals ?? { paintAccuracy: 0.5, midAccuracy: 0.42, threeAccuracy: 0.33, ftAccuracy: 0.7, usagePercentile: 50, ptsPercentile: 50 },
      };
    });
  }

  const teamRosters = new Map(teamNames.map((t) => [t, buildTeamRoster(t)]));
  const schedule = generateRoundRobinSchedule(teamNames, 6);
  const season = runSeason(teamRosters, schedule);

  console.log(`[seed] 경기 ${season.gameLogs.length}개 삽입 중...`);
  for (const log of season.gameLogs) {
    const homeTeamId = teamIdByName.get(log.home)!;
    const awayTeamId = teamIdByName.get(log.away)!;
    const gameRes = await pool.query(
      `INSERT INTO games (season_id, round, day_offset, home_team_id, away_team_id, home_score, away_score, went_to_ot, ot_periods, home_rest_days, away_rest_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [seasonId, log.round, log.day, homeTeamId, awayTeamId, log.homeScore, log.awayScore, log.wentToOT, 0, log.homeRestDays, log.awayRestDays]
    );
    const gameId = gameRes.rows[0].id;

    for (const box of log.homeBoxScores) {
      const playerId = playerIdByName.get(box.name);
      if (!playerId) continue;
      await pool.query(
        `INSERT INTO player_game_stats (game_id, player_id, team_id, pts, ast, reb, tov, blk, pf)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [gameId, playerId, homeTeamId, box.PTS, box.AST, box.REB, box.TOV, box.BLK, box.PF]
      );
    }
    for (const box of log.awayBoxScores) {
      const playerId = playerIdByName.get(box.name);
      if (!playerId) continue;
      await pool.query(
        `INSERT INTO player_game_stats (game_id, player_id, team_id, pts, ast, reb, tov, blk, pf)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [gameId, playerId, awayTeamId, box.PTS, box.AST, box.REB, box.TOV, box.BLK, box.PF]
      );
    }
  }
  console.log("[seed] 완료!");
}

main()
  .catch((e) => {
    console.error("[seed] 실패:", e);
    process.exit(1);
  })
  .finally(() => pool.end());
