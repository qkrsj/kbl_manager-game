/**
 * KBL Manager — "선수에게 맞는" 성장 능력치 선정 로직
 * (v1부터 성장 자체는 development.ts의 훈련/경험치 시스템이 담당하고, 경기 경험치 레벨업 시
 *  어떤 능력치를 올릴지 고르는 데 이 모듈의 selectGrowthAttrs를 사용한다.
 *  구버전의 9경기 체크포인트 성장(player_growth 테이블)은 v1에서 대체되어 제거됨)
 *
 * 능력치 선정 기준 (세 가지를 섞어서 스코어링 후 상위 2~3개 선택):
 *   1. 선수 본인의 현재 능력치 중 강점(이미 높은 능력치가 더 크게 성장) — 특성 강화
 *   2. 포지션(G/F/C)과 관련도가 높은 능력치군
 *   3. 이번 시즌 실제 인게임 스탯과 연관된 능력치 (AST 많으면 패싱, REB 많으면 리바운드 등)
 */

export const GROWTH_ATTR_KEYS = [
  "finishing", "dunking", "mid_range_shooting", "three_point_shooting", "free_throw_shooting",
  "ball_handling", "passing", "steal", "shot_blocking", "defensive_rebounding",
  "offensive_rebounding", "strength", "stamina",
] as const;
export type GrowthAttrKey = (typeof GROWTH_ATTR_KEYS)[number];

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
const NEUTRAL_STAT_SIGNAL = 0.3; // 인게임 스탯으로 알 수 없는 능력치(스틸/자유투/근력/스태미나)의 기본값


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
export function selectGrowthAttrs(
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
