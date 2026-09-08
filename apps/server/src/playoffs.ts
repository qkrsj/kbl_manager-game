/**
 * KBL Manager — 플레이오프 시스템
 * 정규시즌 순위 1~6위가 진출. 6강전(3v6, 4v5) -> 4강전(1v승자, 2v승자) -> 챔피언결정전
 * 6강전/4강전 5전3선(2-2-1 홈배정), 챔피언결정전 7전4선(2-3-2 홈배정). 상위시드가 항상 먼저 홈.
 */
import { Pool } from "pg";
import { loadLeagueData, applyGrowthDeltas } from "./leagueData";
import { simulateGame } from "../../../packages/simulation-engine/gameSimulator";
import { SimPlayer } from "../../../packages/simulation-engine/possession";
import { loadGrowthDeltas } from "./playerProgression";

// 2-2-1: 홈,홈,[휴식],원정,원정,[휴식],홈  (게임번호1~5에 대응하는 dayGap과 홈여부)
const SERIES5_PATTERN = [
  { gapFromPrev: 0, higherSeedIsHome: true },  // G1
  { gapFromPrev: 2, higherSeedIsHome: true },  // G2
  { gapFromPrev: 4, higherSeedIsHome: false }, // G3 (휴식 후 원정)
  { gapFromPrev: 2, higherSeedIsHome: false }, // G4
  { gapFromPrev: 4, higherSeedIsHome: true },  // G5 (휴식 후 홈)
];

// 2-3-2: 홈,홈,[휴식],원정,원정,원정,[휴식],홈,홈
const SERIES7_PATTERN = [
  { gapFromPrev: 0, higherSeedIsHome: true },  // G1
  { gapFromPrev: 2, higherSeedIsHome: true },  // G2
  { gapFromPrev: 4, higherSeedIsHome: false }, // G3
  { gapFromPrev: 2, higherSeedIsHome: false }, // G4
  { gapFromPrev: 2, higherSeedIsHome: false }, // G5
  { gapFromPrev: 4, higherSeedIsHome: true },  // G6
  { gapFromPrev: 2, higherSeedIsHome: true },  // G7
];

function winsNeeded(bestOf: number): number {
  return bestOf === 7 ? 4 : 3;
}

/** 정규시즌 순위 1~6위로 6강전(2개 시리즈) 생성 */
export async function createFirstRoundPlayoffs(pool: Pool, seasonId: number): Promise<void> {
  const standingsRes = await pool.query(
    `SELECT t.id AS team_id, t.name
     FROM standings s JOIN teams t ON t.name = s.team_name
     WHERE s.season_id = $1
     ORDER BY s.wins DESC, s.points_for DESC
     LIMIT 6`,
    [seasonId]
  );
  if (standingsRes.rows.length < 6) throw new Error("순위표에 6팀 미만 — 정규시즌이 아직 안 끝났습니다");

  const seeds = standingsRes.rows.map((r) => r.team_id); // [1위,2위,3위,4위,5위,6위]

  // A: 3위 vs 6위, B: 4위 vs 5위
  await pool.query(
    `INSERT INTO playoff_series (season_id, round, slot, best_of, higher_seed_team_id, lower_seed_team_id)
     VALUES ($1,'round1','A',5,$2,$3), ($1,'round1','B',5,$4,$5)`,
    [seasonId, seeds[2], seeds[5], seeds[3], seeds[4]]
  );

  // 1위/2위는 대기 상태로 기록 (4강전 생성 시 사용) — franchise 테이블에 별도 저장 없이,
  // 정규시즌 standings에서 다시 조회 가능하니 굳이 저장 안 해도 되지만, 편의상 필요시 재조회.
}

async function getRoundGames(pool: Pool, seasonId: number): Promise<{ id: number; day_offset: number }[]> {
  const r = await pool.query(
    `SELECT id, day_offset FROM games WHERE season_id=$1 ORDER BY day_offset DESC LIMIT 1`,
    [seasonId]
  );
  return r.rows;
}

/** 시리즈 하나에서 다음 경기를 시뮬레이션. 시리즈가 끝나면 winner_team_id 세팅. */
async function playNextGameInSeries(pool: Pool, seriesId: number): Promise<{
  gameId: number; home: string; away: string; homeScore: number; awayScore: number;
  seriesComplete: boolean; winner: string | null;
}> {
  const seriesRes = await pool.query(`SELECT * FROM playoff_series WHERE id=$1`, [seriesId]);
  const series = seriesRes.rows[0];
  const pattern = series.best_of === 7 ? SERIES7_PATTERN : SERIES5_PATTERN;
  const gameNumber = series.games_played + 1; // 1-indexed
  const patternStep = pattern[gameNumber - 1];

  const higherTeamRes = await pool.query(`SELECT name FROM teams WHERE id=$1`, [series.higher_seed_team_id]);
  const lowerTeamRes = await pool.query(`SELECT name FROM teams WHERE id=$1`, [series.lower_seed_team_id]);
  const higherName = higherTeamRes.rows[0].name;
  const lowerName = lowerTeamRes.rows[0].name;

  const homeName = patternStep.higherSeedIsHome ? higherName : lowerName;
  const awayName = patternStep.higherSeedIsHome ? lowerName : higherName;

  const { buildTeamRoster } = loadLeagueData();
  const growthDeltas = await loadGrowthDeltas(pool, series.season_id);
  const homeRoster: SimPlayer[] = applyGrowthDeltas(buildTeamRoster(homeName), growthDeltas);
  const awayRoster: SimPlayer[] = applyGrowthDeltas(buildTeamRoster(awayName), growthDeltas);

  const result = simulateGame(homeRoster, awayRoster, homeName, awayName);

  const lastGame = await getRoundGames(pool, series.season_id);
  const lastDay = lastGame.length > 0 ? lastGame[0].day_offset : 0;
  const dayOffset = lastDay + patternStep.gapFromPrev + 1;

  const gameRes = await pool.query(
    `INSERT INTO games (season_id, round, day_offset, home_team_id, away_team_id, home_score, away_score,
                         went_to_ot, ot_periods, series_id, game_number_in_series)
     VALUES ($1,0,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      series.season_id, dayOffset,
      patternStep.higherSeedIsHome ? series.higher_seed_team_id : series.lower_seed_team_id,
      patternStep.higherSeedIsHome ? series.lower_seed_team_id : series.higher_seed_team_id,
      result.home.totalScore, result.away.totalScore, result.wentToOT, result.otPeriods,
      seriesId, gameNumber,
    ]
  );
  const gameId = gameRes.rows[0].id;

  // 개인 박스스코어 저장
  const homeTeamId = patternStep.higherSeedIsHome ? series.higher_seed_team_id : series.lower_seed_team_id;
  const awayTeamId = patternStep.higherSeedIsHome ? series.lower_seed_team_id : series.higher_seed_team_id;
  for (const [players, teamId] of [
    [result.home.players, homeTeamId],
    [result.away.players, awayTeamId],
  ] as const) {
    for (const [name, box] of players) {
      const pRes = await pool.query(`SELECT id FROM players WHERE name=$1 LIMIT 1`, [name]);
      if (pRes.rows.length === 0) continue;
      await pool.query(
        `INSERT INTO player_game_stats (game_id, player_id, team_id, pts, ast, reb, tov, blk, pf) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [gameId, pRes.rows[0].id, teamId, box.PTS, box.AST, box.REB, box.TOV, box.BLK, box.PF]
      );
    }
  }

  const higherWon = patternStep.higherSeedIsHome
    ? result.home.totalScore > result.away.totalScore
    : result.away.totalScore > result.home.totalScore;

  const higherSeedWins = series.higher_seed_wins + (higherWon ? 1 : 0);
  const lowerSeedWins = series.lower_seed_wins + (higherWon ? 0 : 1);
  const need = winsNeeded(series.best_of);
  const seriesComplete = higherSeedWins >= need || lowerSeedWins >= need;
  const winnerTeamId = seriesComplete ? (higherSeedWins >= need ? series.higher_seed_team_id : series.lower_seed_team_id) : null;

  await pool.query(
    `UPDATE playoff_series SET higher_seed_wins=$1, lower_seed_wins=$2, games_played=$3, winner_team_id=$4 WHERE id=$5`,
    [higherSeedWins, lowerSeedWins, gameNumber, winnerTeamId, seriesId]
  );

  return {
    gameId, home: homeName, away: awayName,
    homeScore: result.home.totalScore, awayScore: result.away.totalScore,
    seriesComplete, winner: seriesComplete ? (winnerTeamId === series.higher_seed_team_id ? higherName : lowerName) : null,
  };
}

/** round1(6강전) 두 시리즈가 모두 끝났으면 round2(4강전) 시리즈 생성 */
async function tryCreateRound2(pool: Pool, seasonId: number): Promise<boolean> {
  const round1 = await pool.query(
    `SELECT slot, winner_team_id FROM playoff_series WHERE season_id=$1 AND round='round1'`,
    [seasonId]
  );
  if (round1.rows.length < 2 || round1.rows.some((r) => r.winner_team_id === null)) return false;

  const existing = await pool.query(`SELECT id FROM playoff_series WHERE season_id=$1 AND round='round2'`, [seasonId]);
  if (existing.rows.length > 0) return false; // 이미 생성됨

  const winnerA = round1.rows.find((r) => r.slot === "A")!.winner_team_id;
  const winnerB = round1.rows.find((r) => r.slot === "B")!.winner_team_id;

  const standingsRes = await pool.query(
    `SELECT t.id AS team_id
     FROM standings s JOIN teams t ON t.name = s.team_name
     WHERE s.season_id = $1 ORDER BY s.wins DESC, s.points_for DESC LIMIT 2`,
    [seasonId]
  );
  const seed1 = standingsRes.rows[0].team_id;
  const seed2 = standingsRes.rows[1].team_id;

  // C: 2위 vs 승자A, D: 1위 vs 승자B (상위시드 자동 판별은 higher/lower를 시드 랭킹 순으로 지정)
  await pool.query(
    `INSERT INTO playoff_series (season_id, round, slot, best_of, higher_seed_team_id, lower_seed_team_id)
     VALUES ($1,'round2','C',5,$2,$3), ($1,'round2','D',5,$4,$5)`,
    [seasonId, seed2, winnerA, seed1, winnerB]
  );
  return true;
}

/** round2(4강전) 두 시리즈가 모두 끝났으면 final(챔피언결정전) 생성 */
async function tryCreateFinal(pool: Pool, seasonId: number): Promise<boolean> {
  const round2 = await pool.query(
    `SELECT slot, winner_team_id, higher_seed_team_id FROM playoff_series WHERE season_id=$1 AND round='round2'`,
    [seasonId]
  );
  if (round2.rows.length < 2 || round2.rows.some((r) => r.winner_team_id === null)) return false;

  const existing = await pool.query(`SELECT id FROM playoff_series WHERE season_id=$1 AND round='final'`, [seasonId]);
  if (existing.rows.length > 0) return false;

  const winnerC = round2.rows.find((r) => r.slot === "C")!;
  const winnerD = round2.rows.find((r) => r.slot === "D")!;

  // 정규시즌 순위로 최종 홈어드밴티지 판정 (standings 재조회)
  const standingsRes = await pool.query(
    `SELECT t.id AS team_id, s.wins
     FROM standings s JOIN teams t ON t.name = s.team_name
     WHERE s.season_id = $1`,
    [seasonId]
  );
  const rank = new Map(standingsRes.rows.map((r, i) => [r.team_id, i]));
  const cWins = winnerC.winner_team_id, dWins = winnerD.winner_team_id;
  const higher = (rank.get(cWins) ?? 999) < (rank.get(dWins) ?? 999) ? cWins : dWins;
  const lower = higher === cWins ? dWins : cWins;

  await pool.query(
    `INSERT INTO playoff_series (season_id, round, slot, best_of, higher_seed_team_id, lower_seed_team_id)
     VALUES ($1,'final','F',7,$2,$3)`,
    [seasonId, higher, lower]
  );
  return true;
}

export interface PlayoffAdvanceResult {
  round: string;
  slot: string;
  gameId: number;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  seriesComplete: boolean;
  seriesWinner: string | null;
  championDecided: boolean;
  champion: string | null;
}

/** 아직 안 끝난 시리즈 중 유저 팀이 낀 시리즈를 우선 진행, 없으면 다른 시리즈 아무거나 진행 */
export async function advancePlayoffs(pool: Pool, seasonId: number, userTeamId: number): Promise<PlayoffAdvanceResult | null> {
  await tryCreateRound2(pool, seasonId);
  await tryCreateFinal(pool, seasonId);

  const activeSeries = await pool.query(
    `SELECT id, round, slot, higher_seed_team_id, lower_seed_team_id
     FROM playoff_series WHERE season_id=$1 AND winner_team_id IS NULL`,
    [seasonId]
  );
  if (activeSeries.rows.length === 0) return null; // 진행할 시리즈 없음 (플레이오프 전체 종료 또는 유저 팀 탈락)

  const userSeries = activeSeries.rows.find(
    (s) => s.higher_seed_team_id === userTeamId || s.lower_seed_team_id === userTeamId
  );
  const target = userSeries ?? activeSeries.rows[0];

  const result = await playNextGameInSeries(pool, target.id);

  // 이 결과로 다음 라운드가 열릴 수 있으니 다시 시도 (마지막 시리즈가 막 끝난 경우 대비)
  await tryCreateRound2(pool, seasonId);
  const finalCreated = await tryCreateFinal(pool, seasonId);

  let championDecided = false;
  let champion: string | null = null;
  if (target.round === "final" && result.seriesComplete) {
    championDecided = true;
    champion = result.winner;
  }
  void finalCreated;

  return {
    round: target.round, slot: target.slot, gameId: result.gameId,
    home: result.home, away: result.away, homeScore: result.homeScore, awayScore: result.awayScore,
    seriesComplete: result.seriesComplete, seriesWinner: result.winner,
    championDecided, champion,
  };
}
