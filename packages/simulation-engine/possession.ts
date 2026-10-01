/**
 * KBL Manager — 포제션 시뮬레이션 (v1)
 *
 * 지금까지 확정한 규칙을 하나의 함수로 조립:
 *  - 공격 시작: 가드 중 ballHandling 가중 추첨
 *  - 슛/패스 결정: usage×0.3 + PTS×0.7 (둘 다 리그 퍼센타일)
 *  - 패스 대상: 팀원별 usage 퍼센타일 가중 추첨
 *  - 포지션 매치업 + 스위치(0.7 페널티)
 *  - 턴오버/파울/리바운드
 *
 * v1 추가:
 *  - 팀 단위 전술 컨텍스트(TeamContext): 수비 전술(맨투맨/지역방어/압박), 더블팀 대상, 리바운드 강조,
 *    3점 의존도. 유저 팀과 AI 감독 모두 같은 컨텍스트로 전술을 표현한다.
 *  - 스틸(STEAL) 이벤트, 야투/3점/자유투 성공·시도 이벤트(박스스코어 FG/3P/FT 집계용)
 *  - ⚠️ 슈팅파울 후 슛이 실패해도 자유투가 없던 버그 수정 (실패 시 2~3구, 성공 시 앤드원 1구)
 *
 * ⚠️ 아직 사용자와 명시적으로 확정 안 한 가정 (v0 임시, 추후 조정 가능):
 *  - "슛 종류(페인트/미드/3점) 선택"은 선수의 세 지표(finishing 볼륨, midRangeShooting,
 *    threePointShooting) 퍼센타일 비례 가중치로 정함 — 실제로는 상황(공간, 수비 배치)에
 *    따라 달라져야 하지만 v0에서는 "이 선수가 상대적으로 어떤 거리에 강한가"로 근사.
 */

import { LineupPlayer } from "./lineup";

// ============================================================
// 타입
// ============================================================

/** 표시용 능력치(50~99) — attribute-pipeline의 DerivedAttributes와 동일 필드만 사용 */
export interface DisplayAttrs {
  finishing: number;           // 볼륨 단독
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
  strength: number;
  stamina: number;
}

/** 시뮬레이션 전용 내부값 — 화면에 노출 안 함. 전부 실제 확률(0~1) */
export interface SimulationInternals {
  paintAccuracy: number;
  midAccuracy: number;
  threeAccuracy: number;
  ftAccuracy: number;
  usagePercentile: number;     // 0~100, 리그 내 usage(FGA+0.44FTA+TO, 경기당) 퍼센타일
  ptsPercentile: number;       // 0~100, 리그 내 PTS(경기당) 퍼센타일
}

/**
 * 선수 단위 전술 오버라이드 (전부 optional — 없으면 기존 엔진 기본 동작).
 */
export interface TacticsOverride {
  shotProbExponent?: number;      // 기본 9. (v1부터 템포는 포제션 수로 표현하므로 사용 안 함, 호환용)
  threeWeightMultiplier?: number; // 기본 1.0. 3점 슛종류 선택 가중치 배수
  isDefensiveStopper?: boolean;   // 상대 최고usage 선수를 포지션 무관 전담마크
  isClutchCloser?: boolean;       // 4쿼터에 usage/득점력 부스트 (gameSimulator에서 적용)
}

export type DefenseScheme = "man" | "zone" | "press";

/** 팀 단위 전술 컨텍스트 (한 포제션 동안 공격팀/수비팀 각각 하나씩) */
export interface TeamContext {
  defenseScheme: DefenseScheme;
  doubleTeamTarget?: string | null;  // 상대 선수 이름 — 이 선수가 공을 잡으면 더블팀
  reboundEmphasis?: boolean;
  threeWeightMultiplier?: number;    // 팀 전체 3점 의존도 (선수 개별값과 곱해짐)
}

export const DEFAULT_TEAM_CONTEXT: TeamContext = { defenseScheme: "man" };

export interface SimPlayer extends LineupPlayer {
  attrs: DisplayAttrs;
  internals: SimulationInternals;
  tactics?: TacticsOverride;
  overall?: number;   // 라인업 선택(클로징 라인업 등)에 쓰는 종합 능력치
  playerId?: number;
}

export type ShotType = "paint" | "mid" | "three";

export interface PossessionEvent {
  type: "PASS" | "SHOT" | "FT" | "TURNOVER" | "STEAL" | "FOUL" | "BLOCK" | "REBOUND_OFF" | "REBOUND_DEF";
  actor: string;
  detail?: string;
  shotType?: ShotType;
  made?: boolean;
  points?: number;
  assister?: string;
  putback?: boolean;
}

export interface PossessionResult {
  points: number;
  turnover: boolean;
  events: PossessionEvent[];
}

// ============================================================
// 상수 (실제 리그 평균으로 추후 캘리브레이션 예정)
// ============================================================

const BASE_TURNOVER_PASS = 0.02;
const BASE_TURNOVER_DRIVE = 0.12;
const BASE_FOUL_DRIVE = 0.10;
const BASE_SHOT_FOUL = { paint: 0.14, mid: 0.07, three: 0.035 };
const SWITCH_PENALTY = 0.7;
const MAX_CHAIN_LENGTH = 6;
const FIRST_TOUCH_SHOT_MULT = 0.6;
// 슛 결정 곡선: (usage×0.3 + PTS×0.7)^지수, 상한 — 2025-26 실제 개인 득점과의 평균오차가
// 최소가 되도록 보정 (지수 9/상한 0.45였을 때 1옵션 선수 득점이 실제보다 6~14점 높았음)
const SHOT_PROB_EXPONENT = 4;
const SHOT_PROB_CAP = 0.33;
const PASS_TARGET_USAGE_POWER = 0.6;
const STEAL_SHARE_OF_TURNOVER = 0.55;   // 턴오버 중 수비자 스틸로 기록되는 비율 (나머지는 라인크로스 등)

// 수비 전술 효과
const PRESS_TURNOVER_MULT = 1.25;
const PRESS_FOUL_MULT = 1.15;
const ZONE_PAINT_PENALTY = 0.035;
const ZONE_MID_PENALTY = 0.01;
const ZONE_THREE_BONUS = 0.015;
const ZONE_THREE_WEIGHT_MULT = 1.25;

// 더블팀 효과
const DOUBLE_TEAM_SHOT_PROB_MULT = 0.6;
const DOUBLE_TEAM_ACCURACY_PENALTY = 0.06;
const DOUBLE_TEAM_TURNOVER_MULT = 1.2;
const OPEN_LOOK_BONUS = 0.035;          // 더블팀을 피해 빠져나온 패스를 받은 선수의 오픈샷 보너스

const REBOUND_EMPHASIS_MULT = 1.12;

// ============================================================
// 유틸리티
// ============================================================

function rand(): number {
  return Math.random();
}

function weightedPick<T>(items: T[], weightFn: (t: T) => number): T {
  const weights = items.map((i) => Math.max(0, weightFn(i)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rand() * items.length)];
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** 같은 포지션 그룹의 수비자를 찾고, 스위치 확률에 따라 다른 그룹 선수로 교체 */
function assignDefender(
  offPlayer: SimPlayer,
  defense: SimPlayer[],
  offense: SimPlayer[]
): { defender: SimPlayer; switched: boolean } {
  // ⚠️ 수비 스토퍼 지정: 상대팀 usage 최고 선수를 포지션 무관 전담마크.
  const stopper = defense.find((d) => d.tactics?.isDefensiveStopper);
  if (stopper) {
    const topThreat = offense.reduce((a, b) => (b.internals.usagePercentile > a.internals.usagePercentile ? b : a));
    if (offPlayer === topThreat) {
      return { defender: stopper, switched: false }; // 의도된 지정 매치업이라 스위치 페널티 없음
    }
  }

  const sameGroup = defense.find((d) => d.positionGroup === offPlayer.positionGroup);
  const primaryDefender = sameGroup ?? defense[0];

  const gap = offPlayer.attrs.ballHandling - primaryDefender.attrs.ballHandling;
  const switchProb = Math.min(0.4, Math.max(0.05, 0.05 + (gap + 50) / 100 * 0.35));

  if (rand() < switchProb) {
    const others = defense.filter((d) => d !== primaryDefender);
    const switched = others[Math.floor(rand() * others.length)] ?? primaryDefender;
    return { defender: switched, switched: true };
  }
  return { defender: primaryDefender, switched: false };
}

function effectiveDefenseValue(defender: SimPlayer, switched: boolean, attr: keyof DisplayAttrs): number {
  const base = defender.attrs[attr];
  return switched ? base * SWITCH_PENALTY : base;
}

function pickShotType(shooter: SimPlayer, offCtx: TeamContext, defCtx: TeamContext): ShotType {
  let threeMultiplier = (shooter.tactics?.threeWeightMultiplier ?? 1.0) * (offCtx.threeWeightMultiplier ?? 1.0);
  if (defCtx.defenseScheme === "zone") threeMultiplier *= ZONE_THREE_WEIGHT_MULT;
  const weights: Record<ShotType, number> = {
    paint: shooter.attrs.finishing,
    mid: shooter.attrs.midRangeShooting,
    three: shooter.attrs.threePointShooting * threeMultiplier,
  };
  const total = weights.paint + weights.mid + weights.three;
  if (total <= 0) return "paint";
  let r = rand() * total;
  r -= weights.paint;
  if (r <= 0) return "paint";
  r -= weights.mid;
  if (r <= 0) return "mid";
  return "three";
}

function shotSuccessProb(shooter: SimPlayer, shotType: ShotType, defCtx: TeamContext, openLook: boolean): number {
  let p =
    shotType === "paint" ? shooter.internals.paintAccuracy
    : shotType === "mid" ? shooter.internals.midAccuracy
    : shooter.internals.threeAccuracy;
  if (defCtx.defenseScheme === "zone") {
    if (shotType === "paint") p -= ZONE_PAINT_PENALTY;
    else if (shotType === "mid") p -= ZONE_MID_PENALTY;
    else p += ZONE_THREE_BONUS;
  }
  if (defCtx.doubleTeamTarget === shooter.name) p -= DOUBLE_TEAM_ACCURACY_PENALTY;
  if (openLook) p += OPEN_LOOK_BONUS;
  return Math.max(0.05, Math.min(0.95, p));
}

/** 턴오버 발생 시 일정 비율은 수비자 스틸로 기록 */
function pushTurnover(events: PossessionEvent[], holder: SimPlayer, stealer: SimPlayer, detail: string) {
  events.push({ type: "TURNOVER", actor: holder.name, detail });
  const stealWeight = STEAL_SHARE_OF_TURNOVER * (0.6 + stealer.attrs.steal / 125);
  if (rand() < stealWeight) events.push({ type: "STEAL", actor: stealer.name });
}

function shootFreeThrows(events: PossessionEvent[], shooter: SimPlayer, count: number): number {
  let pts = 0;
  for (let i = 0; i < count; i++) {
    const made = rand() < shooter.internals.ftAccuracy;
    events.push({ type: "FT", actor: shooter.name, made, points: made ? 1 : 0 });
    if (made) pts += 1;
  }
  return pts;
}

// ============================================================
// 메인: 포제션 시뮬레이션
// ============================================================

export function simulatePossession(
  offense: SimPlayer[],
  defense: SimPlayer[],
  offCtx: TeamContext = DEFAULT_TEAM_CONTEXT,
  defCtx: TeamContext = DEFAULT_TEAM_CONTEXT
): PossessionResult {
  const events: PossessionEvent[] = [];
  const press = defCtx.defenseScheme === "press";

  // 1. 공격 시작: 가드 중 ballHandling 가중 추첨
  const guards = offense.filter((p) => p.positionGroup === "G");
  const startingPool = guards.length > 0 ? guards : offense;
  // ⚠️ 이전엔 ballHandling 최고 1명으로 고정 -> 그 선수가 "첫 터치 프리미엄"을 매번 독점해서
  // usage 낮은 선수가 usage 높은 선수보다 슛 점유율이 더 높아지는 왜곡 발생 (실측 검증 중 발견).
  let holder = weightedPick(startingPool, (p) => Math.max(1, p.attrs.ballHandling));

  let lastPasser: SimPlayer | null = null;
  let openLook = false;

  for (let chain = 0; chain < MAX_CHAIN_LENGTH; chain++) {
    const doubled = defCtx.doubleTeamTarget === holder.name;
    // ⚠️ 원래 공식(선형)은 평균적인 선수도 즉시슛확률 50%가 나와서 어시스트 비율이 비현실적이었음.
    // 지수를 줘서 고usage/고득점력 선수일수록 즉시슛확률이 높도록.
    const rawFactor =
      (holder.internals.usagePercentile / 100) * 0.3 + (holder.internals.ptsPercentile / 100) * 0.7;
    // ⚠️ 상한이 없으면 극단적 고usage 선수가 "패스도 몰리고 + 받으면 거의 다 쏨"으로 폭주.
    const shotProbExponent = holder.tactics?.shotProbExponent ?? SHOT_PROB_EXPONENT;
    let shotAttemptProb = Math.min(SHOT_PROB_CAP, Math.pow(rawFactor, shotProbExponent));
    if (doubled) shotAttemptProb *= DOUBLE_TEAM_SHOT_PROB_MULT;
    // ⚠️ 볼을 운반한 가드의 "첫 터치 즉시슛"이 과도하면 가드·아시아쿼터 득점이 비현실적으로 부풀려짐
    // (v1 시즌 시뮬 검증 중 발견: 아시아쿼터 가드 3명이 25점대). 첫 터치는 세트오펜스 전개 단계로 보고 감쇠.
    if (chain === 0) shotAttemptProb *= FIRST_TOUCH_SHOT_MULT;
    if (openLook) shotAttemptProb = Math.max(shotAttemptProb, 0.4); // 오픈 찬스면 쏜다

    if (rand() < shotAttemptProb || chain === MAX_CHAIN_LENGTH - 1) {
      // ---- 드라이브(돌파) 단계: 슛 시도 전에 반드시 거침 ----
      const { defender: driveDefender, switched: driveSwitched } = assignDefender(holder, defense, offense);
      const driveDefenderSteal = effectiveDefenseValue(driveDefender, driveSwitched, "steal");
      let driveTurnoverProb =
        BASE_TURNOVER_DRIVE * (1 - (holder.attrs.ballHandling / 100) * 0.5) * (1 + (driveDefenderSteal / 100) * 0.5);
      if (press) driveTurnoverProb *= PRESS_TURNOVER_MULT;
      if (doubled) driveTurnoverProb *= DOUBLE_TEAM_TURNOVER_MULT;

      if (rand() < driveTurnoverProb) {
        pushTurnover(events, holder, driveDefender, "drive");
        return { points: 0, turnover: true, events };
      }

      const driveDefenderStrength = effectiveDefenseValue(driveDefender, driveSwitched, "strength");
      let driveFoulProb =
        BASE_FOUL_DRIVE * (1 + (holder.attrs.ballHandling / 100) * 0.3) * (1 - (driveDefenderStrength / 100) * 0.3);
      if (press) driveFoulProb *= PRESS_FOUL_MULT;

      if (rand() < driveFoulProb) {
        // 돌파 파울: 자유투 2개로 전환 (팀파울 보너스 등 세부 규칙은 생략)
        events.push({ type: "FOUL", actor: driveDefender.name, detail: "drive" });
        const points = shootFreeThrows(events, holder, 2);
        return { points, turnover: false, events };
      }

      // ---- 슛 시도 ----
      const shotType = pickShotType(holder, offCtx, defCtx);
      const { defender, switched } = assignDefender(holder, defense, offense);

      if (shotType === "paint") {
        const blockChance = effectiveDefenseValue(defender, switched, "shotBlocking") / 100 * 0.25;
        if (rand() < blockChance) {
          events.push({ type: "SHOT", actor: holder.name, shotType, made: false, points: 0 });
          events.push({ type: "BLOCK", actor: defender.name });
          return finishWithRebound(offense, defense, events, offCtx, defCtx);
        }
      }

      const shotFoulProb = BASE_SHOT_FOUL[shotType] * (shotType === "paint" ? 1 + holder.attrs.finishing / 100 * 0.4 : 1);
      const isFouled = rand() < shotFoulProb;
      const made = rand() < shotSuccessProb(holder, shotType, defCtx, openLook);
      const shotPoints = shotType === "three" ? 3 : 2;

      if (isFouled) events.push({ type: "FOUL", actor: defender.name, detail: `${shotType} shooting` });

      if (made) {
        events.push({
          type: "SHOT", actor: holder.name, shotType, made: true, points: shotPoints,
          assister: lastPasser?.name,
        });
        const andOne = isFouled ? shootFreeThrows(events, holder, 1) : 0;
        return { points: shotPoints + andOne, turnover: false, events };
      }

      if (isFouled) {
        // 슈팅파울 + 실패: 자유투 2개(3점이면 3개). 슛 시도 자체는 야투로 기록하지 않음(실제 규정과 동일)
        const points = shootFreeThrows(events, holder, shotPoints);
        return { points, turnover: false, events };
      }

      events.push({ type: "SHOT", actor: holder.name, shotType, made: false, points: 0 });
      return finishWithRebound(offense, defense, events, offCtx, defCtx);
    }

    // ---- 패스 ----
    events.push({ type: "PASS", actor: holder.name });
    const defenderAvgSteal =
      defense.reduce((s, d) => s + d.attrs.steal, 0) / defense.length;
    let turnoverProb =
      BASE_TURNOVER_PASS * (1 - (holder.attrs.passing / 100) * 0.5) * (1 + (defenderAvgSteal / 100) * 0.5);
    if (press) turnoverProb *= PRESS_TURNOVER_MULT;
    if (doubled) turnoverProb *= DOUBLE_TEAM_TURNOVER_MULT;

    if (rand() < turnoverProb) {
      const stealer = weightedPick(defense, (d) => d.attrs.steal);
      pushTurnover(events, holder, stealer, "pass");
      return { points: 0, turnover: true, events };
    }

    lastPasser = holder;
    openLook = doubled; // 더블팀에서 빠져나온 패스 → 받는 선수는 오픈 찬스
    const candidates = offense.filter((p) => p !== holder);
    holder = weightedPick(candidates, (p) => Math.pow(p.internals.usagePercentile, PASS_TARGET_USAGE_POWER));
  }

  // 체인 길이 초과 시 안전장치 (도달 안 하는 게 정상)
  return { points: 0, turnover: false, events };
}

function finishWithRebound(
  offense: SimPlayer[],
  defense: SimPlayer[],
  events: PossessionEvent[],
  offCtx: TeamContext,
  defCtx: TeamContext
): PossessionResult {
  const offRebSum = offense.reduce((s, p) => s + p.attrs.offensiveRebounding, 0) * (offCtx.reboundEmphasis ? REBOUND_EMPHASIS_MULT : 1);
  const defRebSum = defense.reduce((s, p) => s + p.attrs.defensiveRebounding, 0) * (defCtx.reboundEmphasis ? REBOUND_EMPHASIS_MULT : 1);
  const offRebProb = offRebSum / (offRebSum + defRebSum);

  if (rand() < offRebProb) {
    const reboundWinner = weightedPick(offense, (p) => p.attrs.offensiveRebounding);
    events.push({ type: "REBOUND_OFF", actor: reboundWinner.name });
    return simulatePossessionContinued(offense, defense, events, reboundWinner, offCtx, defCtx);
  } else {
    const reboundWinner = weightedPick(defense, (p) => p.attrs.defensiveRebounding);
    events.push({ type: "REBOUND_DEF", actor: reboundWinner.name });
    return { points: 0, turnover: false, events };
  }
}

/** 공격리바운드 후 이어지는 포제션 — holder를 리바운더로 지정하고 체인 재개 */
function simulatePossessionContinued(
  offense: SimPlayer[],
  defense: SimPlayer[],
  priorEvents: PossessionEvent[],
  newHolder: SimPlayer,
  offCtx: TeamContext,
  defCtx: TeamContext
): PossessionResult {
  // 간단화를 위해 새 체인은 최대 길이를 짧게(3)만 허용 (리바운드 후 세컨찬스는 대개 빠르게 끝남)
  let holder = newHolder;
  for (let chain = 0; chain < 3; chain++) {
    const shotAttemptProb =
      (holder.internals.usagePercentile / 100) * 0.3 + (holder.internals.ptsPercentile / 100) * 0.7;

    if (rand() < Math.max(0.5, shotAttemptProb) || chain === 2) {
      const shotType = pickShotType(holder, offCtx, defCtx);
      const made = rand() < shotSuccessProb(holder, shotType, defCtx, false);
      const points = shotType === "three" ? 3 : 2;
      priorEvents.push({ type: "SHOT", actor: holder.name, shotType, made, points: made ? points : 0, putback: true });

      if (made) return { points, turnover: false, events: priorEvents };
      // 세컨찬스도 실패하면 그냥 종료 (무한 루프 방지, 수비 리바운드로 처리)
      const reboundWinner = weightedPick(defense, (p) => p.attrs.defensiveRebounding);
      priorEvents.push({ type: "REBOUND_DEF", actor: reboundWinner.name });
      return { points: 0, turnover: false, events: priorEvents };
    }
    const candidates = offense.filter((p) => p !== holder);
    holder = weightedPick(candidates, (p) => Math.pow(p.internals.usagePercentile, PASS_TARGET_USAGE_POWER));
  }
  return { points: 0, turnover: false, events: priorEvents };
}
