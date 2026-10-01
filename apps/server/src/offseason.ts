/**
 * KBL Manager — 비시즌 (NBA2K 마이GM / FM 스타일)
 *
 * 챔피언결정전이 끝나면 비시즌이 시작되고 아래 단계를 차례로 진행한다.
 *
 * 1. 연봉협상·재계약 (stage='resign')
 *    - 계약기간이 남은 국내선수: KBL처럼 매 시즌 보수를 다시 협상 (kind='salary').
 *      제시액을 계속 거절하면 KBL 재정위원회 "보수 조정"으로 넘어가며, 선수 요구액과 구단 제시액 중
 *      공정가치(fair value)에 더 가까운 쪽으로 결정된다 (2026 이관희 조정 사례와 동일한 방식).
 *    - 계약이 끝난 국내선수(FA): 원소속 구단 우선 협상 (kind='fa_resign', 보수+계약기간).
 *    - 외국선수/아시아쿼터: 1년 단위 재계약 (kind='foreign_resign', 달러).
 *    - AI 구단도 같은 규칙으로 자동 처리.
 * 2. FA 시장 (stage='fa', FA_DAYS일)
 *    - 재계약 못 한 FA + 외국선수 시장(해외리그 기록 기반 가상 선수) + 아시아쿼터 후보.
 *    - 유저와 AI 구단이 제안 → 매일 선수가 가장 좋은 제안을 선택 (날이 갈수록 눈높이를 낮춤).
 *    - 샐러리캡(외부 영입은 30억 하드캡) / 외국선수 연봉 한도 / 등록 인원 한도 검사.
 *    - 직전 시즌 보수 순위에 따른 FA 보상금(2026 개정 규정) 기록.
 * 3. 신인 드래프트 (자동, 2라운드, 정규시즌 역순)
 * 4. 새 시즌 시작 (stage='ready' → startNewSeason): 비시즌 성장/노화, 은퇴, 일정 생성
 */
import { Pool, PoolClient } from "pg";
import { loadLeaguePlayers, LeaguePlayer, ageOn } from "./rosterBuilder";
import {
  teamPayroll, checkContract, faCompensation, formatKrw, MIN_SALARY, FOREIGN_SINGLE_CAP_USD, FOREIGN_TOTAL_CAP_USD,
  ASIA_CAP_USD, MAX_DOMESTIC_ROSTER, MIN_DOMESTIC_ROSTER, SOFT_CAP_LIMIT, MAX_CONTRACT_YEARS, DOMESTIC_CAP, MIN_CAP_RATIO,
} from "./salaryCap";
import { generateDraftClass, generateForeignPool } from "./generatedPlayers";
import { processOffseasonDevelopment } from "./development";
import { generateKblCalendarSchedule, addDays, parseDate, formatDate } from "../../../packages/simulation-engine/seasonScheduler";
import { regularSeasonRanking } from "./playoffs";

type Db = Pool | PoolClient;

export const FA_DAYS = 5;
const MAX_NEGOTIATION_ROUNDS = 4;

const round100 = (v: number) => Math.max(MIN_SALARY, Math.round(v / 100) * 100);
const round10k = (v: number) => Math.round(v / 10000) * 10000;

async function franchiseRow(db: Db) {
  const r = await db.query(
    `SELECT f.id, f.season_id, s.year, f.user_team_id, f.offseason_stage, f.fa_day, f.game_date
     FROM franchise f JOIN seasons s ON s.id=f.season_id LIMIT 1`
  );
  const f = r.rows[0];
  return { id: f.id, seasonId: f.season_id, year: f.year as number, endYear: (f.year as number) + 1, userTeamId: f.user_team_id as number, stage: f.offseason_stage as string | null, faDay: f.fa_day as number, date: f.game_date as string };
}

// ============================================================
// 선수 가치 → 공정 연봉
// ============================================================

export interface PlayerValue {
  player: LeaguePlayer;
  score: number;
  fair: number;          // 국내: 만원 / 외국·아시아: 달러
  desiredYears: number;
  games: number;
  ppg: number;
  rpg: number;
  apg: number;
}

export async function computePlayerValues(db: Db, seasonId: number, date: string): Promise<Map<number, PlayerValue>> {
  const players = await loadLeaguePlayers(db, date, { includeFreeAgents: true });
  const statRes = await db.query(
    `SELECT s.player_id, COUNT(*) AS g, AVG(s.min) AS min, AVG(s.pts) AS pts, AVG(s.reb) AS reb, AVG(s.ast) AS ast,
            AVG(s.pts + s.reb + s.ast + s.stl + s.blk - s.tov - (s.fga - s.fgm) - 0.5*(s.fta - s.ftm)) AS eff
     FROM player_game_stats s JOIN games g ON g.id=s.game_id
     WHERE g.season_id=$1 AND s.min > 0 GROUP BY s.player_id`,
    [seasonId]
  );
  const stats = new Map(statRes.rows.map((r) => [r.player_id, r]));
  const salRes = await db.query(`SELECT salary_krw FROM contracts WHERE contract_type='domestic' AND salary_krw IS NOT NULL ORDER BY salary_krw DESC`);
  const salaries = salRes.rows.map((r) => Number(r.salary_krw));

  const scored = players.map((p) => {
    const st = stats.get(p.id);
    const games = st ? Number(st.g) : 0;
    let score = p.ratings.overall;
    if (games >= 10) score += Math.max(-4, Math.min(8, (Number(st.eff) - 6) * 0.6));
    if (p.age >= 35) score -= 6; else if (p.age >= 33) score -= 3;
    if (p.age <= 24 && p.potential) score += (p.potential - 70) * 0.1;
    const desiredYears = p.age <= 27 ? (p.age <= 24 ? 5 : 4) : p.age <= 31 ? 3 : p.age <= 34 ? 2 : 1;
    return {
      player: p, score, fair: 0, desiredYears, games,
      ppg: st ? Number(st.pts) : 0, rpg: st ? Number(st.reb) : 0, apg: st ? Number(st.ast) : 0,
    };
  });

  const rankWithin = (type: string) => scored.filter((s) => s.player.contractType === type).sort((a, b) => b.score - a.score);
  const domestic = rankWithin("domestic");
  const currentSalary = new Map<number, number>(
    (await db.query(`SELECT player_id, salary_krw FROM contracts WHERE contract_type='domestic'`)).rows.map((r) => [r.player_id, Number(r.salary_krw)])
  );
  domestic.forEach((v, i) => {
    const q = i / Math.max(1, domestic.length - 1);
    const idx = Math.min(salaries.length - 1, Math.floor(q * salaries.length));
    const byRank = salaries[idx] ?? MIN_SALARY;
    // 시장 관성: 능력치 순위만으로 연봉이 급변하지 않도록 현재 보수와 섞는다
    // (스타 선수의 몸값은 한 시즌 부진으로 1/5이 되지 않는다)
    const current = currentSalary.get(v.player.id);
    const blended = current ? byRank * 0.55 + current * 0.45 : byRank;
    v.fair = round100(v.player.age >= 34 ? blended * 0.85 : blended);
  });
  const foreign = rankWithin("foreign");
  foreign.forEach((v, i) => {
    const q = 1 - i / Math.max(1, foreign.length - 1);
    v.fair = Math.min(FOREIGN_SINGLE_CAP_USD, round10k(250000 + q * 450000));
  });
  const asia = rankWithin("asia");
  asia.forEach((v, i) => {
    const q = 1 - i / Math.max(1, asia.length - 1);
    v.fair = Math.min(ASIA_CAP_USD, round10k(100000 + q * 100000));
  });
  return new Map(scored.map((s) => [s.player.id, s]));
}

// ============================================================
// 1. 비시즌 시작 → 연봉협상/재계약 단계
// ============================================================

export async function startOffseason(db: Db): Promise<string[]> {
  const f = await franchiseRow(db);
  const events: string[] = [];
  await db.query(`UPDATE franchise SET offseason_stage='resign', fa_day=0 WHERE id=$1`, [f.id]);
  await db.query(`DELETE FROM negotiations WHERE season_year=$1`, [f.endYear]);

  const values = await computePlayerValues(db, f.seasonId, f.date);

  // 직전 시즌 보수 순위 기록 (FA 보상 규정용)
  await db.query(
    `UPDATE players p SET prev_salary_rank = r.rk
     FROM (SELECT player_id, RANK() OVER (ORDER BY salary_krw DESC) AS rk FROM contracts WHERE contract_type='domestic') r
     WHERE r.player_id = p.id`
  );

  const contracted = await db.query(
    `SELECT p.id, p.name, p.team_id, p.birth_date, c.contract_type, c.salary_krw, c.salary_usd, c.fa_year
     FROM players p JOIN contracts c ON c.player_id=p.id
     WHERE p.team_id IS NOT NULL AND NOT p.is_retired`
  );

  for (const row of contracted.rows) {
    const v = values.get(row.id);
    if (!v) continue;
    const age = ageOn(row.birth_date, f.date);
    const expiring = row.fa_year <= f.endYear;

    // 계약 만료 고령 선수 은퇴
    if (expiring && age >= 36 && Math.random() < (age - 35) * 0.3) {
      await retirePlayer(db, row.id, f.endYear, `${row.name} 은퇴 발표 (만 ${age}세)`);
      if (row.team_id === f.userTeamId) events.push(`${row.name} 선수가 은퇴를 발표했습니다`);
      continue;
    }
    if (row.team_id !== f.userTeamId) continue; // AI 구단은 단계 종료 시 일괄 처리

    if (row.contract_type === "domestic") {
      const current = Number(row.salary_krw);
      if (expiring) {
        const ask = round100(Math.max(v.fair * 1.1, MIN_SALARY));
        await insertNegotiation(db, f.endYear, row.id, row.team_id, "fa_resign", ask, v.desiredYears, v.fair,
          `FA 자격 취득. ${formatKrw(ask)} · ${v.desiredYears}년 계약을 원합니다`);
      } else {
        const ask = round100(v.fair > current ? Math.max(v.fair * 1.05, current * 1.05) : Math.max(v.fair, current * 0.95));
        await insertNegotiation(db, f.endYear, row.id, row.team_id, "salary", ask, 1, v.fair,
          ask > current ? `활약을 인정받고 싶습니다. ${formatKrw(ask)}을(를) 원합니다` : `현재 수준(${formatKrw(ask)}) 유지를 원합니다`);
      }
    } else if (expiring) {
      const cap = row.contract_type === "foreign" ? FOREIGN_SINGLE_CAP_USD : ASIA_CAP_USD;
      const ask = Math.min(cap, round10k(Math.max(v.fair * 1.05, Number(row.salary_usd) * 0.9)));
      await insertNegotiation(db, f.endYear, row.id, row.team_id, "foreign_resign", ask, 1, v.fair,
        `재계약 시 $${ask.toLocaleString()}을(를) 원합니다`);
    }
  }
  events.push("비시즌 시작: 연봉협상과 FA 재계약을 진행하세요");
  return events;
}

async function insertNegotiation(db: Db, year: number, playerId: number, teamId: number, kind: string, ask: number, years: number, fair: number, message: string) {
  await db.query(
    `INSERT INTO negotiations (season_year, player_id, team_id, kind, asking_amount, asking_years, fair_value, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [year, playerId, teamId, kind, ask, years, fair, message]
  );
}

async function retirePlayer(db: Db, playerId: number, year: number, description: string) {
  const r = await db.query(`SELECT team_id FROM players WHERE id=$1`, [playerId]);
  await db.query(`UPDATE players SET is_retired=TRUE, previous_team_id=team_id, team_id=NULL WHERE id=$1`, [playerId]);
  await db.query(`DELETE FROM contracts WHERE player_id=$1`, [playerId]);
  await db.query(`INSERT INTO transactions (season_year, team_id, player_id, kind, description) VALUES ($1,$2,$3,'retire',$4)`, [year, r.rows[0]?.team_id ?? null, playerId, description]);
}

async function logTx(db: Db, year: number, teamId: number | null, playerId: number, kind: string, description: string) {
  await db.query(`INSERT INTO transactions (season_year, team_id, player_id, kind, description) VALUES ($1,$2,$3,$4,$5)`, [year, teamId, playerId, kind, description]);
}

// ============================================================
// 협상 (유저)
// ============================================================

export async function offerNegotiation(pool: Pool, negotiationId: number, amount: number, years: number) {
  const f = await franchiseRow(pool);
  if (f.stage !== "resign") throw new Error("연봉협상 기간이 아닙니다");
  const r = await pool.query(
    `SELECT n.*, p.name, c.salary_krw, c.salary_usd, c.contract_type FROM negotiations n
     JOIN players p ON p.id=n.player_id JOIN contracts c ON c.player_id=n.player_id WHERE n.id=$1`,
    [negotiationId]
  );
  const n = r.rows[0];
  if (!n || n.team_id !== f.userTeamId) throw new Error("협상을 찾을 수 없습니다");
  if (n.status !== "open") throw new Error("이미 종료된 협상입니다");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("금액을 입력하세요");
  years = n.kind === "fa_resign" ? Math.max(1, Math.min(MAX_CONTRACT_YEARS, Math.round(years || 1))) : 1;
  amount = n.contract_type === "domestic" ? round100(amount) : round10k(amount);

  const payroll = await teamPayroll(pool, f.userTeamId);
  const current = n.contract_type === "domestic" ? Number(n.salary_krw) : Number(n.salary_usd);
  const capErr = checkContract(payroll, n.contract_type, amount, { replacingAmount: current, isOwnPlayer: true });
  if (capErr) throw new Error(capErr);

  const ask = Number(n.asking_amount);
  const yearsPenalty = n.kind === "fa_resign" && Math.abs(years - n.asking_years) >= 2 ? 1.05 : 1;
  const rounds = n.rounds + 1;
  let status = "open";
  let message: string;
  let newAsk = ask;
  const fmt = (v: number) => (n.contract_type === "domestic" ? formatKrw(v) : `$${v.toLocaleString()}`);

  if (amount >= ask * yearsPenalty) {
    status = "accepted";
    message = `${n.name}: "좋습니다. ${fmt(amount)}${n.kind === "fa_resign" ? `, ${years}년` : ""} 조건에 사인하겠습니다."`;
    await applyNegotiatedContract(pool, n, amount, years, f.endYear);
  } else if (amount >= ask * 0.88) {
    newAsk = n.contract_type === "domestic" ? round100((ask + amount) / 2 + ask * 0.01) : round10k((ask + amount) / 2);
    message = `${n.name}: "조금만 더 써 주세요. ${fmt(newAsk)}이면 사인하겠습니다."`;
  } else {
    message = `${n.name}: "제 가치에 한참 못 미치는 제안입니다. (요구액 ${fmt(ask)})"`;
  }
  if (status === "open" && rounds >= MAX_NEGOTIATION_ROUNDS) {
    if (n.kind === "salary") {
      status = "arbitration";
      message += " → 합의 실패, KBL 재정위원회에 보수 조정을 신청합니다.";
    } else {
      status = "declined";
      message += " → 협상 결렬. FA 시장에 나갑니다.";
    }
  }
  await pool.query(
    `UPDATE negotiations SET asking_amount=$2, last_offer=$3, last_offer_years=$4, rounds=$5, status=$6, message=$7 WHERE id=$1`,
    [negotiationId, newAsk, amount, years, rounds, status, message]
  );
  return { status, message, askingAmount: newAsk };
}

async function applyNegotiatedContract(db: Db, n: any, amount: number, years: number, endYear: number) {
  if (n.contract_type === "domestic") {
    if (n.kind === "fa_resign") {
      await db.query(`UPDATE contracts SET salary_krw=$2, fa_year=$3, source='negotiated', signed_year=$4 WHERE player_id=$1`, [n.player_id, amount, endYear + years, endYear]);
      await logTx(db, endYear, n.team_id, n.player_id, "re-sign", `${n.name} FA 재계약 (${years}년, ${formatKrw(amount)})`);
    } else {
      await db.query(`UPDATE contracts SET salary_krw=$2, source='negotiated' WHERE player_id=$1`, [n.player_id, amount]);
      await logTx(db, endYear, n.team_id, n.player_id, "salary", `${n.name} 보수 협상 완료 (${formatKrw(amount)})`);
    }
  } else {
    await db.query(`UPDATE contracts SET salary_usd=$2, fa_year=$3, source='negotiated', signed_year=$4 WHERE player_id=$1`, [n.player_id, amount, endYear + 1, endYear]);
    await logTx(db, endYear, n.team_id, n.player_id, "re-sign", `${n.name} 재계약 (1년, $${amount.toLocaleString()})`);
  }
}

/** 유저가 자기 팀 선수 방출 (비시즌에만) */
export async function releasePlayer(pool: Pool, playerId: number) {
  const f = await franchiseRow(pool);
  if (!f.stage) throw new Error("선수 방출은 비시즌에만 가능합니다");
  const r = await pool.query(`SELECT name, team_id FROM players WHERE id=$1`, [playerId]);
  if (r.rows[0]?.team_id !== f.userTeamId) throw new Error("우리 팀 선수가 아닙니다");
  await pool.query(`UPDATE players SET previous_team_id=team_id, team_id=NULL WHERE id=$1`, [playerId]);
  await pool.query(`UPDATE contracts SET fa_year=$2 WHERE player_id=$1`, [playerId, f.endYear]);
  await pool.query(`UPDATE negotiations SET status='declined' WHERE player_id=$1 AND season_year=$2 AND status='open'`, [playerId, f.endYear]);
  await pool.query(`DELETE FROM player_roster_settings WHERE player_id=$1`, [playerId]);
  await logTx(pool, f.endYear, f.userTeamId, playerId, "release", `${r.rows[0].name} 방출`);
  return { ok: true };
}

// ============================================================
// 1단계 종료: 미합의 처리 + AI 구단 처리 → FA 시장 개장
// ============================================================

async function finalizeResign(db: Db): Promise<string[]> {
  const f = await franchiseRow(db);
  const events: string[] = [];
  const values = await computePlayerValues(db, f.seasonId, f.date);

  // 유저 팀 협상 마무리
  const negs = await db.query(
    `SELECT n.*, p.name, c.salary_krw, c.salary_usd, c.contract_type FROM negotiations n
     JOIN players p ON p.id=n.player_id JOIN contracts c ON c.player_id=n.player_id
     WHERE n.season_year=$1 AND n.team_id=$2`,
    [f.endYear, f.userTeamId]
  );
  for (const n of negs.rows) {
    if (n.status === "accepted") continue;
    if (n.kind === "salary") {
      // 보수 조정 (재정위원회): 선수 요구액 vs 구단 제시액 중 공정가치에 가까운 쪽
      const teamOffer = n.last_offer ?? Number(n.salary_krw);
      const ask = Number(n.asking_amount);
      const fair = Number(n.fair_value);
      const decided = Math.abs(ask - fair) < Math.abs(teamOffer - fair) ? ask : teamOffer;
      await db.query(`UPDATE contracts SET salary_krw=$2, source='arbitration' WHERE player_id=$1`, [n.player_id, decided]);
      await db.query(`UPDATE negotiations SET status='arbitration', message=$2 WHERE id=$1`, [n.id,
        `재정위원회 결정: ${decided === ask ? "선수" : "구단"} 제시액 ${formatKrw(decided)} 채택`]);
      events.push(`[보수 조정] ${n.name}: ${decided === ask ? "선수" : "구단"} 제시액 ${formatKrw(decided)}으로 결정`);
      await logTx(db, f.endYear, f.userTeamId, n.player_id, "arbitration", `${n.name} 보수 조정 결정 (${formatKrw(decided)})`);
    } else {
      await toFreeAgent(db, n.player_id, f.endYear, `${n.name} FA 시장 진출`);
      events.push(`${n.name} 선수가 FA 시장에 나갔습니다`);
    }
  }

  // AI 구단
  const contracted = await db.query(
    `SELECT p.id, p.name, p.team_id, c.contract_type, c.salary_krw, c.salary_usd, c.fa_year
     FROM players p JOIN contracts c ON c.player_id=p.id
     WHERE p.team_id IS NOT NULL AND p.team_id <> $1 AND NOT p.is_retired`,
    [f.userTeamId]
  );
  const byTeam = new Map<number, typeof contracted.rows>();
  contracted.rows.forEach((r) => byTeam.set(r.team_id, [...(byTeam.get(r.team_id) ?? []), r]));

  for (const [teamId, rows] of byTeam) {
    const teamScores = rows.filter((r) => r.contract_type === "domestic").map((r) => values.get(r.id)?.score ?? 0).sort((a, b) => b - a);
    const keepThreshold = teamScores[10] ?? 0; // 국내 상위 11명 안이면 잔류 우선
    for (const r of rows) {
      const v = values.get(r.id);
      if (!v) continue;
      const expiring = r.fa_year <= f.endYear;
      if (r.contract_type === "domestic" && !expiring) {
        const current = Number(r.salary_krw);
        const next = round100(current * 0.5 + v.fair * 0.5);
        const payroll = await teamPayroll(db, teamId);
        if (!checkContract(payroll, "domestic", next, { replacingAmount: current, isOwnPlayer: true })) {
          await db.query(`UPDATE contracts SET salary_krw=$2, source='negotiated' WHERE player_id=$1`, [r.id, next]);
        }
      } else if (r.contract_type === "domestic" && expiring) {
        const wants = v.score >= keepThreshold || v.player.age <= 26;
        const testsMarket = v.score > 76 && Math.random() < 0.3;
        const amount = round100(v.fair * (0.95 + Math.random() * 0.15));
        const payroll = await teamPayroll(db, teamId);
        const ok = !checkContract(payroll, "domestic", amount, { replacingAmount: Number(r.salary_krw), isOwnPlayer: true });
        if (wants && !testsMarket && ok) {
          const years = Math.max(1, v.desiredYears - (Math.random() < 0.3 ? 1 : 0));
          await db.query(`UPDATE contracts SET salary_krw=$2, fa_year=$3, source='negotiated', signed_year=$4 WHERE player_id=$1`, [r.id, amount, f.endYear + years, f.endYear]);
          await logTx(db, f.endYear, teamId, r.id, "re-sign", `${r.name} FA 재계약 (${years}년, ${formatKrw(amount)})`);
        } else {
          await toFreeAgent(db, r.id, f.endYear, `${r.name} FA 시장 진출`);
        }
      } else if (expiring) {
        const teamForeign = rows.filter((x) => x.contract_type === r.contract_type).map((x) => values.get(x.id)?.score ?? 0);
        const best = Math.max(...teamForeign);
        const keep = v.score >= best - 2 ? Math.random() < 0.75 : Math.random() < 0.35;
        if (keep) {
          const cap = r.contract_type === "foreign" ? FOREIGN_SINGLE_CAP_USD : ASIA_CAP_USD;
          await db.query(`UPDATE contracts SET salary_usd=$2, fa_year=$3, source='negotiated', signed_year=$3 WHERE player_id=$1`, [r.id, Math.min(cap, v.fair), f.endYear + 1]);
        } else {
          await toFreeAgent(db, r.id, f.endYear, `${r.name} 재계약 불발`);
        }
      }
    }
  }

  const pool = await generateForeignPool(db, f.endYear, f.seasonId);
  events.push(`외국선수 시장 개장: 후보 ${pool.length}명 (해외리그 기록 기반 평가)`);
  await db.query(`UPDATE franchise SET offseason_stage='fa', fa_day=1 WHERE id=$1`, [f.id]);
  events.push(`FA 시장 개장 (${FA_DAYS}일간). 원하는 선수에게 제안하세요`);
  return events;
}

async function toFreeAgent(db: Db, playerId: number, year: number, description: string) {
  const r = await db.query(`SELECT team_id FROM players WHERE id=$1`, [playerId]);
  await db.query(`UPDATE players SET previous_team_id=team_id, team_id=NULL WHERE id=$1`, [playerId]);
  await db.query(`DELETE FROM player_roster_settings WHERE player_id=$1`, [playerId]);
  await logTx(db, year, r.rows[0]?.team_id ?? null, playerId, "fa", description);
}

// ============================================================
// 2. FA 시장
// ============================================================

export async function freeAgentList(db: Db) {
  const f = await franchiseRow(db);
  const values = await computePlayerValues(db, f.seasonId, f.date);
  const r = await db.query(
    `SELECT p.id, p.name, p.position, p.position_group, p.nationality, p.birth_date, p.previous_team_id, p.prev_salary_rank,
            pt.name AS previous_team, c.contract_type, c.salary_krw, c.salary_usd, p.is_generated,
            (SELECT COUNT(*) FROM fa_offers o WHERE o.player_id=p.id AND o.season_year=$1) AS offers,
            (SELECT amount FROM fa_offers o WHERE o.player_id=p.id AND o.season_year=$1 AND o.team_id=$2) AS my_offer,
            (SELECT years FROM fa_offers o WHERE o.player_id=p.id AND o.season_year=$1 AND o.team_id=$2) AS my_offer_years
     FROM players p JOIN contracts c ON c.player_id=p.id LEFT JOIN teams pt ON pt.id=p.previous_team_id
     WHERE p.team_id IS NULL AND NOT p.is_retired`,
    [f.endYear, f.userTeamId]
  );
  return r.rows.map((row) => {
    const v = values.get(row.id);
    const fair = v?.fair ?? 0;
    const ask = row.contract_type === "domestic" ? round100(fair * 1.1) : Math.round(fair * 1.05 / 10000) * 10000;
    const comp = row.contract_type === "domestic" && row.previous_team_id && row.previous_team_id !== f.userTeamId
      ? faCompensation(row.prev_salary_rank, Number(row.salary_krw)) : { tier: "보상 없음", amount: 0 };
    return {
      id: row.id, name: row.name, position: row.position, positionGroup: row.position_group, nationality: row.nationality,
      age: ageOn(row.birth_date, f.date), contractType: row.contract_type, previousTeam: row.previous_team,
      previousSalary: row.contract_type === "domestic" ? Number(row.salary_krw) : Number(row.salary_usd),
      overall: v?.player.ratings.overall ?? 0, offense: v?.player.ratings.offense ?? 0, defense: v?.player.ratings.defense ?? 0,
      potential: v?.player.potential ?? null, ppg: v?.ppg ?? 0, rpg: v?.rpg ?? 0, apg: v?.apg ?? 0,
      askingAmount: ask, desiredYears: row.contract_type === "domestic" ? v?.desiredYears ?? 1 : 1,
      offers: Number(row.offers), myOffer: row.my_offer, myOfferYears: row.my_offer_years,
      compensation: comp, isGenerated: row.is_generated,
    };
  }).sort((a, b) => b.overall - a.overall);
}

export async function makeFaOffer(pool: Pool, playerId: number, amount: number, years: number) {
  const f = await franchiseRow(pool);
  if (f.stage !== "fa") throw new Error("FA 시장 기간이 아닙니다");
  const r = await pool.query(
    `SELECT p.team_id, p.previous_team_id, p.is_retired, c.contract_type FROM players p JOIN contracts c ON c.player_id=p.id WHERE p.id=$1`,
    [playerId]
  );
  const p = r.rows[0];
  if (!p || p.team_id !== null || p.is_retired) throw new Error("FA 선수가 아닙니다");
  years = p.contract_type === "domestic" ? Math.max(1, Math.min(MAX_CONTRACT_YEARS, Math.round(years || 1))) : 1;
  amount = p.contract_type === "domestic" ? round100(amount) : round10k(amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("금액을 입력하세요");
  const payroll = await teamPayroll(pool, f.userTeamId);
  // 이미 낸 다른 제안들도 모두 성사된다고 가정하고 캡 검사 (동시다발 제안으로 캡을 넘기는 꼼수 방지)
  const pending = await pool.query(
    `SELECT o.amount, c.contract_type FROM fa_offers o JOIN contracts c ON c.player_id=o.player_id
     WHERE o.season_year=$1 AND o.team_id=$2 AND o.player_id<>$3`,
    [f.endYear, f.userTeamId, playerId]
  );
  for (const o of pending.rows) {
    if (o.contract_type === "domestic") { payroll.domesticTotal += o.amount; payroll.domesticCount++; }
    else if (o.contract_type === "foreign") { payroll.foreignTotalUsd += o.amount; payroll.foreignCount++; }
    else { payroll.asiaTotalUsd += o.amount; payroll.asiaCount++; }
  }
  const err = checkContract(payroll, p.contract_type, amount, { isOwnPlayer: p.previous_team_id === f.userTeamId, addsRosterSpot: true });
  if (err) throw new Error(err);
  await pool.query(
    `INSERT INTO fa_offers (season_year, player_id, team_id, amount, years, offer_day) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (season_year, player_id, team_id) DO UPDATE SET amount=$4, years=$5, offer_day=$6`,
    [f.endYear, playerId, f.userTeamId, amount, years, f.faDay]
  );
  return { ok: true };
}

export async function withdrawFaOffer(pool: Pool, playerId: number) {
  const f = await franchiseRow(pool);
  await pool.query(`DELETE FROM fa_offers WHERE season_year=$1 AND player_id=$2 AND team_id=$3`, [f.endYear, playerId, f.userTeamId]);
  return { ok: true };
}

/** AI 구단들의 FA 제안 */
async function aiFaOffers(db: Db, f: Awaited<ReturnType<typeof franchiseRow>>, values: Map<number, PlayerValue>) {
  const fas = (await db.query(`SELECT p.id, c.contract_type FROM players p JOIN contracts c ON c.player_id=p.id WHERE p.team_id IS NULL AND NOT p.is_retired`)).rows;
  const teams = (await db.query(`SELECT id FROM teams WHERE id <> $1`, [f.userTeamId])).rows.map((r) => r.id);
  const ranked = fas.map((x) => ({ ...x, v: values.get(x.id)! })).filter((x) => x.v).sort((a, b) => b.v.score - a.v.score);

  for (const teamId of teams) {
    const payroll = await teamPayroll(db, teamId);
    const existing = await db.query(`SELECT o.amount, c.contract_type FROM fa_offers o JOIN contracts c ON c.player_id=o.player_id WHERE o.season_year=$1 AND o.team_id=$2`, [f.endYear, teamId]);
    for (const o of existing.rows) {
      if (o.contract_type === "domestic") { payroll.domesticTotal += o.amount; payroll.domesticCount++; }
      else if (o.contract_type === "foreign") { payroll.foreignTotalUsd += o.amount; payroll.foreignCount++; }
      else { payroll.asiaTotalUsd += o.amount; payroll.asiaCount++; }
    }
    const roster = values.size ? [...values.values()].filter((v) => v.player.teamId === teamId) : [];
    const domesticScores = roster.filter((v) => v.player.contractType === "domestic").map((v) => v.score).sort((a, b) => b - a);
    const eighth = domesticScores[7] ?? 0;
    let made = 0;
    for (const c of ranked) {
      if (made >= 2) break;
      const already = await db.query(`SELECT 1 FROM fa_offers WHERE season_year=$1 AND player_id=$2 AND team_id=$3`, [f.endYear, c.id, teamId]);
      if (already.rows.length) continue;
      let amount: number;
      let years = 1;
      if (c.contract_type === "domestic") {
        const need = payroll.domesticCount < 14 || c.v.score > eighth + 1;
        if (!need) continue;
        amount = round100(c.v.fair * (0.9 + Math.random() * 0.25));
        years = Math.max(1, c.v.desiredYears - (Math.random() < 0.4 ? 1 : 0));
      } else if (c.contract_type === "foreign") {
        if (payroll.foreignCount >= 2) continue;
        amount = Math.min(FOREIGN_SINGLE_CAP_USD, FOREIGN_TOTAL_CAP_USD - payroll.foreignTotalUsd, round10k(c.v.fair * (0.95 + Math.random() * 0.1)));
        if (amount < 200000) continue;
      } else {
        if (payroll.asiaCount >= 1) continue;
        amount = Math.min(ASIA_CAP_USD, round10k(c.v.fair));
      }
      if (checkContract(payroll, c.contract_type, amount, { addsRosterSpot: true })) continue;
      if (Math.random() < 0.35) continue; // 모든 구단이 모든 선수에게 달려들지는 않음
      await db.query(
        `INSERT INTO fa_offers (season_year, player_id, team_id, amount, years, offer_day) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [f.endYear, c.id, teamId, amount, years, f.faDay]
      );
      if (c.contract_type === "domestic") { payroll.domesticTotal += amount; payroll.domesticCount++; }
      else if (c.contract_type === "foreign") { payroll.foreignTotalUsd += amount; payroll.foreignCount++; }
      else { payroll.asiaTotalUsd += amount; payroll.asiaCount++; }
      made++;
    }
  }
}

/** FA 선수들의 결정 (하루) */
async function faDecisions(db: Db, f: Awaited<ReturnType<typeof franchiseRow>>, values: Map<number, PlayerValue>, lastDay: boolean): Promise<string[]> {
  const events: string[] = [];
  const offers = await db.query(
    `SELECT o.*, p.name, p.previous_team_id, p.prev_salary_rank, c.contract_type, c.salary_krw, t.name AS team_name
     FROM fa_offers o JOIN players p ON p.id=o.player_id JOIN contracts c ON c.player_id=o.player_id JOIN teams t ON t.id=o.team_id
     WHERE o.season_year=$1 AND p.team_id IS NULL AND NOT p.is_retired`,
    [f.endYear]
  );
  const standings = await regularSeasonRanking(db, f.seasonId);
  const quality = new Map(standings.map((t, i) => [t, 1 - i / Math.max(1, standings.length - 1)]));
  const byPlayer = new Map<number, typeof offers.rows>();
  offers.rows.forEach((o) => byPlayer.set(o.player_id, [...(byPlayer.get(o.player_id) ?? []), o]));

  for (const [playerId, list] of byPlayer) {
    const v = values.get(playerId);
    if (!v) continue;
    const ask = v.fair * (list[0].contract_type === "domestic" ? 1.1 : 1.05);
    const threshold = ask * Math.max(0.7, 1 - 0.07 * (f.faDay - 1));
    const scored = list.map((o) => ({
      o,
      s: o.amount / Math.max(1, v.fair) + (o.years === v.desiredYears ? 0.04 : -0.02 * Math.abs(o.years - v.desiredYears))
        + (quality.get(o.team_id) ?? 0.5) * 0.08 + (o.team_id === list[0].previous_team_id ? 0.03 : 0) + Math.random() * 0.03,
    })).sort((a, b) => b.s - a.s);
    const best = scored[0].o;
    if (best.amount < threshold && !(lastDay && best.amount >= v.fair * 0.7)) continue;

    // 계약 직전에 캡 재검사 (같은 날 여러 선수가 한 팀을 고른 경우 대비)
    const payroll = await teamPayroll(db, best.team_id);
    const err = checkContract(payroll, best.contract_type, best.amount, { isOwnPlayer: best.previous_team_id === best.team_id, addsRosterSpot: true });
    if (err) {
      await db.query(`DELETE FROM fa_offers WHERE id=$1`, [best.id]);
      if (best.team_id === f.userTeamId) events.push(`${best.name} 영입 실패: ${err}`);
      continue;
    }
    const faYear = f.endYear + (best.contract_type === "domestic" ? best.years : 1);
    if (best.contract_type === "domestic") {
      await db.query(`UPDATE contracts SET salary_krw=$2, fa_year=$3, source='fa', signed_year=$4 WHERE player_id=$1`, [playerId, best.amount, faYear, f.endYear]);
    } else {
      await db.query(`UPDATE contracts SET salary_usd=$2, fa_year=$3, source='fa', signed_year=$4 WHERE player_id=$1`, [playerId, best.amount, faYear, f.endYear]);
    }
    await db.query(`UPDATE players SET team_id=$2 WHERE id=$1`, [playerId, best.team_id]);
    await db.query(`DELETE FROM fa_offers WHERE season_year=$1 AND player_id=$2`, [f.endYear, playerId]);

    const amountLabel = best.contract_type === "domestic" ? formatKrw(best.amount) : `$${Number(best.amount).toLocaleString()}`;
    let desc = `${best.name} → ${best.team_name} (${best.contract_type === "domestic" ? `${best.years}년, ` : ""}${amountLabel})`;
    if (best.contract_type === "domestic" && best.previous_team_id && best.previous_team_id !== best.team_id) {
      const comp = faCompensation(best.prev_salary_rank, Number(best.salary_krw));
      if (comp.amount > 0) desc += ` · 원소속팀 보상금 ${formatKrw(comp.amount)} (${comp.tier})`;
    }
    await logTx(db, f.endYear, best.team_id, playerId, "sign", desc);
    if (best.team_id === f.userTeamId) events.push(`✅ 영입 성공: ${desc}`);
    else if (list.some((o) => o.team_id === f.userTeamId)) events.push(`❌ ${best.name} 선수는 ${best.team_name}을(를) 선택했습니다`);
    else if (v.score >= 76) events.push(`FA 계약: ${desc}`);
  }
  return events;
}

/** FA 종료 후 AI 구단 로스터 보강 (외국선수 2명, 아시아쿼터 1명, 국내 최소 인원) */
async function aiFillRosters(db: Db, f: Awaited<ReturnType<typeof franchiseRow>>, values: Map<number, PlayerValue>) {
  const teams = (await db.query(`SELECT id FROM teams WHERE id <> $1`, [f.userTeamId])).rows.map((r) => r.id);
  for (const teamId of teams) {
    for (const type of ["foreign", "asia", "domestic"] as const) {
      for (let guard = 0; guard < 6; guard++) {
        const payroll = await teamPayroll(db, teamId);
        // 국내: 최소 13명 + 샐러리캡 최소 소진율(70%)을 넘길 때까지 보강
        const needed = type === "foreign" ? payroll.foreignCount < 2 : type === "asia" ? payroll.asiaCount < 1
          : payroll.domesticCount < 13 || (payroll.usageRatio < MIN_CAP_RATIO + 0.02 && payroll.domesticCount < MAX_DOMESTIC_ROSTER);
        if (!needed) break;
        const pool = (await db.query(`SELECT p.id, p.name FROM players p JOIN contracts c ON c.player_id=p.id WHERE p.team_id IS NULL AND NOT p.is_retired AND c.contract_type=$1`, [type])).rows
          .map((r) => ({ ...r, v: values.get(r.id) })).filter((r) => r.v).sort((a, b) => b.v!.score - a.v!.score);
        let signed = false;
        for (const c of pool) {
          const belowFloor = payroll.usageRatio < MIN_CAP_RATIO + 0.02;
          const amount = type === "domestic" ? Math.max(MIN_SALARY, round100(c.v!.fair * (belowFloor ? 1.0 : 0.8)))
            : type === "foreign" ? Math.min(c.v!.fair, FOREIGN_TOTAL_CAP_USD - payroll.foreignTotalUsd) : Math.min(c.v!.fair, ASIA_CAP_USD);
          if (type === "foreign" && amount < 150000) continue;
          if (checkContract(payroll, type, amount, { addsRosterSpot: true })) continue;
          const faYear = f.endYear + (type === "domestic" ? 1 : 1);
          if (type === "domestic") await db.query(`UPDATE contracts SET salary_krw=$2, fa_year=$3, source='fa', signed_year=$4 WHERE player_id=$1`, [c.id, amount, faYear, f.endYear]);
          else await db.query(`UPDATE contracts SET salary_usd=$2, fa_year=$3, source='fa', signed_year=$4 WHERE player_id=$1`, [c.id, amount, faYear, f.endYear]);
          await db.query(`UPDATE players SET team_id=$2 WHERE id=$1`, [c.id, teamId]);
          const tn = (await db.query(`SELECT name FROM teams WHERE id=$1`, [teamId])).rows[0].name;
          await logTx(db, f.endYear, teamId, c.id, "sign", `${c.name} → ${tn} (${type === "domestic" ? formatKrw(amount) : `$${amount.toLocaleString()}`})`);
          signed = true;
          break;
        }
        if (!signed) break;
      }
    }
  }
}

/** 그래도 최소 소진율(70%)에 못 미치는 AI 구단은 소속 선수 보수를 일괄 인상해 맞춘다 */
async function aiMeetCapFloor(db: Db, f: Awaited<ReturnType<typeof franchiseRow>>) {
  const teams = (await db.query(`SELECT id FROM teams WHERE id <> $1`, [f.userTeamId])).rows.map((r) => r.id);
  for (const teamId of teams) {
    const payroll = await teamPayroll(db, teamId);
    const target = DOMESTIC_CAP * (MIN_CAP_RATIO + 0.01);
    if (payroll.domesticTotal >= target || payroll.domesticTotal === 0) continue;
    const ratio = target / payroll.domesticTotal;
    await db.query(
      `UPDATE contracts c SET salary_krw = GREATEST(${MIN_SALARY}, ROUND(c.salary_krw * $2::numeric / 100.0) * 100)
       FROM players p WHERE p.id=c.player_id AND p.team_id=$1 AND c.contract_type='domestic'`,
      [teamId, ratio]
    );
  }
}

// ============================================================
// 3. 신인 드래프트 (자동)
// ============================================================

async function runDraft(db: Db, f: Awaited<ReturnType<typeof franchiseRow>>): Promise<string[]> {
  const events: string[] = [];
  const classIds = await generateDraftClass(db, f.endYear, f.seasonId);
  const order = (await regularSeasonRanking(db, f.seasonId)).reverse(); // 하위팀부터
  const players = await loadLeaguePlayers(db, f.date, { includeFreeAgents: true });
  const prospects = players.filter((p) => classIds.includes(p.id))
    .map((p) => ({ p, score: p.ratings.overall * 0.5 + (p.potential ?? 60) * 0.5 }))
    .sort((a, b) => b.score - a.score);
  let pickNo = 0;
  for (let round = 1; round <= 2; round++) {
    for (const teamId of order) {
      const next = prospects.shift();
      if (!next) break;
      pickNo++;
      const payroll = await teamPayroll(db, teamId);
      if (payroll.domesticCount >= MAX_DOMESTIC_ROSTER && teamId !== f.userTeamId) continue; // 지명권 행사 포기
      const salary = round === 1 ? 10000 - (pickNo - 1) * 400 : Math.max(MIN_SALARY, 5000 - (pickNo - 11) * 100);
      await db.query(`UPDATE players SET team_id=$2, draft_year=$3, draft_overall_pick=$4, draft_category='picked' WHERE id=$1`, [next.p.id, teamId, f.endYear, pickNo]);
      await db.query(
        `INSERT INTO contracts (player_id, contract_type, salary_krw, fa_year, source, signed_year) VALUES ($1,'domestic',$2,$3,'rookie',$4)`,
        [next.p.id, salary, f.endYear + (round === 1 ? 5 : 3), f.endYear]
      );
      const tn = (await db.query(`SELECT name FROM teams WHERE id=$1`, [teamId])).rows[0].name;
      await logTx(db, f.endYear, teamId, next.p.id, "draft", `${f.endYear} 드래프트 ${round}라운드 (전체 ${pickNo}순위) ${next.p.name} — ${tn}`);
      if (teamId === f.userTeamId) events.push(`🎓 드래프트 ${round}라운드(전체 ${pickNo}순위): ${next.p.name} 지명 (잠재력 ${next.p.potential})`);
    }
  }
  // 미지명 선수는 리그에서 제외
  for (const left of prospects) await db.query(`UPDATE players SET is_retired=TRUE WHERE id=$1`, [left.p.id]);
  return events;
}

// ============================================================
// 단계 진행
// ============================================================

export async function advanceOffseason(pool: Pool): Promise<{ stage: string; faDay: number; events: string[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const f = await franchiseRow(client);
    let events: string[] = [];
    if (f.stage === "resign") {
      events = await finalizeResign(client);
    } else if (f.stage === "fa") {
      const values = await computePlayerValues(client, f.seasonId, f.date);
      await aiFaOffers(client, f, values);
      const lastDay = f.faDay >= FA_DAYS;
      events = await faDecisions(client, f, values, lastDay);
      if (lastDay) {
        await aiFillRosters(client, f, await computePlayerValues(client, f.seasonId, f.date));
        events.push(...(await runDraft(client, f)));
        await aiMeetCapFloor(client, f);
        await client.query(`UPDATE franchise SET offseason_stage='ready', game_date=$2 WHERE id=$1`, [f.id, `${f.endYear}-07-01`]);
        events.push("FA 시장과 신인 드래프트가 끝났습니다. 로스터를 확인하고 새 시즌을 시작하세요");
      } else {
        await client.query(`UPDATE franchise SET fa_day=fa_day+1, game_date=$2 WHERE id=$1`, [f.id, addDays(f.date, 1)]);
      }
    } else {
      throw new Error("진행할 비시즌 단계가 없습니다");
    }
    await client.query("COMMIT");
    const after = await franchiseRow(pool);
    return { stage: after.stage ?? "", faDay: after.faDay, events };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function offseasonOverview(pool: Pool) {
  const f = await franchiseRow(pool);
  const negotiations = await pool.query(
    `SELECT n.id, n.kind, n.asking_amount, n.asking_years, n.last_offer, n.last_offer_years, n.rounds, n.status, n.fair_value, n.message,
            p.id AS player_id, p.name, p.position_group, p.birth_date, c.contract_type, c.salary_krw, c.salary_usd, c.fa_year
     FROM negotiations n JOIN players p ON p.id=n.player_id JOIN contracts c ON c.player_id=n.player_id
     WHERE n.season_year=$1 AND n.team_id=$2 ORDER BY n.kind, c.salary_krw DESC NULLS LAST`,
    [f.endYear, f.userTeamId]
  );
  const tx = await pool.query(
    `SELECT t.tx_date, t.kind, t.description, tm.name AS team_name FROM transactions t LEFT JOIN teams tm ON tm.id=t.team_id
     WHERE t.season_year=$1 AND t.kind IN ('sign','re-sign','fa','draft','retire','arbitration','release') ORDER BY t.id DESC LIMIT 80`,
    [f.endYear]
  );
  return {
    stage: f.stage, faDay: f.faDay, faDays: FA_DAYS, endYear: f.endYear,
    payroll: await teamPayroll(pool, f.userTeamId),
    negotiations: negotiations.rows.map((n) => ({ ...n, age: ageOn(n.birth_date, f.date) })),
    transactions: tx.rows,
  };
}

// ============================================================
// 4. 새 시즌 시작
// ============================================================

export function seasonCalendar(year: number) {
  // 개막: 10월 첫 토요일, 종료: 이듬해 4월 둘째 토요일 무렵 (2026-27 실제: 10/3 ~ 4/11)
  const oct1 = parseDate(`${year}-10-01`);
  const start = new Date(oct1);
  start.setUTCDate(1 + ((6 - oct1.getUTCDay() + 7) % 7));
  const apr = parseDate(`${year + 1}-04-01`);
  const end = new Date(apr);
  end.setUTCDate(1 + ((0 - apr.getUTCDay() + 7) % 7) + 7);
  return {
    startDate: formatDate(start),
    endDate: formatDate(end),
    breaks: [
      { from: `${year}-11-23`, to: `${year}-11-29` },        // FIBA 월드컵 예선 윈도우 (11월)
      { from: `${year + 1}-01-16`, to: `${year + 1}-01-19` }, // 올스타 브레이크
      { from: `${year + 1}-02-22`, to: `${year + 1}-03-01` }, // FIBA 윈도우 (2월)
    ],
  };
}

export async function startNewSeason(pool: Pool): Promise<{ seasonLabel: string; startDate: string; warnings: string[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const f = await franchiseRow(client);
    if (f.stage !== "ready") throw new Error("FA 시장과 드래프트를 먼저 마치세요");
    const payroll = await teamPayroll(client, f.userTeamId);
    const warnings: string[] = [];
    if (payroll.domesticCount < MIN_DOMESTIC_ROSTER) throw new Error(`국내선수가 최소 ${MIN_DOMESTIC_ROSTER}명 필요합니다 (현재 ${payroll.domesticCount}명)`);
    if (payroll.domesticCount > MAX_DOMESTIC_ROSTER) throw new Error(`국내선수 등록 한도 ${MAX_DOMESTIC_ROSTER}명 초과 (현재 ${payroll.domesticCount}명) — 방출이 필요합니다`);
    if (payroll.foreignCount < 1) throw new Error("외국선수를 최소 1명 보유해야 합니다");
    if (payroll.domesticTotal > SOFT_CAP_LIMIT) throw new Error("샐러리캡 한도를 초과했습니다");
    if (payroll.domesticTotal > DOMESTIC_CAP) warnings.push(`샐러리캡 초과분 ${formatKrw(payroll.domesticTotal - DOMESTIC_CAP)} — 사치세(초과분 100%) 부과`);
    if (payroll.domesticTotal < DOMESTIC_CAP * MIN_CAP_RATIO) warnings.push(`샐러리캡 최소 소진율(70%) 미달 — 미달분 제재금 부과`);
    if (payroll.foreignCount < 2) warnings.push("외국선수가 1명뿐입니다 (2·3쿼터에 외국선수 1명만 출전)");

    const newYear = f.endYear;
    const label = `${newYear}-${newYear + 1}`;
    const cal = seasonCalendar(newYear);
    const s = await client.query(`INSERT INTO seasons (label, start_date, year) VALUES ($1,$2,$3) RETURNING id`, [label, cal.startDate, newYear]);
    const seasonId = s.rows[0].id;

    // 은퇴: 미계약 34세 이상, 미계약 가상 외국선수
    const fas = await client.query(`SELECT id, name, birth_date, is_generated FROM players WHERE team_id IS NULL AND NOT is_retired`);
    for (const p of fas.rows) {
      if (p.is_generated || ageOn(p.birth_date, cal.startDate) >= 34) {
        await client.query(`UPDATE players SET is_retired=TRUE WHERE id=$1`, [p.id]);
      }
    }
    // AI 구단 등록 인원 초과 정리
    const teams = (await client.query(`SELECT id FROM teams WHERE id <> $1`, [f.userTeamId])).rows.map((r) => r.id);
    for (const teamId of teams) {
      const extra = await client.query(
        `SELECT p.id FROM players p JOIN contracts c ON c.player_id=p.id JOIN player_attributes pa ON pa.player_id=p.id
         WHERE p.team_id=$1 AND c.contract_type='domestic' ORDER BY (pa.finishing+pa.three_point_shooting+pa.passing+pa.defensive_rebounding+pa.steal) ASC`,
        [teamId]
      );
      const over = extra.rows.length - MAX_DOMESTIC_ROSTER;
      for (let i = 0; i < over; i++) await client.query(`UPDATE players SET previous_team_id=team_id, team_id=NULL WHERE id=$1`, [extra.rows[i].id]);
    }

    await processOffseasonDevelopment(client, cal.startDate);
    await client.query(`UPDATE player_condition SET fatigue=0, injured_until=NULL, training_progress='{}'`);
    await client.query(`UPDATE player_attributes SET season_id=$1`, [seasonId]);
    await client.query(`DELETE FROM player_roster_settings prs USING players p WHERE p.id=prs.player_id AND (p.team_id IS NULL OR p.team_id <> prs.team_id)`);

    const teamRows = (await client.query(`SELECT id, name FROM teams ORDER BY id`)).rows;
    const schedule = generateKblCalendarSchedule(teamRows.map((t) => t.name), { startDate: cal.startDate, endDate: cal.endDate, breaks: cal.breaks });
    const idByName = new Map(teamRows.map((t) => [t.name, t.id]));
    await insertSchedule(client, seasonId, schedule, cal.startDate, idByName);

    await client.query(
      `UPDATE franchise SET season_id=$2, game_date=$3, phase='regular', offseason_stage=NULL, fa_day=0, champion_team_id=NULL, current_round=0 WHERE id=$1`,
      [f.id, seasonId, cal.startDate]
    );
    await client.query("COMMIT");
    return { seasonLabel: label, startDate: cal.startDate, warnings };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function insertSchedule(db: Db, seasonId: number, schedule: { round: number; date: string; home: string; away: string }[], startDate: string, idByName: Map<string, number>) {
  const start = parseDate(startDate).getTime();
  await db.query(
    `INSERT INTO games (season_id, round, day_offset, game_date, home_team_id, away_team_id, home_score, away_score, went_to_ot, ot_periods)
     SELECT $1, r, d, gd, h, a, NULL, NULL, FALSE, 0 FROM unnest($2::int[], $3::int[], $4::date[], $5::int[], $6::int[]) AS t(r, d, gd, h, a)`,
    [
      seasonId,
      schedule.map((g) => g.round),
      schedule.map((g) => Math.round((parseDate(g.date).getTime() - start) / 86400000)),
      schedule.map((g) => g.date),
      schedule.map((g) => idByName.get(g.home)!),
      schedule.map((g) => idByName.get(g.away)!),
    ]
  );
}
