/**
 * KBL Manager — 샐러리캡 / 로스터 규정 (2026-27 KBL 기준)
 *
 *  - 국내선수 샐러리캡 30억 원 (보수 총액 = 연봉 + 인센티브)
 *  - 최소 소진율 70% (미달 시 시즌 시작 불가 → 최저연봉 선수라도 채워야 함)
 *  - 최저 보수 4,200만 원
 *  - 외국선수 2명 보유·연봉 합계 100만 달러, 1인 최대 70만 달러
 *  - 아시아쿼터 1명 (국내선수 샐러리캡 별도, 게임 설정상 최대 20만 달러)
 *  - FA 보상(2026 개정안): 전년 보수 30위 이내 → 보상선수 1명+보수 25% 또는 보수 100%,
 *    31~40위 → 보수 50%, 41위 이하 → 보상 없음. (게임에서는 보상금 방식으로 처리)
 *
 * ⚠️ KBL은 2026-27 "소프트캡" 성격의 운영(원소속 구단 재계약 시 일부 초과 허용)으로 보도됨.
 *    게임에서는: 외부 FA 영입·신규 계약은 30억 이하로만 가능, 기존 소속 선수 연봉협상/재계약은
 *    캡의 105%(31.5억)까지 허용하되 초과분은 사치세(100%)로 기록한다.
 */
import { Pool, PoolClient } from "pg";

export const DOMESTIC_CAP = 300000;          // 만원 (30억)
export const SOFT_CAP_LIMIT = 315000;        // 만원 (31.5억) — 기존 선수 재계약 한도
export const MIN_CAP_RATIO = 0.7;
export const MIN_SALARY = 4200;              // 만원
export const MAX_SALARY = 120000;            // 만원 (게임 상 상한, 실질적으론 캡이 제한)
export const FOREIGN_TOTAL_CAP_USD = 1000000;
export const FOREIGN_SINGLE_CAP_USD = 700000;
export const ASIA_CAP_USD = 200000;
export const MAX_DOMESTIC_ROSTER = 18;
export const MIN_DOMESTIC_ROSTER = 12;
export const MAX_FOREIGN = 2;
export const MAX_ASIA = 1;
export const MAX_CONTRACT_YEARS = 5;

type Db = Pool | PoolClient;

export interface Payroll {
  domesticTotal: number;     // 만원
  domesticCount: number;
  foreignTotalUsd: number;
  foreignCount: number;
  asiaTotalUsd: number;
  asiaCount: number;
  capRoom: number;           // 만원 (30억 기준)
  usageRatio: number;
}

export async function teamPayroll(db: Db, teamId: number): Promise<Payroll> {
  const res = await db.query(
    `SELECT c.contract_type, COALESCE(SUM(c.salary_krw),0) AS krw, COALESCE(SUM(c.salary_usd),0) AS usd, COUNT(*) AS n
     FROM players p JOIN contracts c ON c.player_id = p.id
     WHERE p.team_id = $1 AND NOT p.is_retired
     GROUP BY c.contract_type`,
    [teamId]
  );
  const row = (t: string) => res.rows.find((r) => r.contract_type === t);
  const domesticTotal = Number(row("domestic")?.krw ?? 0);
  return {
    domesticTotal,
    domesticCount: Number(row("domestic")?.n ?? 0),
    foreignTotalUsd: Number(row("foreign")?.usd ?? 0),
    foreignCount: Number(row("foreign")?.n ?? 0),
    asiaTotalUsd: Number(row("asia")?.usd ?? 0),
    asiaCount: Number(row("asia")?.n ?? 0),
    capRoom: DOMESTIC_CAP - domesticTotal,
    usageRatio: domesticTotal / DOMESTIC_CAP,
  };
}

export type ContractType = "domestic" | "foreign" | "asia";

/**
 * 신규 계약(또는 연봉 변경)이 규정상 가능한지 검사. 가능하면 null, 아니면 사유 문자열.
 * @param replacingAmount 같은 선수의 기존 계약 금액(연봉협상처럼 기존 금액을 대체하는 경우)
 * @param isOwnPlayer 기존 소속 선수 재계약/연봉협상이면 true (소프트캡 한도 적용)
 */
export function checkContract(
  payroll: Payroll,
  type: ContractType,
  amount: number,
  opts: { replacingAmount?: number; isOwnPlayer?: boolean; addsRosterSpot?: boolean } = {}
): string | null {
  const replacing = opts.replacingAmount ?? 0;
  if (type === "domestic") {
    if (amount < MIN_SALARY) return `국내선수 최저 보수는 ${MIN_SALARY.toLocaleString()}만 원입니다`;
    if (amount > MAX_SALARY) return `보수 상한(${(MAX_SALARY / 10000).toFixed(0)}억 원)을 넘을 수 없습니다`;
    const after = payroll.domesticTotal - replacing + amount;
    const limit = opts.isOwnPlayer ? SOFT_CAP_LIMIT : DOMESTIC_CAP;
    if (after > limit) {
      return `샐러리캡 초과: 계약 후 보수 총액 ${(after / 10000).toFixed(2)}억 원 > 한도 ${(limit / 10000).toFixed(1)}억 원`;
    }
    if (opts.addsRosterSpot && payroll.domesticCount >= MAX_DOMESTIC_ROSTER) return `국내선수 등록 한도(${MAX_DOMESTIC_ROSTER}명) 초과`;
  } else if (type === "foreign") {
    if (amount > FOREIGN_SINGLE_CAP_USD) return `외국선수 1인 최대 연봉은 $${FOREIGN_SINGLE_CAP_USD.toLocaleString()}입니다`;
    if (payroll.foreignTotalUsd - replacing + amount > FOREIGN_TOTAL_CAP_USD) {
      return `외국선수 연봉 합계 한도($${FOREIGN_TOTAL_CAP_USD.toLocaleString()}) 초과`;
    }
    if (opts.addsRosterSpot && payroll.foreignCount >= MAX_FOREIGN) return `외국선수는 ${MAX_FOREIGN}명까지 보유할 수 있습니다`;
  } else {
    if (amount > ASIA_CAP_USD) return `아시아쿼터 최대 연봉은 $${ASIA_CAP_USD.toLocaleString()}입니다`;
    if (opts.addsRosterSpot && payroll.asiaCount >= MAX_ASIA) return `아시아쿼터는 ${MAX_ASIA}명까지 보유할 수 있습니다`;
  }
  return null;
}

/** 직전 시즌 보수 순위 기반 FA 보상 (2026 개정 규정, 보상금 방식) */
export function faCompensation(previousSalaryRank: number | null, salary: number): { tier: string; amount: number } {
  if (previousSalaryRank === null) return { tier: "보상 없음", amount: 0 };
  if (previousSalaryRank <= 30) return { tier: "보수 30위 이내 (보수 100%)", amount: salary };
  if (previousSalaryRank <= 40) return { tier: "보수 31~40위 (보수 50%)", amount: Math.round(salary * 0.5) };
  return { tier: "보상 없음 (41위 이하)", amount: 0 };
}

export function formatKrw(manwon: number): string {
  if (manwon >= 10000) {
    const eok = Math.floor(manwon / 10000);
    const rest = manwon % 10000;
    return rest === 0 ? `${eok}억` : `${eok}억 ${rest.toLocaleString()}만`;
  }
  return `${manwon.toLocaleString()}만`;
}
