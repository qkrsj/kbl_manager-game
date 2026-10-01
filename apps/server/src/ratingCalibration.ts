/**
 * KBL Manager — 능력치 "수준" 보정 (역할 · 생산성 · 연봉)
 *
 * 기록에서 뽑은 세부 능력치(attribute-pipeline)는 "어떤 유형의 선수인가"(슈터/림프로텍터/패서 등)는
 * 잘 보여주지만, 분당 효율 위주라 "팀에서 얼마나 중요한 선수인가"가 약하게 반영된다.
 * (예: 11분 뛰는 백업 빅맨이 27분 뛰는 에이스 가드보다 오버롤이 높게 나오는 문제 — 사용자 지적)
 *
 * 그래서 오버롤의 "수준"은 아래 세 신호를 섞어서 정하고, 세부 능력치는 그 수준에 맞게 같은 폭으로
 * 평행이동한다 (선수 유형·강약점 모양은 그대로 유지).
 *
 *   1) 기록 능력치  : 세부 능력치로 계산한 오버롤의 리그 내 순위
 *   2) 역할·생산성 : 최근 3시즌 가중 경기당 출전시간(40%) + 경기당 공헌도(60%)의 순위
 *                    (표본 신뢰도만큼만 인정 — 거의 못 뛴 선수는 하위권으로)
 *                    + 전성기 실적: 최근 5시즌 중 20경기 이상 뛴 최고 시즌의 공헌도를 30% 반영
 *                    (부상·군 복무로 최근 2시즌이 주춤한 검증된 에이스가 과소평가되지 않게. 올려주기만 함)
 *   3) 연봉(국내)   : 2026-27 보수 순위 = 구단·시장이 지금 매긴 평가 (가장 최신 정보).
 *                    부상·군 복무 등으로 최근 기록이 적은 에이스(예: 변준형 8억)가 과소평가되지 않게 함.
 *                    31세 이상 베테랑은 연봉 비중을 더 높여, 기록이 다소 떨어져도 높은 연봉을 받는
 *                    핵심 베테랑이 나이 때문에 과소평가되지 않게 함. 신인 계약(2025 드래프트)은 연봉이
 *                    정해진 테이블이라 연봉 신호를 쓰지 않음.
 *
 *   가중치  기록 / 역할·생산성 / 연봉 = 30% / 30% / 40%  (31세 이상: 25% / 30% / 45%)
 *   ⚠️ 연봉이 보도로 확인되지 않은 추정치(source=estimated)인 선수는 연봉 비중을 1/3로 줄임
 *      (추정 연봉 자체가 기록·경력으로 만든 값이라 다시 크게 반영하면 이중 반영 — 벤치 베테랑 과대평가 원인)
 *   해외리그 기록으로 평가하는 선수(KBL 첫 시즌 / 마지막 KBL 시즌이 3년 이상 지남): KBL 환산 기록을
 *   KBL 선수와 똑같이 쓰되, 리그 환산의 불확실성 때문에 표본 신뢰도를 90%만 인정
 *
 * 국내선수·아시아쿼터: 순위 → 오버롤 58~90, 외국선수: 78~92 (외국선수끼리 비교)
 */
import { computeRatings, AttributeRow } from "./ratings";
import type { SeasonStatLine } from "../../../packages/attribute-pipeline/attributeConversion";

export type CalibrationGroup = "domestic" | "asia" | "foreign";

export interface CalibrationInput {
  name: string;
  group: CalibrationGroup;
  positionGroup: string;
  age: number;
  attrs: AttributeRow;
  pooled: SeasonStatLine | null;   // 최근 3시즌 가중 합산 스탯 (KBL 기록 없으면 null)
  seasons: SeasonStatLine[];        // 커리어 전체 시즌 (전성기 실적 계산용)
  reliability: number;              // 0~1
  salaryKrw: number | null;         // 국내선수 보수(만원)
  salaryReported: boolean;          // true = 2026-27 보도로 확인된 보수, false = 추정치
  overseas?: boolean;               // true = pooled가 해외리그 기록을 KBL 기준으로 환산한 값
  rookieContract: boolean;
}

export interface CalibrationResult {
  attrs: AttributeRow;
  before: number;
  after: number;
  statPct: number;
  productionPct: number | null;
  salaryPct: number | null;
}

const SKILL_KEYS: (keyof AttributeRow)[] = [
  "finishing", "dunking", "mid_range_shooting", "three_point_shooting", "free_throw_shooting",
  "ball_handling", "passing", "steal", "shot_blocking", "defensive_rebounding", "offensive_rebounding", "stamina",
];

function percentileOf(values: number[], v: number): number {
  if (values.length === 0) return 50;
  const below = values.filter((x) => x < v).length;
  const equal = values.filter((x) => x === v).length;
  return ((below + equal * 0.5) / values.length) * 100;
}

function efficiencyPerGame(s: SeasonStatLine): number {
  return s.PTS + s.REB + s.AST + s.STL + s.BLK - s.TO - (s.FGA - s.FGM) - (s.FTA - s.FTM);
}

/** 최근 5시즌 중 20경기 이상 뛴 시즌의 최고 경기당 공헌도 (검증된 전성기 실적) */
function peakEfficiency(seasons: SeasonStatLine[]): number | null {
  const vals = seasons.slice(-5).filter((x) => x.G >= 20).map(efficiencyPerGame);
  return vals.length ? Math.max(...vals) : null;
}

export function targetOverall(group: CalibrationGroup, pct: number): number {
  const q = Math.max(0, Math.min(100, pct)) / 100;
  return group === "foreign" ? 78 + 14 * q : 58 + 32 * Math.pow(q, 1.15);
}

/** 세부 능력치를 같은 폭으로 이동시켜 오버롤을 목표치에 맞춤 */
export function shiftToOverall(attrs: AttributeRow, positionGroup: string, target: number): AttributeRow {
  let cur = { ...attrs };
  for (let i = 0; i < 6; i++) {
    const ovr = computeRatings(cur, positionGroup).overall;
    const delta = Math.round(target) - ovr;
    if (delta === 0) break;
    const next = { ...cur };
    for (const k of SKILL_KEYS) next[k] = Math.max(40, Math.min(99, Number(cur[k]) + delta));
    cur = next;
  }
  return cur;
}

export function calibrateRatings(players: CalibrationInput[]): Map<string, CalibrationResult> {
  const out = new Map<string, CalibrationResult>();
  const groups: CalibrationGroup[][] = [["domestic", "asia"], ["foreign"]];
  const salaries = players.filter((p) => p.group === "domestic" && p.salaryKrw !== null).map((p) => p.salaryKrw!);

  for (const g of groups) {
    const members = players.filter((p) => g.includes(p.group));
    const overall = new Map(members.map((p) => [p.name, computeRatings(p.attrs, p.positionGroup).overall]));
    const overallArr = [...overall.values()];
    const withStats = members.filter((p) => p.pooled);
    const mpgArr = withStats.map((p) => p.pooled!.Min);
    const effArr = withStats.map((p) => efficiencyPerGame(p.pooled!));
    const peakArr = members.map((p) => peakEfficiency(p.seasons)).filter((v): v is number => v !== null);

    for (const p of members) {
      const before = overall.get(p.name)!;
      const statPct = percentileOf(overallArr, before);
      let productionPct: number | null = null;
      if (p.pooled) {
        const raw = percentileOf(mpgArr, p.pooled.Min) * 0.4 + percentileOf(effArr, efficiencyPerGame(p.pooled)) * 0.6;
        // 해외 환산 기록은 리그 간 환산 오차가 있어 신뢰도를 90%만 인정
        const rel = p.overseas ? p.reliability * 0.9 : p.reliability;
        const recent = raw * rel + 10 * (1 - rel);
        // 전성기 실적: 부상·군 복무로 최근 표본이 적거나 주춤한 검증된 주전을 인정 (최근 70% + 전성기 30%)
        const peak = peakEfficiency(p.seasons);
        productionPct = peak === null ? recent : Math.max(recent, recent * 0.7 + percentileOf(peakArr, peak) * 0.3);
      }
      const salaryPct = p.group === "domestic" && p.salaryKrw !== null && !p.rookieContract ? percentileOf(salaries, p.salaryKrw) : null;

      let pct: number;
      if (productionPct === null && salaryPct === null) {
        // 기록 없음: 외국선수는 기록 능력치 그대로, 국내 무기록 선수는 하위권
        pct = p.group === "foreign" ? statPct : Math.min(statPct, 10);
      } else if (salaryPct === null) {
        pct = statPct * 0.5 + (productionPct ?? statPct) * 0.5;
      } else {
        const veteran = p.age >= 31;
        let [ws, wp, wsal] = veteran ? [0.25, 0.3, 0.45] : [0.3, 0.3, 0.4];
        if (!p.salaryReported) {
          // 추정 연봉은 기록·경력으로 만든 값이라 다시 크게 반영하면 이중 반영 → 비중 1/3로 줄이고 나머지는 기록·역할로
          const cut = wsal * (2 / 3);
          wsal -= cut;
          ws += cut / 2;
          wp += cut / 2;
        }
        pct = statPct * ws + (productionPct ?? 10) * wp + salaryPct * wsal;
      }
      const target = targetOverall(p.group, pct);
      const attrs = shiftToOverall(p.attrs, p.positionGroup, target);
      out.set(p.name, {
        attrs, before, after: computeRatings(attrs, p.positionGroup).overall,
        statPct: Math.round(statPct), productionPct: productionPct === null ? null : Math.round(productionPct),
        salaryPct: salaryPct === null ? null : Math.round(salaryPct),
      });
    }
  }
  return out;
}
