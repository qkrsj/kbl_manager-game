/**
 * KBL Manager — 한 경기 전체 조립 (v0)
 *
 * 쿼터 4개 × 팀당 고정 포제션(18개)만큼 simulatePossession()을 반복 호출해서
 * 최종 스코어와 개인/팀 박스스코어를 누적한다.
 * 포제션 수는 KBL 평균 팀당 경기 포제션(약 70~75개)에 맞춰 18×4=72로 설정.
 */

import { selectLineup } from "./lineup";
import { simulatePossession, PossessionResult, SimPlayer } from "./possession";

const POSSESSIONS_PER_QUARTER_PER_TEAM = 18;

export interface PlayerBoxScore {
  name: string;
  PTS: number;
  AST: number;
  REB: number;   // 공격+수비 리바운드 합산 (v0에서는 구분 안 함)
  TOV: number;
  BLK: number;
  PF: number;
}

export interface TeamBoxScore {
  teamName: string;
  quarterScores: number[];    // [1Q, 2Q, 3Q, 4Q]
  totalScore: number;
  players: Map<string, PlayerBoxScore>;
}

export interface GameResult {
  home: TeamBoxScore;
  away: TeamBoxScore;
}

function emptyBox(name: string): PlayerBoxScore {
  return { name, PTS: 0, AST: 0, REB: 0, TOV: 0, BLK: 0, PF: 0 };
}

function getOrCreate(map: Map<string, PlayerBoxScore>, name: string): PlayerBoxScore {
  let box = map.get(name);
  if (!box) {
    box = emptyBox(name);
    map.set(name, box);
  }
  return box;
}

/** 포제션 결과 이벤트를 박스스코어에 반영 */
function applyResultToBox(
  result: PossessionResult,
  offenseBox: Map<string, PlayerBoxScore>,
  defenseBox: Map<string, PlayerBoxScore>
) {
  if (result.scorer) {
    getOrCreate(offenseBox, result.scorer).PTS += result.points;
  }
  if (result.assister) {
    getOrCreate(offenseBox, result.assister).AST += 1;
  }
  result.events.forEach((e) => {
    if (e.type === "TURNOVER") getOrCreate(offenseBox, e.actor).TOV += 1;
    if (e.type === "BLOCK") getOrCreate(defenseBox, e.actor).BLK += 1;
    if (e.type === "FOUL") getOrCreate(defenseBox, e.actor).PF += 1;
    if (e.type === "REBOUND_OFF") getOrCreate(offenseBox, e.actor).REB += 1;
    if (e.type === "REBOUND_DEF") getOrCreate(defenseBox, e.actor).REB += 1;
  });
}

export function simulateGame(
  homeRoster: SimPlayer[],
  awayRoster: SimPlayer[],
  homeName: string,
  awayName: string
): GameResult {
  const home: TeamBoxScore = { teamName: homeName, quarterScores: [0, 0, 0, 0], totalScore: 0, players: new Map() };
  const away: TeamBoxScore = { teamName: awayName, quarterScores: [0, 0, 0, 0], totalScore: 0, players: new Map() };

  homeRoster.forEach((p) => getOrCreate(home.players, p.name));
  awayRoster.forEach((p) => getOrCreate(away.players, p.name));

  for (let q = 1; q <= 4; q++) {
    const quarter = q as 1 | 2 | 3 | 4;
    let quarterHomeScore = 0;
    let quarterAwayScore = 0;

    // 쿼터 내에서 팀당 18포제션씩, 홈/원정 번갈아 공격 (2*18=36회 루프)
    for (let i = 0; i < POSSESSIONS_PER_QUARTER_PER_TEAM * 2; i++) {
      const homeIsOffense = i % 2 === 0;

      const homeLineup = selectLineup(homeRoster, quarter).map(
        (lp) => homeRoster.find((p) => p.name === lp.name)!
      );
      const awayLineup = selectLineup(awayRoster, quarter).map(
        (lp) => awayRoster.find((p) => p.name === lp.name)!
      );

      const offense = homeIsOffense ? homeLineup : awayLineup;
      const defense = homeIsOffense ? awayLineup : homeLineup;
      const offenseBox = homeIsOffense ? home.players : away.players;
      const defenseBox = homeIsOffense ? away.players : home.players;

      const result = simulatePossession(offense, defense);
      applyResultToBox(result, offenseBox, defenseBox);

      if (homeIsOffense) quarterHomeScore += result.points;
      else quarterAwayScore += result.points;
    }

    home.quarterScores[q - 1] = quarterHomeScore;
    away.quarterScores[q - 1] = quarterAwayScore;
    home.totalScore += quarterHomeScore;
    away.totalScore += quarterAwayScore;
  }

  return { home, away };
}
