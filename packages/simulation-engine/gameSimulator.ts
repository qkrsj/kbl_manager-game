/**
 * KBL Manager — 한 경기 시뮬레이션 (v1: 구간 단위 라이브 게임)
 *
 * 경기를 5분 구간(쿼터당 2구간, 연장은 구간 1개)으로 나눠 진행한다.
 *  - 구간 시작 시 코트 위 5명을 확정 (AI: 목표 출전시간·체력 기반 로테이션 / 유저: 직접 지정 가능)
 *  - 구간마다 팀당 포제션 9개(템포 전술로 ±10%) → 정규 40분 기준 팀당 약 72포제션
 *  - 경기 중 체력(energy): 코트에 있으면 감소(스태미나 낮을수록, 압박수비면 더 크게), 벤치에선 회복.
 *    체력이 떨어지면 슛 확률이 낮아짐
 *  - 파울아웃(5반칙): 즉시 교체되고 이후 출전 불가
 *  - 연장전(OT): 4쿼터 종료 후 동점이면 5분 연장을 반복. 외국선수는 1·4쿼터와 같이 1명
 *
 * 유저 팀이 "직접 참여"하는 경기는 LiveGame 인스턴스를 서버 메모리에 들고 구간마다
 * playSegment()를 호출하고, 그 사이에 라인업/전술을 바꿀 수 있다.
 * AI끼리의 경기는 simulateGame()으로 한 번에 끝까지 돌린다.
 */

import { chooseRotationLineup, validateManualLineup, RotationCandidate } from "./lineup";
import { simulatePossession, PossessionEvent, SimPlayer, TeamContext, ShotType } from "./possession";
export type { SimPlayer };

const SEGMENT_MINUTES = 5;
const REGULATION_SEGMENTS = 8;
const POSSESSIONS_PER_SEGMENT = 9;
const FOUL_OUT_LIMIT = 5;
const MAX_OT = 6;

export interface PlayerBoxScore {
  name: string;
  MIN: number;
  PTS: number;
  AST: number;
  REB: number;   // 공격+수비 리바운드 합산
  OREB: number;
  TOV: number;
  BLK: number;
  STL: number;
  PF: number;
  FGM: number;
  FGA: number;
  TPM: number;
  TPA: number;
  FTM: number;
  FTA: number;
}

export interface TeamBoxScore {
  teamName: string;
  quarterScores: number[];    // [1Q, 2Q, 3Q, 4Q, (OT1, OT2, ...)]
  totalScore: number;
  players: Map<string, PlayerBoxScore>;
}

export interface GameResult {
  home: TeamBoxScore;
  away: TeamBoxScore;
  wentToOT: boolean;
  otPeriods: number;
}

export interface TeamGameSetup {
  name: string;
  roster: SimPlayer[];            // perGameMin = 목표 출전시간, overall = 종합능력치
  context: TeamContext;
  paceFactor: number;             // 0.9(느리게) / 1.0 / 1.1(빠르게)
  startingEnergy?: Record<string, number>; // 시즌 누적 피로도 반영한 경기 시작 체력 (기본 100)
}

export interface PlayByPlay {
  quarter: number;
  clock: string;
  team: string;
  text: string;
  homeScore: number;
  awayScore: number;
  scoring: boolean;
}

/** 중계 화면용 "한 동작" (패스·슛·리바운드 등) */
export interface PlayBeat {
  kind: "bring" | "pass" | "shot" | "ft" | "turnover" | "steal" | "foul" | "block" | "oreb" | "dreb" | "info";
  side: "home" | "away";       // 동작한 선수의 팀
  actor: string;
  target?: string;             // 패스 받는 선수
  shotType?: ShotType;
  made?: boolean;
  points?: number;
  text: string;
}

/** 포제션 하나 (중계 화면이 한 동작씩 재생) */
export interface PossessionPlay {
  seq: number;
  quarter: number;
  clockStart: string;
  clockEnd: string;
  offense: "home" | "away";
  beats: PlayBeat[];
  points: number;
  homeScore: number;
  awayScore: number;
  homeOnCourt: string[];
  awayOnCourt: string[];
  quarterEnd?: boolean;        // 이 포제션으로 쿼터(연장)가 끝남
  timeout?: { side: "home" | "away"; team: string; remaining: number }; // 이 포제션 뒤에 부른 작전타임
}

/**
 * 작전타임 규정 (KBL = FIBA 규칙)
 *  - 전반(1·2쿼터) 2회, 후반(3·4쿼터) 3회, 연장은 매 연장마다 1회
 *  - 4쿼터 마지막 2분 동안은 후반 작전타임 중 최대 2회까지만
 *  - 쓰지 않은 작전타임은 다음 반·연장으로 넘어가지 않음
 */
export const TIMEOUT_RULE_TEXT = "전반 2회 · 후반 3회(4쿼터 마지막 2분엔 최대 2회) · 연장마다 1회, 남은 횟수는 이월 안 됨";

interface SegmentState {
  quarter: number;
  possessions: number;         // 팀당 포제션 수
  i: number;                   // 진행한 포제션(양 팀 합산)
  homeStarts: boolean;
  segInQuarter: number;
  quarterSeconds: number;
  homePts: number;
  awayPts: number;
  courtShare: Map<string, number>;
}

interface LiveTeam {
  setup: TeamGameSetup;
  box: TeamBoxScore;
  energy: Map<string, number>;
  minutes: Map<string, number>;
  onCourt: SimPlayer[];
  manualLineup: string[] | null;
  manualUntilSegment: number;          // 직접 지정한 라인업은 이 구간까지만 유지 (이후엔 출전시간에 맞춰 자동 교체)
  timeoutsUsed: { quarter: number; secondsLeft: number }[];
}

const SHOT_LABEL: Record<ShotType, string> = { paint: "골밑슛", mid: "미드레인지 점퍼", three: "3점슛" };

function emptyBox(name: string): PlayerBoxScore {
  return { name, MIN: 0, PTS: 0, AST: 0, REB: 0, OREB: 0, TOV: 0, BLK: 0, STL: 0, PF: 0, FGM: 0, FGA: 0, TPM: 0, TPA: 0, FTM: 0, FTA: 0 };
}

function getOrCreate(map: Map<string, PlayerBoxScore>, name: string): PlayerBoxScore {
  let box = map.get(name);
  if (!box) {
    box = emptyBox(name);
    map.set(name, box);
  }
  return box;
}

/** 포제션 이벤트를 박스스코어에 반영 */
function applyEventsToBox(events: PossessionEvent[], offenseBox: Map<string, PlayerBoxScore>, defenseBox: Map<string, PlayerBoxScore>) {
  for (const e of events) {
    switch (e.type) {
      case "SHOT": {
        const b = getOrCreate(offenseBox, e.actor);
        b.FGA += 1;
        if (e.shotType === "three") b.TPA += 1;
        if (e.made) {
          b.FGM += 1;
          b.PTS += e.points ?? 0;
          if (e.shotType === "three") b.TPM += 1;
          if (e.assister) getOrCreate(offenseBox, e.assister).AST += 1;
        }
        break;
      }
      case "FT": {
        const b = getOrCreate(offenseBox, e.actor);
        b.FTA += 1;
        if (e.made) { b.FTM += 1; b.PTS += 1; }
        break;
      }
      case "TURNOVER": getOrCreate(offenseBox, e.actor).TOV += 1; break;
      case "STEAL": getOrCreate(defenseBox, e.actor).STL += 1; break;
      case "BLOCK": getOrCreate(defenseBox, e.actor).BLK += 1; break;
      case "FOUL": getOrCreate(defenseBox, e.actor).PF += 1; break;
      case "REBOUND_OFF": { const b = getOrCreate(offenseBox, e.actor); b.REB += 1; b.OREB += 1; break; }
      case "REBOUND_DEF": getOrCreate(defenseBox, e.actor).REB += 1; break;
    }
  }
}

/** 포제션 하나를 중계 문장으로 요약 */
function describePossession(events: PossessionEvent[]): string[] {
  const lines: string[] = [];
  let ftShooter: string | null = null;
  let ftMade = 0;
  let ftTotal = 0;
  const flushFt = () => {
    if (ftShooter) lines.push(`${ftShooter} 자유투 ${ftTotal}개 중 ${ftMade}개 성공`);
    ftShooter = null; ftMade = 0; ftTotal = 0;
  };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "FT") flushFt();
    switch (e.type) {
      case "SHOT": {
        const label = e.putback ? `세컨찬스 ${SHOT_LABEL[e.shotType!]}` : SHOT_LABEL[e.shotType!];
        const blocked = events[i + 1]?.type === "BLOCK" ? events[i + 1].actor : null;
        if (e.made) lines.push(`${e.actor} ${label} 성공${e.assister ? ` (어시스트: ${e.assister})` : ""}`);
        else if (blocked) lines.push(`${e.actor}의 ${label}을 ${blocked}가 블록!`);
        else lines.push(`${e.actor} ${label} 실패`);
        break;
      }
      case "FT":
        ftShooter = e.actor; ftTotal += 1; if (e.made) ftMade += 1;
        break;
      case "TURNOVER": {
        const steal = events[i + 1]?.type === "STEAL" ? events[i + 1].actor : null;
        lines.push(steal ? `${steal}가 ${e.actor}의 공을 가로챔 (스틸)` : `${e.actor} 턴오버`);
        break;
      }
      case "FOUL":
        lines.push(`${e.actor} 파울 (${e.detail === "drive" ? "돌파 저지" : "슈팅 파울"})`);
        break;
      case "REBOUND_OFF":
        lines.push(`${e.actor} 공격 리바운드`);
        break;
      default:
        break;
    }
  }
  flushFt();
  return lines;
}

/** 포제션 이벤트 → 중계 동작 목록 (패스 하나하나까지) */
function toBeats(events: PossessionEvent[], offSide: "home" | "away"): PlayBeat[] {
  const defSide = offSide === "home" ? "away" : "home";
  const beats: PlayBeat[] = [];
  let holder: string | null = null; // 지금 공을 가진 공격수
  if (events.length > 0) {
    const first = events.find((e) => e.type === "PASS" || e.type === "SHOT" || e.type === "TURNOVER" || e.type === "FT");
    if (first) {
      beats.push({ kind: "bring", side: offSide, actor: first.actor, text: `${first.actor} 공을 몰고 넘어옵니다` });
      holder = first.actor;
    }
  }
  /** 기록에 없는 패스(공격 리바운드 뒤 빼주기 등)를 채워서 공이 순간이동하지 않게 */
  const handTo = (actor: string) => {
    if (holder && holder !== actor) beats.push({ kind: "pass", side: offSide, actor: holder, target: actor, text: `${holder} → ${actor} 패스` });
    holder = actor;
  };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const next = events[i + 1];
    switch (e.type) {
      case "PASS": {
        // 받는 선수 = 다음 공격 동작의 주인 (패스미스면 다음 이벤트가 같은 선수의 턴오버)
        const recv = events.slice(i + 1).find((x) => x.type === "PASS" || x.type === "SHOT" || x.type === "FT" || (x.type === "TURNOVER"));
        if (recv && recv.actor !== e.actor) {
          holder = e.actor;
          handTo(recv.actor);
        }
        break;
      }
      case "SHOT": {
        handTo(e.actor);
        const label = e.putback ? `세컨찬스 ${SHOT_LABEL[e.shotType!]}` : SHOT_LABEL[e.shotType!];
        const blocked = next?.type === "BLOCK";
        const text = e.made
          ? `${e.actor} ${label} 성공! +${e.points}${e.assister ? ` (어시스트 ${e.assister})` : ""}`
          : blocked ? `${e.actor} ${label} 시도…` : `${e.actor} ${label} 실패`;
        beats.push({ kind: "shot", side: offSide, actor: e.actor, shotType: e.shotType, made: !!e.made, points: e.points ?? 0, text });
        break;
      }
      case "BLOCK": beats.push({ kind: "block", side: defSide, actor: e.actor, text: `${e.actor} 블록슛!` }); break;
      case "FT": beats.push({ kind: "ft", side: offSide, actor: e.actor, made: !!e.made, points: e.made ? 1 : 0, text: `${e.actor} 자유투 ${e.made ? "성공" : "실패"}` }); break;
      case "TURNOVER": {
        const steal = next?.type === "STEAL";
        if (!steal) beats.push({ kind: "turnover", side: offSide, actor: e.actor, text: `${e.actor} 턴오버` });
        break;
      }
      case "STEAL": {
        const loser = events[i - 1]?.actor ?? "";
        beats.push({ kind: "steal", side: defSide, actor: e.actor, target: loser, text: `${e.actor} 스틸! (${loser}의 공을 가로챔)` });
        break;
      }
      case "FOUL": beats.push({ kind: "foul", side: defSide, actor: e.actor, text: `${e.actor} 파울 (${e.detail === "drive" ? "돌파 저지" : "슈팅 파울"})` }); break;
      case "REBOUND_OFF": beats.push({ kind: "oreb", side: offSide, actor: e.actor, text: `${e.actor} 공격 리바운드!` }); holder = e.actor; break;
      case "REBOUND_DEF": beats.push({ kind: "dreb", side: defSide, actor: e.actor, text: `${e.actor} 수비 리바운드` }); break;
    }
  }
  return beats;
}

function formatClock(secondsLeft: number): string {
  const s = Math.max(0, Math.round(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 4쿼터·연장 클러치 마무리 부스트 (tactics.isClutchCloser 지정 선수의 usage/득점력 상향) */
function clutchBoost(p: SimPlayer): SimPlayer {
  return p.tactics?.isClutchCloser
    ? { ...p, internals: { ...p.internals, usagePercentile: 97, ptsPercentile: 97 } }
    : p;
}

/** 체력에 따른 슛 정확도 보정 */
function withEnergy(p: SimPlayer, energy: number): SimPlayer {
  const mult = 0.88 + 0.12 * Math.max(0, Math.min(100, energy)) / 100;
  return {
    ...p,
    internals: {
      ...p.internals,
      paintAccuracy: p.internals.paintAccuracy * mult,
      midAccuracy: p.internals.midAccuracy * mult,
      threeAccuracy: p.internals.threeAccuracy * mult,
      ftAccuracy: p.internals.ftAccuracy * (0.94 + 0.06 * mult),
    },
  };
}

export class LiveGame {
  readonly home: LiveTeam;
  readonly away: LiveTeam;
  segmentIndex = 0;            // 완료된 구간 수
  log: PlayByPlay[] = [];
  plays: PossessionPlay[] = [];
  finished = false;
  private seg: SegmentState | null = null;
  /** 작전타임을 스스로 부르는 AI 팀 (유저가 지휘하는 경기에서 상대 팀). null이면 아무도 안 부름 */
  aiTimeoutSide: "home" | "away" | null = null;
  /** 작전타임 직후 — 다음 포제션 전까지 교체·작전 변경 가능 */
  private timeoutWindow = false;
  private runAgainst = { home: 0, away: 0 }; // 상대에게 연속으로 내준 점수

  constructor(home: TeamGameSetup, away: TeamGameSetup) {
    this.home = this.initTeam(home);
    this.away = this.initTeam(away);
  }

  private initTeam(setup: TeamGameSetup): LiveTeam {
    const box: TeamBoxScore = { teamName: setup.name, quarterScores: [0, 0, 0, 0], totalScore: 0, players: new Map() };
    const energy = new Map<string, number>();
    const minutes = new Map<string, number>();
    setup.roster.forEach((p) => {
      getOrCreate(box.players, p.name);
      energy.set(p.name, setup.startingEnergy?.[p.name] ?? 100);
      minutes.set(p.name, 0);
    });
    return { setup, box, energy, minutes, onCourt: [], manualLineup: null, manualUntilSegment: -1, timeoutsUsed: [] };
  }

  /** 다음에 진행할 구간의 쿼터 번호 (5 이상 = 연장) */
  get quarter(): number {
    return this.segmentIndex < REGULATION_SEGMENTS ? Math.floor(this.segmentIndex / 2) + 1 : 5 + (this.segmentIndex - REGULATION_SEGMENTS);
  }

  get elapsedMinutes(): number {
    return this.segmentIndex * SEGMENT_MINUTES;
  }

  team(side: "home" | "away"): LiveTeam {
    return side === "home" ? this.home : this.away;
  }

  /** 출전 가능 선수 (파울아웃 제외) */
  available(t: LiveTeam): SimPlayer[] {
    return t.setup.roster.filter((p) => (t.box.players.get(p.name)?.PF ?? 0) < FOUL_OUT_LIMIT);
  }

  /**
   * 유저 지정 라인업 (null이면 자동 로테이션). 작전타임·쿼터 사이에만 바꿀 수 있고,
   * 지정한 5명은 이번 교체 구간(5분 단위)이 끝날 때까지 뛰고 그다음부터는 출전시간에 맞춰 자동 교체된다.
   */
  setManualLineup(side: "home" | "away", names: string[] | null): string | null {
    const t = this.team(side);
    if (names === null) {
      t.manualLineup = null;
      return null;
    }
    const players = names.map((n) => this.available(t).find((p) => p.name === n));
    if (players.some((p) => !p)) return "출전할 수 없는 선수가 포함되어 있습니다 (파울아웃/엔트리 제외)";
    const err = validateManualLineup(players as SimPlayer[], this.quarter);
    if (err) return err;
    t.manualLineup = names;
    t.manualUntilSegment = this.segmentIndex;
    return null;
  }

  /** 지금 이 순간(다음 포제션 시작 전)의 쿼터와 남은 시간(초) */
  private now(): { quarter: number; secondsLeft: number } {
    if (this.seg) {
      const total = this.seg.possessions * 2;
      return { quarter: this.seg.quarter, secondsLeft: this.seg.quarterSeconds - (this.seg.segInQuarter * 300 + (this.seg.i / total) * 300) };
    }
    const q = this.quarter;
    return { quarter: q, secondsLeft: q >= 5 ? 300 : this.segmentIndex % 2 === 1 ? 300 : 600 };
  }

  /** 남은 작전타임 (지금 시점 기준) */
  timeoutsLeft(side: "home" | "away"): number {
    const t = this.team(side);
    const { quarter, secondsLeft } = this.now();
    if (quarter >= 5) return Math.max(0, 1 - t.timeoutsUsed.filter((u) => u.quarter === quarter).length);
    const half = quarter <= 2 ? [1, 2] : [3, 4];
    let left = (quarter <= 2 ? 2 : 3) - t.timeoutsUsed.filter((u) => half.includes(u.quarter)).length;
    if (quarter === 4 && secondsLeft <= 120) {
      const lastTwo = t.timeoutsUsed.filter((u) => u.quarter === 4 && u.secondsLeft <= 120).length;
      left = Math.min(left, 2 - lastTwo);
    }
    return Math.max(0, left);
  }

  /** 쿼터 사이(쿼터 시작 전)인지 — 이때는 작전타임 없이 교체 가능 */
  get atQuarterBreak(): boolean {
    if (this.finished || this.seg) return false;
    return this.segmentIndex >= REGULATION_SEGMENTS || this.segmentIndex % 2 === 0;
  }

  /** 교체·작전 변경이 가능한 순간: 작전타임 직후(어느 팀이든) 또는 쿼터 사이 */
  get substitutionWindow(): boolean {
    return !this.finished && (this.timeoutWindow || this.atQuarterBreak);
  }

  /** 작전타임 요청. 성공하면 null, 못 부르면 사유 */
  callTimeout(side: "home" | "away"): string | null {
    if (this.finished) return "경기가 끝났습니다";
    if (this.atQuarterBreak) return "쿼터 사이에는 작전타임 없이 바로 교체할 수 있습니다";
    if (this.timeoutWindow) return "이미 작전타임 중입니다 — 지금 교체·작전을 바꿀 수 있습니다";
    if (this.timeoutsLeft(side) <= 0) return `남은 작전타임이 없습니다 (${TIMEOUT_RULE_TEXT})`;
    const t = this.team(side);
    const at = this.now();
    t.timeoutsUsed.push({ quarter: at.quarter, secondsLeft: at.secondsLeft });
    // 작전타임 동안 코트 위 선수들이 숨을 돌림
    for (const team of [this.home, this.away]) team.onCourt.forEach((p) => team.energy.set(p.name, Math.min(100, (team.energy.get(p.name) ?? 100) + 3)));
    this.timeoutWindow = true;
    this.runAgainst[side] = 0;
    const last = this.plays[this.plays.length - 1];
    if (last && !last.timeout) last.timeout = { side, team: t.setup.name, remaining: this.timeoutsLeft(side) };
    this.log.push({
      quarter: at.quarter, clock: formatClock(at.secondsLeft), team: t.setup.name, text: `${t.setup.name} 작전타임`,
      homeScore: this.home.box.totalScore, awayScore: this.away.box.totalScore, scoring: false,
    });
    return null;
  }

  /** AI 팀 작전타임 판단: 상대에게 연속 8점 이상 내줬거나, 4쿼터 막판 접전에서 상대가 득점했을 때 */
  private maybeAiTimeout(play: PossessionPlay) {
    const side = this.aiTimeoutSide;
    if (!side || play.quarterEnd || this.finished || play.points === 0 || play.offense === side) return;
    if (this.timeoutsLeft(side) <= 0) return;
    const { quarter, secondsLeft } = this.now();
    const margin = Math.abs(this.home.box.totalScore - this.away.box.totalScore);
    const run = this.runAgainst[side] >= 8 && Math.random() < 0.75;
    const clutch = quarter >= 4 && secondsLeft <= 120 && margin <= 4 && Math.random() < 0.35;
    if (run || clutch) this.callTimeout(side);
  }

  updateSetup(side: "home" | "away", patch: Partial<Pick<TeamGameSetup, "context" | "paceFactor">> & { roster?: SimPlayer[] }) {
    const t = this.team(side);
    if (patch.context) t.setup.context = { ...t.setup.context, ...patch.context };
    if (patch.paceFactor) t.setup.paceFactor = patch.paceFactor;
    if (patch.roster) {
      // 목표 출전시간/전술 플래그만 교체 (체력·기록은 유지)
      const byName = new Map(patch.roster.map((p) => [p.name, p]));
      t.setup.roster = t.setup.roster.map((p) => byName.get(p.name) ?? p);
    }
  }

  private pickLineup(t: LiveTeam, closing: boolean): SimPlayer[] {
    const avail = this.available(t);
    if (t.manualLineup && this.segmentIndex > t.manualUntilSegment) t.manualLineup = null; // 지정 구간이 지나면 자동 교체로
    if (t.manualLineup) {
      const manual = t.manualLineup.map((n) => avail.find((p) => p.name === n)).filter((p): p is SimPlayer => !!p);
      if (manual.length === 5 && !validateManualLineup(manual, this.quarter)) return manual;
      t.manualLineup = null; // 파울아웃 등으로 무효화되면 자동 로테이션으로 복귀
    }
    const candidates: (RotationCandidate & { sim: SimPlayer })[] = avail.map((p) => ({
      ...p,
      targetMinutes: p.perGameMin,
      minutesPlayed: t.minutes.get(p.name) ?? 0,
      energy: t.energy.get(p.name) ?? 100,
      overall: p.overall ?? 70,
      sim: p,
    }));
    const chosen = chooseRotationLineup(candidates, this.quarter, this.elapsedMinutes, SEGMENT_MINUTES, { closing });
    return chosen.map((c) => (c as RotationCandidate & { sim: SimPlayer }).sim);
  }

  /** 파울아웃 선수를 같은 포지션 우선으로 즉시 교체 */
  private replaceFouledOut(t: LiveTeam) {
    t.onCourt = t.onCourt.map((p) => {
      if ((t.box.players.get(p.name)?.PF ?? 0) < FOUL_OUT_LIMIT) return p;
      const bench = this.available(t).filter((b) => !t.onCourt.includes(b));
      const foreignOnCourt = t.onCourt.filter((c) => c.isForeign && c !== p).length;
      const legal = bench.filter((b) => !b.isForeign || foreignOnCourt < (this.quarter === 2 || this.quarter === 3 ? 2 : 1));
      const sameGroup = legal.filter((b) => b.positionGroup === p.positionGroup);
      const pool = sameGroup.length > 0 ? sameGroup : legal;
      if (pool.length === 0) return p; // 교체할 선수가 없으면(극히 드묾) 그대로
      this.log.push({
        quarter: this.quarter, clock: "", team: t.setup.name, text: `${p.name} 5반칙 퇴장`,
        homeScore: this.home.box.totalScore, awayScore: this.away.box.totalScore, scoring: false,
      });
      return pool.reduce((a, b) => ((a.overall ?? 70) >= (b.overall ?? 70) ? a : b));
    });
  }

  /** 구간(5분) 진행 중인지 — 진행 중이면 다음 포제션은 같은 구간에서 이어짐 */
  get inSegment(): boolean {
    return this.seg !== null;
  }

  /** 지금 쿼터가 진행 중인지 (쿼터 시작 전이면 false) */
  get quarterInProgress(): boolean {
    if (this.finished) return false;
    if (this.seg) return true;
    return this.segmentIndex < REGULATION_SEGMENTS && this.segmentIndex % 2 === 1;
  }

  private startSegment() {
    const quarter = this.quarter;
    const isOT = quarter >= 5;
    const scoreGap = Math.abs(this.home.box.totalScore - this.away.box.totalScore);
    const closing = (this.segmentIndex === REGULATION_SEGMENTS - 1 || isOT) && scoreGap <= 10;
    for (const t of [this.home, this.away]) t.onCourt = this.pickLineup(t, closing);
    const pace = (this.home.setup.paceFactor + this.away.setup.paceFactor) / 2;
    this.seg = {
      quarter,
      possessions: Math.max(6, Math.round(POSSESSIONS_PER_SEGMENT * pace + (Math.random() - 0.5))),
      i: 0,
      homeStarts: this.segmentIndex % 2 === 0,
      segInQuarter: isOT ? 0 : this.segmentIndex % 2,
      quarterSeconds: isOT ? 300 : 600,
      homePts: 0,
      awayPts: 0,
      courtShare: new Map(),
    };
  }

  /** 작전타임 교체: 구간 진행 중이면 지정 라인업을 바로 코트에 투입 (해제하면 출전시간 기준 자동 라인업으로) */
  substituteNow(side: "home" | "away") {
    if (!this.seg) return;
    const t = this.team(side);
    t.onCourt = this.pickLineup(t, false);
  }

  /** 포제션 하나 진행 (구간 시작/정산은 자동). 진행한 포제션을 돌려준다 */
  playPossession(): PossessionPlay | null {
    if (this.finished) return null;
    if (!this.seg) this.startSegment();
    this.timeoutWindow = false;
    const seg = this.seg!;
    const quarter = seg.quarter;
    const total = seg.possessions * 2;
    const homeOff = (seg.i % 2 === 0) === seg.homeStarts;
    const off = homeOff ? this.home : this.away;
    const def = homeOff ? this.away : this.home;
    const late = quarter >= 4;
    const offLineup = off.onCourt.map((p) => withEnergy(late ? clutchBoost(p) : p, off.energy.get(p.name) ?? 100));
    const defLineup = def.onCourt.map((p) => withEnergy(p, def.energy.get(p.name) ?? 100));

    const result = simulatePossession(offLineup, defLineup, off.setup.context, def.setup.context);
    applyEventsToBox(result.events, off.box.players, def.box.players);
    off.box.totalScore += result.points;
    if (homeOff) seg.homePts += result.points; else seg.awayPts += result.points;

    const secondsAt = (k: number) => seg.quarterSeconds - (seg.segInQuarter * 300 + (k / total) * 300);
    const clockEnd = formatClock(secondsAt(seg.i + 1));
    for (const text of describePossession(result.events)) {
      this.log.push({
        quarter, clock: clockEnd, team: off.setup.name, text,
        homeScore: this.home.box.totalScore, awayScore: this.away.box.totalScore, scoring: result.points > 0,
      });
    }
    const play: PossessionPlay = {
      seq: this.plays.length + 1, quarter, clockStart: formatClock(secondsAt(seg.i)), clockEnd,
      offense: homeOff ? "home" : "away", beats: toBeats(result.events, homeOff ? "home" : "away"), points: result.points,
      homeScore: this.home.box.totalScore, awayScore: this.away.box.totalScore,
      homeOnCourt: this.home.onCourt.map((p) => p.name), awayOnCourt: this.away.onCourt.map((p) => p.name),
    };
    this.plays.push(play);

    for (const t of [this.home, this.away]) t.onCourt.forEach((p) => seg.courtShare.set(p.name, (seg.courtShare.get(p.name) ?? 0) + 1));
    this.replaceFouledOut(this.home);
    this.replaceFouledOut(this.away);

    // 연속 실점 집계 (AI 작전타임 판단용)
    if (result.points > 0) {
      const scorer: "home" | "away" = homeOff ? "home" : "away";
      const victim: "home" | "away" = homeOff ? "away" : "home";
      this.runAgainst[scorer] = 0;
      this.runAgainst[victim] += result.points;
    }

    seg.i++;
    if (seg.i >= total) {
      const quarterBefore = this.quarter;
      this.finishSegment();
      if (this.finished || this.quarter !== quarterBefore) play.quarterEnd = true;
    }
    this.maybeAiTimeout(play);
    return play;
  }

  /** 구간 정산: 출전시간·체력·쿼터 점수, 경기 종료 판정 */
  private finishSegment() {
    const seg = this.seg!;
    const total = seg.possessions * 2;
    for (const t of [this.home, this.away]) {
      const drainMult = t.setup.context.defenseScheme === "press" ? 1.25 : 1;
      for (const p of t.setup.roster) {
        const share = (seg.courtShare.get(p.name) ?? 0) / total;
        const played = share * SEGMENT_MINUTES;
        t.minutes.set(p.name, (t.minutes.get(p.name) ?? 0) + played);
        getOrCreate(t.box.players, p.name).MIN += played;
        const e = t.energy.get(p.name) ?? 100;
        const drain = (7 + (99 - p.attrs.stamina) * 0.12) * drainMult * share;
        const recover = 12 * (1 - share);
        t.energy.set(p.name, Math.max(0, Math.min(100, e - drain + recover)));
      }
    }
    const qIdx = seg.quarter - 1;
    for (const [t, pts] of [[this.home, seg.homePts], [this.away, seg.awayPts]] as const) {
      while (t.box.quarterScores.length <= qIdx) t.box.quarterScores.push(0);
      t.box.quarterScores[qIdx] += pts;
    }
    this.seg = null;
    this.segmentIndex++;
    const regulationDone = this.segmentIndex >= REGULATION_SEGMENTS;
    const tied = this.home.box.totalScore === this.away.box.totalScore;
    if (regulationDone && (!tied || this.segmentIndex >= REGULATION_SEGMENTS + MAX_OT)) {
      if (tied) this.home.box.totalScore += 1; // 극히 드문 무한 연장 안전장치
      this.finished = true;
    }
  }

  /** 구간 하나(5분) 끝까지 진행 (이미 진행 중이면 남은 포제션만) */
  playSegment(): void {
    if (this.finished) return;
    const startIdx = this.segmentIndex;
    while (!this.finished && this.segmentIndex === startIdx) this.playPossession();
  }

  runToEnd(): GameResult {
    while (!this.finished) this.playSegment();
    return this.result();
  }

  result(): GameResult {
    const otPeriods = Math.max(0, this.segmentIndex - REGULATION_SEGMENTS);
    for (const t of [this.home, this.away]) t.box.players.forEach((b) => { b.MIN = Math.round(b.MIN * 10) / 10; });
    return { home: this.home.box, away: this.away.box, wentToOT: otPeriods > 0, otPeriods };
  }
}

/** AI 경기 등 사람이 개입하지 않는 경기를 한 번에 시뮬레이션 */
export function simulateGame(
  homeRoster: SimPlayer[] | TeamGameSetup,
  awayRoster: SimPlayer[] | TeamGameSetup,
  homeName?: string,
  awayName?: string
): GameResult {
  const toSetup = (r: SimPlayer[] | TeamGameSetup, name?: string): TeamGameSetup =>
    Array.isArray(r) ? { name: name ?? "team", roster: r, context: { defenseScheme: "man" }, paceFactor: 1 } : r;
  return new LiveGame(toSetup(homeRoster, homeName), toSetup(awayRoster, awayName)).runToEnd();
}
