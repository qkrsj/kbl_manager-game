/**
 * KBL Manager — 한 경기 전체 조립 (v0)
 *
 * 쿼터 4개 × 팀당 고정 포제션(18개)만큼 simulatePossession()을 반복 호출해서
 * 최종 스코어와 개인/팀 박스스코어를 누적한다.
 * 포제션 수는 KBL 평균 팀당 경기 포제션(약 70~75개)에 맞춰 18×4=72로 설정.
 *
 * v0.2 추가:
 *  - 파울아웃(5반칙): 해당 선수는 이후 포제션의 라인업 후보에서 제외
 *  - 연장전(OT): 4쿼터 종료 후 동점이면 연장(9포제션/팀, 정규시즌 절반)을 스코어가
 *    갈릴 때까지 반복. 연장은 용병 규칙상 4쿼터와 동일하게 1명 제한 적용.
 */

import { selectLineup } from "./lineup";
import { simulatePossession, PossessionResult, SimPlayer } from "./possession";
export type { SimPlayer };

const POSSESSIONS_PER_QUARTER_PER_TEAM = 18;
const POSSESSIONS_PER_OT_PER_TEAM = 9; // 연장 5분 = 정규 쿼터(10분)의 절반
const FOUL_OUT_LIMIT = 5;

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

/** 파울아웃(5반칙 이상) 선수를 제외한 로스터 반환 */
function excludeFouledOut(roster: SimPlayer[], box: Map<string, PlayerBoxScore>): SimPlayer[] {
  return roster.filter((p) => (box.get(p.name)?.PF ?? 0) < FOUL_OUT_LIMIT);
}

/** 한 쿼터(또는 연장)를 시뮬레이션하고 쿼터 득점을 반환 */
/**
 * 4쿼터 클러치 마무리 부스트: tactics.isClutchCloser로 지정된 선수의 usage/득점력
 * 퍼센타일을 일시적으로 끌어올려서 마무리를 몰아주는 효과를 냄.
 * ⚠️ 정교한 "경기 종료 직전 N분"이 아니라 4쿼터 전체에 적용하는 v0 근사치.
 */
function applyClutchBoost(roster: SimPlayer[]): SimPlayer[] {
  const closer = roster.find((p) => p.tactics?.isClutchCloser);
  if (!closer) return roster;
  return roster.map((p) =>
    p === closer
      ? { ...p, internals: { ...p.internals, usagePercentile: 97, ptsPercentile: 97 } }
      : p
  );
}

function playPeriod(
  homeRoster: SimPlayer[],
  awayRoster: SimPlayer[],
  home: TeamBoxScore,
  away: TeamBoxScore,
  quarter: number,
  possessionsPerTeam: number
): { homeScore: number; awayScore: number } {
  let homeScore = 0;
  let awayScore = 0;

  const effectiveHomeRoster = quarter === 4 ? applyClutchBoost(homeRoster) : homeRoster;
  const effectiveAwayRoster = quarter === 4 ? applyClutchBoost(awayRoster) : awayRoster;

  for (let i = 0; i < possessionsPerTeam * 2; i++) {
    const homeIsOffense = i % 2 === 0;

    // 파울아웃 선수 제외한 풀에서 라인업 선택 (안전장치: lineup.ts에서 5명 미만이면 자동 보충)
    const homeEligible = excludeFouledOut(effectiveHomeRoster, home.players);
    const awayEligible = excludeFouledOut(effectiveAwayRoster, away.players);

    const homeLineup = selectLineup(homeEligible, quarter).map(
      (lp) => effectiveHomeRoster.find((p) => p.name === lp.name)!
    );
    const awayLineup = selectLineup(awayEligible, quarter).map(
      (lp) => effectiveAwayRoster.find((p) => p.name === lp.name)!
    );

    const offense = homeIsOffense ? homeLineup : awayLineup;
    const defense = homeIsOffense ? awayLineup : homeLineup;
    const offenseBox = homeIsOffense ? home.players : away.players;
    const defenseBox = homeIsOffense ? away.players : home.players;

    const result = simulatePossession(offense, defense);
    applyResultToBox(result, offenseBox, defenseBox);

    if (homeIsOffense) homeScore += result.points;
    else awayScore += result.points;
  }

  return { homeScore, awayScore };
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

  // 정규 4쿼터
  for (let q = 1; q <= 4; q++) {
    const { homeScore, awayScore } = playPeriod(
      homeRoster, awayRoster, home, away, q, POSSESSIONS_PER_QUARTER_PER_TEAM
    );
    home.quarterScores[q - 1] = homeScore;
    away.quarterScores[q - 1] = awayScore;
    home.totalScore += homeScore;
    away.totalScore += awayScore;
  }

  // 연장전: 동점인 동안 반복 (5쿼터, 6쿼터... 로 계속 이어짐, 용병규칙은 1명 제한)
  let otPeriods = 0;
  let otQuarterIndex = 5;
  while (home.totalScore === away.totalScore) {
    otPeriods++;
    const { homeScore, awayScore } = playPeriod(
      homeRoster, awayRoster, home, away, otQuarterIndex, POSSESSIONS_PER_OT_PER_TEAM
    );
    home.quarterScores.push(homeScore);
    away.quarterScores.push(awayScore);
    home.totalScore += homeScore;
    away.totalScore += awayScore;
    otQuarterIndex++;

    // 무한루프 방지 (극히 낮은 확률로 계속 동점일 경우 대비 안전장치)
    if (otPeriods >= 10) break;
  }

  return { home, away, wentToOT: otPeriods > 0, otPeriods };
}
