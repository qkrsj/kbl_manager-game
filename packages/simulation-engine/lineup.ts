/**
 * KBL Manager — 라인업 선택 로직 (v0)
 *
 * 규칙:
 * - 1쿼터/4쿼터: 코트에 용병 정확히 1명
 * - 2쿼터/3쿼터: 코트에 용병 정확히 2명
 * - 아시아쿼터(PHI 국적)는 국내선수 취급
 * - 라건아는 국적상 KOR(귀화)이지만 예외적으로 용병 취급
 * - 로테이션은 실제 교체 타이밍을 시뮬레이션하지 않고, 매 포제션마다
 *   각 선수의 "경기당 출전비중(perGameMin/200)"에 비례한 확률로 5명을 뽑는 방식
 *   (포제션이 충분히 쌓이면 장기적으로 실제 출전시간 비율에 수렴)
 */

export type PositionGroup = "G" | "F" | "C";

export interface RosterPlayer {
  name: string;
  position: string;      // roster.csv 원본 포지션 문자열 (예: "포인트 가드/슈팅 가드")
  nationality: string;   // "KOR" | "PHI" | "USA" | "TUR" | "EGY" 등
  perGameMin: number;    // 경기당 평균 출장시간(분)
}

export interface LineupPlayer extends RosterPlayer {
  positionGroup: PositionGroup;
  isForeign: boolean;    // true면 쿼터별 용병 제한 대상
}

/** 국적상 KOR(귀화)이지만 용병 취급하는 예외 명단 */
const FOREIGN_OVERRIDE_NAMES = new Set<string>(["라건아"]);

/** 국내선수 취급 국적 (KOR 본인 + PHI 아시아쿼터) */
const DOMESTIC_NATIONALITIES = new Set<string>(["KOR", "PHI"]);

export function isForeignImport(p: { name: string; nationality: string }): boolean {
  if (FOREIGN_OVERRIDE_NAMES.has(p.name)) return true;
  return !DOMESTIC_NATIONALITIES.has(p.nationality);
}

/** roster.csv의 복합 포지션 표기를 3그룹으로 단순화 ("포인트 가드/슈팅 가드" 등도 커버) */
export function mapPositionToGroup(position: string): PositionGroup {
  if (position.includes("센터")) return "C";
  if (position.includes("가드")) return "G";
  return "F"; // 스몰포워드/파워포워드 등 포워드 계열 전부
}

export function toLineupPlayer(p: RosterPlayer): LineupPlayer {
  return {
    ...p,
    positionGroup: mapPositionToGroup(p.position),
    isForeign: isForeignImport(p),
  };
}

/** 5 이상은 연장전(OT)으로 취급 — Q1/Q4와 동일하게 용병 1명 규칙 적용 */
export function requiredForeignCount(quarter: number): number {
  return quarter === 2 || quarter === 3 ? 2 : 1;
}

/** 표준 라인업 구성 가정: 가드2 + 포워드2 + 센터1 */
const TARGET_POSITION_COUNTS: Record<PositionGroup, number> = { G: 2, F: 2, C: 1 };

/** 가중치 비례 복원추출 없는 샘플링 (weightFn이 전부 0이면 균등 추첨으로 폴백) */
function weightedSampleWithoutReplacement<T>(
  pool: T[],
  weightFn: (t: T) => number,
  count: number
): T[] {
  const chosen: T[] = [];
  const remaining = [...pool];
  for (let i = 0; i < count && remaining.length > 0; i++) {
    const weights = remaining.map(weightFn);
    const total = weights.reduce((a, b) => a + b, 0);
    let idx: number;
    if (total <= 0) {
      idx = Math.floor(Math.random() * remaining.length);
    } else {
      let r = Math.random() * total;
      idx = 0;
      for (; idx < weights.length; idx++) {
        r -= weights[idx];
        if (r <= 0) break;
      }
      idx = Math.min(idx, remaining.length - 1);
    }
    chosen.push(remaining.splice(idx, 1)[0]);
  }
  return chosen;
}

/**
 * 특정 쿼터의 한 포제션에 코트에 있을 5명을 확률적으로 선택.
 * 1) 용병 풀에서 그 쿼터의 요구 인원만큼 출전비중 가중 추첨
 * 2) 용병이 채운 포지션 그룹을 제외하고, 남은 슬롯을 국내선수 풀에서 그룹별 출전비중 가중 추첨
 */
export function selectLineup(
  teamRoster: LineupPlayer[],
  quarter: number
): LineupPlayer[] {
  const foreignPool = teamRoster.filter((p) => p.isForeign);
  const domesticPool = teamRoster.filter((p) => !p.isForeign);

  const neededForeign = requiredForeignCount(quarter);
  const selectedForeign = weightedSampleWithoutReplacement(
    foreignPool,
    (p) => p.perGameMin,
    neededForeign
  );

  const filledGroups: Record<PositionGroup, number> = { G: 0, F: 0, C: 0 };
  selectedForeign.forEach((p) => filledGroups[p.positionGroup]++);

  const selectedDomestic: LineupPlayer[] = [];
  (["G", "F", "C"] as PositionGroup[]).forEach((group) => {
    const need = Math.max(0, TARGET_POSITION_COUNTS[group] - filledGroups[group]);
    const groupPool = domesticPool.filter((p) => p.positionGroup === group);
    const picked = weightedSampleWithoutReplacement(groupPool, (p) => p.perGameMin, need);
    selectedDomestic.push(...picked);
  });

  // ⚠️ 안전장치: 파울아웃 등으로 특정 포지션 그룹이 비어 5명을 못 채우면,
  // 남은 인원(국내+용병 무관, 이미 뽑힌 선수 제외)에서 출전비중 가중으로 보충
  const selectedSoFar = [...selectedForeign, ...selectedDomestic];
  if (selectedSoFar.length < 5) {
    const remaining = teamRoster.filter((p) => !selectedSoFar.includes(p));
    const extra = weightedSampleWithoutReplacement(
      remaining, (p) => p.perGameMin, 5 - selectedSoFar.length
    );
    selectedSoFar.push(...extra);
  }

  return selectedSoFar;
}
