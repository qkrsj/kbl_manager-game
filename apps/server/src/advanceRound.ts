import { Pool } from "pg";
import { loadLeagueData } from "./leagueData";
import { simulateGame } from "../../../packages/simulation-engine/gameSimulator";
import { SimPlayer } from "../../../packages/simulation-engine/possession";

interface BoxScoreEntry {
  name: string;
  team: string;
  pts: number;
  ast: number;
  reb: number;
  tov: number;
  blk: number;
  pf: number;
}

export interface AdvanceRoundResult {
  round: number;
  userTeamGame: {
    gameId: number;
    home: string;
    away: string;
    homeScore: number;
    awayScore: number;
    wentToOT: boolean;
    boxScore: BoxScoreEntry[];
  } | null;
  otherGames: { gameId: number; home: string; away: string; homeScore: number; awayScore: number }[];
}

export async function advanceRound(pool: Pool): Promise<AdvanceRoundResult> {
  const franchiseRes = await pool.query(`SELECT id, season_id, user_team_id, current_round FROM franchise LIMIT 1`);
  if (franchiseRes.rows.length === 0) throw new Error("franchise 세이브가 없습니다 (seed를 먼저 실행하세요)");
  const franchise = franchiseRes.rows[0];
  const nextRound = franchise.current_round + 1;

  const gamesRes = await pool.query(
    `SELECT g.id, g.home_team_id, g.away_team_id, ht.name AS home_name, at.name AS away_name
     FROM games g
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at ON at.id = g.away_team_id
     WHERE g.season_id = $1 AND g.round = $2 AND g.home_score IS NULL`,
    [franchise.season_id, nextRound]
  );

  if (gamesRes.rows.length === 0) {
    throw new Error(`라운드 ${nextRound}에 진행할 경기가 없습니다 (시즌 종료 또는 이미 진행됨)`);
  }

  const { buildTeamRoster } = loadLeagueData();
  const rosterCache = new Map<string, SimPlayer[]>();
  function getRoster(teamName: string): SimPlayer[] {
    if (!rosterCache.has(teamName)) rosterCache.set(teamName, buildTeamRoster(teamName));
    return rosterCache.get(teamName)!;
  }

  const userTeamRes = await pool.query(`SELECT name FROM teams WHERE id = $1`, [franchise.user_team_id]);
  const userTeamName = userTeamRes.rows[0].name;

  const result: AdvanceRoundResult = { round: nextRound, userTeamGame: null, otherGames: [] };
  const playerIdCache = new Map<string, number | null>();

  async function getPlayerId(name: string): Promise<number | null> {
    if (playerIdCache.has(name)) return playerIdCache.get(name)!;
    const r = await pool.query(`SELECT id FROM players WHERE name=$1 LIMIT 1`, [name]);
    const id = r.rows.length === 0 ? null : r.rows[0].id;
    playerIdCache.set(name, id);
    return id;
  }

  for (const g of gamesRes.rows) {
    const homeRoster = getRoster(g.home_name);
    const awayRoster = getRoster(g.away_name);
    const gameResult = simulateGame(homeRoster, awayRoster, g.home_name, g.away_name);

    await pool.query(
      `UPDATE games SET home_score=$1, away_score=$2, went_to_ot=$3, ot_periods=$4 WHERE id=$5`,
      [gameResult.home.totalScore, gameResult.away.totalScore, gameResult.wentToOT, gameResult.otPeriods, g.id]
    );

    const isUserGame = g.home_name === userTeamName || g.away_name === userTeamName;

    if (isUserGame) {
      const boxScore: BoxScoreEntry[] = [];
      gameResult.home.players.forEach((box, name) => {
        boxScore.push({ name, team: g.home_name, pts: box.PTS, ast: box.AST, reb: box.REB, tov: box.TOV, blk: box.BLK, pf: box.PF });
      });
      gameResult.away.players.forEach((box, name) => {
        boxScore.push({ name, team: g.away_name, pts: box.PTS, ast: box.AST, reb: box.REB, tov: box.TOV, blk: box.BLK, pf: box.PF });
      });
      result.userTeamGame = {
        gameId: g.id, home: g.home_name, away: g.away_name,
        homeScore: gameResult.home.totalScore, awayScore: gameResult.away.totalScore,
        wentToOT: gameResult.wentToOT, boxScore,
      };
    } else {
      result.otherGames.push({
        gameId: g.id, home: g.home_name, away: g.away_name,
        homeScore: gameResult.home.totalScore, awayScore: gameResult.away.totalScore,
      });
    }

    for (const [players, teamId] of [
      [gameResult.home.players, g.home_team_id],
      [gameResult.away.players, g.away_team_id],
    ] as const) {
      for (const [name, box] of players) {
        const pid = await getPlayerId(name);
        if (!pid) continue;
        await pool.query(
          `INSERT INTO player_game_stats (game_id, player_id, team_id, pts, ast, reb, tov, blk, pf) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [g.id, pid, teamId, box.PTS, box.AST, box.REB, box.TOV, box.BLK, box.PF]
        );
      }
    }
  }

  await pool.query(`UPDATE franchise SET current_round = $1 WHERE id = $2`, [nextRound, franchise.id]);

  return result;
}
