/**
 * KBL Manager — 트레이드
 *
 * 선수 가치 = 지금 실력(오버롤) + 미래 가치(잠재력·나이) — 팀 상황에 따라 비중이 다르다.
 *  - 우승 경쟁 팀(상위권): 지금 실력 80% / 미래 20%
 *  - 중위권: 60% / 40%
 *  - 리빌딩 팀(하위권): 40% / 60%, 31세 이상 베테랑 가치는 더 낮게 봄
 *  - 포지션 사정: 주전급이 부족한 포지션 선수는 +15%, 이미 넘치는 포지션은 −10%
 *
 * 성사 조건 (윈윈): 양 팀이 각자 기준으로 평가해서
 *  - 상대(AI) 팀: 받는 가치가 주는 가치보다 3% 이상 커야 함 (이득이 없으면 굳이 바꾸지 않음)
 *  - 우리 팀: 받는 가치가 주는 가치의 95% 이상 (한쪽만 손해 보는 트레이드는 성사 안 됨)
 *  - 간판 선수(팀 최고 가치)를 내주는 경우 AI는 10% 이상 이득일 때만 수락
 * 규정: 국내선수 12~18명, 외국선수 2명, 아시아쿼터 1명 이하, 국내 보수 총액 31.5억 이하(이미 넘으면 늘어나지 않게)
 * 기간: 정규시즌 4라운드 종료일(트레이드 마감)까지 + 비시즌
 *
 * AI 팀끼리의 트레이드는 아주 드물게(한 시즌 최대 1건, 안 일어나는 시즌도 많음) — 우승 경쟁 팀과 리빌딩 팀이
 * 서로 이득인 경우(베테랑 ↔ 유망주)에만 성사된다.
 */
import type { Pool, PoolClient } from "pg";
import { getFranchise, withTx } from "./season";
import { loadLeaguePlayers, LeaguePlayer } from "./rosterBuilder";
import { addNews, shortTeam } from "./news";
import { addDays } from "../../../packages/simulation-engine/seasonScheduler";
import { teamPayroll, SOFT_CAP_LIMIT, MAX_DOMESTIC_ROSTER, MIN_DOMESTIC_ROSTER, MAX_FOREIGN, MAX_ASIA } from "./salaryCap";

type Db = Pool | PoolClient;
export type TeamMode = "contend" | "balanced" | "rebuild";

export const MODE_LABEL: Record<TeamMode, string> = { contend: "우승 경쟁", balanced: "중위권", rebuild: "리빌딩" };
const MODE_WEIGHT: Record<TeamMode, { now: number; future: number }> = {
  contend: { now: 0.8, future: 0.2 },
  balanced: { now: 0.6, future: 0.4 },
  rebuild: { now: 0.4, future: 0.6 },
};
const AI_AI_TRADES_PER_SEASON = 1;
const AI_MIN_GAIN = 0.03;   // 상대 팀은 3% 이상 이득이어야 수락
const USER_MIN_GAIN = -0.05; // 우리 팀이 5% 넘게 손해 보는 트레이드는 성사 안 됨 (윈윈)
const AI_AI_DAILY_CHANCE = 0.008;

/** 오버롤 → 가치 (오버롤 70 = 100, 1 오를 때마다 12%씩 커짐 — 주전급일수록 희소) */
function ovrValue(ovr: number): number {
  return 100 * Math.pow(1.12, ovr - 70);
}

/** 몇 년 뒤 예상 오버롤 (젊고 잠재력이 높을수록 많이 오름) */
export function projectedOverall(p: { overall: number; potential: number | null; age: number }): number {
  if (p.potential === null || p.age > 27) return p.overall;
  const room = Math.max(0, p.potential - p.overall);
  const youth = p.age <= 22 ? 0.75 : p.age <= 24 ? 0.6 : 0.4;
  return p.overall + room * youth;
}

export interface ValuedPlayer {
  id: number; name: string; teamId: number | null; positionGroup: "G" | "F" | "C"; contractType: string;
  age: number; overall: number; potential: number | null; projected: number; salaryKrw: number | null; salaryUsd: number | null;
}

/** 팀 입장에서 본 선수 가치 */
export function playerValue(p: ValuedPlayer, mode: TeamMode, needMult = 1): number {
  const w = MODE_WEIGHT[mode];
  let now = ovrValue(p.overall);
  if (p.age >= 31) now *= Math.max(0.5, 1 - 0.06 * (p.age - 30) * (mode === "rebuild" ? 1.6 : 1));
  const future = ovrValue(p.projected) * (p.age >= 31 ? 0.6 : 1);
  // 외국선수는 1년 계약이라 미래 가치가 거의 없음
  const fut = p.contractType === "foreign" ? now * 0.5 : future;
  return (w.now * now + w.future * fut) * needMult;
}

interface TeamInfo { id: number; name: string; mode: TeamMode; rank: number; players: ValuedPlayer[] }

async function loadTeams(db: Db): Promise<{ f: Awaited<ReturnType<typeof getFranchise>>; teams: Map<number, TeamInfo>; all: LeaguePlayer[] }> {
  const f = await getFranchise(db);
  const all = await loadLeaguePlayers(db, f.date);
  const sal = await db.query(`SELECT player_id, salary_krw, salary_usd FROM contracts`);
  const salMap = new Map(sal.rows.map((r) => [r.player_id, r]));
  const names = await db.query(`SELECT id, name FROM teams ORDER BY id`);
  const st = await db.query(`SELECT team_id, wins, losses FROM standings WHERE season_id=$1`, [f.seasonId]);
  const winPct = new Map(st.rows.map((r) => [r.team_id, Number(r.wins) + Number(r.losses) > 0 ? Number(r.wins) / (Number(r.wins) + Number(r.losses)) : null]));

  const teams = new Map<number, TeamInfo>();
  for (const t of names.rows) {
    const players: ValuedPlayer[] = all.filter((p) => p.teamId === t.id).map((p) => ({
      id: p.id, name: p.name, teamId: p.teamId, positionGroup: p.positionGroup, contractType: p.contractType,
      age: p.age, overall: p.ratings.overall, potential: p.potential,
      projected: projectedOverall({ overall: p.ratings.overall, potential: p.potential, age: p.age }),
      salaryKrw: salMap.get(p.id)?.salary_krw ?? null, salaryUsd: salMap.get(p.id)?.salary_usd ?? null,
    }));
    teams.set(t.id, { id: t.id, name: t.name, mode: "balanced", rank: 0, players });
  }
  // 팀 상황: 시즌 중엔 승률 순위, 개막 전·비시즌엔 전력(상위 8명 평균 오버롤) 순위
  const strength = (t: TeamInfo) => {
    const top = [...t.players].sort((a, b) => b.overall - a.overall).slice(0, 8);
    return top.reduce((a, p) => a + p.overall, 0) / Math.max(1, top.length);
  };
  const gamesPlayed = st.rows.reduce((a, r) => a + Number(r.wins) + Number(r.losses), 0);
  const order = [...teams.values()].sort((a, b) => {
    if (gamesPlayed >= 30 && f.phase !== "offseason") return (winPct.get(b.id) ?? 0) - (winPct.get(a.id) ?? 0);
    return strength(b) - strength(a);
  });
  order.forEach((t, i) => { t.rank = i + 1; t.mode = i < 4 ? "contend" : i >= order.length - 3 ? "rebuild" : "balanced"; });
  return { f, teams, all };
}

/** 포지션 사정: 해당 포지션의 주전급(오버롤 78+) 선수가 적으면 가산, 많으면 감산 */
function needMultiplier(team: TeamInfo, group: string, excludeIds: number[] = []): number {
  const n = team.players.filter((p) => p.positionGroup === group && p.overall >= 78 && !excludeIds.includes(p.id)).length;
  return n <= 1 ? 1.15 : n >= 4 ? 0.9 : 1;
}

function sideValue(team: TeamInfo, incoming: ValuedPlayer[], outgoing: ValuedPlayer[]) {
  const outIds = outgoing.map((p) => p.id);
  const get = incoming.reduce((a, p) => a + playerValue(p, team.mode, needMultiplier(team, p.positionGroup, outIds)), 0);
  const give = outgoing.reduce((a, p) => a + playerValue(p, team.mode), 0);
  return { get, give, gainPct: give > 0 ? (get - give) / give : get > 0 ? 1 : 0 };
}

/** 트레이드 마감일 = 4라운드 마지막 경기일 (games.round는 팀당 경기 순번 1~54, 한 라운드 = 9경기 → 4라운드 끝 = 36번째) */
async function tradeDeadline(db: Db, seasonId: number): Promise<string | null> {
  const r = await db.query(`SELECT MAX(game_date)::text AS d FROM games WHERE season_id=$1 AND round=36 AND series_id IS NULL`, [seasonId]);
  return r.rows[0]?.d ?? null;
}

async function tradeWindow(db: Db, f: Awaited<ReturnType<typeof getFranchise>>): Promise<{ open: boolean; reason: string | null; deadline: string | null }> {
  const deadline = await tradeDeadline(db, f.seasonId);
  if (f.phase === "playoffs") return { open: false, reason: "플레이오프 기간에는 트레이드할 수 없습니다", deadline };
  if (f.phase === "offseason") {
    if (f.offseasonStage === "fa") return { open: false, reason: "FA 시장이 열려 있는 동안에는 트레이드할 수 없습니다", deadline };
    return { open: true, reason: null, deadline };
  }
  if (deadline && f.date > deadline) return { open: false, reason: `트레이드 마감일(${deadline}, 4라운드 종료)이 지났습니다`, deadline };
  return { open: true, reason: null, deadline };
}

/** 규정 검사: 로스터 인원·외국선수·아시아쿼터·보수 총액 */
async function checkRules(db: Db, team: TeamInfo, incoming: ValuedPlayer[], outgoing: ValuedPlayer[]): Promise<string | null> {
  const after = [...team.players.filter((p) => !outgoing.some((o) => o.id === p.id)), ...incoming];
  const count = (t: string) => after.filter((p) => p.contractType === t).length;
  if (count("domestic") > MAX_DOMESTIC_ROSTER) return `${team.name}: 국내선수가 ${MAX_DOMESTIC_ROSTER}명을 넘습니다`;
  if (count("domestic") < MIN_DOMESTIC_ROSTER) return `${team.name}: 국내선수가 ${MIN_DOMESTIC_ROSTER}명보다 적어집니다`;
  if (count("foreign") > MAX_FOREIGN) return `${team.name}: 외국선수는 ${MAX_FOREIGN}명까지입니다`;
  if (count("asia") > MAX_ASIA) return `${team.name}: 아시아쿼터는 ${MAX_ASIA}명까지입니다`;
  const payroll = await teamPayroll(db, team.id);
  const delta = incoming.reduce((a, p) => a + (p.contractType === "domestic" ? p.salaryKrw ?? 0 : 0), 0)
    - outgoing.reduce((a, p) => a + (p.contractType === "domestic" ? p.salaryKrw ?? 0 : 0), 0);
  const total = payroll.domesticTotal + delta;
  if (delta > 0 && total > SOFT_CAP_LIMIT) return `${team.name}: 국내 보수 총액이 31.5억을 넘습니다 (트레이드 후 ${(total / 10000).toFixed(1)}억)`;
  return null;
}

export interface TradeEvaluation {
  accepted: boolean;
  verdict: string;
  reasons: string[];
  user: { get: number; give: number; gainPct: number };
  ai: { get: number; give: number; gainPct: number; mode: TeamMode; modeLabel: string };
  ruleError: string | null;
  windowError: string | null;
}

async function evaluate(db: Db, partnerId: number, giveIds: number[], receiveIds: number[]): Promise<TradeEvaluation & { ctx: Awaited<ReturnType<typeof loadTeams>>; give: ValuedPlayer[]; receive: ValuedPlayer[] }> {
  const ctx = await loadTeams(db);
  const { f, teams } = ctx;
  const me = teams.get(f.userTeamId)!;
  const partner = teams.get(partnerId);
  if (!partner || partner.id === me.id) throw new Error("트레이드 상대 팀을 다시 선택하세요");
  const give = giveIds.map((id) => me.players.find((p) => p.id === id)).filter((p): p is ValuedPlayer => !!p);
  const receive = receiveIds.map((id) => partner.players.find((p) => p.id === id)).filter((p): p is ValuedPlayer => !!p);
  if (give.length !== giveIds.length || receive.length !== receiveIds.length) throw new Error("이미 팀을 옮긴 선수가 포함되어 있습니다");

  const window = await tradeWindow(db, f);
  const ruleError = give.length === 0 || receive.length === 0 ? "주는 선수와 받는 선수를 각각 1명 이상 고르세요"
    : (await checkRules(db, me, receive, give)) ?? (await checkRules(db, partner, give, receive));
  const userSide = sideValue(me, receive, give);
  const aiSide = sideValue(partner, give, receive);
  const reasons: string[] = [];
  const partnerBest = [...partner.players].sort((a, b) => playerValue(b, partner.mode) - playerValue(a, partner.mode))[0];
  const givesFace = receive.some((p) => p.id === partnerBest?.id);

  let accepted = !ruleError && !window.reason;
  if (aiSide.gainPct < AI_MIN_GAIN) { accepted = false; reasons.push(`${partner.name}이(가) 얻는 게 없다고 판단했습니다 (상대 평가 ${pct(aiSide.gainPct)}, +${Math.round(AI_MIN_GAIN * 100)}% 이상 필요)`); }
  if (givesFace && aiSide.gainPct < 0.1) { accepted = false; reasons.push(`${partnerBest.name}은(는) 팀의 간판이라 확실한 이득(+10% 이상)이 아니면 내주지 않습니다`); }
  if (userSide.gainPct < USER_MIN_GAIN) { accepted = false; reasons.push(`우리 팀이 너무 손해입니다 (우리 평가 ${pct(userSide.gainPct)}) — 윈윈 트레이드만 성사됩니다`); }
  if (ruleError) reasons.unshift(ruleError);
  if (window.reason) reasons.unshift(window.reason);
  const verdict = accepted ? "수락" : ruleError || window.reason ? "불가" : "거절";
  if (accepted) reasons.push(`${partner.name}(${MODE_LABEL[partner.mode]}) 평가 ${pct(aiSide.gainPct)}, 우리 평가 ${pct(userSide.gainPct)} — 서로 이득`);
  return {
    accepted, verdict, reasons, ruleError, windowError: window.reason,
    user: round(userSide), ai: { ...round(aiSide), mode: partner.mode, modeLabel: MODE_LABEL[partner.mode] },
    ctx, give, receive,
  };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
const round = (x: { get: number; give: number; gainPct: number }) => ({ get: Math.round(x.get), give: Math.round(x.give), gainPct: Math.round(x.gainPct * 1000) / 1000 });

async function executeTrade(db: Db, date: string, seasonYear: number, a: TeamInfo, b: TeamInfo, aGives: ValuedPlayer[], bGives: ValuedPlayer[]) {
  for (const p of aGives) await db.query(`UPDATE players SET previous_team_id=team_id, team_id=$2 WHERE id=$1`, [p.id, b.id]);
  for (const p of bGives) await db.query(`UPDATE players SET previous_team_id=team_id, team_id=$2 WHERE id=$1`, [p.id, a.id]);
  const moved = [...aGives, ...bGives].map((p) => p.id);
  await db.query(`DELETE FROM player_roster_settings WHERE player_id = ANY($1::int[])`, [moved]);
  await db.query(`DELETE FROM player_training_focus WHERE player_id = ANY($1::int[])`, [moved]);
  const short = (n: string) => n.split(" ").slice(1, 2).join(" ") || n;
  const desc = `[트레이드] ${short(a.name)} ${aGives.map((p) => p.name).join("·")} ↔ ${short(b.name)} ${bGives.map((p) => p.name).join("·")}`;
  await db.query(`INSERT INTO transactions (season_year, tx_date, team_id, player_id, kind, description) VALUES ($1,$2,$3,$4,'trade',$5)`,
    [seasonYear, date, a.id, aGives[0]?.id ?? null, desc]);
  return desc;
}

// ============================================================
// API
// ============================================================

/** 트레이드 화면: 우리 팀·상대 팀 선수와 가치, 팀 상황, 마감일 */
export async function tradeContext(pool: Pool, partnerId: number | null) {
  const { f, teams } = await loadTeams(pool);
  const window = await tradeWindow(pool, f);
  const me = teams.get(f.userTeamId)!;
  const partner = partnerId ? teams.get(partnerId) ?? null : null;
  const view = (t: TeamInfo) => ({
    id: t.id, name: t.name, mode: t.mode, modeLabel: MODE_LABEL[t.mode], rank: t.rank,
    players: [...t.players].sort((a, b) => b.overall - a.overall).map((p) => ({ ...p, value: Math.round(playerValue(p, t.mode)) })),
  });
  return {
    window,
    me: view(me),
    partner: partner ? view(partner) : null,
    teams: [...teams.values()].filter((t) => t.id !== me.id).map((t) => ({ id: t.id, name: t.name, mode: t.mode, modeLabel: MODE_LABEL[t.mode] })),
  };
}

export async function evaluateTrade(pool: Pool, partnerId: number, giveIds: number[], receiveIds: number[]) {
  const { ctx: _ctx, give: _g, receive: _r, ...out } = await evaluate(pool, partnerId, giveIds, receiveIds);
  return out;
}

export async function proposeTrade(pool: Pool, partnerId: number, giveIds: number[], receiveIds: number[]) {
  return withTx(pool, async (db) => {
    const ev = await evaluate(db, partnerId, giveIds, receiveIds);
    const { ctx, give, receive, ...out } = ev;
    if (!ev.accepted) return { ...out, executed: false, description: null };
    const me = ctx.teams.get(ctx.f.userTeamId)!;
    const partner = ctx.teams.get(partnerId)!;
    const description = await executeTrade(db, ctx.f.date, ctx.f.seasonYear, me, partner, give, receive);
    await addNews(db, [{ date: ctx.f.date, category: "trade", teamId: me.id, team2Id: partner.id, importance: 3, headline: description.replace("[트레이드] ", "트레이드 성사: ") }]);
    return { ...out, executed: true, description };
  });
}

/**
 * 받고 싶은 선수(들)를 주면, 상대가 수락할 만한 우리 팀 선수 조합(1~2명)을 찾아준다.
 * 우리 팀이 덜 손해 보는(평가가 높은) 순으로 최대 3개.
 */
export async function suggestPackages(pool: Pool, partnerId: number, receiveIds: number[]) {
  const { f, teams } = await loadTeams(pool);
  const me = teams.get(f.userTeamId)!;
  const partner = teams.get(partnerId);
  if (!partner) throw new Error("상대 팀을 찾을 수 없습니다");
  const receive = receiveIds.map((id) => partner.players.find((p) => p.id === id)).filter((p): p is ValuedPlayer => !!p);
  if (receive.length === 0) throw new Error("받고 싶은 선수를 고르세요");
  const pool12 = [...me.players].sort((a, b) => playerValue(b, me.mode) - playerValue(a, me.mode)).slice(0, 14);
  const combos: ValuedPlayer[][] = [];
  pool12.forEach((a, i) => { combos.push([a]); pool12.slice(i + 1).forEach((b) => combos.push([a, b])); });
  const out: { give: { id: number; name: string; overall: number }[]; userGainPct: number; aiGainPct: number }[] = [];
  for (const give of combos) {
    const userSide = sideValue(me, receive, give);
    const aiSide = sideValue(partner, give, receive);
    if (aiSide.gainPct < AI_MIN_GAIN || userSide.gainPct < USER_MIN_GAIN) continue;
    if (await checkRules(pool, me, receive, give) || await checkRules(pool, partner, give, receive)) continue;
    out.push({ give: give.map((p) => ({ id: p.id, name: p.name, overall: p.overall })), userGainPct: round(userSide).gainPct, aiGainPct: round(aiSide).gainPct });
  }
  return out.sort((a, b) => b.userGainPct - a.userGainPct).slice(0, 3);
}

export async function tradeHistory(pool: Pool) {
  const r = await pool.query(`SELECT season_year, tx_date::text AS tx_date, description FROM transactions WHERE kind='trade' ORDER BY id DESC LIMIT 50`);
  return r.rows;
}

/**
 * AI 팀끼리 트레이드 (하루 진행 때 호출) — 아주 드물게.
 * 우승 경쟁 팀의 유망주 ↔ 리빌딩 팀의 베테랑, 같은 계약 유형(국내↔국내 / 외국↔외국)끼리 1대1로만,
 * 양 팀 모두 자기 기준 5% 이상 이득일 때만.
 */
export async function maybeAiTrade(db: Db): Promise<string | null> {
  const f = await getFranchise(db);
  if (f.phase !== "regular") return null;
  const window = await tradeWindow(db, f);
  if (!window.open) return null;
  // AI끼리 트레이드는 첫 번째 팀(team_id)이 항상 AI 팀, 유저 트레이드는 유저 팀으로 기록됨
  const done = await db.query(
    `SELECT COUNT(*) AS n FROM transactions WHERE kind='trade' AND season_year=$1 AND team_id <> $2`,
    [f.seasonYear, f.userTeamId]
  );
  if (Number(done.rows[0].n) >= AI_AI_TRADES_PER_SEASON) return null;
  if (Math.random() > AI_AI_DAILY_CHANCE) return null;

  const ctx = await loadTeams(db);
  const ai = [...ctx.teams.values()].filter((t) => t.id !== f.userTeamId);
  const contenders = ai.filter((t) => t.mode === "contend");
  const rebuilders = ai.filter((t) => t.mode === "rebuild");
  let best: { a: TeamInfo; b: TeamInfo; pa: ValuedPlayer; pb: ValuedPlayer; score: number } | null = null;
  for (const a of contenders) for (const b of rebuilders) {
    // a(경쟁)는 젊은 유망주를 내주고, b(리빌딩)는 베테랑을 내준다
    const prospects = a.players.filter((p) => p.age <= 24 && p.projected - p.overall >= 4);
    const veterans = b.players.filter((p) => p.age >= 29 && p.overall >= 78);
    for (const pa of prospects) for (const pb of veterans) {
      if (pa.contractType !== pb.contractType) continue;
      const aSide = sideValue(a, [pb], [pa]);
      const bSide = sideValue(b, [pa], [pb]);
      if (aSide.gainPct < 0.05 || bSide.gainPct < 0.05) continue;
      if (await checkRules(db, a, [pb], [pa]) || await checkRules(db, b, [pa], [pb])) continue;
      const score = Math.min(aSide.gainPct, bSide.gainPct);
      if (!best || score > best.score) best = { a, b, pa, pb, score };
    }
  }
  if (!best) return null;
  return executeTrade(db, f.date, f.seasonYear, best.a, best.b, [best.pa], [best.pb]);
}

// ============================================================
// 다른 팀이 우리 팀에 먼저 트레이드를 문의 (AI → 유저 제안)
// ============================================================

const OFFER_DAILY_CHANCE = 0.07;  // 조건이 맞는 날 제안이 올 확률
const OFFER_COOLDOWN_DAYS = 10;   // 제안 사이 최소 간격
const OFFER_VALID_DAYS = 5;       // 답하지 않으면 철회

export async function ensureTradeOfferSchema(db: Db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS trade_offers (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      offer_date DATE NOT NULL,
      expires_date DATE NOT NULL,
      ai_gives INTEGER[] NOT NULL,
      ai_wants INTEGER[] NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      resolved_date DATE
    )`);
  // 제안할 때의 양 팀 평가 (제안은 기한 안에는 이 조건 그대로 유효)
  await db.query(`ALTER TABLE trade_offers ADD COLUMN IF NOT EXISTS ai_gain REAL`);
  await db.query(`ALTER TABLE trade_offers ADD COLUMN IF NOT EXISTS user_gain REAL`);
}

/** 기한이 지났거나 트레이드 기간이 끝난 제안은 철회 */
export async function expireTradeOffers(db: Db, date: string) {
  const f = await getFranchise(db);
  const window = await tradeWindow(db, f);
  await db.query(
    `UPDATE trade_offers SET status='expired', resolved_date=$1 WHERE status='pending' AND (expires_date < $1 OR $2::boolean)`,
    [date, !window.open]
  );
}

/**
 * 하루 진행 때 호출. AI 팀 몇 곳이 우리 팀 선수 중 필요한 선수를 찾아, 자기 선수 1~2명을 주는 윈윈 제안을 만든다.
 * 조건: AI 자기 기준 +3% 이상 이득(클수록 우선), 우리 팀 기준으로도 +2~15% 이득인 제안, 간판 선수는 내주지 않음, 규정 통과.
 */
export async function maybeAiOfferToUser(db: Db): Promise<{ teamId: number; headline: string; body: string } | null> {
  const f = await getFranchise(db);
  if (f.phase !== "regular") return null;
  const window = await tradeWindow(db, f);
  if (!window.open) return null;
  const pending = await db.query(`SELECT COUNT(*)::int AS n FROM trade_offers WHERE status='pending'`);
  if (pending.rows[0].n > 0) return null;
  const last = await db.query(`SELECT MAX(offer_date)::text AS d FROM trade_offers`);
  if (last.rows[0].d && addDays(last.rows[0].d, OFFER_COOLDOWN_DAYS) > f.date) return null;
  if (Math.random() > OFFER_DAILY_CHANCE) return null;

  const { teams } = await loadTeams(db);
  const me = teams.get(f.userTeamId)!;
  const ai = [...teams.values()].filter((t) => t.id !== me.id).sort(() => Math.random() - 0.5).slice(0, 3);
  // 최근 두 번 제안에서 원했던 선수는 이번엔 제외 (같은 선수만 계속 문의하지 않게)
  const recent = await db.query(`SELECT ai_wants FROM trade_offers ORDER BY id DESC LIMIT 2`);
  const recentWants = new Set<number>(recent.rows.flatMap((r) => r.ai_wants));
  type Cand = { team: TeamInfo; want: ValuedPlayer; give: ValuedPlayer[]; aiGain: number; userGain: number };
  const cands: Cand[] = [];
  for (const team of ai) {
    const face = [...team.players].sort((a, b) => playerValue(b, team.mode) - playerValue(a, team.mode))[0];
    const targets = me.players
      .filter((p) => p.overall >= 70 && !recentWants.has(p.id))
      .sort((a, b) => playerValue(b, team.mode, needMultiplier(team, b.positionGroup)) - playerValue(a, team.mode, needMultiplier(team, a.positionGroup)))
      .slice(0, 5);
    const mine = team.players.filter((p) => p.id !== face?.id);
    const combos: ValuedPlayer[][] = [];
    mine.forEach((a, i) => { combos.push([a]); mine.slice(i + 1).forEach((b) => combos.push([a, b])); });
    for (const want of targets) for (const give of combos) {
      const aiSide = sideValue(team, [want], give);
      const userSide = sideValue(me, give, [want]);
      // 상대는 자기 이득을 최대한 챙기되, 우리가 받아들일 만한(+2~15%) 선에서 제안
      if (aiSide.gainPct < AI_MIN_GAIN || userSide.gainPct < 0.02 || userSide.gainPct > 0.15) continue;
      cands.push({ team, want, give, aiGain: aiSide.gainPct, userGain: userSide.gainPct });
    }
  }
  // 원하는 선수마다 상대 이득이 가장 큰 조합 (규정 통과) → 상위 3명 중 하나를 무작위로
  cands.sort((a, b) => b.aiGain - a.aiGain);
  const best = new Map<number, Cand>();
  for (const c of cands.slice(0, 80)) {
    if (best.has(c.want.id) || best.size >= 3) continue;
    if (await checkRules(db, me, c.give, [c.want]) || await checkRules(db, c.team, [c.want], c.give)) continue;
    best.set(c.want.id, c);
  }
  const picks = [...best.values()];
  if (picks.length > 0) {
    const c = picks[Math.floor(Math.random() * picks.length)];
    const gives = c.give.map((p) => `${p.name}(${p.overall})`).join("·");
    const headline = `${shortTeam(c.team.name)}, ${c.want.name} 영입 문의 — ${gives} 제안`;
    const body = `${c.team.name}(${MODE_LABEL[c.team.mode]})이(가) ${c.want.name}(${c.want.overall})을(를) 원합니다. ` +
      `대가로 ${gives}을(를) 내놓겠다고 합니다. ${OFFER_VALID_DAYS}일 안에 [트레이드] 메뉴에서 답하지 않으면 철회됩니다.`;
    await db.query(
      `INSERT INTO trade_offers (team_id, offer_date, expires_date, ai_gives, ai_wants, note, ai_gain, user_gain) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [c.team.id, f.date, addDays(f.date, OFFER_VALID_DAYS - 1), c.give.map((p) => p.id), [c.want.id], body, c.aiGain, c.userGain]
    );
    return { teamId: c.team.id, headline, body };
  }
  return null;
}

/** 받은 제안 목록 (대기 중인 제안은 지금 기준 평가도 함께) */
export async function listTradeOffers(pool: Pool) {
  await ensureTradeOfferSchema(pool);
  const r = await pool.query(
    `SELECT o.id, o.team_id AS "teamId", t.name AS "teamName", o.offer_date::text AS "offerDate", o.expires_date::text AS "expiresDate",
            o.ai_gives AS "aiGives", o.ai_wants AS "aiWants", o.status, o.note, o.resolved_date::text AS "resolvedDate",
            o.ai_gain AS "aiGain", o.user_gain AS "userGain"
     FROM trade_offers o JOIN teams t ON t.id=o.team_id ORDER BY o.id DESC LIMIT 15`
  );
  const f = await getFranchise(pool);
  const league = new Map((await loadLeaguePlayers(pool, f.date)).map((p) => [p.id, p]));
  const view = (id: number) => {
    const p = league.get(id);
    return p ? { id, name: p.name, overall: p.ratings.overall, positionGroup: p.positionGroup, age: p.age, teamId: p.teamId } : null;
  };
  const out = [];
  for (const o of r.rows) {
    let evaluation = null;
    if (o.status === "pending") {
      evaluation = await evaluateTrade(pool, o.teamId, o.aiWants, o.aiGives).catch((e) => ({ error: String(e.message) }));
    }
    out.push({
      ...o,
      gives: o.aiGives.map(view).filter(Boolean),
      wants: o.aiWants.map(view).filter(Boolean),
      evaluation,
    });
  }
  return out;
}

/**
 * 제안에 답하기. 상대가 먼저 낸 제안이라 기한 안에는 그 조건 그대로 유효하다 —
 * 수락하면 로스터·샐러리캡 규정과 트레이드 기간, 선수가 아직 그 팀에 있는지만 다시 확인하고 성사.
 */
export async function respondTradeOffer(pool: Pool, offerId: number, accept: boolean) {
  return withTx(pool, async (db) => {
    const r = await db.query(`SELECT * FROM trade_offers WHERE id=$1 FOR UPDATE`, [offerId]);
    const o = r.rows[0];
    if (!o || o.status !== "pending") throw new Error("이미 끝난 제안입니다");
    const f = await getFranchise(db);
    if (!accept) {
      await db.query(`UPDATE trade_offers SET status='rejected', resolved_date=$2 WHERE id=$1`, [offerId, f.date]);
      return { executed: false, status: "rejected", message: "제안을 거절했습니다" };
    }
    let ev: Awaited<ReturnType<typeof evaluate>>;
    try {
      ev = await evaluate(db, o.team_id, o.ai_wants, o.ai_gives);
    } catch (e) {
      await db.query(`UPDATE trade_offers SET status='withdrawn', resolved_date=$2 WHERE id=$1`, [offerId, f.date]);
      return { executed: false, status: "withdrawn", message: `제안이 무효가 되었습니다: ${(e as Error).message}` };
    }
    const blocker = ev.windowError ?? ev.ruleError;
    if (blocker) {
      await db.query(`UPDATE trade_offers SET status='withdrawn', resolved_date=$2 WHERE id=$1`, [offerId, f.date]);
      return { executed: false, status: "withdrawn", message: `규정상 성사될 수 없어 제안이 철회되었습니다: ${blocker}` };
    }
    const me = ev.ctx.teams.get(f.userTeamId)!;
    const partner = ev.ctx.teams.get(o.team_id)!;
    const description = await executeTrade(db, f.date, f.seasonYear, me, partner, ev.give, ev.receive);
    await db.query(`UPDATE trade_offers SET status='accepted', resolved_date=$2 WHERE id=$1`, [offerId, f.date]);
    await addNews(db, [{ date: f.date, category: "trade", teamId: me.id, team2Id: partner.id, importance: 3, headline: description.replace("[트레이드] ", "트레이드 성사: ") }]);
    return { executed: true, status: "accepted", message: `트레이드 성사! ${description}` };
  });
}
