/**
 * KBL Manager — DB 기반 경기용 로스터(TeamGameSetup) 구성
 *
 * v1부터 시뮬레이션은 DB만 보고 돌아간다 (FA 이적, 신인, 성장/하락이 전부 즉시 반영되도록).
 *  - 소속팀/외국선수 여부: players.team_id + contracts.contract_type
 *  - 능력치: player_attributes (훈련·경험치·노화로 매일 바뀜)
 *  - 실제 슛 확률: player_sim_profile (실측 기록 기반) + 능력치 변화분만큼 보정
 *  - 출전시간: 유저 팀은 로스터 설정, AI 팀은 감독 뎁스차트(coaches.ts)
 *  - 전술: 유저 팀은 team_tactics + 경기별 game_plans, AI 팀은 감독 성향
 *  - 경기 시작 체력: 시즌 누적 피로도(player_condition.fatigue) 반영, 부상자는 제외
 */
import { Pool, PoolClient } from "pg";
import { SimPlayer, TeamContext, DisplayAttrs } from "../../../packages/simulation-engine/possession";
import { TeamGameSetup } from "../../../packages/simulation-engine/gameSimulator";
import { computeRatings, AttributeRow, Ratings } from "./ratings";
import { COACHES, CoachProfile, aiMinutesPlan, aiDoubleTeamTarget, PACE_FACTOR, THREE_MULT, PaceStyle, ThreeReliance, DefenseScheme } from "./coaches";

type Db = Pool | PoolClient;

export interface LeaguePlayer {
  id: number;
  name: string;
  teamId: number | null;
  position: string;
  positionGroup: "G" | "F" | "C";
  nationality: string;
  contractType: "domestic" | "foreign" | "asia";
  isForeign: boolean;
  age: number;
  attrs: AttributeRow;
  potential: number | null;
  workEthic: number;
  ratings: Ratings;
  fatigue: number;
  injuredUntil: string | null;
  role: string | null;
  minutesTarget: number | null;
  offensePriority: number | null;
  lineupSlot: number | null;          // 선발 코트 위치 1=PG 2=SG 3=SF 4=PF 5=C
  sim: Omit<SimPlayer, "perGameMin">;
}

/**
 * 공격 1·2·3옵션 자동 선정 (AI 팀, 그리고 유저가 지정하지 않은 경우의 유저 팀)
 * 주전급(예상 출전 18분 이상) 중 공격 능력치 + 실제 득점 퍼센타일이 높은 순.
 */
export function autoOffenseOptions(
  members: { id: number; isForeign: boolean; ratings: Ratings; sim: { internals: { ptsPercentile: number } } }[],
  plannedMinutes: (id: number) => number,
  opts: { foreignAce?: boolean } = {}
): Map<number, 1 | 2 | 3> {
  const pool = members.filter((p) => plannedMinutes(p.id) >= 18);
  const out = new Map<number, 1 | 2 | 3>();
  // AI 팀: 1옵션은 무조건 오버롤이 가장 높은 외국선수 (이 경기에 뛰는 선수 중)
  if (opts.foreignAce) {
    const ace = members
      .filter((p) => p.isForeign && plannedMinutes(p.id) > 0)
      .sort((a, b) => b.ratings.overall - a.ratings.overall || b.ratings.offense - a.ratings.offense)[0];
    if (ace) out.set(ace.id, 1);
  }
  const rest = (pool.length >= 3 ? pool : members).filter((p) => !out.has(p.id));
  rest
    .map((p) => ({ id: p.id, score: p.ratings.offense + 0.15 * p.sim.internals.ptsPercentile }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3 - out.size)
    .forEach((r) => out.set(r.id, (out.size + 1) as 1 | 2 | 3));
  return out;
}

export function ageOn(birthDate: string | Date | null, onDate: string): number {
  if (!birthDate) return 27;
  const b = typeof birthDate === "string" ? new Date(birthDate) : birthDate;
  const d = new Date(onDate);
  let age = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) age--;
  return age;
}

function toDisplayAttrs(a: AttributeRow): DisplayAttrs {
  return {
    finishing: a.finishing, dunking: a.dunking, midRangeShooting: a.mid_range_shooting,
    threePointShooting: a.three_point_shooting, freeThrowShooting: a.free_throw_shooting,
    ballHandling: a.ball_handling, passing: a.passing, steal: a.steal, shotBlocking: a.shot_blocking,
    defensiveRebounding: a.defensive_rebounding, offensiveRebounding: a.offensive_rebounding,
    strength: a.strength, stamina: a.stamina,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 실측 슛 확률을 "프로필 산출 당시 능력치 → 현재 능력치" 변화량만큼 보정 */
function adjustedInternals(row: any, attrs: AttributeRow, offense: number) {
  const base = row.base_attrs as Record<string, number>;
  const d = (k: keyof AttributeRow) => (Number(attrs[k]) || 50) - (Number(base[k]) || Number(attrs[k]) || 50);
  const baseOffense = Number(base.offense ?? offense);
  return {
    paintAccuracy: clamp(row.paint_accuracy + d("finishing") * 0.0015 + d("dunking") * 0.001, 0.3, 0.8),
    midAccuracy: clamp(row.mid_accuracy + d("mid_range_shooting") * 0.0025, 0.2, 0.65),
    threeAccuracy: clamp(row.three_accuracy + d("three_point_shooting") * 0.0025, 0.15, 0.48),
    ftAccuracy: clamp(row.ft_accuracy + d("free_throw_shooting") * 0.003, 0.4, 0.95),
    usagePercentile: clamp(row.usage_percentile + (offense - baseOffense) * 1.5, 1, 99.5),
    ptsPercentile: clamp(row.pts_percentile + (offense - baseOffense) * 1.5, 1, 99.5),
  };
}

export async function loadLeaguePlayers(db: Db, onDate: string, opts: { includeFreeAgents?: boolean } = {}): Promise<LeaguePlayer[]> {
  const res = await db.query(
    `SELECT p.id, p.name, p.team_id, p.position, p.position_group, p.nationality, p.birth_date,
            COALESCE(c.contract_type, CASE WHEN p.is_foreign_import THEN 'foreign' WHEN p.nationality='PHI' THEN 'asia' ELSE 'domestic' END) AS contract_type,
            pa.finishing, pa.dunking, pa.mid_range_shooting, pa.three_point_shooting, pa.free_throw_shooting,
            pa.ball_handling, pa.passing, pa.steal, pa.shot_blocking, pa.defensive_rebounding,
            pa.offensive_rebounding, pa.stamina, pa.strength, pa.speed, pa.potential, pa.work_ethic,
            sp.paint_accuracy, sp.mid_accuracy, sp.three_accuracy, sp.ft_accuracy, sp.usage_percentile,
            sp.pts_percentile, sp.base_attrs,
            COALESCE(pc.fatigue, 0) AS fatigue, pc.injured_until,
            prs.role, prs.minutes_target, prs.offense_priority, prs.lineup_slot
     FROM players p
     JOIN player_attributes pa ON pa.player_id = p.id
     JOIN player_sim_profile sp ON sp.player_id = p.id
     LEFT JOIN contracts c ON c.player_id = p.id
     LEFT JOIN player_condition pc ON pc.player_id = p.id
     LEFT JOIN player_roster_settings prs ON prs.player_id = p.id AND prs.team_id = p.team_id
     WHERE NOT p.is_retired ${opts.includeFreeAgents ? "" : "AND p.team_id IS NOT NULL"}`
  );
  return res.rows.map((r) => {
    const attrs: AttributeRow = {
      finishing: r.finishing, dunking: r.dunking, mid_range_shooting: r.mid_range_shooting,
      three_point_shooting: r.three_point_shooting, free_throw_shooting: r.free_throw_shooting,
      ball_handling: r.ball_handling, passing: r.passing, steal: r.steal, shot_blocking: r.shot_blocking,
      defensive_rebounding: r.defensive_rebounding, offensive_rebounding: r.offensive_rebounding,
      stamina: r.stamina, strength: r.strength, speed: r.speed,
    };
    const ratings = computeRatings(attrs, r.position_group);
    const positionGroup = (r.position_group === "G" || r.position_group === "C" ? r.position_group : "F") as "G" | "F" | "C";
    const isForeign = r.contract_type === "foreign";
    return {
      id: r.id, name: r.name, teamId: r.team_id, position: r.position ?? "", positionGroup,
      nationality: r.nationality, contractType: r.contract_type, isForeign,
      age: ageOn(r.birth_date, onDate), attrs, potential: r.potential, workEthic: r.work_ethic ?? 65,
      ratings, fatigue: Number(r.fatigue), injuredUntil: r.injured_until ? formatDbDate(r.injured_until) : null,
      role: r.role, minutesTarget: r.minutes_target !== null ? Number(r.minutes_target) : null, offensePriority: r.offense_priority,
      lineupSlot: r.lineup_slot ?? null,
      sim: {
        playerId: r.id, name: r.name, position: r.position ?? "", nationality: r.nationality, positionGroup, isForeign,
        attrs: toDisplayAttrs(attrs), internals: adjustedInternals(r, attrs, ratings.offense), overall: ratings.overall,
      },
    };
  });
}

export function formatDbDate(d: Date | string): string {
  if (typeof d === "string") return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function coachForTeam(teamName: string): CoachProfile {
  return COACHES.find((c) => c.teamName === teamName) ?? {
    teamName, name: "감독", style: "밸런스", description: "", paceStyle: "normal", threePointReliance: "normal",
    defenseScheme: "man", rotationDepth: 0.5, youthPreference: 0.5, doubleTeamTendency: 0.3,
  };
}

export function isAvailable(p: LeaguePlayer, onDate: string): boolean {
  return !p.injuredUntil || p.injuredUntil <= onDate;
}

export interface UserTactics {
  paceStyle: PaceStyle;
  threePointReliance: ThreeReliance;
  defenseScheme: DefenseScheme;
  reboundEmphasis: boolean;
  defensiveStopperId: number | null;
  clutchCloserId: number | null;
  offenseOptions: (number | null)[];   // [1옵션, 2옵션, 3옵션] 선수 id
}

export async function loadUserTactics(db: Db, teamId: number): Promise<UserTactics> {
  const r = await db.query(
    `SELECT pace_style, three_point_reliance, defense_scheme, rebound_emphasis,
            defensive_stopper_player_id, clutch_closer_player_id, option1_player_id, option2_player_id, option3_player_id
     FROM team_tactics WHERE team_id=$1`,
    [teamId]
  );
  const t = r.rows[0];
  return {
    paceStyle: t?.pace_style ?? "normal",
    threePointReliance: t?.three_point_reliance ?? "normal",
    defenseScheme: t?.defense_scheme ?? "man",
    reboundEmphasis: t?.rebound_emphasis ?? false,
    defensiveStopperId: t?.defensive_stopper_player_id ?? null,
    clutchCloserId: t?.clutch_closer_player_id ?? null,
    offenseOptions: [t?.option1_player_id ?? null, t?.option2_player_id ?? null, t?.option3_player_id ?? null],
  };
}

/** 상대팀 선수들의 이번 시즌 경기당 득점 (AI 더블팀 판단용) */
async function opponentThreats(db: Db, teamId: number, seasonId: number) {
  const r = await db.query(
    `SELECT p.name, AVG(s.pts) AS ppg
     FROM player_game_stats s JOIN games g ON g.id=s.game_id JOIN players p ON p.id=s.player_id
     WHERE g.season_id=$1 AND p.team_id=$2 AND s.min > 0
     GROUP BY p.name HAVING COUNT(*) >= 3`,
    [seasonId, teamId]
  );
  return r.rows.map((x) => ({ name: x.name, ppg: Number(x.ppg) }));
}

export interface BuildContext {
  db: Db;
  date: string;
  seasonId: number;
  userTeamId: number;
  players: LeaguePlayer[];
  teamNames: Map<number, string>;
}

/**
 * 한 팀의 경기 셋업 생성.
 * @param gameId 경기별 게임플랜(game_plans) 조회용 (유저 팀만 사용)
 */
export async function buildTeamSetup(ctx: BuildContext, teamId: number, opponentId: number, gameId: number | null): Promise<TeamGameSetup> {
  const teamName = ctx.teamNames.get(teamId)!;
  const isUser = teamId === ctx.userTeamId;
  const members = ctx.players.filter((p) => p.teamId === teamId && isAvailable(p, ctx.date));
  const coach = coachForTeam(teamName);

  let roster: SimPlayer[];
  let context: TeamContext;
  let paceFactor: number;

  const userConfigured = isUser && members.some((p) => p.role === "starter" || p.role === "bench");
  if (isUser) {
    const tactics = await loadUserTactics(ctx.db, teamId);
    const planRes = gameId
      ? await ctx.db.query(`SELECT * FROM game_plans WHERE game_id=$1 AND team_id=$2`, [gameId, teamId])
      : { rows: [] as any[] };
    const plan = planRes.rows[0];
    const pace = (plan?.pace_style ?? tactics.paceStyle) as PaceStyle;
    const three = (plan?.three_point_reliance ?? tactics.threePointReliance) as ThreeReliance;
    const scheme = (plan?.defense_scheme ?? tactics.defenseScheme) as DefenseScheme;
    const doubleTeam = plan?.double_team_player_id
      ? ctx.players.find((p) => p.id === plan.double_team_player_id)?.name ?? null
      : null;
    paceFactor = PACE_FACTOR[pace];
    context = { defenseScheme: scheme, threeWeightMultiplier: THREE_MULT[three], reboundEmphasis: plan?.rebound_emphasis ?? tactics.reboundEmphasis, doubleTeamTarget: doubleTeam };

    const fallback = aiMinutesPlan(members.map((p) => ({ name: p.name, isForeign: p.isForeign, overall: p.ratings.overall, age: p.age, fatigue: p.fatigue })), { ...coach, rotationDepth: 0.5, youthPreference: 0.4 });
    const minutesOf = (p: LeaguePlayer) => userConfigured ? (p.minutesTarget ?? (p.role === "starter" ? 30 : p.role === "bench" ? 12 : 6)) : fallback.get(p.name) ?? 0;
    const active = members.filter((p) => !userConfigured || p.role !== "inactive"); // 설정 이후 새로 합류한 선수(role 없음)는 후보로 취급
    // 공격 옵션: 유저가 지정한 1·2·3옵션 (출전 가능한 선수만), 하나도 없으면 자동 선정
    const chosen = new Map<number, 1 | 2 | 3>();
    tactics.offenseOptions.forEach((id, i) => { if (id && active.some((p) => p.id === id)) chosen.set(id, (i + 1) as 1 | 2 | 3); });
    if (chosen.size === 0) {
      active.forEach((p) => { if (p.offensePriority && p.offensePriority >= 1 && p.offensePriority <= 3) chosen.set(p.id, p.offensePriority as 1 | 2 | 3); });
    }
    const options = chosen.size > 0 ? chosen : autoOffenseOptions(active, (id) => minutesOf(active.find((p) => p.id === id)!));
    roster = active.map((p) => ({
      ...p.sim,
      perGameMin: minutesOf(p),
      tactics: {
        isDefensiveStopper: tactics.defensiveStopperId === p.id,
        isClutchCloser: tactics.clutchCloserId === p.id,
        offenseOption: options.get(p.id),
      },
    }));
  } else {
    const plan = aiMinutesPlan(members.map((p) => ({ name: p.name, isForeign: p.isForeign, overall: p.ratings.overall, age: p.age, fatigue: p.fatigue })), coach);
    const closer = [...members].sort((a, b) => b.sim.internals.ptsPercentile - a.sim.internals.ptsPercentile)[0];
    // AI 팀 공격 옵션: 1옵션은 오버롤 최고 외국선수, 2·3옵션은 공격 능력치·득점력 순 (감독 뎁스차트상 주전급 중에서)
    const options = autoOffenseOptions(members, (id) => plan.get(members.find((p) => p.id === id)!.name) ?? 0, { foreignAce: true });
    roster = members.map((p) => ({ ...p.sim, perGameMin: plan.get(p.name) ?? 0, tactics: { isClutchCloser: p === closer, offenseOption: options.get(p.id) } }));
    const threats = await opponentThreats(ctx.db, opponentId, ctx.seasonId);
    paceFactor = PACE_FACTOR[coach.paceStyle];
    context = {
      defenseScheme: coach.defenseScheme,
      threeWeightMultiplier: THREE_MULT[coach.threePointReliance],
      doubleTeamTarget: aiDoubleTeamTarget(coach, threats),
    };
  }

  const startingEnergy: Record<string, number> = {};
  members.forEach((p) => { startingEnergy[p.name] = Math.max(40, 100 - p.fatigue * 0.6); });

  // 5명 미만이 되는 극단적 상황(부상 다수) 방지: 부상자 제외 전체 로스터로 보충
  if (roster.length < 8) {
    const extra = members.filter((p) => !roster.some((r) => r.name === p.name)).map((p) => ({ ...p.sim, perGameMin: 5 }));
    roster = [...roster, ...extra];
  }

  // 선발 5명 (유저가 지정한 경우, 코트 위치 PG→C 순서) — 경기 시작과 3쿼터 시작에 이 5명이 나온다
  const starters = isUser && userConfigured
    ? members.filter((p) => p.role === "starter").sort((a, b) => (a.lineupSlot ?? 9) - (b.lineupSlot ?? 9)).map((p) => p.name)
    : undefined;

  return { name: teamName, roster, context, paceFactor, startingEnergy, starters };
}
