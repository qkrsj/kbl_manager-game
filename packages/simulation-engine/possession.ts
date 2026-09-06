/**
 * KBL Manager — 포제션 시뮬레이션 (v0)
 *
 * 지금까지 확정한 규칙을 하나의 함수로 조립:
 *  - 공격 시작: 가드 중 ballHandling 최고 선수
 *  - 슛/패스 결정: usage×0.3 + PTS×0.7 (둘 다 리그 퍼센타일)
 *  - 패스 대상: 팀원별 usage 퍼센타일 가중 추첨
 *  - 포지션 매치업 + 스위치(0.7 페널티)
 *  - 턴오버/파울/리바운드
 *
 * ⚠️ 아직 사용자와 명시적으로 확정 안 한 가정 (v0 임시, 추후 조정 가능):
 *  - "슛 종류(페인트/미드/3점) 선택"은 선수의 세 지표(finishing 볼륨, midRangeShooting,
 *    threePointShooting) 퍼센타일 비례 가중치로 정함 — 실제로는 상황(공간, 수비 배치)에
 *    따라 달라져야 하지만 v0에서는 "이 선수가 상대적으로 어떤 거리에 강한가"로 근사.
 */

import { PositionGroup, LineupPlayer } from "./lineup";

// ============================================================
// 타입
// ============================================================

/** 표시용 능력치(0~99) — attribute-pipeline의 DerivedAttributes와 동일 필드만 사용 */
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

export interface SimPlayer extends LineupPlayer {
  attrs: DisplayAttrs;
  internals: SimulationInternals;
}

export interface PossessionEvent {
  type: "PASS" | "SHOT_ATTEMPT" | "TURNOVER" | "FOUL" | "BLOCK" | "REBOUND_OFF" | "REBOUND_DEF";
  actor: string;
  detail?: string;
}

export interface PossessionResult {
  points: 0 | 1 | 2 | 3;
  turnover: boolean;
  events: PossessionEvent[];
  scorer?: string;
  assister?: string;
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
  defense: SimPlayer[]
): { defender: SimPlayer; switched: boolean } {
  const sameGroup = defense.find((d) => d.positionGroup === offPlayer.positionGroup);
  const primaryDefender = sameGroup ?? defense[0];

  const gap = offPlayer.attrs.ballHandling - primaryDefender.attrs.ballHandling;
  const switchProb = Math.min(0.4, Math.max(0.05, 0.05 + (gap + 50) / 100 * 0.35));

  if (rand() < switchProb) {
    // 가장 가까이 있던 선수 = 같은 그룹 다음으로, 인접 그룹(간단히: 나머지 중 랜덤)에서 대체
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

type ShotType = "paint" | "mid" | "three";

function pickShotType(shooter: SimPlayer): ShotType {
  const weights: Record<ShotType, number> = {
    paint: shooter.attrs.finishing,
    mid: shooter.attrs.midRangeShooting,
    three: shooter.attrs.threePointShooting,
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

// ============================================================
// 메인: 포제션 시뮬레이션
// ============================================================

export function simulatePossession(
  offense: SimPlayer[],
  defense: SimPlayer[]
): PossessionResult {
  const events: PossessionEvent[] = [];

  // 1. 공격 시작: 가드 중 ballHandling 최고, 없으면 전체 중 최고
  const guards = offense.filter((p) => p.positionGroup === "G");
  const startingPool = guards.length > 0 ? guards : offense;
  // ⚠️ 이전엔 ballHandling 최고 1명으로 고정 -> 그 선수가 "첫 터치 프리미엄"을 매번 독점해서
  // usage 낮은 선수가 usage 높은 선수보다 슛 점유율이 더 높아지는 왜곡 발생 (실측 검증 중 발견:
  // 김낙현 usagePct80이 안영준90/워니99보다 슛시도 훨씬 많았음). ballHandling 가중 확률추첨으로 변경.
  let holder = weightedPick(startingPool, (p) => Math.max(1, p.attrs.ballHandling));

  let lastPasser: SimPlayer | null = null;
  let assister: string | undefined;

  for (let chain = 0; chain < MAX_CHAIN_LENGTH; chain++) {
    // ⚠️ 원래 공식(선형)은 평균적인 선수(usage/PTS 퍼센타일 50)도 즉시슛확률 50%가 나와서,
    // 득점의 57.8%가 패스 0회(첫터치 즉시슛)로 끝나는 비현실적 결과가 나왔다
    // (실제 리그는 어시스트 비율 55~65%, 즉 패스 없는 고립 슛은 소수여야 함).
    // 지수(1.8)를 줘서 평균~중간 수준 선수는 확률을 크게 낮추고, 진짜 고usage/고득점력
    // 선수만 여전히 높은 즉시슛확률을 갖도록 완화 (실측 검증 중 발견).
    const rawFactor =
      (holder.internals.usagePercentile / 100) * 0.3 + (holder.internals.ptsPercentile / 100) * 0.7;
    // ⚠️ 상한선 없이는 usagePct가 극단값(99+)인 선수가 즉시슛확률 97%+까지 치솟아서
    // "패스도 몰리고 + 받으면 거의 다 쏨"의 이중 몰림이 발생 (실측 검증 중 발견 —
    // 시즌 시뮬레이션에서 패리스 배스 45.7점/경기로 비현실적으로 나온 원인).
    // 아무리 볼독점형 선수여도 매번 쏘지는 않는다는 하한을 두기 위해 0.65로 상한 설정.
    const shotAttemptProb = Math.min(0.45, Math.pow(rawFactor, 9));

    if (rand() < shotAttemptProb || chain === MAX_CHAIN_LENGTH - 1) {
      // ---- 드라이브(돌파) 단계: 슛 시도 전에 반드시 거침 ----
      // ⚠️ 이전 버전은 이 단계가 누락되어, "즉시슛"으로 끝나는 포제션(패스 0회)에는
      // 턴오버/파울이 발생할 기회 자체가 없었다 (실측 검증 중 발견 — 턴오버율 2.5~3.1%로
      // 비현실적으로 낮게 나온 원인. 정상 리그 평균은 12~15%).
      const { defender: driveDefender, switched: driveSwitched } = assignDefender(holder, defense);
      const driveDefenderSteal = effectiveDefenseValue(driveDefender, driveSwitched, "steal");
      const driveTurnoverProb =
        BASE_TURNOVER_DRIVE * (1 - (holder.attrs.ballHandling / 100) * 0.5) * (1 + (driveDefenderSteal / 100) * 0.5);

      if (rand() < driveTurnoverProb) {
        events.push({ type: "TURNOVER", actor: holder.name, detail: "drive" });
        return { points: 0, turnover: true, events };
      }

      const driveDefenderStrength = effectiveDefenseValue(driveDefender, driveSwitched, "strength");
      const driveFoulProb =
        BASE_FOUL_DRIVE * (1 + (holder.attrs.ballHandling / 100) * 0.3) * (1 - (driveDefenderStrength / 100) * 0.3);

      if (rand() < driveFoulProb) {
        // 돌파 파울: 자유투 2개로 전환 (앤드원 등 세부 규칙은 v0에서 생략, 단순 2FT 처리)
        events.push({ type: "FOUL", actor: driveDefender.name, detail: "drive foul -> 2FT" });
        const ft1 = rand() < holder.internals.ftAccuracy;
        const ft2 = rand() < holder.internals.ftAccuracy;
        const points = ((ft1 ? 1 : 0) + (ft2 ? 1 : 0)) as 0 | 1 | 2;
        return { points, turnover: false, events, scorer: holder.name };
      }

      // ---- 슛 시도 ----
      const shotType = pickShotType(holder);
      const { defender, switched } = assignDefender(holder, defense);
      events.push({ type: "SHOT_ATTEMPT", actor: holder.name, detail: shotType });

      if (shotType === "paint") {
        const blockChance = effectiveDefenseValue(defender, switched, "shotBlocking") / 100 * 0.25;
        if (rand() < blockChance) {
          events.push({ type: "BLOCK", actor: defender.name });
          return finishWithRebound(offense, defense, events);
        }
      }

      const shotFoulProb = BASE_SHOT_FOUL[shotType] * (shotType === "paint" ? 1 + holder.attrs.finishing / 100 * 0.4 : 1);
      const isFouled = rand() < shotFoulProb;

      const successProb =
        shotType === "paint" ? holder.internals.paintAccuracy
        : shotType === "mid" ? holder.internals.midAccuracy
        : holder.internals.threeAccuracy;

      const made = rand() < successProb;

      if (isFouled) {
        events.push({ type: "FOUL", actor: defender.name, detail: `${shotType} shooting foul` });
      }

      if (made) {
        const points: 0 | 1 | 2 | 3 = shotType === "three" ? 3 : 2;
        if (lastPasser) assister = lastPasser.name;
        return { points, turnover: false, events, scorer: holder.name, assister };
      }

      // 실패 -> 리바운드
      return finishWithRebound(offense, defense, events);
    }

    // ---- 패스 ----
    events.push({ type: "PASS", actor: holder.name });
    const defenderAvgSteal =
      defense.reduce((s, d) => s + d.attrs.steal, 0) / defense.length;
    const turnoverProb =
      BASE_TURNOVER_PASS * (1 - (holder.attrs.passing / 100) * 0.5) * (1 + (defenderAvgSteal / 100) * 0.5);

    if (rand() < turnoverProb) {
      events.push({ type: "TURNOVER", actor: holder.name });
      return { points: 0, turnover: true, events };
    }

    lastPasser = holder;
    const candidates = offense.filter((p) => p !== holder);
    holder = weightedPick(candidates, (p) => p.internals.usagePercentile);
  }

  // 체인 길이 초과 시 안전장치 (도달 안 하는 게 정상)
  return { points: 0, turnover: false, events };
}

function finishWithRebound(
  offense: SimPlayer[],
  defense: SimPlayer[],
  events: PossessionEvent[]
): PossessionResult {
  const offRebSum = offense.reduce((s, p) => s + p.attrs.offensiveRebounding, 0);
  const defRebSum = defense.reduce((s, p) => s + p.attrs.defensiveRebounding, 0);
  const offRebProb = offRebSum / (offRebSum + defRebSum);

  if (rand() < offRebProb) {
    const reboundWinner = weightedPick(offense, (p) => p.attrs.offensiveRebounding);
    events.push({ type: "REBOUND_OFF", actor: reboundWinner.name });
    // 공격리바운드 성공 -> 포제션 계속 (재귀 호출로 새 체인 시작, 리바운더가 새 볼 소유자)
    return simulatePossessionContinued(offense, defense, events, reboundWinner);
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
  newHolder: SimPlayer
): PossessionResult {
  // 간단화를 위해 새 체인은 최대 길이를 짧게(3)만 허용 (리바운드 후 세컨찬스는 대개 빠르게 끝남)
  let holder = newHolder;
  for (let chain = 0; chain < 3; chain++) {
    const shotAttemptProb =
      (holder.internals.usagePercentile / 100) * 0.3 + (holder.internals.ptsPercentile / 100) * 0.7;

    if (rand() < Math.max(0.5, shotAttemptProb) || chain === 2) {
      const shotType = pickShotType(holder);
      const successProb =
        shotType === "paint" ? holder.internals.paintAccuracy
        : shotType === "mid" ? holder.internals.midAccuracy
        : holder.internals.threeAccuracy;

      priorEvents.push({ type: "SHOT_ATTEMPT", actor: holder.name, detail: `${shotType}(putback)` });

      if (rand() < successProb) {
        const points: 0 | 1 | 2 | 3 = shotType === "three" ? 3 : 2;
        return { points, turnover: false, events: priorEvents, scorer: holder.name };
      }
      // 세컨찬스도 실패하면 그냥 종료 (무한 루프 방지, 수비 리바운드로 처리)
      priorEvents.push({ type: "REBOUND_DEF", actor: defense[0].name });
      return { points: 0, turnover: false, events: priorEvents };
    }
    const candidates = offense.filter((p) => p !== holder);
    holder = weightedPick(candidates, (p) => p.internals.usagePercentile);
  }
  return { points: 0, turnover: false, events: priorEvents };
}
