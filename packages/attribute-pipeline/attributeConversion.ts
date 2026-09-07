/**
 * KBL Manager — 스탯 → 능력치(0~99) 변환 파이프라인
 * v0.2 — 자동 도출 확정 항목만 구현 (보류/수동조정 항목 제외)
 *        finishing/midRangeShooting/threePointShooting/freeThrowShooting에
 *        정확도+볼륨 가중조합 적용, dunking 속성 신설 (finishing에서 분리)
 *
 * 파이프라인 3단계:
 *   1. 퍼센타일 정규화 (전체 리그 기준)
 *   2. 가중 조합
 *   3. 수동 조정 레이어 (본 파일에서는 다루지 않음 — 별도 오버레이 단계)
 */

// ============================================================
// 0. 기본 타입
// ============================================================

/** raw 시즌 기록 한 줄 (경기당 평균 컬럼 기준) */
export interface SeasonStatLine {
  season: string;          // 예: "2025-26"
  team: string;
  G: number;
  W: number;
  L: number;
  Min: number;              // 분 단위로 환산된 출장시간
  PTS: number;
  "2PM": number;
  "2PA": number;
  "2P%": number;
  "3PM": number;
  "3PA": number;
  "3P%": number;
  FGM: number;
  FGA: number;
  "FG%": number;
  FTM: number;
  FTA: number;
  "FT%": number;
  OREB: number;
  DREB: number;
  REB: number;
  AST: number;
  STL: number;
  BLK: number;
  GD: number;
  DK: number;
  DKA: number;
  TO: number;
  PF: number;
  PP: number;
  PPA: number;
  "PP%": number;
  plusMinus: number;
  DD2: number;
  TD3: number;
}

/** 선수 단위 입력 — 커리어 전체 시즌 목록 + 메타정보 */
export interface PlayerInput {
  playerId: string;
  name: string;
  ageAtSeasonStart: number;           // 계산 대상 시즌 개막일 기준 만 나이
  draftInfo: DraftInfo;
  nationality: string;                // "KOR"이 아니면 potential 계산에서 제외 (용병 potential 개념 자체가 안 맞음)
  seasons: SeasonStatLine[];          // 시간순 정렬 (오래된 -> 최신), 결측 시즌은 그냥 없음
  heightCm: number | null;            // strength/speed 거친 초기값 산출용
  weightKg: number | null;
}

/**
 * v0.5: 드래프트 점수 — 순위표(카테고리) 방식에서 "전체 순번(overallPick) 기반 연속함수"로 전환.
 * overallPick = (라운드-1)*10 + 라운드 내 순위 (일반적인 10개 구단 구조 기준).
 * 특수 케이스(연고선수/귀화·해외/순수언드래프트)는 kind로 구분.
 */
export type DraftInfo =
  | { kind: "picked"; overallPick: number }
  | { kind: "regional_signee" }       // 연고선수 출신 — 1순위급(100점)
  | { kind: "foreign_or_naturalized" } // 귀화/해외 출신 — potential 자체를 계산 안 함(제외)
  | { kind: "undrafted" };            // 순수 언드래프트

/** 자동 도출 가능한 15개 속성 + potential(국내선수만, 용병은 null) */
export interface DerivedAttributes {
  finishing: number;
  dunking: number;
  midRangeShooting: number;
  threePointShooting: number;
  freeThrowShooting: number;
  ballHandling: number;
  passing: number;
  steal: number;
  shotBlocking: number;
  defensiveRebounding: number;
  offensiveRebounding: number;
  stamina: number;
  injuryProneness: number;
  strength: number;   // 거친 초기값 (몸무게 기반) — 수동 조정으로 다듬을 것을 전제
  speed: number;       // 거친 초기값 (키/몸무게 기반) — 수동 조정으로 다듬을 것을 전제
  potential: number | null;  // 용병(국적 KOR 아님)은 null — potential 개념 자체가 성립 안 함
}

// ============================================================
// 1. 리그 전체 컨텍스트 (퍼센타일/리그평균 계산용)
// ============================================================

/**
 * 174명 전체 리그 시즌 데이터. 퍼센타일과 리그평균은 전부 이 배열 기준으로 계산.
 * 실제 사용시 마스터 데이터셋(전체 선수 최신시즌 기록)을 로드해서 주입.
 */
export interface LeagueContext {
  players: { playerId: string; stat: SeasonStatLine }[];
}

// ============================================================
// 2. 공통 유틸리티
// ============================================================

/** 값의 배열에서 target이 몇 %ile인지 계산 (0~100) */
function percentile(values: number[], target: number): number {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return 50; // 데이터 없으면 중립값
  const below = clean.filter((v) => v < target).length;
  const equal = clean.filter((v) => v === target).length;
  // tie 처리: 동률은 절반만 카운트 (표준적인 percentile rank 방식)
  return ((below + equal * 0.5) / clean.length) * 100;
}

function mean(values: number[]): number {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return 0;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

/** 베이지안 보정: (성공 + k*리그평균) / (시도 + k) */
function bayesianRate(success: number, attempts: number, k: number, leagueAvgRate: number): number {
  return (success + k * leagueAvgRate) / (attempts + k);
}

/** 베이지안 보정 (분당 생산량 버전): (총량 + k*리그평균분당) / (분 + k) */
function bayesianPerMinute(total: number, minutes: number, k: number, leagueAvgPerMinute: number): number {
  return (total + k * leagueAvgPerMinute) / (minutes + k);
}

/**
 * 이벤트 희소성 기반 k(분) 산출: k = targetEvents / 리그평균분당비율.
 * "표본을 신뢰하려면 기대값 targetEvents개 사건은 봐야 한다"는 기준을
 * 이벤트 발생 빈도에 맞게 자동으로 환산한다.
 * (고정 k=10/15/20을 썼을 때 STL/BLK처럼 희귀한 이벤트에서 보정이
 *  턱없이 부족해 극소표본 선수가 상위권에 오염되는 문제를 실측 검증 중 발견)
 */
function eventBasedK(leagueAvgPerMinute: number, targetEvents: number = 5): number {
  return leagueAvgPerMinute === 0 ? 100 : targetEvents / leagueAvgPerMinute;
}
function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const xMean = mean(xs);
  const yMean = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (values[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * 0~100 퍼센타일 값을 최종 게임 스케일(50~99)로 클램프/변환.
 * ⚠️ v0.6: 기존 0~99 스케일에서 50~99로 변경. 리그 최하위(0퍼센타일)도 50점을
 * 보장하니, speed처럼 극단값이 비현실적으로 낮게 나오던 문제가 스케일 자체에서
 * 자동으로 해결됨 (개별 속성마다 하한선/편차압축 같은 별도 보정이 필요 없어짐).
 */
function toAttributeScale(percentile0to100: number): number {
  const clamped = Math.max(0, Math.min(100, percentile0to100));
  return Math.round(50 + (clamped / 100) * 49);
}

// ============================================================
// 3. 리그 전체 통계 캐시 (한 번 계산해서 재사용)
// ============================================================

interface LeagueAverages {
  ppPct: number;
  midRangePct: number;
  threePct: number;
  ftPct: number;
  perMinAst: number;
  perMinStl: number;
  perMinBlk: number;
  perMinDreb: number;
  perMinOreb: number;
  perMinGD: number;
  toRatioPerUsage: number;
  astPerUsage: number;
}

function computeLeagueAverages(ctx: LeagueContext): LeagueAverages {
  const stats = ctx.players.map((p) => p.stat);

  // ⚠️ 경기당평균 × G(경기수) = 시즌 총량으로 환산 후 합산 (경기수 가중치 반영)
  // rawFinishingMetrics 등에서 사용하는 bayesianRate와 동일한 단위(시즌 총량) 기준으로
  // 리그평균을 계산해야 보정 기준선이 일치한다.
  const ppSuccessTotal = stats.reduce((a, s) => a + seasonTotal(s.PP, s.G), 0);
  const ppAttemptTotal = stats.reduce((a, s) => a + seasonTotal(s.PPA, s.G), 0);

  const midSuccessTotal = stats.reduce((a, s) => a + seasonTotal(s["2PM"] - s.PP, s.G), 0);
  const midAttemptTotal = stats.reduce((a, s) => a + seasonTotal(s["2PA"] - s.PPA, s.G), 0);

  const threeSuccessTotal = stats.reduce((a, s) => a + seasonTotal(s["3PM"], s.G), 0);
  const threeAttemptTotal = stats.reduce((a, s) => a + seasonTotal(s["3PA"], s.G), 0);

  const ftSuccessTotal = stats.reduce((a, s) => a + seasonTotal(s.FTM, s.G), 0);
  const ftAttemptTotal = stats.reduce((a, s) => a + seasonTotal(s.FTA, s.G), 0);

  // ⚠️ 분당 지표도 경기수(G) 가중 시즌총량 기준으로 계산 (rawStealMetric 등과 단위 일치)
  const astTotal = stats.reduce((a, s) => a + seasonTotal(s.AST, s.G), 0);
  const stlTotal = stats.reduce((a, s) => a + seasonTotal(s.STL, s.G), 0);
  const blkTotal = stats.reduce((a, s) => a + seasonTotal(s.BLK, s.G), 0);
  const drebTotal = stats.reduce((a, s) => a + seasonTotal(s.DREB, s.G), 0);
  const orebTotal = stats.reduce((a, s) => a + seasonTotal(s.OREB, s.G), 0);
  const gdTotal = stats.reduce((a, s) => a + seasonTotal(s.GD, s.G), 0);
  const minTotal = stats.reduce((a, s) => a + seasonTotal(s.Min, s.G), 0);

  // ballHandling용: usage(볼관여도) 기준 리그평균
  const usageTotal = stats.reduce((a, s) => a + seasonTotal(s.FGA + 0.44 * s.FTA + s.TO, s.G), 0);
  const toTotalForUsage = stats.reduce((a, s) => a + seasonTotal(s.TO, s.G), 0);
  const astTotalForUsage = stats.reduce((a, s) => a + seasonTotal(s.AST, s.G), 0);

  return {
    ppPct: ppAttemptTotal === 0 ? 0 : ppSuccessTotal / ppAttemptTotal,
    midRangePct: midAttemptTotal === 0 ? 0 : midSuccessTotal / midAttemptTotal,
    threePct: threeAttemptTotal === 0 ? 0 : threeSuccessTotal / threeAttemptTotal,
    ftPct: ftAttemptTotal === 0 ? 0 : ftSuccessTotal / ftAttemptTotal,
    perMinAst: minTotal === 0 ? 0 : astTotal / minTotal,
    perMinStl: minTotal === 0 ? 0 : stlTotal / minTotal,
    perMinBlk: minTotal === 0 ? 0 : blkTotal / minTotal,
    perMinDreb: minTotal === 0 ? 0 : drebTotal / minTotal,
    perMinOreb: minTotal === 0 ? 0 : orebTotal / minTotal,
    perMinGD: minTotal === 0 ? 0 : gdTotal / minTotal,
    toRatioPerUsage: usageTotal === 0 ? 0 : toTotalForUsage / usageTotal,
    astPerUsage: usageTotal === 0 ? 0 : astTotalForUsage / usageTotal,
  };
}

// ============================================================
// 4. 속성별 "원시 지표(raw metric)" 계산 — 퍼센타일 내기 전 단계
//    리그 전체 선수에 대해 이 값들을 미리 계산해두고 percentile()에 배열로 넘김
// ============================================================

/**
 * ⚠️ 데이터 단위 주의: SeasonStatLine의 PP/PPA/2PM/2PA/3PM/3PA/FTM/FTA 등은
 * 전부 "경기당 평균"(per-game average)이다. 베이지안 보정의 k값은 애초에
 * "시즌 전체 시도 횟수" 기준으로 설계됐으므로(예: "시즌 3~5개 시도"),
 * 보정 전에 반드시 경기당평균 × G(경기수) = 시즌 총량으로 환산해야 한다.
 * 이 환산 없이 k를 그대로 적용하면 고volume 선수까지 표본부족으로 오판되어
 * 리그평균 쪽으로 과도하게 쏠리는 버그가 생긴다 (실측 검증 중 발견).
 */
function seasonTotal(perGameAvg: number, games: number): number {
  return perGameAvg * games;
}

function rawFinishingMetrics(stat: SeasonStatLine) {
  // v0.3: finishing = 볼륨(경기당PPA) 단독. 정확도(PP%)는 제거.
  // (실측 검증 결과 KBL 데이터상 고볼륨 선수의 PP%가 극단적으로 낮은 케이스가 없어
  //  정확도를 빼도 왜곡 위험이 낮다고 판단)
  return { perGamePPA: stat.PPA };
}

/** dunking: 덩크 시도 횟수(DKA) 기준 — finishing과 분리된 별도 속성 */
function rawDunkingMetric(stat: SeasonStatLine) {
  return seasonTotal(stat.DKA, stat.G);
}

function rawMidRangeMetrics(stat: SeasonStatLine, avg: LeagueAverages) {
  const midMadePerGame = stat["2PM"] - stat.PP;
  const midAttPerGame = stat["2PA"] - stat.PPA;
  const midSeasonMade = seasonTotal(midMadePerGame, stat.G);
  const midSeasonAtt = seasonTotal(midAttPerGame, stat.G);
  const correctedMid = bayesianRate(midSeasonMade, midSeasonAtt, 20, avg.midRangePct);
  const perGameMidAtt = midAttPerGame; // 볼륨 지표
  return { correctedMid, perGameMidAtt };
}

function rawThreePointMetrics(stat: SeasonStatLine, avg: LeagueAverages) {
  const threeSeasonMade = seasonTotal(stat["3PM"], stat.G);
  const threeSeasonAtt = seasonTotal(stat["3PA"], stat.G);
  const corrected3P = bayesianRate(threeSeasonMade, threeSeasonAtt, 20, avg.threePct);
  const per3PA = stat["3PA"]; // 이미 경기당 평균이므로 그대로 사용
  return { corrected3P, per3PA };
}

function rawFreeThrowMetrics(stat: SeasonStatLine, avg: LeagueAverages) {
  const ftSeasonMade = seasonTotal(stat.FTM, stat.G);
  const ftSeasonAtt = seasonTotal(stat.FTA, stat.G);
  const correctedFT = bayesianRate(ftSeasonMade, ftSeasonAtt, 15, avg.ftPct);
  const perGameFTA = stat.FTA; // 볼륨 지표
  return { correctedFT, perGameFTA };
}

/**
 * v0.4: ballHandling 재설계.
 * 기존 방식(AST/TO 직접 나누기)은 ①베이지안 보정이 전혀 없어 극소표본(1경기 등)
 * 선수가 상위권을 오염시키고, ②TO=0일 때 astToRatio=AST로 임의 대체하여 값이
 * 튀는 문제가 있었다(실측 검증 중 발견). usage(볼관여도)를 표본크기로 삼아
 * 두 지표 모두 베이지안 보정하는 방식으로 교체 — TO=0 분모 문제도 자동 해결.
 */
function rawBallHandlingMetrics(stat: SeasonStatLine, avg: LeagueAverages) {
  const usagePerGame = stat.FGA + 0.44 * stat.FTA + stat.TO;
  const usageSeasonTotal = seasonTotal(usagePerGame, stat.G);
  const toSeasonTotal = seasonTotal(stat.TO, stat.G);
  const astSeasonTotal = seasonTotal(stat.AST, stat.G);

  const kTo = eventBasedK(avg.toRatioPerUsage);
  const kAst = eventBasedK(avg.astPerUsage);

  const correctedToRatio = bayesianRate(toSeasonTotal, usageSeasonTotal, kTo, avg.toRatioPerUsage);
  const correctedAstPerUsage = bayesianRate(astSeasonTotal, usageSeasonTotal, kAst, avg.astPerUsage);

  return { correctedToRatio, correctedAstPerUsage };
}

/**
 * ⚠️ Min(출장시간)도 PP/PPA와 마찬가지로 "경기당 평균"이다.
 * 경기수(G)를 곱해 시즌 총 출장분으로 환산하지 않으면, 1경기만 뛴 선수와
 * 50경기를 뛴 선수가 "분당 생산량" 계산에서 동일한 표본 크기로 취급되어
 * 극소표본(가비지타임 1경기 등)이 보정을 거의 안 받고 상위권에 올라오는
 * 버그가 생긴다 (실측 검증 중 발견 — steal/shotBlocking 상위권 오염).
 */
/**
 * ⚠️ 최소 표본 기준: 시즌 총 출장분(Min×G)이 5분 미만이면 null 반환 (호출부에서 중립값 50 처리).
 * 리바운드/블록 등은 소수의 빅맨이 끌어올리는 오른쪽 치우침 분포라, 산술평균(리그평균)
 * 자체가 이미 중위값보다 높은 위치에 있다. 그래서 극소표본 선수가 베이지안 보정으로
 * "평균"에 수렴해도 실제로는 50퍼센타일이 아니라 60~80퍼센타일로 밀려 올라가는 왜곡이
 * 생긴다 (실측 검증 중 발견 — BLK=0/DREB=0인데 60점대로 나오는 선수들 확인됨).
 * 판단 근거 자체가 없는 극소표본은 계산을 아예 건너뛰고 중립값으로 처리하는 게 안전하다.
 */
const MIN_SEASON_MINUTES_THRESHOLD = 5;

function rawPassingMetric(stat: SeasonStatLine, avg: LeagueAverages): number | null {
  const astSeasonTotal = seasonTotal(stat.AST, stat.G);
  const minSeasonTotal = seasonTotal(stat.Min, stat.G);
  if (minSeasonTotal < MIN_SEASON_MINUTES_THRESHOLD) return null;
  const k = eventBasedK(avg.perMinAst);
  return bayesianPerMinute(astSeasonTotal, minSeasonTotal, k, avg.perMinAst);
}

function rawStealMetric(stat: SeasonStatLine, avg: LeagueAverages): number | null {
  const stlSeasonTotal = seasonTotal(stat.STL, stat.G);
  const minSeasonTotal = seasonTotal(stat.Min, stat.G);
  if (minSeasonTotal < MIN_SEASON_MINUTES_THRESHOLD) return null;
  const k = eventBasedK(avg.perMinStl);
  return bayesianPerMinute(stlSeasonTotal, minSeasonTotal, k, avg.perMinStl);
}

function rawBlockMetric(stat: SeasonStatLine, avg: LeagueAverages): number | null {
  const blkSeasonTotal = seasonTotal(stat.BLK, stat.G);
  const minSeasonTotal = seasonTotal(stat.Min, stat.G);
  if (minSeasonTotal < MIN_SEASON_MINUTES_THRESHOLD) return null;
  const k = eventBasedK(avg.perMinBlk);
  return bayesianPerMinute(blkSeasonTotal, minSeasonTotal, k, avg.perMinBlk);
}

function rawDrebMetric(stat: SeasonStatLine, avg: LeagueAverages): number | null {
  const drebSeasonTotal = seasonTotal(stat.DREB, stat.G);
  const minSeasonTotal = seasonTotal(stat.Min, stat.G);
  if (minSeasonTotal < MIN_SEASON_MINUTES_THRESHOLD) return null;
  const k = eventBasedK(avg.perMinDreb);
  return bayesianPerMinute(drebSeasonTotal, minSeasonTotal, k, avg.perMinDreb);
}

/** offensiveRebounding: defensiveRebounding과 완전히 동일한 방식 */
function rawOrebMetric(stat: SeasonStatLine, avg: LeagueAverages): number | null {
  const orebSeasonTotal = seasonTotal(stat.OREB, stat.G);
  const minSeasonTotal = seasonTotal(stat.Min, stat.G);
  if (minSeasonTotal < MIN_SEASON_MINUTES_THRESHOLD) return null;
  const k = eventBasedK(avg.perMinOreb);
  return bayesianPerMinute(orebSeasonTotal, minSeasonTotal, k, avg.perMinOreb);
}

/**
 * GD(굿디펜스) — 4개 수비속성(steal/shotBlocking/defensiveRebounding/offensiveRebounding)에
 * 공통 보너스(0.15 가중)로 얹기 위한 지표. 독립 속성으로 만들지 않고 보정 레이어로만 사용.
 */
function rawGDMetric(stat: SeasonStatLine, avg: LeagueAverages): number | null {
  const gdSeasonTotal = seasonTotal(stat.GD, stat.G);
  const minSeasonTotal = seasonTotal(stat.Min, stat.G);
  if (minSeasonTotal < MIN_SEASON_MINUTES_THRESHOLD) return null;
  const k = eventBasedK(avg.perMinGD);
  return bayesianPerMinute(gdSeasonTotal, minSeasonTotal, k, avg.perMinGD);
}

// ============================================================
// 5. potential 하위 계산
// ============================================================

function ageScore(age: number): number {
  if (age <= 23) return 100;
  if (age < 30) return 100 * Math.exp(-0.08 * (age - 23));
  const at29 = 100 * Math.exp(-0.08 * (29 - 23)); // ≈ 61.9
  return at29 * Math.exp(-0.15 * (age - 29));
}

/**
 * v0.5: 전체 순번(overallPick) 기반 연속 감쇠 함수.
 * 구간별 감쇠율을 다르게 줘서 "1~4순위 최상위 그룹 / 5~10순위 완만한 하락 /
 * 11~20순위(2R) 한 단계 꺾임 / 21~40순위(3~4R) 가파른 하락"을 표현한다.
 * (사용자와 여러 차례 조정을 거쳐 확정된 곡선 — 아래 각 구간 경계값은 하드코딩된 상수가 아니라
 *  이전 구간의 끝값을 그대로 이어받아 계산하므로 구간 경계에서 값이 끊기지 않는다.)
 */
function pickScore(overallPick: number): number {
  if (overallPick <= 1) return 100;
  if (overallPick <= 4) {
    return 100 * Math.exp(-0.025 * (overallPick - 1));
  }
  const score4 = 100 * Math.exp(-0.025 * 3); // 4순위 값 ≈ 92.77
  if (overallPick <= 10) {
    return score4 * Math.exp(-0.04 * (overallPick - 4));
  }
  const score10 = score4 * Math.exp(-0.04 * 6); // 10순위 값 ≈ 73.0
  if (overallPick <= 20) {
    return score10 * 0.9 * Math.exp(-0.035 * (overallPick - 10));
  }
  const score20 = score10 * 0.9 * Math.exp(-0.035 * 10); // 20순위 값 ≈ 47.4
  // 21순위 이상은 이 감쇠율을 계속 적용 (3~4라운드, 하한 없음 — 자연히 매우 낮아짐)
  return score20 * Math.exp(-0.09 * (overallPick - 20));
}

function draftScore(info: DraftInfo): number {
  switch (info.kind) {
    case "picked":
      return pickScore(info.overallPick);
    case "regional_signee":
      return 100;
    case "foreign_or_naturalized":
      return 50; // 실제로는 potential 자체를 계산 안 하므로 이 값은 쓰이지 않음
    case "undrafted":
      return 15;
  }
}

/** stamina: 경기당 출장시간(Min) 퍼센타일 단독 (거친 근사치) */
function rawStaminaMetric(stat: SeasonStatLine): number {
  return stat.Min;
}

/**
 * strength/speed: 키/몸무게 기반 거친 초기값.
 * ⚠️ 실제 근력/스피드 측정치가 아닌 체격 기반 추정 — 수동 조정으로 다듬는 것을 전제로 함.
 * 키·몸무게 데이터 없는 선수는 null 반환 (호출부에서 중립값 50 처리).
 */
function rawStrengthMetric(weightKg: number | null): number | null {
  return weightKg;
}

function rawSpeedRawInputs(heightCm: number | null, weightKg: number | null): { height: number; weight: number } | null {
  if (heightCm === null || weightKg === null) return null;
  return { height: heightCm, weight: weightKg };
}

/**
 * injuryProneness: 최근 3개 유효시즌의 "출장률(그 시즌 실제 뛴 G / 그 시즌 리그 최대 G)" 평균.
 * 리그 최대 G를 "정상 시즌 소화 경기수"의 근사 기준선으로 사용.
 * ⚠️ 한계: 결장 사유가 부상인지 방출/이적/코칭스태프 판단인지 구분 불가 — 근사치로만 사용.
 * ⚠️ 보유 시즌이 1~2개뿐인 선수(주로 신인)는 "부상으로 결장"과 "아직 기회를 못 받음"을
 *    구분할 수 없어 null(중립값 50 처리) 반환 — 최소 3시즌 이상 누적된 선수만 판단
 *    (실측 검증 중 1경기만 뛴 신인이 최상위 injuryProneness로 오분류되는 문제 발견).
 */
function rawInjuryPronenessMetric(
  seasons: SeasonStatLine[],
  seasonMaxG: Map<string, number>
): number | null {
  if (seasons.length < 3) return null;
  const recent = seasons.slice(-3);
  const rates = recent
    .map((s) => {
      const maxG = seasonMaxG.get(s.season);
      if (!maxG || maxG === 0) return null;
      return s.G / maxG;
    })
    .filter((v): v is number => v !== null);
  if (rates.length === 0) return null;
  return mean(rates);
}

/** 종합효율 = PTS+REB+AST+STL+BLK-TO */
function compositeEfficiency(stat: SeasonStatLine): number {
  return stat.PTS + stat.REB + stat.AST + stat.STL + stat.BLK - stat.TO;
}

/**
 * 추세 원시값(raw trend metric) 계산.
 * 결측(공백) 시즌은 seasons 배열에 애초에 없다는 전제 — 있는 시즌만 시간순으로 옴.
 * 반환값 종류가 다르므로 { kind, value } 형태로 리턴, 퍼센타일 배열도 kind별로 따로 관리해야 함.
 */
type TrendRawResult =
  | { kind: "slope"; value: number }
  | { kind: "diff"; value: number }
  | { kind: "level"; value: number }
  | { kind: "neutral" };

function rawTrendMetric(seasons: SeasonStatLine[]): TrendRawResult {
  const recent = seasons.slice(-3); // 최신 3개 유효시즌
  if (recent.length >= 3) {
    const effs = recent.map(compositeEfficiency);
    return { kind: "slope", value: linearRegressionSlope(effs) };
  }
  if (recent.length === 2) {
    const [prev, latest] = recent.map(compositeEfficiency);
    return { kind: "diff", value: latest - prev };
  }
  if (recent.length === 1) {
    // 신인 등 1시즌뿐인 선수: 그 시즌 종합효율 자체를 "1시즌 선수 집단" 내에서 비교
    return { kind: "level", value: compositeEfficiency(recent[0]) };
  }
  return { kind: "neutral" };
}

// ============================================================
// 6. 메인 파이프라인
//    ⚠️ 리그 전체 174명에 대해 이 함수를 한 번에 돌려서
//       raw metric 배열들을 먼저 구축한 뒤, 그 배열로 각 선수의 percentile을 매겨야 함.
//       아래 computeLeagueDerivedAttributes()가 그 전체 과정을 담당.
// ============================================================

export function computeLeagueDerivedAttributes(
  players: PlayerInput[]
): Map<string, DerivedAttributes> {
  const leagueCtx: LeagueContext = {
    players: players
      .filter((p) => p.seasons.length > 0)
      .map((p) => ({ playerId: p.playerId, stat: p.seasons[p.seasons.length - 1] })),
  };
  const avg = computeLeagueAverages(leagueCtx);

  // 시즌별 리그 최대 G ("정상 소화 경기수" 근사 기준선) — injuryProneness용
  const seasonMaxG = new Map<string, number>();
  players.forEach((p) => {
    p.seasons.forEach((s) => {
      const cur = seasonMaxG.get(s.season) ?? 0;
      if (s.G > cur) seasonMaxG.set(s.season, s.G);
    });
  });

  // --- 최신 시즌 기준 raw metric을 리그 전체에 대해 미리 계산 ---
  const latestStatByPlayer = new Map<string, SeasonStatLine>();
  players.forEach((p) => {
    if (p.seasons.length > 0) latestStatByPlayer.set(p.playerId, p.seasons[p.seasons.length - 1]);
  });

  const finishingRaw = new Map<string, { perGamePPA: number }>();
  const dunkingRaw = new Map<string, number>();
  const midRangeRaw = new Map<string, { correctedMid: number; perGameMidAtt: number }>();
  const threeRaw = new Map<string, { corrected3P: number; per3PA: number }>();
  const ftRaw = new Map<string, { correctedFT: number; perGameFTA: number }>();
  const bhRaw = new Map<string, { correctedToRatio: number; correctedAstPerUsage: number }>();
  const passingRaw = new Map<string, number | null>();
  const stealRaw = new Map<string, number | null>();
  const blockRaw = new Map<string, number | null>();
  const drebRaw = new Map<string, number | null>();
  const orebRaw = new Map<string, number | null>();
  const gdRaw = new Map<string, number | null>();
  const trendRaw = new Map<string, TrendRawResult>();
  const staminaRaw = new Map<string, number>();
  const injuryRaw = new Map<string, number | null>();
  const strengthRaw = new Map<string, number | null>();
  const speedRaw = new Map<string, { height: number; weight: number } | null>();

  players.forEach((p) => {
    const stat = latestStatByPlayer.get(p.playerId);
    if (!stat) return;
    finishingRaw.set(p.playerId, rawFinishingMetrics(stat));
    dunkingRaw.set(p.playerId, rawDunkingMetric(stat));
    midRangeRaw.set(p.playerId, rawMidRangeMetrics(stat, avg));
    threeRaw.set(p.playerId, rawThreePointMetrics(stat, avg));
    ftRaw.set(p.playerId, rawFreeThrowMetrics(stat, avg));
    bhRaw.set(p.playerId, rawBallHandlingMetrics(stat, avg));
    passingRaw.set(p.playerId, rawPassingMetric(stat, avg));
    stealRaw.set(p.playerId, rawStealMetric(stat, avg));
    blockRaw.set(p.playerId, rawBlockMetric(stat, avg));
    drebRaw.set(p.playerId, rawDrebMetric(stat, avg));
    orebRaw.set(p.playerId, rawOrebMetric(stat, avg));
    gdRaw.set(p.playerId, rawGDMetric(stat, avg));
    trendRaw.set(p.playerId, rawTrendMetric(p.seasons));
    staminaRaw.set(p.playerId, rawStaminaMetric(stat));
    injuryRaw.set(p.playerId, rawInjuryPronenessMetric(p.seasons, seasonMaxG));
    strengthRaw.set(p.playerId, rawStrengthMetric(p.weightKg));
    speedRaw.set(p.playerId, rawSpeedRawInputs(p.heightCm, p.weightKg));
  });

  // 퍼센타일 계산용 전체 값 배열
  const arr = <T,>(map: Map<string, T>, pick: (v: T) => number) =>
    Array.from(map.values()).map(pick);

  const perGamePPAArr = arr(finishingRaw, (v) => v.perGamePPA);
  const dunkingArr = Array.from(dunkingRaw.values());
  const correctedMidArr = arr(midRangeRaw, (v) => v.correctedMid);
  const perGameMidAttArr = arr(midRangeRaw, (v) => v.perGameMidAtt);
  const corrected3PArr = arr(threeRaw, (v) => v.corrected3P);
  const per3PAArr = arr(threeRaw, (v) => v.per3PA);
  const correctedFTArr = arr(ftRaw, (v) => v.correctedFT);
  const perGameFTAArr = arr(ftRaw, (v) => v.perGameFTA);
  const toRatioArr = arr(bhRaw, (v) => v.correctedToRatio);
  const astPerUsageArr = arr(bhRaw, (v) => v.correctedAstPerUsage);
  const passingArr = Array.from(passingRaw.values()).filter((v): v is number => v !== null);
  const stealArr = Array.from(stealRaw.values()).filter((v): v is number => v !== null);
  const blockArr = Array.from(blockRaw.values()).filter((v): v is number => v !== null);
  const drebArr = Array.from(drebRaw.values()).filter((v): v is number => v !== null);
  const orebArr = Array.from(orebRaw.values()).filter((v): v is number => v !== null);
  const gdArr = Array.from(gdRaw.values()).filter((v): v is number => v !== null);

  const slopeArr = Array.from(trendRaw.values())
    .filter((v): v is { kind: "slope"; value: number } => v.kind === "slope")
    .map((v) => v.value);
  const diffArr = Array.from(trendRaw.values())
    .filter((v): v is { kind: "diff"; value: number } => v.kind === "diff")
    .map((v) => v.value);
  const levelArr = Array.from(trendRaw.values())
    .filter((v): v is { kind: "level"; value: number } => v.kind === "level")
    .map((v) => v.value);

  const staminaArr = Array.from(staminaRaw.values());
  const injuryRateArr = Array.from(injuryRaw.values()).filter(
    (v): v is number => v !== null
  );
  const weightArr = Array.from(strengthRaw.values()).filter(
    (v): v is number => v !== null
  );
  const heightArr = Array.from(speedRaw.values())
    .filter((v): v is { height: number; weight: number } => v !== null)
    .map((v) => v.height);
  const speedWeightArr = Array.from(speedRaw.values())
    .filter((v): v is { height: number; weight: number } => v !== null)
    .map((v) => v.weight);

  const result = new Map<string, DerivedAttributes>();

  players.forEach((p) => {
    const fin = finishingRaw.get(p.playerId);
    const dunk = dunkingRaw.get(p.playerId);
    const mid = midRangeRaw.get(p.playerId);
    const three = threeRaw.get(p.playerId);
    const ft = ftRaw.get(p.playerId);
    const bh = bhRaw.get(p.playerId);
    const pass = passingRaw.get(p.playerId);
    const stl = stealRaw.get(p.playerId);
    const blk = blockRaw.get(p.playerId);
    const dreb = drebRaw.get(p.playerId);
    const oreb = orebRaw.get(p.playerId);
    const gd = gdRaw.get(p.playerId);
    const trend = trendRaw.get(p.playerId);

    if (!fin || dunk === undefined || !mid || !three || !ft || !bh ||
        pass === undefined || stl === undefined || blk === undefined || dreb === undefined ||
        oreb === undefined || gd === undefined) {
      return; // 최신 시즌 데이터 없는 선수 (은퇴 등) 스킵
    }

    // finishing: 볼륨(경기당PPA) 단독 — 정확도 제거, dunking은 별도 속성
    const finishing = toAttributeScale(percentile(perGamePPAArr, fin.perGamePPA));

    // dunking: 시즌환산 덩크 시도 횟수(DKA) 단독
    const dunking = toAttributeScale(percentile(dunkingArr, dunk));

    // midRangeShooting: 정확도 0.7 + 볼륨 0.3
    const midRangeShooting = toAttributeScale(
      percentile(correctedMidArr, mid.correctedMid) * 0.7 +
      percentile(perGameMidAttArr, mid.perGameMidAtt) * 0.3
    );

    const threePointShooting = toAttributeScale(
      percentile(corrected3PArr, three.corrected3P) * 0.7 +
      percentile(per3PAArr, three.per3PA) * 0.3
    );

    // freeThrowShooting: 정확도 0.85 + 볼륨 0.15
    const freeThrowShooting = toAttributeScale(
      percentile(correctedFTArr, ft.correctedFT) * 0.85 +
      percentile(perGameFTAArr, ft.perGameFTA) * 0.15
    );

    const ballHandling = toAttributeScale(
      (100 - percentile(toRatioArr, bh.correctedToRatio)) * 0.4 +
      percentile(astPerUsageArr, bh.correctedAstPerUsage) * 0.6
    );

    // ⚠️ 최소표본 미달(출장시간 5분 미만)인 선수는 "정보가 없어서 평균"이 아니라
    // "코치가 안 믿고 거의 안 써서 표본이 없는 것" — 즉 이미 그 자체가 못한다는 신호임.
    // 그래서 중립값(50퍼센타일)이 아니라 최하위권(5퍼센타일)을 기본값으로 사용.
    // (지적으로 발견 — 거의 안 뛴 후보선수를 "평균"으로 처리하는 게 논리적으로 안 맞음)
    const LOW_SAMPLE_DEFAULT_PERCENTILE = 5;

    const passing = toAttributeScale(pass === null ? LOW_SAMPLE_DEFAULT_PERCENTILE : percentile(passingArr, pass));

    // GD(굿디펜스) 보너스: steal에만 적용.
    // shotBlocking/defensiveRebounding은 빅맨 편향 속성인데 GD는 가드 편향 스탯이라
    // 함께 블렌딩하면 원래 잘하던 빅맨 점수가 오히려 깎이는 역효과가 있어 제외 (실측 검증 중 발견)
    const stealPct = stl === null ? LOW_SAMPLE_DEFAULT_PERCENTILE : percentile(stealArr, stl);
    const gdPct = gd === null ? LOW_SAMPLE_DEFAULT_PERCENTILE : percentile(gdArr, gd);
    const steal = toAttributeScale(stealPct * 0.85 + gdPct * 0.15);
    const shotBlocking = toAttributeScale(blk === null ? LOW_SAMPLE_DEFAULT_PERCENTILE : percentile(blockArr, blk));
    const defensiveRebounding = toAttributeScale(dreb === null ? LOW_SAMPLE_DEFAULT_PERCENTILE : percentile(drebArr, dreb));
    const offensiveRebounding = toAttributeScale(oreb === null ? LOW_SAMPLE_DEFAULT_PERCENTILE : percentile(orebArr, oreb));

    // stamina: 경기당 출장시간(Min) 퍼센타일 단독 (거친 근사치)
    const staminaRawVal = staminaRaw.get(p.playerId)!;
    const stamina = toAttributeScale(percentile(staminaArr, staminaRawVal));

    // injuryProneness: 최근 3시즌 평균 출장률이 낮을수록 높음 (역순), 데이터 없으면 중립값 50
    const injuryRawVal = injuryRaw.get(p.playerId);
    const injuryProneness = toAttributeScale(
      injuryRawVal === null || injuryRawVal === undefined
        ? 50
        : 100 - percentile(injuryRateArr, injuryRawVal)
    );

    // strength: 몸무게 퍼센타일 단독 (거친 초기값). 데이터 없으면 중립값 50.
    const strengthRawVal = strengthRaw.get(p.playerId) ?? null;
    const strength = toAttributeScale(
      strengthRawVal === null ? 50 : percentile(weightArr, strengthRawVal)
    );

    // speed: 100 - (키퍼센타일×0.5 + 몸무게퍼센타일×0.5) — 크고 무거울수록 느리다는 거친 전제.
    // 전역 스케일이 이제 50~99라서, 극단적으로 크고 무거운 선수도 자동으로 50 밑으로
    // 안 내려감 — 이전엔 이 문제를 speed 공식 자체에서 편차압축/하한선으로 따로
    // 처리했었는데, 전역 스케일 변경으로 그 보정이 불필요해져서 원래의 단순한 공식으로 복원.
    // 데이터 없으면 중립값(퍼센타일 50 -> 스케일변환후 약 75점).
    const speedRawVal = speedRaw.get(p.playerId) ?? null;
    const speed = toAttributeScale(
      speedRawVal === null
        ? 50
        : 100 - (percentile(heightArr, speedRawVal.height) * 0.5 +
                 percentile(speedWeightArr, speedRawVal.weight) * 0.5)
    );

    // potential — 용병(국적 KOR 아님)은 개념 자체가 안 맞아 null 처리
    let potential: number | null;
    if (p.nationality !== "KOR") {
      potential = null;
    } else {
      const age = ageScore(p.ageAtSeasonStart);
      const draft = draftScore(p.draftInfo);
      let trendScore = 50;
      if (trend) {
        if (trend.kind === "slope") trendScore = percentile(slopeArr, trend.value);
        else if (trend.kind === "diff") trendScore = percentile(diffArr, trend.value);
        else if (trend.kind === "level") trendScore = percentile(levelArr, trend.value);
        else trendScore = 50;
      }
      potential = toAttributeScale(age * 0.45 + draft * 0.25 + trendScore * 0.30);
    }

    result.set(p.playerId, {
      finishing,
      dunking,
      midRangeShooting,
      threePointShooting,
      freeThrowShooting,
      ballHandling,
      passing,
      steal,
      shotBlocking,
      defensiveRebounding,
      offensiveRebounding,
      stamina,
      injuryProneness,
      strength,
      speed,
      potential,
    });
  });

  return result;
}
