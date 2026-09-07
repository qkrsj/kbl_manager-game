/**
 * KBL Manager — 다음 경기까지 진행 (날짜 기반)
 *
 * "라운드 번호" 기준이 아니라 "유저 팀의 다음 미진행 경기 날짜"를 기준으로 진행한다.
 * 그 날짜(day) 이하이면서 아직 안 뛴 경기를 전부 한번에 시뮬레이션한다 —
 * 유저 팀 경기는 그 안에 정확히 1개 포함되고(상세 박스스코어 반환),
 * 그날 또는 그 이전 날짜에 밀려있던 다른 팀들끼리의 경기는 스코어만 처리된다.
 *
 * ⚠️ 알려진 한계: 유저 팀의 시즌 마지막 경기 날짜보다 늦은 날짜에 잡힌 "다른 두 팀만의"
 * 경기가 있으면, 유저 시즌이 끝난 뒤에도 그 경기들은 미진행 상태로 남을 수 있다.
 * (v0에서는 시즌 최종 정산 스윕을 별도로 구현하지 않음 — 추후 개선 예정)
 */
import { Pool } from "pg";
import { loadLeagueData, applyUserOverrides, PlayerRosterSetting, TeamTacticsSetting } from "./leagueData";
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

export interface AdvanceResult {
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

export async function advanceToNextGame(pool: Pool): Promise<AdvanceResult> {
  const franchiseRes = await pool.query(`SELECT id, season_id, user_team_id, current_round FROM franchise LIMIT 1`);
  if (franchiseRes.rows.length === 0) throw new Error("franchise 세이브가 없습니다 (seed를 먼저 실행하세요)");
  const franchise = franchiseRes.rows[0];

  const nextGameRes = await pool.query(
    `SELECT day_offset FROM games
     WHERE season_id=$1 AND home_score IS NULL AND (home_team_id=$2 OR away_team_id=$2)
     ORDER BY day_offset ASC LIMIT 1`,
    [franchise.season_id, franchise.user_team_id]
  );
  if (nextGameRes.rows.length === 0) {
    throw new Error("우리 팀의 남은 경기가 없습니다 (시즌 종료)");
  }
  const targetDay = nextGameRes.rows[0].day_offset;

  const gamesRes = await pool.query(
    `SELECT g.id, g.day_offset AS day, g.home_team_id, g.away_team_id, ht.name AS home_name, at.name AS away_name
     FROM games g
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at ON at.id = g.away_team_id
     WHERE g.season_id = $1 AND g.home_score IS NULL AND g.day_offset <= $2
     ORDER BY g.day_offset ASC`,
    [franchise.season_id, targetDay]
  );

  const { buildTeamRoster } = loadLeagueData();

  const userTeamRes = await pool.query(`SELECT name FROM teams WHERE id = $1`, [franchise.user_team_id]);
  const userTeamName = userTeamRes.rows[0].name;

  // 유저 팀 로스터설정/전술 조회 (없으면 기본값 — 즉 오버라이드 없이 기존 엔진 동작)
  const rosterSettingsRes = await pool.query(
    `SELECT p.name, prs.role, prs.minutes_target, prs.offense_priority
     FROM player_roster_settings prs JOIN players p ON p.id = prs.player_id
     WHERE prs.team_id = $1`,
    [franchise.user_team_id]
  );
  const playerSettings: PlayerRosterSetting[] = rosterSettingsRes.rows.map((r) => ({
    name: r.name, role: r.role, minutesTarget: r.minutes_target ? Number(r.minutes_target) : null,
    offensePriority: r.offense_priority,
  }));

  const tacticsRes = await pool.query(
    `SELECT tt.pace_style, tt.three_point_reliance, sp.name AS stopper_name, cl.name AS closer_name
     FROM team_tactics tt
     LEFT JOIN players sp ON sp.id = tt.defensive_stopper_player_id
     LEFT JOIN players cl ON cl.id = tt.clutch_closer_player_id
     WHERE tt.team_id = $1`,
    [franchise.user_team_id]
  );
  const tactics: TeamTacticsSetting = tacticsRes.rows.length > 0
    ? {
        paceStyle: tacticsRes.rows[0].pace_style, threePointReliance: tacticsRes.rows[0].three_point_reliance,
        defensiveStopperName: tacticsRes.rows[0].stopper_name, clutchCloserName: tacticsRes.rows[0].closer_name,
      }
    : { paceStyle: "normal", threePointReliance: "normal", defensiveStopperName: null, clutchCloserName: null };

  const hasUserRosterConfig = playerSettings.some((s) => s.role === "starter" || s.role === "bench");

  const rosterCache = new Map<string, SimPlayer[]>();
  function getRoster(teamName: string): SimPlayer[] {
    if (!rosterCache.has(teamName)) {
      const base = buildTeamRoster(teamName);
      // ⚠️ 유저 팀이고, 유저가 실제로 로스터를 설정한 경우에만 오버라이드 적용.
      // 아직 설정 안 했으면(기본 franchise 상태) 다른 팀과 동일하게 기존 엔진 그대로 사용.
      const roster = teamName === userTeamName && hasUserRosterConfig
        ? applyUserOverrides(base, playerSettings, tactics)
        : base;
      rosterCache.set(teamName, roster);
    }
    return rosterCache.get(teamName)!;
  }

  const result: AdvanceResult = { targetDay, userTeamGame: null, otherGames: [] };
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

  // current_round는 이제 "유저 팀이 지금까지 뛴 경기 수" 카운터로 재활용 (표시용)
  await pool.query(`UPDATE franchise SET current_round = current_round + 1 WHERE id = $1`, [franchise.id]);

  return result;
}
