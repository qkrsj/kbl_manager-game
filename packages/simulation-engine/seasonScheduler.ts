/**
 * KBL Manager — 시즌 스케줄러 (v0)
 *
 * 10개 팀이 서로 정해진 횟수(홈/원정 절반씩)만큼 맞붙는 라운드로빈 일정을 생성하고,
 * 전체 시즌을 시뮬레이션해서 팀 순위표와 게임 로그를 만든다.
 * 실제 KBL 정규시즌 포맷(팀당 54경기 = 9개 상대팀 × 6번)을 기본값으로 사용.
 */

import { simulateGame, GameResult, SimPlayer } from "./gameSimulator";
export { SimPlayer };

export interface ScheduledGame {
  round: number;
  home: string;
  away: string;
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * 각 팀 쌍이 timesEach번 맞붙는 일정 생성 (홈/원정 절반씩 배분, 홀수면 마지막 한 번은
 * 먼저 나열된 팀이 홈). 실제 달력/요일 배정은 v0에서 생략하고 무작위 순서만 부여.
 */
export function generateRoundRobinSchedule(teams: string[], timesEach: number): ScheduledGame[] {
  const games: ScheduledGame[] = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      for (let k = 0; k < timesEach; k++) {
        const teamIIsHome = k % 2 === 0;
        games.push({
          round: 0,
          home: teamIIsHome ? teams[i] : teams[j],
          away: teamIIsHome ? teams[j] : teams[i],
        });
      }
    }
  }
  shuffle(games);
  games.forEach((g, idx) => (g.round = idx + 1));
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
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  wentToOT: boolean;
}

export interface SeasonResult {
  standings: TeamStanding[];
  gameLogs: SeasonGameLog[];
  playerSeasonTotals: Map<string, { PTS: number; AST: number; REB: number; TOV: number; BLK: number; PF: number; games: number }>;
}

function emptyStanding(team: string): TeamStanding {
  return { team, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, gamesPlayed: 0 };
}

/**
 * 전체 시즌 시뮬레이션.
 * @param teamRosters 팀명 -> SimPlayer[] (시즌 내내 고정, 부상/이적 등은 v0에서 미반영)
 * @param schedule generateRoundRobinSchedule()로 만든 일정
 */
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

  for (const game of schedule) {
    const homeRoster = teamRosters.get(game.home);
    const awayRoster = teamRosters.get(game.away);
    if (!homeRoster || !awayRoster) continue;

    const result: GameResult = simulateGame(homeRoster, awayRoster, game.home, game.away);

    gameLogs.push({
      round: game.round,
      home: game.home,
      away: game.away,
      homeScore: result.home.totalScore,
      awayScore: result.away.totalScore,
      wentToOT: result.wentToOT,
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
  }

  const standings = Array.from(standingsMap.values()).sort((a, b) => b.wins - a.wins);

  return { standings, gameLogs, playerSeasonTotals };
}
