/**
 * KBL Manager — 선수 성장/하락 (훈련 · 경기 경험치 · 노화 · 피로도 · 부상)
 *
 * 1) 훈련 (경기가 없는 날)
 *    - 유저 팀: 매일 휴식/훈련, 훈련 초점(슈팅/인사이드/플레이메이킹/수비/리바운드/체력/밸런스),
 *      강도(가볍게/보통/강하게)를 직접 정함. 선수별 개인 훈련 초점도 지정 가능.
 *    - AI 팀: 피로도가 높으면 휴식, 아니면 밸런스 보통 강도 훈련.
 *    - 하루 성장치 = 기본값 × 나이 계수 × 잠재력 계수 × 성실성 계수 × 강도 × 피로 페널티.
 *      잠재력(potential)은 attribute-pipeline에서 "나이 45% + 드래프트 순위 25% + 커리어 기록 추세 30%"로
 *      산출된 값이라, 드래프트 상위 지명·젊은 나이·상승세 기록을 가진 선수가 훈련으로 더 빨리 큰다.
 *      능력치별 소수점 누적치(training_progress)가 +1을 넘는 순간 실제 능력치가 오른다.
 * 2) 노화 — 30세 이상은 매일 운동능력(스피드/체력/덩크/파워/블록/공격리바운드) 중심으로 조금씩 감소.
 *    누적치가 -1을 넘으면 실제 하락. "체력" 훈련으로 일부 상쇄 가능.
 * 3) 경기 경험치 — 출전시간과 경기 활약도만큼 XP 획득 (플레이오프 1.5배).
 *    XP_PER_LEVEL마다 레벨업 → 선수 포지션·강점·이번 경기 스탯에 맞는 능력치 +1 (26세 이하 +2개)
 * 4) 피로도 — 경기 출전시간만큼 쌓이고, 매일 회복(휴식일엔 더 많이). 훈련 강도만큼 회복이 줄어듦.
 *    경기 시작 체력과 AI 출전시간에 반영됨.
 * 5) 부상 — 경기 중(출전시간·피로·부상 위험도 비례)과 강도 높은 훈련 중 낮은 확률로 발생.
 */
import { Pool, PoolClient } from "pg";
import { AttrKey, ATTR_LABEL, computeRatings } from "./ratings";
import { LeaguePlayer, loadLeaguePlayers, isAvailable } from "./rosterBuilder";
import { selectGrowthAttrs, GrowthAttrKey } from "./playerProgression";
import { addDays } from "../../../packages/simulation-engine/seasonScheduler";

type Db = Pool | PoolClient;

export type TrainingFocus = "balanced" | "shooting" | "inside" | "playmaking" | "defense" | "rebounding" | "conditioning";
export type TrainingIntensity = "light" | "normal" | "intense";

export const TRAINING_FOCUS: Record<TrainingFocus, { label: string; attrs: AttrKey[] }> = {
  balanced: { label: "밸런스", attrs: ["finishing", "mid_range_shooting", "three_point_shooting", "ball_handling", "passing", "steal", "defensive_rebounding", "stamina"] },
  shooting: { label: "슈팅", attrs: ["three_point_shooting", "mid_range_shooting", "free_throw_shooting"] },
  inside: { label: "인사이드", attrs: ["finishing", "dunking", "strength"] },
  playmaking: { label: "플레이메이킹", attrs: ["ball_handling", "passing"] },
  defense: { label: "수비", attrs: ["steal", "shot_blocking", "speed"] },
  rebounding: { label: "리바운드", attrs: ["defensive_rebounding", "offensive_rebounding", "strength"] },
  conditioning: { label: "체력·스피드", attrs: ["stamina", "speed", "strength"] },
};

const INTENSITY: Record<TrainingIntensity, { gain: number; fatigueCost: number; injuryMult: number; label: string }> = {
  light: { gain: 0.6, fatigueCost: 4, injuryMult: 0.3, label: "가볍게" },
  normal: { gain: 1.0, fatigueCost: 8, injuryMult: 1, label: "보통" },
  intense: { gain: 1.5, fatigueCost: 14, injuryMult: 3, label: "강하게" },
};

const BASE_DAILY_GAIN = 0.05;
const DAILY_RECOVERY = 15;
const REST_BONUS_RECOVERY = 12;
const AGING_ATTRS: AttrKey[] = ["speed", "stamina", "dunking", "strength", "shot_blocking", "offensive_rebounding"];
export const XP_PER_LEVEL = 300;

function ageFactor(age: number): number {
  if (age <= 22) return 1.6;
  if (age <= 25) return 1.3;
  if (age <= 28) return 1.0;
  if (age <= 30) return 0.7;
  if (age <= 32) return 0.4;
  return 0.2;
}

/** 하루 훈련 성장치 (훈련 초점 능력치 전체에 나눠 배분되는 총량) */
export function dailyGrowthRate(p: LeaguePlayer, intensity: TrainingIntensity): number {
  const potNorm = p.potential !== null ? Math.max(0, (p.potential - 50) / 49) : 0.35;
  const ethic = 0.7 + 0.6 * (p.workEthic / 99);
  const fatiguePenalty = p.fatigue > 70 ? 0.5 : 1;
  return BASE_DAILY_GAIN * ageFactor(p.age) * (0.4 + 1.2 * potNorm) * ethic * INTENSITY[intensity].gain * fatiguePenalty;
}

export interface TrainingPlan {
  mode: "rest" | "train";
  focus: TrainingFocus;
  intensity: TrainingIntensity;
}

export async function loadTrainingPlan(db: Db, teamId: number): Promise<TrainingPlan> {
  const r = await db.query(`SELECT mode, focus, intensity FROM training_plans WHERE team_id=$1`, [teamId]);
  return r.rows[0] ?? { mode: "train", focus: "balanced", intensity: "normal" };
}

interface PendingUpdate {
  playerId: number;
  fatigue: number;
  progress: Record<string, number>;
  attrChanges: Partial<Record<AttrKey, number>>;
  injuredUntil: string | null;
}

export interface DevelopmentChange {
  playerId: number;
  name: string;
  teamId: number | null;
  attribute: string;
  label: string;
  delta: number;
  reason: string;
}

/**
 * 하루치 훈련/회복/노화 처리 (리그 전체).
 * @param playedToday 오늘 경기를 뛴 팀 id (그 팀은 훈련 없이 회복만)
 * @param userPlan 유저 팀 오늘 계획
 */
export async function processDailyDevelopment(
  db: Db, date: string, userTeamId: number, userPlan: TrainingPlan, playedToday: Set<number>
): Promise<{ changes: DevelopmentChange[]; injuries: { name: string; teamId: number | null; days: number }[] }> {
  const players = await loadLeaguePlayers(db, date);
  const progressRes = await db.query(`SELECT player_id, training_progress FROM player_condition`);
  const progressMap = new Map<number, Record<string, number>>(progressRes.rows.map((r) => [r.player_id, r.training_progress ?? {}]));
  const focusRes = await db.query(`SELECT player_id, focus FROM player_training_focus`);
  const personalFocus = new Map<number, TrainingFocus>(focusRes.rows.map((r) => [r.player_id, r.focus]));

  const updates: PendingUpdate[] = [];
  const changes: DevelopmentChange[] = [];
  const injuries: { name: string; teamId: number | null; days: number }[] = [];

  // AI 팀 계획: 팀 평균 피로도가 높으면 휴식
  const teamFatigue = new Map<number, number[]>();
  players.forEach((p) => { if (p.teamId) teamFatigue.set(p.teamId, [...(teamFatigue.get(p.teamId) ?? []), p.fatigue]); });

  for (const p of players) {
    const progress = { ...(progressMap.get(p.id) ?? {}) };
    let fatigue = p.fatigue;
    const injured = !isAvailable(p, date);
    let plan: TrainingPlan;
    if (p.teamId === null) plan = { mode: "train", focus: "balanced", intensity: "light" };
    else if (p.teamId === userTeamId) plan = userPlan;
    else {
      const arr = teamFatigue.get(p.teamId) ?? [0];
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      plan = avg > 35 ? { mode: "rest", focus: "balanced", intensity: "light" } : { mode: "train", focus: "balanced", intensity: "normal" };
    }
    const trains = plan.mode === "train" && !injured && !(p.teamId !== null && playedToday.has(p.teamId));

    // 회복
    fatigue -= DAILY_RECOVERY + (plan.mode === "rest" || injured ? REST_BONUS_RECOVERY : 0);

    if (trains) {
      const focus = (p.teamId === userTeamId ? personalFocus.get(p.id) : undefined) ?? plan.focus;
      const attrs = TRAINING_FOCUS[focus]?.attrs ?? TRAINING_FOCUS.balanced.attrs;
      const total = dailyGrowthRate(p, plan.intensity);
      for (const a of attrs) {
        const cur = Number(p.attrs[a]);
        const ceilingMult = cur >= 95 ? 0.3 : cur >= 90 ? 0.6 : 1;
        progress[a] = (progress[a] ?? 0) + (total / attrs.length) * ceilingMult * (0.7 + Math.random() * 0.6);
      }
      fatigue += INTENSITY[plan.intensity].fatigueCost;

      // 강도 높은 훈련 중 부상
      const injuryProb = 0.0012 * INTENSITY[plan.intensity].injuryMult * (0.5 + p.fatigue / 60);
      if (Math.random() < injuryProb) {
        const days = 3 + Math.floor(Math.random() * 10);
        injuries.push({ name: p.name, teamId: p.teamId, days });
        updates.push({ playerId: p.id, fatigue: Math.max(0, Math.min(100, fatigue)), progress, attrChanges: {}, injuredUntil: addDays(date, days) });
        continue;
      }
    }

    // 노화 (30세 이상, 매일)
    if (p.age >= 30) {
      const decline = 0.004 * (p.age - 29);
      for (const a of AGING_ATTRS) progress[a] = (progress[a] ?? 0) - decline * (0.6 + Math.random() * 0.8);
    }

    // 누적치가 ±1을 넘은 능력치 반영
    const attrChanges: Partial<Record<AttrKey, number>> = {};
    for (const [k, v] of Object.entries(progress)) {
      const a = k as AttrKey;
      if (v >= 1 || v <= -1) {
        const step = v >= 1 ? 1 : -1;
        const cur = Number(p.attrs[a]);
        const next = Math.max(40, Math.min(99, cur + step));
        progress[a] = v - step;
        if (next !== cur) {
          attrChanges[a] = step;
          changes.push({ playerId: p.id, name: p.name, teamId: p.teamId, attribute: a, label: ATTR_LABEL[a], delta: step, reason: step > 0 ? "training" : "aging" });
        }
      }
    }
    updates.push({ playerId: p.id, fatigue: Math.max(0, Math.min(100, fatigue)), progress, attrChanges, injuredUntil: null });
  }

  await flushUpdates(db, updates, date, changes);
  return { changes, injuries };
}

async function flushUpdates(db: Db, updates: PendingUpdate[], date: string, changes: DevelopmentChange[]) {
  if (updates.length === 0) return;
  await db.query(
    `INSERT INTO player_condition (player_id, fatigue, training_progress)
     SELECT * FROM unnest($1::int[], $2::real[], $3::jsonb[])
     ON CONFLICT (player_id) DO UPDATE SET fatigue = EXCLUDED.fatigue, training_progress = EXCLUDED.training_progress`,
    [updates.map((u) => u.playerId), updates.map((u) => u.fatigue), updates.map((u) => JSON.stringify(u.progress))]
  );
  const injured = updates.filter((u) => u.injuredUntil);
  for (const u of injured) {
    await db.query(`UPDATE player_condition SET injured_until=$2 WHERE player_id=$1`, [u.playerId, u.injuredUntil]);
  }
  await applyAttributeChanges(db, changes, date);
}

export async function applyAttributeChanges(db: Db, changes: DevelopmentChange[], date: string) {
  for (const c of changes) {
    await db.query(
      `UPDATE player_attributes SET ${c.attribute} = GREATEST(40, LEAST(99, COALESCE(${c.attribute},50) + $2)) WHERE player_id=$1`,
      [c.playerId, c.delta]
    );
  }
  if (changes.length > 0) {
    await db.query(
      `INSERT INTO development_log (player_id, log_date, attribute, delta, reason)
       SELECT * FROM unnest($1::int[], $2::date[], $3::text[], $4::smallint[], $5::text[])`,
      [changes.map((c) => c.playerId), changes.map(() => date), changes.map((c) => c.attribute), changes.map((c) => c.delta), changes.map((c) => c.reason)]
    );
  }
}

export interface GameLine {
  playerId: number;
  name: string;
  teamId: number;
  positionGroup: "G" | "F" | "C";
  min: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  fga: number;
  fgm: number;
  fta: number;
  ftm: number;
}

/**
 * 경기 후 처리: 피로도 누적, 경험치 획득·레벨업, 경기 중 부상.
 */
export async function processPostGame(db: Db, date: string, lines: GameLine[], isPlayoff: boolean): Promise<DevelopmentChange[]> {
  const ids = lines.filter((l) => l.min > 0).map((l) => l.playerId);
  if (ids.length === 0) return [];
  const res = await db.query(
    `SELECT p.id, p.birth_date, pc.xp, pc.xp_level, pc.fatigue,
            pa.finishing, pa.dunking, pa.mid_range_shooting, pa.three_point_shooting, pa.free_throw_shooting,
            pa.ball_handling, pa.passing, pa.steal, pa.shot_blocking, pa.defensive_rebounding,
            pa.offensive_rebounding, pa.strength, pa.stamina, pa.injury_proneness
     FROM players p JOIN player_attributes pa ON pa.player_id=p.id
     LEFT JOIN player_condition pc ON pc.player_id=p.id
     WHERE p.id = ANY($1::int[])`,
    [ids]
  );
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  const changes: DevelopmentChange[] = [];

  for (const l of lines) {
    if (l.min <= 0) continue;
    const r = byId.get(l.playerId);
    if (!r) continue;
    const eff = l.pts + l.reb + l.ast + l.stl + l.blk - l.tov - (l.fga - l.fgm) - (l.fta - l.ftm) * 0.5;
    const gained = Math.round((l.min + Math.max(0, eff) * 1.5) * (isPlayoff ? 1.5 : 1));
    let xp = (r.xp ?? 0) + gained;
    let level = r.xp_level ?? 0;
    const birth = r.birth_date ? new Date(r.birth_date) : null;
    const age = birth ? new Date(date).getFullYear() - birth.getFullYear() : 27;

    while (xp >= (level + 1) * XP_PER_LEVEL) {
      level++;
      const attrs: Record<GrowthAttrKey, number> = {
        finishing: r.finishing, dunking: r.dunking, mid_range_shooting: r.mid_range_shooting,
        three_point_shooting: r.three_point_shooting, free_throw_shooting: r.free_throw_shooting,
        ball_handling: r.ball_handling, passing: r.passing, steal: r.steal, shot_blocking: r.shot_blocking,
        defensive_rebounding: r.defensive_rebounding, offensive_rebounding: r.offensive_rebounding,
        strength: r.strength, stamina: r.stamina,
      };
      const statPct = {
        pts: Math.min(100, (l.pts / 20) * 100), ast: Math.min(100, (l.ast / 6) * 100),
        reb: Math.min(100, (l.reb / 10) * 100), blk: Math.min(100, (l.blk / 2) * 100),
      };
      const picks = selectGrowthAttrs(attrs, l.positionGroup, statPct);
      const count = age <= 26 ? 2 : 1;
      for (const a of picks.slice(0, count)) {
        if (attrs[a] >= 99) continue;
        changes.push({ playerId: l.playerId, name: l.name, teamId: l.teamId, attribute: a, label: ATTR_LABEL[a as AttrKey], delta: 1, reason: "experience" });
      }
    }

    // 피로도 누적 + 경기 중 부상
    const fatigue = Math.min(100, Number(r.fatigue ?? 0) + l.min * 0.9);
    const injuryProb = 0.004 * (l.min / 30) * ((r.injury_proneness ?? 60) / 75) * (1 + Number(r.fatigue ?? 0) / 100);
    const injuredUntil = Math.random() < injuryProb ? addDays(date, 2 + Math.floor(Math.random() * 18)) : null;

    await db.query(
      `INSERT INTO player_condition (player_id, xp, xp_level, fatigue, injured_until) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (player_id) DO UPDATE SET xp=$2, xp_level=$3, fatigue=$4,
         injured_until = COALESCE($5, player_condition.injured_until)`,
      [l.playerId, xp, level, fatigue, injuredUntil]
    );
  }
  await applyAttributeChanges(db, changes, date);
  return changes;
}

/**
 * 비시즌 성장/하락 (시즌 전환 시 1회): 여름 훈련 캠프 ~40일치 밸런스 훈련 + 1년치 노화를 한 번에 적용.
 */
export async function processOffseasonDevelopment(db: Db, date: string): Promise<DevelopmentChange[]> {
  const players = await loadLeaguePlayers(db, date, { includeFreeAgents: true });
  const changes: DevelopmentChange[] = [];
  for (const p of players) {
    const gainTotal = dailyGrowthRate({ ...p, fatigue: 0 }, "normal") * 40;
    const attrs = TRAINING_FOCUS.balanced.attrs;
    const delta: Partial<Record<AttrKey, number>> = {};
    for (const a of attrs) delta[a] = (delta[a] ?? 0) + gainTotal / attrs.length * (0.5 + Math.random());
    if (p.age >= 30) for (const a of AGING_ATTRS) delta[a] = (delta[a] ?? 0) - 0.004 * (p.age - 29) * 60 * (0.6 + Math.random() * 0.8);
    for (const [k, v] of Object.entries(delta)) {
      const step = Math.trunc(v as number);
      if (step !== 0) changes.push({ playerId: p.id, name: p.name, teamId: p.teamId, attribute: k, label: ATTR_LABEL[k as AttrKey], delta: step, reason: "offseason" });
    }
  }
  await applyAttributeChanges(db, changes, date);
  return changes;
}

export { computeRatings };
