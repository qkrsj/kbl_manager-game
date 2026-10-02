/**
 * KBL Manager — 연봉협상 · 보수 조정 (비시즌 1단계)
 *
 * 1) 요구액: 능력치 순위가 아니라 "지난 시즌 기록"이 중심.
 *    - 기록 순위 보수 + 기록이 비슷한 선수 5명의 보수 + 현재 보수 (recordSalary) 80% + 능력치 기준 시장가 20%
 *    - 인상 폭 상한: 기록 상위권일수록 크게 (최고 +70%, 상위 20% +40%, 중간 +16%, 하위 +5~8%), 33세 이상 40%, 35세 이상 최대 +10%.
 *      경기를 거의 못 뛴 선수(10경기 미만)는 동결 수준.
 * 2) 협상: 선수마다 속으로 정해 둔 "합의 가능선"(reservation)이 있고, 구단 제시에 따라 요구액을 단계적으로 낮춘다.
 *    - 합리적인 제시(합의 가능선 이상)일수록, 협상이 길어질수록 크게 양보 → 서로 양보하며 타협점에서 사인
 *    - 지나치게 낮은 제시나 지난번보다 낮춘 제시에는 거의 양보하지 않음
 * 3) 보수 조정(재정위원회): 끝내 합의하지 못하면, 선수 요구액과 구단 제시액 사이에서
 *    선수 기록(출전·득점·효율)과 기록이 비슷한 선수들의 보수를 근거로 판결한다.
 */
import { formatKrw, MIN_SALARY } from "./salaryCap";
import type { PlayerValue } from "./offseason";

const round100 = (v: number) => Math.max(MIN_SALARY, Math.round(v / 100) * 100);

export interface ProdRow { id: number; name: string; team: string | null; prod: number; salary: number; games: number; ppg: number; rpg: number; apg: number; mpg: number }

/** 기록 생산성: 경기당 효율에 출전 경기 수(최대 45경기 기준)를 반영 */
export function production(v: Pick<PlayerValue, "eff" | "games" | "mpg">): number {
  if (v.games <= 0) return 0;
  const availability = 0.5 + 0.5 * Math.min(1, v.games / 45);
  return Math.max(0, v.eff) * availability + Math.min(v.mpg, 36) * 0.05;
}

/** 비교 대상 표: 보수 계약이 있고 15경기 이상 뛴 국내선수 */
export function productionTable(values: Map<number, PlayerValue>, salaries: Map<number, number>, teamNames: Map<number, string>): ProdRow[] {
  const rows: ProdRow[] = [];
  for (const v of values.values()) {
    const sal = salaries.get(v.player.id);
    if (v.player.contractType !== "domestic" || !sal || v.games < 15) continue;
    rows.push({
      id: v.player.id, name: v.player.name, team: v.player.teamId ? teamNames.get(v.player.teamId) ?? null : null,
      prod: production(v), salary: sal, games: v.games, ppg: v.ppg, rpg: v.rpg, apg: v.apg, mpg: v.mpg,
    });
  }
  return rows.sort((a, b) => b.prod - a.prod);
}

/** 기록이 가장 비슷한 선수 n명과 그들의 보수 중간값 */
export function comparables(table: ProdRow[], playerId: number, prod: number, n = 5) {
  const comps = table.filter((r) => r.id !== playerId).sort((a, b) => Math.abs(a.prod - prod) - Math.abs(b.prod - prod)).slice(0, n);
  const sorted = comps.map((c) => c.salary).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return { comps, median };
}

/** 기록 순위가 같은 위치의 보수 (기록 하위 10%면 보수도 하위 10% 수준) */
function salaryAtPct(table: ProdRow[], pct: number): number {
  const sorted = table.map((r) => r.salary).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(pct * (sorted.length - 1))))];
}

/** 기록으로 본 적정 보수: 기록 순위 보수 45% + 비슷한 기록 선수 보수 20% + 현재 보수 35% */
function recordSalary(table: ProdRow[], pct: number, compMedian: number, current: number): number {
  const byRank = salaryAtPct(table, pct);
  if (!byRank) return current;
  return byRank * 0.45 + (compMedian || byRank) * 0.2 + current * 0.35;
}

export const pctLabel = (pct: number) => (pct >= 0.5 ? `상위 ${Math.max(1, Math.round((1 - pct) * 100))}%` : `하위 ${Math.max(1, Math.round(pct * 100))}%`);

/** 기록 백분위 (1 = 리그 최고) */
function percentile(table: ProdRow[], prod: number): number {
  if (table.length === 0) return 0.5;
  const below = table.filter((r) => r.prod < prod).length;
  return below / table.length;
}

export interface SalaryTerms { target: number; ask: number; reservation: number; compMedian: number; pct: number; cap: number }

/** 계약기간이 남은 국내선수의 연봉협상 조건 */
export function salaryTerms(v: PlayerValue, current: number, table: ProdRow[], rand = Math.random): SalaryTerms {
  const prod = production(v);
  const pct = percentile(table, prod);
  const { median } = comparables(table, v.player.id, prod);
  // 인상 상한: 기록 최상위 +70%, 상위 20% 약 +40%, 중간 약 +16%, 하위권 +5~8%
  let cap = 0.05 + 0.65 * Math.pow(pct, 2.5);
  if (v.player.age >= 35) cap = Math.min(cap, 0.1);
  else if (v.player.age >= 33) cap *= 0.4;
  let target: number;
  if (v.games < 10) {
    target = current * (0.96 + rand() * 0.04); // 거의 못 뛰었으면 동결 수준 (인상 요구 없음)
    cap = 0.02;
  } else {
    target = recordSalary(table, pct, median, current) * 0.8 + v.fair * 0.2;
  }
  target = Math.min(target, current * (1 + cap * 0.9));
  target = Math.max(target, current * (v.games >= 10 && pct < 0.25 ? 0.8 : 0.9));
  target = round100(target);
  // 요구액: 오를 선수는 목표보다 조금 높게, 깎일 선수는 "현재 수준 유지"를 부름
  const ask = round100(target >= current
    ? Math.min(target * (1.04 + rand() * 0.04), current * (1 + cap))   // 요구액도 인상 상한을 넘지 않음
    : Math.max(target * 1.06, current * 0.98));
  // 합의 가능선: 목표의 94~100% (성격 차이), 요구액보다 높을 수는 없음
  const reservation = Math.min(ask, round100(target * (0.94 + rand() * 0.06)));
  return { target, ask, reservation, compMedian: median, pct, cap };
}

export interface NegotiationState {
  ask: number;          // 지금 선수 요구액
  reservation: number;  // 합의 가능선 (비공개)
  rounds: number;       // 지금까지 제시 횟수
  lastOffer: number | null;
  maxRounds: number;
  minFloor?: number;    // 이 아래로는 절대 양보하지 않음 (오를 선수는 현재 보수)
}

export interface NegotiationReply { result: "accepted" | "counter" | "failed"; newAsk: number; agreed: number | null; mood: string; quote: string }

/**
 * 구단 제시액에 대한 선수 반응. 서로 양보하며 타협점을 찾는다.
 *  - 선수는 매번 남은 격차의 일부(25%→45%)만큼 요구액을 낮춘다 (한 번에 바닥까지 내려가지 않음)
 *  - 받아들일 최저선은 회차마다 내려간다: 1차 (합의선~요구액 중간) → 3차 무렵 합의선 → 마지막엔 합의선의 95%
 *    (오를 자격이 있는 선수는 현재 보수 아래로는 안 내려감) → 구단이 올라오면 중간에서 만남
 *  - 제시액이 그 회차 최저선 이상이거나 요구액의 98.5% 이상이면 사인
 *  - 터무니없이 낮은 제시엔 조금만, 지난번보다 깎은 제시엔 전혀 양보하지 않음
 */
export function negotiate(s: NegotiationState, offer: number, fmt: (v: number) => string, roundTo: (v: number) => number): NegotiationReply {
  const k = s.rounds + 1; // 이번이 몇 번째 제시인지
  if (offer >= s.ask) {
    return { result: "accepted", newAsk: s.ask, agreed: offer, mood: "만족", quote: `좋습니다. ${fmt(offer)}에 사인하겠습니다.` };
  }
  const floorMin = Math.min(s.reservation, Math.max(s.reservation * 0.95, s.minFloor ?? 0));
  // 회차별로 받아들일 수 있는 최저선: 1차 (합의선~요구액 중간) → 3차 무렵 합의선 → 마지막엔 합의선의 95%
  const floorAt = (round: number) => {
    const frac = Math.max(-1, 0.5 - (1.5 / Math.max(1, s.maxRounds - 1)) * (round - 1)); // 0.5 → −1
    return frac >= 0 ? s.reservation + (s.ask - s.reservation) * frac : s.reservation + (s.reservation - floorMin) * frac;
  };
  const floorNow = floorAt(k);
  if (offer >= floorNow || offer >= s.ask * 0.985) {
    return {
      result: "accepted", newAsk: offer, agreed: offer, mood: k === 1 ? "만족" : "타협",
      quote: k === 1 ? `좋은 조건이네요. ${fmt(offer)}에 사인하겠습니다.` : `서로 한 발씩 양보했네요. ${fmt(offer)}에 사인하겠습니다.`,
    };
  }
  const gap = s.ask - offer;
  const loweredOffer = s.lastOffer !== null && offer < s.lastOffer;
  let concession = 0.2 + 0.05 * k;                         // 협상이 길어질수록 더 양보
  if (offer >= floorNow * 0.95) concession += 0.1;         // 거의 다 온 제시
  if (offer < s.reservation * 0.9) concession = 0.08;      // 합의선보다 10% 넘게 낮은 헐값 제시
  if (loweredOffer) concession = 0;
  const newAsk = roundTo(Math.max(floorAt(k + 1), s.ask - gap * concession));

  if (k >= s.maxRounds) {
    return { result: "failed", newAsk, agreed: null, mood: "결렬", quote: `여기까지인 것 같습니다. 제 마지막 요구는 ${fmt(newAsk)}입니다.` };
  }
  const closeness = offer / newAsk;
  const mood = loweredOffer ? "불쾌" : closeness >= 0.95 ? "거의 합의" : closeness >= 0.85 ? "좁혀지는 중" : "격차 큼";
  const quote = loweredOffer
    ? `지난번보다 낮은 제시라니 실망입니다. 요구액은 그대로 ${fmt(newAsk)}입니다.`
    : closeness >= 0.95 ? `거의 다 왔습니다. ${fmt(newAsk)}이면 바로 사인하겠습니다.`
    : closeness >= 0.85 ? `저도 양보하겠습니다. ${fmt(newAsk)}까지 낮출게요.`
    : `차이가 꽤 큽니다. 일단 ${fmt(newAsk)}까지는 낮춰 보겠습니다.`;
  return { result: "counter", newAsk, agreed: null, mood, quote };
}

export interface Ruling {
  amount: number;
  side: "player" | "team" | "middle";
  recordValue: number;
  playerAsk: number;
  teamOffer: number;
  current: number;
  stats: { games: number; mpg: number; ppg: number; rpg: number; apg: number; eff: number; pct: number };
  comps: { name: string; team: string | null; salary: number; ppg: number; rpg: number; apg: number; games: number }[];
  reasons: string[];
  summary: string;
}

/**
 * 보수 조정 판결 (KBL 재정위원회). 선수 요구액과 구단 제시액 사이에서,
 * 기록 순위 보수(45%)·비슷한 기록 선수들의 보수(20%)·현재 보수(35%)로 본 "기록 가치"에 가장 가까운 금액으로 결정.
 * 기록 가치가 요구액 이상이면 선수 측, 제시액 이하면 구단 측 주장을 그대로 인정.
 */
export function arbitrate(v: PlayerValue, current: number, playerAsk: number, teamOffer: number, table: ProdRow[]): Ruling {
  const prod = production(v);
  const pct = percentile(table, prod);
  const { comps, median } = comparables(table, v.player.id, prod);
  let recordValue = recordSalary(table, pct, median, current);
  const reasons: string[] = [];
  if (v.games < 10) {
    recordValue = Math.min(recordValue, current);
    reasons.push(`출전 ${v.games}경기 — 인상을 뒷받침할 기록이 없음`);
  } else if (v.games < 27) {
    recordValue = Math.min(recordValue, current * 1.03);
    reasons.push(`출전 ${v.games}경기로 시즌 절반에 못 미쳐 인상 근거가 약함`);
  }
  recordValue = round100(recordValue);
  const lo = Math.min(playerAsk, teamOffer), hi = Math.max(playerAsk, teamOffer);
  const amount = round100(Math.min(hi, Math.max(lo, recordValue)));
  const side: Ruling["side"] = amount === playerAsk ? "player" : amount === teamOffer ? "team" : "middle";

  reasons.unshift(
    `지난 시즌 ${v.games}경기 평균 ${v.mpg.toFixed(1)}분 ${v.ppg.toFixed(1)}점 ${v.rpg.toFixed(1)}리바운드 ${v.apg.toFixed(1)}어시스트 (효율 ${v.eff.toFixed(1)}, 국내선수 중 ${pctLabel(pct)})`,
    `기록 순위가 비슷한 위치의 보수 수준 ${formatKrw(salaryAtPct(table, pct))}`,
    comps.length ? `기록이 비슷한 선수 ${comps.length}명의 보수 중간값 ${formatKrw(median)} (${comps.slice(0, 3).map((c) => `${c.name} ${formatKrw(c.salary)}`).join(", ")} 등)` : "비교할 만한 선수 기록이 부족함",
    `현재 보수 ${formatKrw(current)} → 기록으로 본 적정 보수 ${formatKrw(recordValue)}`,
  );
  const summary = side === "player"
    ? `선수 측 주장 인정 — 기록상 요구액(${formatKrw(playerAsk)})이 타당하다고 판단`
    : side === "team"
      ? `구단 측 주장 인정 — 기록상 구단 제시액(${formatKrw(teamOffer)})이 타당하다고 판단`
      : `절충 — 양측 주장 사이에서 기록 가치에 맞춰 ${formatKrw(amount)}으로 결정`;
  return {
    amount, side, recordValue, playerAsk, teamOffer, current,
    stats: { games: v.games, mpg: v.mpg, ppg: v.ppg, rpg: v.rpg, apg: v.apg, eff: v.eff, pct },
    comps: comps.map((c) => ({ name: c.name, team: c.team, salary: c.salary, ppg: c.ppg, rpg: c.rpg, apg: c.apg, games: c.games })),
    reasons, summary,
  };
}
