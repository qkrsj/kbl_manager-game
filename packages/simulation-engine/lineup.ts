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

/**
 * 쿼터별 코트 위 외국선수 최대 인원 (2026-27 KBL 규정: 1·4쿼터 1명, 2·3쿼터 2명 동시 출전 가능).
 * 5 이상은 연장전(OT)으로 취급 — Q1/Q4와 동일하게 1명.
 * AI 로테이션은 가능한 최대 인원을 항상 채운다.
 */
export function requiredForeignCount(quarter: number): number {
  return quarter === 2 || quarter === 3 ? 2 : 1;
}

export const maxForeignOnCourt = requiredForeignCount;

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

// ============================================================
// v1: 구간(5분) 단위 로테이션 — 실제 교체처럼 "구간 동안 코트에 있는 5명"을 고정
// ============================================================

export interface RotationCandidate extends LineupPlayer {
  targetMinutes: number;   // 감독(또는 유저)이 정한 목표 출전시간
  minutesPlayed: number;   // 이번 경기에서 지금까지 뛴 시간
  energy: number;          // 0~100, 경기 중 체력
  overall: number;
}

/**
 * 다음 구간에 코트에 설 5명을 고른다.
 *  - 목표 출전시간 대비 "뒤처진 정도"(deficit)가 큰 선수부터 우선 투입 → 장기적으로 목표시간에 수렴
 *  - 체력이 떨어진 선수는 우선순위 하락 (자연스러운 교체)
 *  - 경기 첫 구간은 목표 출전시간이 가장 긴 선수들(주전)로 시작
 *  - 클로징(4쿼터 후반·연장)은 접전이면 종합능력치 상위로 마무리
 *  - 외국선수는 쿼터 규정 인원만큼, 나머지는 가드2/포워드2/센터1 구성 우선
 */
export function chooseRotationLineup(
  pool: RotationCandidate[],
  quarter: number,
  elapsedMinutes: number,
  segmentMinutes: number,
  opts: { closing?: boolean } = {}
): RotationCandidate[] {
  const isOpening = elapsedMinutes === 0;
  const projected = elapsedMinutes + segmentMinutes;
  const score = (p: RotationCandidate): number => {
    if (opts.closing) return p.overall * (0.6 + 0.4 * p.energy / 100) + (p.targetMinutes > 0 ? 5 : -50);
    if (isOpening) return p.targetMinutes + p.overall * 0.01;
    const expected = (p.targetMinutes / 40) * projected;
    const deficit = expected - p.minutesPlayed;
    const tired = p.energy < 55 ? (55 - p.energy) * 0.25 : 0;
    const jitter = Math.random() * 1.5;
    return deficit - tired + jitter + (p.targetMinutes > 0 ? 0 : -100);
  };
  const ranked = [...pool].sort((a, b) => score(b) - score(a));

  const foreignMax = maxForeignOnCourt(quarter);
  const chosen: RotationCandidate[] = [];
  const foreign = ranked.filter((p) => p.isForeign).slice(0, foreignMax);
  chosen.push(...foreign);

  const filled: Record<PositionGroup, number> = { G: 0, F: 0, C: 0 };
  chosen.forEach((p) => filled[p.positionGroup]++);
  const domestic = ranked.filter((p) => !p.isForeign);
  (["G", "C", "F"] as PositionGroup[]).forEach((group) => {
    const need = Math.max(0, TARGET_POSITION_COUNTS[group] - filled[group]);
    // 목표 출전시간을 이미 크게 넘긴 선수는 포지션 때문에 억지로 투입하지 않음 (다른 포지션으로 대체)
    const overTarget = (p: RotationCandidate) =>
      !opts.closing && !isOpening && p.minutesPlayed - (p.targetMinutes / 40) * elapsedMinutes > 1.5;
    domestic.filter((p) => p.positionGroup === group && !chosen.includes(p) && !overTarget(p)).slice(0, need).forEach((p) => {
      chosen.push(p);
      filled[group]++;
    });
  });
  // 포지션 구성으로 다 못 채우면(특정 포지션 부족) 남은 국내선수 순위대로
  for (const p of domestic) {
    if (chosen.length >= 5) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  // 그래도 부족하면(국내선수 부족) 규정 내에서 외국선수까지
  for (const p of ranked) {
    if (chosen.length >= 5) break;
    if (!chosen.includes(p) && (!p.isForeign || chosen.filter((c) => c.isForeign).length < foreignMax)) chosen.push(p);
  }
  return chosen.slice(0, 5);
}

/** 유저가 직접 지정한 5명이 규정에 맞는지 검증 (null = OK, 문자열 = 오류 메시지) */
export function validateManualLineup(lineup: LineupPlayer[], quarter: number): string | null {
  if (lineup.length !== 5) return `코트에는 정확히 5명이 있어야 합니다 (현재 ${lineup.length}명)`;
  const foreignCount = lineup.filter((p) => p.isForeign).length;
  const max = maxForeignOnCourt(quarter);
  if (foreignCount > max) {
    const label = quarter >= 5 ? "연장전" : `${quarter}쿼터`;
    return `${label}에는 외국선수가 최대 ${max}명까지만 뛸 수 있습니다 (현재 ${foreignCount}명)`;
  }
  return null;
}
