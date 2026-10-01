/**
 * KBL Manager — 시즌 스케줄러 (v0.2)
 *
 * v0.2 변경사항:
 *  - 라운드 생성 방식을 "원형법(circle method)"으로 교체. 매 라운드마다 10팀이
 *    전부 동시에 1경기씩 뛰는 정식 라운드로빈 구조(9라운드×6사이클=54라운드=팀당54경기).
 *    홈/원정은 사이클 짝/홀에 따라 반전시켜 모든 팀쌍이 정확히 홈3/원정3이 되도록 보장.
 *  - 각 라운드에 실제 날짜(시즌 시작일로부터 경과일)를 부여. 라운드 간격은 대부분
 *    2~3일이지만 15% 확률로 1일(백투백)도 발생하도록 함.
 *  - 체력(피로) 시스템: 직전 경기로부터 휴식일이 2일 미만(백투백)이면, 그 경기에서
 *    슈팅 계열 실제확률(paintAccuracy 등)에 페널티를 적용. stamina 능력치가 낮을수록
 *    페널티가 더 크게 걸림 (체력 좋은 선수는 백투백에도 덜 흔들림).
 */

import { simulateGame, GameResult, SimPlayer, PlayerBoxScore } from "./gameSimulator";
export type { SimPlayer, PlayerBoxScore };

export interface ScheduledGame {
  round: number;
  day: number;
  home: string;
  away: string;
}

function circleMethodSingleRoundRobin(teams: string[]): { home: string; away: string }[][] {
  const n = teams.length;
  if (n % 2 !== 0) throw new Error("원형법은 짝수 팀 수만 지원합니다 (부전승 미구현)");
  const arr = [...teams];
  const rounds: { home: string; away: string }[][] = [];

  for (let r = 0; r < n - 1; r++) {
    const roundPairs: { home: string; away: string }[] = [];
    for (let i = 0; i < n / 2; i++) {
      roundPairs.push({ home: arr[i], away: arr[n - 1 - i] });
    }
    rounds.push(roundPairs);
    const last = arr[n - 1];
    for (let i = n - 1; i > 1; i--) arr[i] = arr[i - 1];
    arr[1] = last;
  }
  return rounds;
}

export function generateRoundRobinSchedule(teams: string[], timesEach: number): ScheduledGame[] {
  const singleCycle = circleMethodSingleRoundRobin(teams);
  const games: ScheduledGame[] = [];

  let roundCounter = 0;
  let baseDayCounter = 0;

  for (let cycle = 0; cycle < timesEach; cycle++) {
    const flip = cycle % 2 === 1;
    for (const roundPairs of singleCycle) {
      roundCounter++;
      if (roundCounter > 1) {
        // ⚠️ roundGap 최솟값이 항상 라운드내 분산 최댓값보다 커야 라운드 경계에서
        // 같은 팀이 겹쳐 배정되는 사고가 안 생김 (gap=4, jitter=0~3 이므로 항상 안전)
        baseDayCounter += 4;
      }
      roundPairs.forEach((pair) => {
        // ⚠️ "라운드"는 각 팀이 서로 한번씩 붙는 사이클 단위 개념일 뿐, 실제로는
        // 하루에 다 열리지 않고 개별 경기가 며칠에 걸쳐 흩어져서 열린다.
        // round 필드는 참고/디버그용으로만 남기고, 실제 시즌 진행은 day(날짜) 기준으로 처리.
        const dayOffsetWithinRound = Math.floor(Math.random() * 4); // 0~3일 분산
        games.push({
          round: roundCounter,
          day: baseDayCounter + dayOffsetWithinRound,
          home: flip ? pair.away : pair.home,
          away: flip ? pair.home : pair.away,
        });
      });
    }
  }
  return games;
}

export interface TeamStanding {
  team: string;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  gamesPlayed: number;
}

export interface SeasonGameLog {
  round: number;
  day: number;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  wentToOT: boolean;
  homeRestDays: number | null;
  awayRestDays: number | null;
  homeBoxScores: PlayerBoxScore[];
  awayBoxScores: PlayerBoxScore[];
}

export interface SeasonResult {
  standings: TeamStanding[];
  gameLogs: SeasonGameLog[];
  playerSeasonTotals: Map<string, { PTS: number; AST: number; REB: number; TOV: number; BLK: number; PF: number; games: number }>;
}

function emptyStanding(team: string): TeamStanding {
  return { team, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, gamesPlayed: 0 };
}

export function applyFatigue(roster: SimPlayer[], restDays: number | null): SimPlayer[] {
  if (restDays === null || restDays >= 2) return roster;

  return roster.map((p) => {
    const staminaFactor = p.attrs.stamina / 100;
    const penalty = 0.85 + staminaFactor * 0.13;
    return {
      ...p,
      internals: {
        ...p.internals,
        paintAccuracy: p.internals.paintAccuracy * penalty,
        midAccuracy: p.internals.midAccuracy * penalty,
        threeAccuracy: p.internals.threeAccuracy * penalty,
        ftAccuracy: p.internals.ftAccuracy * penalty,
      },
    };
  });
}

export function runSeason(
  teamRosters: Map<string, SimPlayer[]>,
  schedule: ScheduledGame[]
): SeasonResult {
  const standingsMap = new Map<string, TeamStanding>();
  teamRosters.forEach((_, team) => standingsMap.set(team, emptyStanding(team)));

  const gameLogs: SeasonGameLog[] = [];
  const playerSeasonTotals = new Map<
    string,
    { PTS: number; AST: number; REB: number; TOV: number; BLK: number; PF: number; games: number }
  >();
  const lastPlayDay = new Map<string, number>();

  function accumulatePlayer(name: string, box: { PTS: number; AST: number; REB: number; TOV: number; BLK: number; PF: number }) {
    let cur = playerSeasonTotals.get(name);
    if (!cur) {
      cur = { PTS: 0, AST: 0, REB: 0, TOV: 0, BLK: 0, PF: 0, games: 0 };
      playerSeasonTotals.set(name, cur);
    }
    cur.PTS += box.PTS;
    cur.AST += box.AST;
    cur.REB += box.REB;
    cur.TOV += box.TOV;
    cur.BLK += box.BLK;
    cur.PF += box.PF;
    cur.games += 1;
  }

  // ⚠️ round는 이제 "사이클 단위" 개념일 뿐 시간순서를 보장하지 않음 (개별 경기가
  // 날짜별로 흩어져 있으므로) — 반드시 day(날짜) 기준으로 정렬해야 휴식일 계산이 맞음
  const orderedSchedule = [...schedule].sort((a, b) => a.day - b.day);

  for (const game of orderedSchedule) {
    const homeRosterBase = teamRosters.get(game.home);
    const awayRosterBase = teamRosters.get(game.away);
    if (!homeRosterBase || !awayRosterBase) continue;

    const homeLastDay = lastPlayDay.get(game.home);
    const awayLastDay = lastPlayDay.get(game.away);
    const homeRestDays = homeLastDay === undefined ? null : game.day - homeLastDay;
    const awayRestDays = awayLastDay === undefined ? null : game.day - awayLastDay;

    const homeRoster = applyFatigue(homeRosterBase, homeRestDays);
    const awayRoster = applyFatigue(awayRosterBase, awayRestDays);

    const result: GameResult = simulateGame(homeRoster, awayRoster, game.home, game.away);

    gameLogs.push({
      round: game.round,
      day: game.day,
      home: game.home,
      away: game.away,
      homeScore: result.home.totalScore,
      awayScore: result.away.totalScore,
      wentToOT: result.wentToOT,
      homeRestDays,
      awayRestDays,
      homeBoxScores: Array.from(result.home.players.values()),
      awayBoxScores: Array.from(result.away.players.values()),
    });

    const homeStanding = standingsMap.get(game.home)!;
    const awayStanding = standingsMap.get(game.away)!;
    homeStanding.pointsFor += result.home.totalScore;
    homeStanding.pointsAgainst += result.away.totalScore;
    awayStanding.pointsFor += result.away.totalScore;
    awayStanding.pointsAgainst += result.home.totalScore;
    homeStanding.gamesPlayed += 1;
    awayStanding.gamesPlayed += 1;
    if (result.home.totalScore > result.away.totalScore) {
      homeStanding.wins += 1;
      awayStanding.losses += 1;
    } else {
      awayStanding.wins += 1;
      homeStanding.losses += 1;
    }

    result.home.players.forEach((box) => accumulatePlayer(box.name, box));
    result.away.players.forEach((box) => accumulatePlayer(box.name, box));

    lastPlayDay.set(game.home, game.day);
    lastPlayDay.set(game.away, game.day);
  }

  const standings = Array.from(standingsMap.values()).sort((a, b) => b.wins - a.wins);

  return { standings, gameLogs, playerSeasonTotals };
}

// ============================================================
// v1: 실제 달력 기반 KBL 일정 (2026-27 시즌 일정 원칙 반영)
//  - 개막/종료일, 개막일 대진, 휴식기(FIBA 윈도우·올스타 브레이크)를 입력받아
//    "평일 1경기, 주말(토·일) 3경기" 원칙으로 270경기를 날짜에 배정
//  - 같은 팀이 하루 2경기 금지, 가능하면 연전(백투백) 회피
// ============================================================

export interface CalendarGame {
  round: number;
  date: string;   // YYYY-MM-DD
  home: string;
  away: string;
}

export interface CalendarScheduleOptions {
  startDate: string;
  endDate: string;
  openingGames?: { home: string; away: string }[];
  breaks?: { from: string; to: string }[];
  timesEach?: number;
}

export function parseDate(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  const dt = parseDate(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return formatDate(dt);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / 86400000);
}

export function generateKblCalendarSchedule(teams: string[], opts: CalendarScheduleOptions): CalendarGame[] {
  const timesEach = opts.timesEach ?? 6;
  const pairs = generateRoundRobinSchedule(teams, timesEach).map((g) => ({ round: g.round, home: g.home, away: g.away }));
  const totalGames = pairs.length;

  const inBreak = (d: string) => (opts.breaks ?? []).some((b) => d >= b.from && d <= b.to);

  // 1) 날짜별 슬롯 수 산정: 토·일 3경기, 평일 1경기
  const slotDates: { date: string; slots: number }[] = [];
  for (let d = opts.startDate; d <= opts.endDate; d = addDays(d, 1)) {
    if (inBreak(d)) continue;
    const dow = parseDate(d).getUTCDay(); // 0=일, 6=토
    slotDates.push({ date: d, slots: dow === 0 || dow === 6 ? 3 : 1 });
  }
  // 용량 조정: 경기 수 + 약간의 여유가 되도록 평일(수→목→화→금) 슬롯을 1개씩 추가, 넘치면 월요일부터 제거
  const capacity = () => slotDates.reduce((a, s) => a + s.slots, 0);
  const target = totalGames + 4;
  const weekdayOrder = [3, 4, 2, 5, 1];
  for (const dow of weekdayOrder) {
    for (const s of slotDates) {
      if (capacity() >= target) break;
      if (parseDate(s.date).getUTCDay() === dow && s.slots === 1) s.slots = 2;
    }
  }
  for (const s of slotDates) {
    if (capacity() <= target) break;
    if (parseDate(s.date).getUTCDay() === 1 && s.date !== opts.startDate) s.slots = 0;
  }

  // 2) 개막일 대진 고정
  const remaining = [...pairs];
  const result: CalendarGame[] = [];
  const lastPlayed = new Map<string, string>();
  const playedOn = new Map<string, Set<string>>();
  const place = (date: string, g: { round: number; home: string; away: string }) => {
    result.push({ round: g.round, date, home: g.home, away: g.away });
    lastPlayed.set(g.home, date);
    lastPlayed.set(g.away, date);
    if (!playedOn.has(date)) playedOn.set(date, new Set());
    playedOn.get(date)!.add(g.home).add(g.away);
  };
  for (const og of opts.openingGames ?? []) {
    const idx = remaining.findIndex((p) => p.home === og.home && p.away === og.away);
    const idx2 = idx >= 0 ? idx : remaining.findIndex((p) => p.home === og.away && p.away === og.home);
    if (idx2 < 0) continue;
    const g = remaining.splice(idx2, 1)[0];
    place(opts.startDate, { round: g.round, home: og.home, away: og.away });
  }

  // 3) 탐욕 배정: 리그 진행 순서(라운드)를 최대한 유지하면서 하루 2경기·연전 회피
  for (const s of slotDates) {
    const already = playedOn.get(s.date)?.size ?? 0;
    let slots = s.slots - already / 2;
    while (slots > 0 && remaining.length > 0) {
      const busy = playedOn.get(s.date) ?? new Set<string>();
      const prev = addDays(s.date, -1);
      const window = remaining.slice(0, 40);
      let idx = window.findIndex((p) => !busy.has(p.home) && !busy.has(p.away) && lastPlayed.get(p.home) !== prev && lastPlayed.get(p.away) !== prev);
      if (idx < 0) idx = window.findIndex((p) => !busy.has(p.home) && !busy.has(p.away));
      if (idx < 0) break;
      place(s.date, remaining.splice(idx, 1)[0]);
      slots--;
    }
  }
  // 4) 혹시 남은 경기가 있으면 종료일 이후 날짜에 이어 붙임 (안전장치)
  let extra = addDays(opts.endDate, 1);
  while (remaining.length > 0) {
    const busy = playedOn.get(extra) ?? new Set<string>();
    const idx = remaining.findIndex((p) => !busy.has(p.home) && !busy.has(p.away));
    if (idx < 0) { extra = addDays(extra, 1); continue; }
    place(extra, remaining.splice(idx, 1)[0]);
  }
  return result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
