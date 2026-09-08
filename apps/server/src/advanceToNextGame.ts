/**
 * KBL Manager — 다음 경기까지 진행 (날짜 기반, 정규시즌+플레이오프 통합)
 *
 * "라운드 번호" 기준이 아니라 "유저 팀의 다음 미진행 경기 날짜"를 기준으로 진행한다.
 * 그 날짜(day) 이하이면서 아직 안 뛴 경기를 전부 한번에 시뮬레이션한다.
 *
 * 유저 팀의 정규시즌 54경기가 끝나면:
 *  1. 그 시점까지 밀려있던 "다른 팀들끼리의" 잔여 정규시즌 경기를 전부 스윕(정산)해서
 *     순위표를 확정한다 (유저 시즌 종료 후에도 미진행 경기가 남는 v0 한계 보완).
 *  2. franchise.phase를 'playoffs'로 전환하고 6강전을 생성한다.
 *  3. 이후 호출부터는 플레이오프 시리즈를 진행한다 (advancePlayoffs).
 */
import { Pool } from "pg";
import { loadLeagueData, applyUserOverrides, PlayerRosterSetting, TeamTacticsSetting } from "./leagueData";
import { simulateGame } from "../../../packages/simulation-engine/gameSimulator";
import { SimPlayer } from "../../../packages/simulation-engine/possession";
import { createFirstRoundPlayoffs, advancePlayoffs, PlayoffAdvanceResult } from "./playoffs";

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

export interface RegularSeasonAdvanceResult {
  phase: "regular";
  targetDay: number;
  userTeamGame: {
    gameId: number;
    home: string;
    away: string;
    homeScore: number;
    awayScore: number;
    wentToOT: boolean;
    boxScore: BoxScoreEntry[];
  } | null;
  otherGames: { gameId: number; day: number; home: string; away: string; homeScore: number; awayScore: number }[];
}

export type PlayoffAdvanceResultWithPhase = PlayoffAdvanceResult & { phase: "playoffs" };
export interface PlayoffsOverResult {
  phase: "done";
  champion: string | null;
}

export type AdvanceResult = RegularSeasonAdvanceResult | PlayoffAdvanceResultWithPhase | PlayoffsOverResult;

async function loadUserTeamRoster(pool: Pool, userTeamId: number, userTeamName: string): Promise<SimPlayer[]> {
  const { buildTeamRoster } = loadLeagueData();
  const base = buildTeamRoster(userTeamName);

  const rosterSettingsRes = await pool.query(
    `SELECT p.name, prs.role, prs.minutes_target, prs.offense_priority
     FROM player_roster_settings prs JOIN players p ON p.id = prs.player_id
     WHERE prs.team_id = $1`,
    [userTeamId]
  );
  const playerSettings: PlayerRosterSetting[] = rosterSettingsRes.rows.map((r) => ({
    name: r.name, role: r.role, minutesTarget: r.minutes_target ? Number(r.minutes_target) : null,
    offensePriority: r.offense_priority,
  }));
  const hasUserRosterConfig = playerSettings.some((s) => s.role === "starter" || s.role === "bench");
  if (!hasUserRosterConfig) return base;

  const tacticsRes = await pool.query(
    `SELECT tt.pace_style, tt.three_point_reliance, sp.name AS stopper_name, cl.name AS closer_name
     FROM team_tactics tt
     LEFT JOIN players sp ON sp.id = tt.defensive_stopper_player_id
     LEFT JOIN players cl ON cl.id = tt.clutch_closer_player_id
     WHERE tt.team_id = $1`,
    [userTeamId]
  );
  const tactics: TeamTacticsSetting = tacticsRes.rows.length > 0
    ? {
        paceStyle: tacticsRes.rows[0].pace_style, threePointReliance: tacticsRes.rows[0].three_point_reliance,
        defensiveStopperName: tacticsRes.rows[0].stopper_name, clutchCloserName: tacticsRes.rows[0].closer_name,
      }
    : { paceStyle: "normal", threePointReliance: "normal", defensiveStopperName: null, clutchCloserName: null };

  return applyUserOverrides(base, playerSettings, tactics);
}

/** 정규시즌 잔여(다른 팀들끼리의) 미진행 경기를 전부 스윕해서 순위표를 확정 */
async function sweepRemainingRegularSeasonGames(pool: Pool, seasonId: number): Promise<void> {
  const { buildTeamRoster } = loadLeagueData();
  const rosterCache = new Map<string, SimPlayer[]>();
  function getRoster(teamName: string): SimPlayer[] {
    if (!rosterCache.has(teamName)) rosterCache.set(teamName, buildTeamRoster(teamName));
    return rosterCache.get(teamName)!;
  }

  const gamesRes = await pool.query(
    `SELECT g.id, g.home_team_id, g.away_team_id, ht.name AS home_name, at.name AS away_name
     FROM games g
     JOIN teams ht ON ht.id=g.home_team_id JOIN teams at ON at.id=g.away_team_id
     WHERE g.season_id=$1 AND g.home_score IS NULL AND g.series_id IS NULL
     ORDER BY g.day_offset ASC`,
    [seasonId]
  );

  for (const g of gamesRes.rows) {
    const result = simulateGame(getRoster(g.home_name), getRoster(g.away_name), g.home_name, g.away_name);
    await pool.query(
      `UPDATE games SET home_score=$1, away_score=$2, went_to_ot=$3, ot_periods=$4 WHERE id=$5`,
      [result.home.totalScore, result.away.totalScore, result.wentToOT, result.otPeriods, g.id]
    );
    for (const [players, teamId] of [
      [result.home.players, g.home_team_id],
      [result.away.players, g.away_team_id],
    ] as const) {
      for (const [name, box] of players) {
        const pRes = await pool.query(`SELECT id FROM players WHERE name=$1 LIMIT 1`, [name]);
        if (pRes.rows.length === 0) continue;
        await pool.query(
          `INSERT INTO player_game_stats (game_id, player_id, team_id, pts, ast, reb, tov, blk, pf) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [g.id, pRes.rows[0].id, teamId, box.PTS, box.AST, box.REB, box.TOV, box.BLK, box.PF]
        );
      }
    }
  }
}

export async function advanceToNextGame(pool: Pool): Promise<AdvanceResult> {
  const franchiseRes = await pool.query(`SELECT id, season_id, user_team_id, current_round, phase FROM franchise LIMIT 1`);
  if (franchiseRes.rows.length === 0) throw new Error("franchise 세이브가 없습니다 (seed를 먼저 실행하세요)");
  const franchise = franchiseRes.rows[0];

  // ── 플레이오프 단계면 바로 플레이오프 진행 ──
  if (franchise.phase === "playoffs") {
    const result = await advancePlayoffs(pool, franchise.season_id, franchise.user_team_id);
    if (result === null) {
      const seriesRes = await pool.query(
        `SELECT t.name FROM playoff_series s JOIN teams t ON t.id=s.winner_team_id
         WHERE s.season_id=$1 AND s.round='final'`,
        [franchise.season_id]
      );
      return { phase: "done", champion: seriesRes.rows[0]?.name ?? null };
    }
    return { phase: "playoffs", ...result };
  }

  // ── 정규시즌 진행 ──
  const nextGameRes = await pool.query(
    `SELECT day_offset FROM games
     WHERE season_id=$1 AND home_score IS NULL AND (home_team_id=$2 OR away_team_id=$2) AND series_id IS NULL
     ORDER BY day_offset ASC LIMIT 1`,
    [franchise.season_id, franchise.user_team_id]
  );

  if (nextGameRes.rows.length === 0) {
    // 유저 팀 정규시즌 끝 -> 잔여 경기 스윕 후 플레이오프 전환
    await sweepRemainingRegularSeasonGames(pool, franchise.season_id);
    await pool.query(`UPDATE franchise SET phase='playoffs' WHERE id=$1`, [franchise.id]);
    await createFirstRoundPlayoffs(pool, franchise.season_id);
    const result = await advancePlayoffs(pool, franchise.season_id, franchise.user_team_id);
    if (result === null) return { phase: "done", champion: null };
    return { phase: "playoffs", ...result };
  }

  const targetDay = nextGameRes.rows[0].day_offset;

  const gamesRes = await pool.query(
    `SELECT g.id, g.day_offset AS day, g.home_team_id, g.away_team_id, ht.name AS home_name, at.name AS away_name
     FROM games g
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at ON at.id = g.away_team_id
     WHERE g.season_id = $1 AND g.home_score IS NULL AND g.day_offset <= $2 AND g.series_id IS NULL
     ORDER BY g.day_offset ASC`,
    [franchise.season_id, targetDay]
  );

  const userTeamRes = await pool.query(`SELECT name FROM teams WHERE id = $1`, [franchise.user_team_id]);
  const userTeamName = userTeamRes.rows[0].name;
  const userRoster = await loadUserTeamRoster(pool, franchise.user_team_id, userTeamName);

  const { buildTeamRoster } = loadLeagueData();
  const rosterCache = new Map<string, SimPlayer[]>([[userTeamName, userRoster]]);
  function getRoster(teamName: string): SimPlayer[] {
    if (!rosterCache.has(teamName)) rosterCache.set(teamName, buildTeamRoster(teamName));
    return rosterCache.get(teamName)!;
  }

  const result: RegularSeasonAdvanceResult = { phase: "regular", targetDay, userTeamGame: null, otherGames: [] };
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
        gameId: g.id, day: g.day, home: g.home_name, away: g.away_name,
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

  await pool.query(`UPDATE franchise SET current_round = current_round + 1 WHERE id = $1`, [franchise.id]);

  return result;
}
