/**
 * KBL Manager — DB 시드 스크립트 (매니저 모드용)
 * 선수/능력치/팀 정보를 채우고, 시즌 "일정"만 생성한다 (경기 결과는 아직 없음).
 * 실제 경기 시뮬레이션은 /api/franchise/advance-round 호출 시 라운드 단위로 진행됨.
 */
import { pool } from "./db";
import { loadLeagueData } from "./leagueData";
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
  const rosterMeta = new Map<string, { team: string; position: string }>();
  rosterCsv.rows.forEach((cols) => {
    rosterMeta.set(cols[nameIdx], { team: cols[teamIdx], position: cols[posIdx] });
  });

  let playerCount = 0;
  for (const p of raw) {
    const meta = rosterMeta.get(p.name);
    const teamId = meta ? teamIdByName.get(meta.team) : null;

    const playerRes = await pool.query(
      `INSERT INTO players (name, team_id, nationality, position, position_group, height_cm, weight_kg, birth_date, is_foreign_import)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (name, team_id) DO UPDATE SET nationality=EXCLUDED.nationality
       RETURNING id`,
      [
        p.name, teamId, p.nationality, meta?.position ?? null,
        meta?.position?.includes("센터") ? "C" : meta?.position?.includes("가드") ? "G" : "F",
        p.heightCm, p.weightKg, p.birthDate ?? null,
        p.nationality !== "KOR" && p.nationality !== "PHI",
      ]
    );
    const playerId = playerRes.rows[0].id;
    playerCount++;

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
  console.log(`[seed] 선수 ${playerCount}명 삽입 완료`);

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
