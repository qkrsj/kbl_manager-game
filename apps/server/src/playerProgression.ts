/**
 * KBL Manager — 시즌 중 성장/하락 시스템
 * 유저 팀이 9경기(사이클 1회)를 뛸 때마다 리그 전체 선수를 대상으로 실행.
 * (potential + 이번시즌 성과)를 근거로 능력치를 소폭 조정하고, 그 누적분(delta)을
 * player_growth에 저장한다. 실제 시뮬레이션은 이 delta를 base 능력치에 더해서 사용.
 */
import { Pool } from "pg";

export const CHECKPOINT_INTERVAL = 9; // 유저팀 경기수 기준 체크포인트 간격 (한 라운드로빈 사이클)
const MIN_GAMES_FOR_EVAL = 5; // 이번시즌 최소 이 경기 수는 뛰어야 평가 대상
const GROWTH_ATTR_KEYS = [
  "finishing", "dunking", "mid_range_shooting", "three_point_shooting", "free_throw_shooting",
  "ball_handling", "passing", "steal", "shot_blocking", "defensive_rebounding",
  "offensive_rebounding", "strength", "stamina",
] as const;

function percentileOf(values: number[], target: number): number {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return 50;
  const below = clean.filter((v) => v < target).length;
  const equal = clean.filter((v) => v === target).length;
  return ((below + equal * 0.5) / clean.length) * 100;
}

/**
 * 유저팀 경기수가 새로 체크포인트(9의 배수)를 넘겼으면 리그 전체 성장 적용.
 * 이미 이번 체크포인트를 처리했으면 아무것도 안 함(멱등성 보장).
 */
export async function maybeApplyGrowthCheckpoint(pool: Pool, seasonId: number, userGamesPlayed: number): Promise<boolean> {
  const targetCheckpoint = Math.floor(userGamesPlayed / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL;
  if (targetCheckpoint === 0) return false;

  // ⚠️ 이전엔 "선수 1명(순서 불안정)"의 last_checkpoint_games로 중복 여부를 판단해서,
  // 매 advance() 호출마다 계속 재적용되는 버그가 있었음 (delta가 최대 46까지 폭주,
  // 실측 검증 중 발견). 시즌 단위로 안정적인 체크포인트 추적 테이블을 별도로 둬서 수정.
  const trackRes = await pool.query(
    `INSERT INTO season_growth_checkpoints (season_id, last_checkpoint_games)
     VALUES ($1, 0)
     ON CONFLICT (season_id) DO NOTHING`,
    [seasonId]
  );
  void trackRes;
  const stateRes = await pool.query(
    `SELECT last_checkpoint_games FROM season_growth_checkpoints WHERE season_id=$1`,
    [seasonId]
  );
  if (stateRes.rows[0].last_checkpoint_games >= targetCheckpoint) {
    return false; // 이미 이 체크포인트까지 처리됨
  }

  // 이번 호출에서 처리할 체크포인트를 먼저 확정(멱등성 보장을 위해 먼저 업데이트)
  await pool.query(
    `UPDATE season_growth_checkpoints SET last_checkpoint_games=$2 WHERE season_id=$1`,
    [seasonId, targetCheckpoint]
  );

  // 이번시즌 각 선수의 경기수/종합효율(PTS+REB+AST+STL+BLK-TOV) 집계
  const perfRes = await pool.query(
    `SELECT s.player_id, p.name, COUNT(*) AS games,
            AVG(s.pts + s.reb + s.ast + s.tov * -1) AS composite_eff
     FROM player_game_stats s
     JOIN games g ON g.id = s.game_id
     JOIN players p ON p.id = s.player_id
     WHERE g.season_id = $1
     GROUP BY s.player_id, p.name`,
    [seasonId]
  );

  const eligiblePlayers = perfRes.rows.filter((r) => Number(r.games) >= MIN_GAMES_FOR_EVAL);
  if (eligiblePlayers.length === 0) return false;

  const effArr = eligiblePlayers.map((r) => Number(r.composite_eff));

  for (const row of eligiblePlayers) {
    const eff = Number(row.composite_eff);
    const perfPercentile = percentileOf(effArr, eff);
    const performanceSignal = (perfPercentile - 50) / 50; // -1~1

    const attrRes = await pool.query(`SELECT potential FROM player_attributes WHERE player_id=$1`, [row.player_id]);
    const potential: number | null = attrRes.rows[0]?.potential ?? null;
    const potentialSignal = potential !== null ? (potential - 50) / 49 : 0; // 0~1 (용병은 0)

    const growthDelta = Math.round(performanceSignal * 0.6 + potentialSignal * 0.6);
    if (growthDelta === 0) continue;

    // player_growth upsert: 기존 delta에 이번 성장폭을 누적
    const existing = await pool.query(`SELECT * FROM player_growth WHERE player_id=$1`, [row.player_id]);
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO player_growth (player_id, season_id, delta_finishing, delta_dunking, delta_mid_range_shooting,
          delta_three_point_shooting, delta_free_throw_shooting, delta_ball_handling, delta_passing, delta_steal,
          delta_shot_blocking, delta_defensive_rebounding, delta_offensive_rebounding, delta_strength, delta_stamina,
          last_checkpoint_games)
         VALUES ($1,$2,$3,$3,$3,$3,$3,$3,$3,$3,$3,$3,$3,$3,$3,$4)`,
        [row.player_id, seasonId, growthDelta, targetCheckpoint]
      );
    } else {
      await pool.query(
        `UPDATE player_growth SET
          delta_finishing=delta_finishing+$2, delta_dunking=delta_dunking+$2,
          delta_mid_range_shooting=delta_mid_range_shooting+$2, delta_three_point_shooting=delta_three_point_shooting+$2,
          delta_free_throw_shooting=delta_free_throw_shooting+$2, delta_ball_handling=delta_ball_handling+$2,
          delta_passing=delta_passing+$2, delta_steal=delta_steal+$2, delta_shot_blocking=delta_shot_blocking+$2,
          delta_defensive_rebounding=delta_defensive_rebounding+$2, delta_offensive_rebounding=delta_offensive_rebounding+$2,
          delta_strength=delta_strength+$2, delta_stamina=delta_stamina+$2, last_checkpoint_games=$3
         WHERE player_id=$1`,
        [row.player_id, growthDelta, targetCheckpoint]
      );
    }

    // 화면표시(player_attributes)에도 반영 — 50~99 클램프
    for (const col of GROWTH_ATTR_KEYS) {
      await pool.query(
        `UPDATE player_attributes SET ${col} = GREATEST(50, LEAST(99, COALESCE(${col},50) + $2))
         WHERE player_id=$1`,
        [row.player_id, growthDelta]
      );
    }
  }

  return true;
}

export interface GrowthDelta {
  finishing: number; dunking: number; midRangeShooting: number; threePointShooting: number;
  freeThrowShooting: number; ballHandling: number; passing: number; steal: number;
  shotBlocking: number; defensiveRebounding: number; offensiveRebounding: number;
  strength: number; stamina: number;
}

/** playerName -> 누적 성장 delta 맵 (buildTeamRoster 결과에 적용하기 위함) */
export async function loadGrowthDeltas(pool: Pool, seasonId: number): Promise<Map<string, GrowthDelta>> {
  const res = await pool.query(
    `SELECT p.name, g.delta_finishing, g.delta_dunking, g.delta_mid_range_shooting, g.delta_three_point_shooting,
            g.delta_free_throw_shooting, g.delta_ball_handling, g.delta_passing, g.delta_steal,
            g.delta_shot_blocking, g.delta_defensive_rebounding, g.delta_offensive_rebounding,
            g.delta_strength, g.delta_stamina
     FROM player_growth g JOIN players p ON p.id = g.player_id
     WHERE g.season_id = $1`,
    [seasonId]
  );
  const map = new Map<string, GrowthDelta>();
  for (const r of res.rows) {
    map.set(r.name, {
      finishing: r.delta_finishing, dunking: r.delta_dunking, midRangeShooting: r.delta_mid_range_shooting,
      threePointShooting: r.delta_three_point_shooting, freeThrowShooting: r.delta_free_throw_shooting,
      ballHandling: r.delta_ball_handling, passing: r.delta_passing, steal: r.delta_steal,
      shotBlocking: r.delta_shot_blocking, defensiveRebounding: r.delta_defensive_rebounding,
      offensiveRebounding: r.delta_offensive_rebounding, strength: r.delta_strength, stamina: r.delta_stamina,
    });
  }
  return map;
}
