/**
 * KBL Manager — 유저 팀 경기 직접 지휘 (라이브 게임 세션)
 *
 * 경기는 포제션(공격 한 번) 단위로 진행되고, 화면은 받은 포제션을 한 동작씩 실시간 중계처럼 재생한다.
 *  - 진행: mode='chunk'(포제션 몇 개씩) | 'quarter'(쿼터 스킵) | 'end'(경기 스킵)
 *  - 작전타임에 유저가:
 *  - 코트 위 5명 직접 지정 (외국선수 쿼터 규정 검증: 1·4쿼터·연장 1명, 2·3쿼터 2명) 또는 자동 로테이션
 *  - 템포 / 3점 의존도 / 수비 전술(맨투맨·지역방어·압박) / 리바운드 강조 / 상대 더블팀 대상 변경
 * 세션은 서버 메모리에만 존재 (서버 재시작 시 사라지며, 그 경기는 다시 시작하면 됨 — 결과 저장 전이므로 안전).
 */
import { Pool } from "pg";
import { randomUUID } from "crypto";
import { LiveGame, PlayerBoxScore } from "../../../packages/simulation-engine/gameSimulator";
import { getFranchise, userGameToday, buildContext, persistGameResult, withTx, GameRow } from "./season";
import { buildTeamSetup, BuildContext } from "./rosterBuilder";
import { PACE_FACTOR, THREE_MULT, PaceStyle, ThreeReliance, DefenseScheme } from "./coaches";
import { DevelopmentChange } from "./development";

interface Session {
  id: string;
  game: GameRow;
  live: LiveGame;
  userSide: "home" | "away";
  ctx: BuildContext;
  createdAt: number;
}

const sessions = new Map<string, Session>();

export interface TacticsPatch {
  paceStyle?: PaceStyle;
  threePointReliance?: ThreeReliance;
  defenseScheme?: DefenseScheme;
  reboundEmphasis?: boolean;
  doubleTeamTarget?: string | null;
}

function boxRows(box: Map<string, PlayerBoxScore>) {
  return Array.from(box.values()).map((b) => ({ ...b, MIN: Math.round(b.MIN * 10) / 10 }));
}

function sessionState(s: Session, extra: { developmentChanges?: DevelopmentChange[]; since?: number } = {}) {
  const lg = s.live;
  const side = (t: "home" | "away") => {
    const team = lg.team(t);
    return {
      name: team.setup.name,
      score: team.box.totalScore,
      quarterScores: team.box.quarterScores,
      onCourt: team.onCourt.map((p) => p.name),
      manualLineup: team.manualLineup,
      context: team.setup.context,
      paceFactor: team.setup.paceFactor,
      players: team.setup.roster.map((p) => ({
        name: p.name, positionGroup: p.positionGroup, isForeign: p.isForeign, overall: p.overall,
        targetMinutes: p.perGameMin, energy: Math.round(team.energy.get(p.name) ?? 100),
        fouls: team.box.players.get(p.name)?.PF ?? 0,
      })),
      box: boxRows(team.box.players),
    };
  };
  return {
    sessionId: s.id,
    gameId: s.game.id,
    userSide: s.userSide,
    nextQuarter: lg.quarter,
    segmentsPlayed: lg.segmentIndex,
    finished: lg.finished,
    home: side("home"),
    away: side("away"),
    log: lg.log.slice(-60),
    quarterInProgress: lg.quarterInProgress,
    // 화면이 아직 받지 않은 포제션들 (since = 화면이 마지막으로 받은 seq)
    plays: lg.plays.filter((p) => p.seq > (extra.since ?? 0)),
    lastSeq: lg.plays.length,
    developmentChanges: extra.developmentChanges,
  };
}

export async function startLiveGame(pool: Pool, gameId: number) {
  const f = await getFranchise(pool);
  const g = await userGameToday(pool, f);
  if (!g || g.id !== gameId) throw new Error("오늘 진행할 수 있는 우리 팀 경기가 아닙니다");
  const played = await pool.query(`SELECT home_score FROM games WHERE id=$1`, [gameId]);
  if (played.rows[0].home_score !== null) throw new Error("이미 끝난 경기입니다");
  for (const [id, s] of sessions) if (s.game.id === gameId) sessions.delete(id); // 같은 경기 재시작

  const ctx = await buildContext(pool, f);
  const home = await buildTeamSetup(ctx, g.home_team_id, g.away_team_id, g.id);
  const away = await buildTeamSetup(ctx, g.away_team_id, g.home_team_id, g.id);
  const session: Session = {
    id: randomUUID(), game: g, live: new LiveGame(home, away),
    userSide: g.home_team_id === f.userTeamId ? "home" : "away", ctx, createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return sessionState(session);
}

export function getLiveGame(sessionId: string, since = 0) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("경기 세션을 찾을 수 없습니다 (서버가 재시작되었다면 경기를 다시 시작하세요)");
  return sessionState(s, { since });
}

function applyChanges(s: Session, body: { lineup?: string[] | null; tactics?: TacticsPatch }) {
  if (body.lineup !== undefined) {
    const err = s.live.setManualLineup(s.userSide, body.lineup);
    if (err) throw new Error(err);
    s.live.substituteNow(s.userSide); // 작전타임 교체는 바로 코트에 반영
  }
  if (body.tactics) {
    const t = body.tactics;
    const context: Record<string, unknown> = {};
    if (t.defenseScheme) context.defenseScheme = t.defenseScheme;
    if (t.threePointReliance) context.threeWeightMultiplier = THREE_MULT[t.threePointReliance];
    if (t.reboundEmphasis !== undefined) context.reboundEmphasis = t.reboundEmphasis;
    if (t.doubleTeamTarget !== undefined) context.doubleTeamTarget = t.doubleTeamTarget;
    s.live.updateSetup(s.userSide, {
      context: context as never,
      paceFactor: t.paceStyle ? PACE_FACTOR[t.paceStyle] : undefined,
    });
  }
}

/** 작전 변경만 하고 진행하지 않음 */
export function updateLiveGame(sessionId: string, body: { lineup?: string[] | null; tactics?: TacticsPatch; since?: number }) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("경기 세션을 찾을 수 없습니다");
  applyChanges(s, body);
  return sessionState(s, { since: body.since ?? s.live.plays.length });
}

/**
 * 다음 구간 진행. mode='segment'(5분) | 'quarter'(쿼터 끝까지) | 'end'(경기 끝까지)
 * 경기가 끝나면 결과를 DB에 저장하고 세션을 닫는다.
 */
export async function stepLiveGame(
  pool: Pool, sessionId: string,
  body: { lineup?: string[] | null; tactics?: TacticsPatch; mode?: "chunk" | "segment" | "quarter" | "end"; count?: number; since?: number }
) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("경기 세션을 찾을 수 없습니다");
  applyChanges(s, body);
  const since = body.since ?? s.live.plays.length;

  const mode = body.mode ?? "chunk";
  if (mode === "end") {
    while (!s.live.finished) s.live.playPossession();
  } else if (mode === "quarter") {
    // 쿼터 스킵: 지금 쿼터가 끝날 때까지 (쿼터 시작 전이면 그 쿼터 전체)
    const q = s.live.quarter;
    while (!s.live.finished && s.live.quarter === q) s.live.playPossession();
  } else if (mode === "segment") {
    s.live.playSegment();
  } else {
    // 실시간 중계용: 포제션 몇 개씩 (쿼터가 끝나면 거기서 멈춤)
    const n = Math.max(1, Math.min(20, body.count ?? 6));
    for (let i = 0; i < n && !s.live.finished; i++) {
      const play = s.live.playPossession();
      if (play?.quarterEnd) break;
    }
  }

  if (!s.live.finished) return sessionState(s, { since });

  const changes = await withTx(pool, async (db) => {
    const check = await db.query(`SELECT home_score FROM games WHERE id=$1`, [s.game.id]);
    if (check.rows[0].home_score !== null) throw new Error("이미 저장된 경기입니다");
    const f = await getFranchise(db);
    const ctx = await buildContext(db, f);
    return persistGameResult(db, s.game, s.live.result(), ctx);
  });
  sessions.delete(sessionId);
  const userTeamId = s.userSide === "home" ? s.game.home_team_id : s.game.away_team_id;
  return sessionState(s, { since, developmentChanges: changes.filter((c) => c.teamId === userTeamId) });
}
