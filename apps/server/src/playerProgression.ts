/**
 * KBL Manager — 시즌 중 성장/하락 시스템
 * 유저 팀이 9경기(사이클 1회)를 뛸 때마다 리그 전체 선수를 대상으로 실행.
 * (potential + 이번시즌 성과)를 근거로 "선수에게 맞는" 능력치 2~3개만 골라 낮은 확률로
 * ±1 조정하고, 그 누적분(delta)을 player_growth에 저장한다. 실제 시뮬레이션은 이 delta를
 * base 능력치에 더해서 사용.
 *
 * 능력치 선정 기준 (세 가지를 섞어서 스코어링 후 상위 2~3개 선택):
 *   1. 선수 본인의 현재 능력치 중 강점(이미 높은 능력치가 더 크게 성장) — 특성 강화
 *   2. 포지션(G/F/C)과 관련도가 높은 능력치군
 *   3. 이번 시즌 실제 인게임 스탯과 연관된 능력치 (AST 많으면 패싱, REB 많으면 리바운드 등)
 */
import { Pool } from "pg";

export const CHECKPOINT_INTERVAL = 9; // 유저팀 경기수 기준 체크포인트 간격 (한 라운드로빈 사이클)
const MIN_GAMES_FOR_EVAL = 5; // 이번시즌 최소 이 경기 수는 뛰어야 평가 대상

const GROWTH_ATTR_KEYS = [
  "finishing", "dunking", "mid_range_shooting", "three_point_shooting", "free_throw_shooting",
  "ball_handling", "passing", "steal", "shot_blocking", "defensive_rebounding",
  "offensive_rebounding", "strength", "stamina",
] as const;
type GrowthAttrKey = (typeof GROWTH_ATTR_KEYS)[number];

const SCORING_ATTRS: GrowthAttrKey[] = ["finishing", "mid_range_shooting", "three_point_shooting", "dunking"];

// 포지션별 능력치 관련도 (0~1). "그 선수에게 맞는" 능력치를 고르기 위한 축 중 하나.
const POSITION_RELEVANCE: Record<"G" | "F" | "C", Record<GrowthAttrKey, number>> = {
  G: {
    ball_handling: 1.0, passing: 1.0, three_point_shooting: 0.9, steal: 0.9,
    free_throw_shooting: 0.6, mid_range_shooting: 0.5, stamina: 0.5,
    finishing: 0.3, dunking: 0.2, defensive_rebounding: 0.2,
    offensive_rebounding: 0.15, shot_blocking: 0.1, strength: 0.2,
  },
  F: {
    three_point_shooting: 0.6, mid_range_shooting: 0.7, finishing: 0.7,
    defensive_rebounding: 0.7, offensive_rebounding: 0.6, strength: 0.6,
    stamina: 0.5, dunking: 0.5, ball_handling: 0.4, passing: 0.4,
    steal: 0.4, free_throw_shooting: 0.4, shot_blocking: 0.4,
  },
  C: {
    finishing: 0.8, dunking: 0.9, offensive_rebounding: 0.9, defensive_rebounding: 0.9,
    shot_blocking: 0.9, strength: 0.9, stamina: 0.5, mid_range_shooting: 0.3,
    free_throw_shooting: 0.4, passing: 0.25, steal: 0.2,
    three_point_shooting: 0.15, ball_handling: 0.15,
  },
};

const POS_WEIGHT = 0.4;
const STRENGTH_WEIGHT = 0.35;
const STAT_WEIGHT = 0.25;
const THIRD_ATTR_GAP = 0.1; // 3위 점수가 2위와 이 폭 이내면 3개, 아니면 2개만 선정
const GROWTH_ATTR_COUNT_MIN = 2;
const PER_ATTR_APPLY_PROBABILITY = 0.3; // 선정된 능력치라도 30% 확률로만 실제 ±1 적용
const NEUTRAL_STAT_SIGNAL = 0.3; // 인게임 스탯으로 알 수 없는 능력치(스틸/자유투/근력/스태미나)의 기본값

function percentileOf(values: number[], target: number): number {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return 50;
  const below = clean.filter((v) => v < target).length;
  const equal = clean.filter((v) => v === target).length;
  return ((below + equal * 0.5) / clean.length) * 100;
}

/** 선수 본인의 13개 능력치 중 해당 능력치의 상대적 순위(0~1, 높을수록 강점) */
function ownStrengthScore(attrs: Record<GrowthAttrKey, number>, key: GrowthAttrKey): number {
  const values = GROWTH_ATTR_KEYS.map((k) => attrs[k] ?? 50);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 0.5;
  return (attrs[key] - min) / (max - min);
}

/** 이번 시즌 인게임 스탯(pts/ast/reb/blk 퍼센타일) 기반 능력치별 연관 신호 (0~1) */
function statSignalFor(
  key: GrowthAttrKey,
  attrs: Record<GrowthAttrKey, number>,
  statPercentiles: { pts: number; ast: number; reb: number; blk: number },
): number {
  switch (key) {
    case "passing":
      return statPercentiles.ast;
    case "ball_handling":
      return statPercentiles.ast * 0.6 + NEUTRAL_STAT_SIGNAL * 0.4;
    case "offensive_rebounding":
    case "defensive_rebounding":
      return statPercentiles.reb;
    case "shot_blocking":
      return statPercentiles.blk;
    case "finishing":
    case "mid_range_shooting":
    case "three_point_shooting":
    case "dunking": {
      // 득점 관련 능력치 4개 중 본인이 이미 가장 잘하는 쪽에 PTS 신호를 몰아준다
      const values = SCORING_ATTRS.map((k) => attrs[k] ?? 50);
      const max = Math.max(...values);
      const isPrimary = (attrs[key] ?? 50) === max;
      return statPercentiles.pts * (isPrimary ? 1 : 0.3);
    }
    default:
      // steal, free_throw_shooting, strength, stamina — 인게임 박스스코어에 데이터 없음
      return NEUTRAL_STAT_SIGNAL;
  }
}

/** 선수에게 "맞는" 능력치 2~3개를 스코어링해서 선정 */
function selectGrowthAttrs(
  attrs: Record<GrowthAttrKey, number>,
  positionGroup: "G" | "F" | "C",
  statPercentiles: { pts: number; ast: number; reb: number; blk: number },
): GrowthAttrKey[] {
  const scored = GROWTH_ATTR_KEYS.map((key) => {
    const posScore = POSITION_RELEVANCE[positionGroup][key];
    const strengthScore = ownStrengthScore(attrs, key);
    const statScore = statSignalFor(key, attrs, statPercentiles) / 100;
    const score = posScore * POS_WEIGHT + strengthScore * STRENGTH_WEIGHT + statScore * STAT_WEIGHT;
    return { key, score };
  }).sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, GROWTH_ATTR_COUNT_MIN).map((s) => s.key);
  const third = scored[GROWTH_ATTR_COUNT_MIN];
  const secondScore = scored[GROWTH_ATTR_COUNT_MIN - 1].score;
  if (third && secondScore - third.score <= THIRD_ATTR_GAP) {
    picked.push(third.key);
  }
  return picked;
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

  // 이번시즌 각 선수의 경기수/스탯별 percentile 산출용 raw 집계
  const perfRes = await pool.query(
    `SELECT s.player_id, p.name, p.position_group, COUNT(*) AS games,
            AVG(s.pts) AS avg_pts, AVG(s.ast) AS avg_ast, AVG(s.reb) AS avg_reb,
            AVG(s.blk) AS avg_blk, AVG(s.tov) AS avg_tov,
            AVG(s.pts + s.reb + s.ast - s.tov) AS composite_eff
     FROM player_game_stats s
     JOIN games g ON g.id = s.game_id
     JOIN players p ON p.id = s.player_id
     WHERE g.season_id = $1
     GROUP BY s.player_id, p.name, p.position_group`,
    [seasonId]
  );

  const eligiblePlayers = perfRes.rows.filter((r) => Number(r.games) >= MIN_GAMES_FOR_EVAL);
  if (eligiblePlayers.length === 0) return false;

  const effArr = eligiblePlayers.map((r) => Number(r.composite_eff));
  const ptsArr = eligiblePlayers.map((r) => Number(r.avg_pts));
  const astArr = eligiblePlayers.map((r) => Number(r.avg_ast));
  const rebArr = eligiblePlayers.map((r) => Number(r.avg_reb));
  const blkArr = eligiblePlayers.map((r) => Number(r.avg_blk));

  for (const row of eligiblePlayers) {
    const eff = Number(row.composite_eff);
    const perfPercentile = percentileOf(effArr, eff);
    const performanceSignal = (perfPercentile - 50) / 50; // -1~1

    const attrRes = await pool.query(
      `SELECT potential, finishing, dunking, mid_range_shooting, three_point_shooting, free_throw_shooting,
              ball_handling, passing, steal, shot_blocking, defensive_rebounding, offensive_rebounding,
              strength, stamina
       FROM player_attributes WHERE player_id=$1`,
      [row.player_id]
    );
    if (attrRes.rows.length === 0) continue;
    const attrRow = attrRes.rows[0];
    const potential: number | null = attrRow.potential ?? null;
    const potentialSignal = potential !== null ? (potential - 50) / 49 : 0; // 0~1 (용병은 0)

    // 성장/하락 방향만 결정 (폭은 아래서 능력치별로 확률적으로 적용)
    const overallSignal = performanceSignal + potentialSignal; // 대략 -1 ~ 2
    let direction = 0;
    if (overallSignal > 0.05) direction = 1;
    else if (overallSignal < -0.05) direction = -1;
    if (direction === 0) continue;

    const currentAttrs: Record<GrowthAttrKey, number> = {
      finishing: attrRow.finishing, dunking: attrRow.dunking, mid_range_shooting: attrRow.mid_range_shooting,
      three_point_shooting: attrRow.three_point_shooting, free_throw_shooting: attrRow.free_throw_shooting,
      ball_handling: attrRow.ball_handling, passing: attrRow.passing, steal: attrRow.steal,
      shot_blocking: attrRow.shot_blocking, defensive_rebounding: attrRow.defensive_rebounding,
      offensive_rebounding: attrRow.offensive_rebounding, strength: attrRow.strength, stamina: attrRow.stamina,
    };
    const positionGroup: "G" | "F" | "C" = (row.position_group === "G" || row.position_group === "F" || row.position_group === "C")
      ? row.position_group : "F";
    const statPercentiles = {
      pts: percentileOf(ptsArr, Number(row.avg_pts)),
      ast: percentileOf(astArr, Number(row.avg_ast)),
      reb: percentileOf(rebArr, Number(row.avg_reb)),
      blk: percentileOf(blkArr, Number(row.avg_blk)),
    };

    const targetAttrs = selectGrowthAttrs(currentAttrs, positionGroup, statPercentiles);

    // 선정된 능력치라도 낮은 확률로만 실제 ±1 적용 (선수당 최대 2~3, 대부분은 0개)
    const deltasThisCheckpoint: Partial<Record<GrowthAttrKey, number>> = {};
    for (const attrKey of targetAttrs) {
      if (Math.random() < PER_ATTR_APPLY_PROBABILITY) {
        deltasThisCheckpoint[attrKey] = direction;
      }
    }
    if (Object.keys(deltasThisCheckpoint).length === 0) continue;

    const colFor = (k: GrowthAttrKey) => `delta_${k}`;

    // player_growth upsert: 기존 delta에 이번 성장폭을 누적 (해당 안 된 능력치는 0)
    const existing = await pool.query(`SELECT 1 FROM player_growth WHERE player_id=$1`, [row.player_id]);
    if (existing.rows.length === 0) {
      const cols = GROWTH_ATTR_KEYS.map(colFor);
      const values = GROWTH_ATTR_KEYS.map((k) => deltasThisCheckpoint[k] ?? 0);
      await pool.query(
        `INSERT INTO player_growth (player_id, season_id, ${cols.join(", ")}, last_checkpoint_games)
         VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")}, $${cols.length + 3})`,
        [row.player_id, seasonId, ...values, targetCheckpoint]
      );
    } else {
      const setClauses = GROWTH_ATTR_KEYS.map((k) => `${colFor(k)} = ${colFor(k)} + ${deltasThisCheckpoint[k] ?? 0}`);
      await pool.query(
        `UPDATE player_growth SET ${setClauses.join(", ")}, last_checkpoint_games=$2 WHERE player_id=$1`,
        [row.player_id, targetCheckpoint]
      );
    }

    // 화면표시(player_attributes)에도 반영 — 50~99 클램프
    for (const [attrKey, delta] of Object.entries(deltasThisCheckpoint)) {
      await pool.query(
        `UPDATE player_attributes SET ${attrKey} = GREATEST(50, LEAST(99, COALESCE(${attrKey},50) + $2))
         WHERE player_id=$1`,
        [row.player_id, delta]
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
