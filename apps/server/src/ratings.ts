/**
 * KBL Manager — 종합 능력치(오버롤) / 공격 / 수비 능력치 산출
 *
 * 세부 능력치(50~99, 리그 퍼센타일 기반)를 가중 평균해서 계산한다.
 * 포지션마다 공격·수비 비중과 세부 항목 가중치가 다르다 (가드는 핸들링·패스, 센터는 리바운드·블록 비중↑).
 * 서버(AI 로테이션, 연봉 산정)와 화면 표시가 모두 이 함수 하나를 쓴다.
 */

export type PositionGroup = "G" | "F" | "C";

export interface AttributeRow {
  finishing: number;
  dunking: number;
  mid_range_shooting: number;
  three_point_shooting: number;
  free_throw_shooting: number;
  ball_handling: number;
  passing: number;
  steal: number;
  shot_blocking: number;
  defensive_rebounding: number;
  offensive_rebounding: number;
  stamina: number;
  strength: number;
  speed: number;
}

export const SIM_ATTR_KEYS = [
  "finishing", "dunking", "mid_range_shooting", "three_point_shooting", "free_throw_shooting",
  "ball_handling", "passing", "steal", "shot_blocking", "defensive_rebounding",
  "offensive_rebounding", "strength", "stamina", "speed",
] as const;
export type AttrKey = (typeof SIM_ATTR_KEYS)[number];

export const ATTR_LABEL: Record<AttrKey, string> = {
  finishing: "골밑 마무리", dunking: "덩크", mid_range_shooting: "미드레인지", three_point_shooting: "3점슛",
  free_throw_shooting: "자유투", ball_handling: "볼핸들링", passing: "패스", steal: "스틸",
  shot_blocking: "블록", defensive_rebounding: "수비 리바운드", offensive_rebounding: "공격 리바운드",
  strength: "파워", stamina: "체력", speed: "스피드",
};

const OFFENSE_WEIGHTS: Record<PositionGroup, Partial<Record<AttrKey, number>>> = {
  G: { finishing: 0.13, dunking: 0.03, mid_range_shooting: 0.14, three_point_shooting: 0.22, free_throw_shooting: 0.06, ball_handling: 0.22, passing: 0.20 },
  F: { finishing: 0.20, dunking: 0.08, mid_range_shooting: 0.17, three_point_shooting: 0.20, free_throw_shooting: 0.06, ball_handling: 0.12, passing: 0.10, offensive_rebounding: 0.07 },
  C: { finishing: 0.30, dunking: 0.14, mid_range_shooting: 0.12, three_point_shooting: 0.06, free_throw_shooting: 0.06, ball_handling: 0.05, passing: 0.09, offensive_rebounding: 0.18 },
};

const DEFENSE_WEIGHTS: Record<PositionGroup, Partial<Record<AttrKey, number>>> = {
  G: { steal: 0.38, shot_blocking: 0.05, defensive_rebounding: 0.12, strength: 0.15, speed: 0.30 },
  F: { steal: 0.24, shot_blocking: 0.18, defensive_rebounding: 0.24, strength: 0.18, speed: 0.16 },
  C: { steal: 0.08, shot_blocking: 0.34, defensive_rebounding: 0.34, strength: 0.20, speed: 0.04 },
};

const OFFENSE_SHARE: Record<PositionGroup, number> = { G: 0.6, F: 0.55, C: 0.5 };

function weighted(attrs: AttributeRow, weights: Partial<Record<AttrKey, number>>): number {
  let sum = 0;
  let wsum = 0;
  for (const [k, w] of Object.entries(weights) as [AttrKey, number][]) {
    sum += (Number(attrs[k]) || 50) * w;
    wsum += w;
  }
  return wsum === 0 ? 50 : sum / wsum;
}

export interface Ratings {
  offense: number;
  defense: number;
  overall: number;
}

/**
 * 오버롤은 단순 평균이 아니라 "가장 잘하는 쪽"에 약간 가중(최대치 보정)을 줘서
 * 한쪽에 특화된 선수(예: 슈터, 림프로텍터)가 평범한 올라운더보다 지나치게 낮게 나오지 않게 함.
 */
export function computeRatings(attrs: AttributeRow, positionGroup: string | null): Ratings {
  const pos: PositionGroup = positionGroup === "G" || positionGroup === "C" ? positionGroup : "F";
  const offense = weighted(attrs, OFFENSE_WEIGHTS[pos]);
  const defense = weighted(attrs, DEFENSE_WEIGHTS[pos]);
  const share = OFFENSE_SHARE[pos];
  const blended = offense * share + defense * (1 - share);
  const peak = Math.max(offense, defense);
  const overall = blended * 0.75 + peak * 0.25 + ((Number(attrs.stamina) || 50) - 75) * 0.04;
  return {
    offense: Math.round(offense),
    defense: Math.round(defense),
    overall: Math.round(Math.max(40, Math.min(99, overall))),
  };
}
