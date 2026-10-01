/**
 * KBL Manager — 시즌 진행 (하루 단위)
 *
 * 한 번 "다음 날"을 누를 때마다 하루가 지나간다.
 *  - 유저 팀 경기가 있는 날: 먼저 경기를 치러야 함 (직접 지휘 = liveGames.ts, 빠른 시뮬 = quickSimUserGame)
 *  - 그 날의 나머지 경기(AI끼리)는 하루를 넘길 때 시뮬레이션
 *  - 경기가 없는 팀은 훈련/휴식 (유저 팀은 유저가 고른 계획) → development.ts
 *  - 정규시즌이 끝나면 플레이오프 생성, 챔피언이 결정되면 비시즌(offseason.ts)으로 전환
 */
import { Pool, PoolClient } from "pg";
import { GameResult, LiveGame } from "../../../packages/simulation-engine/gameSimulator";
import { addDays } from "../../../packages/simulation-engine/seasonScheduler";
import { loadLeaguePlayers, buildTeamSetup, BuildContext } from "./rosterBuilder";
import { processDailyDevelopment, processPostGame, loadTrainingPlan, TrainingPlan, GameLine, DevelopmentChange } from "./development";
import { createFirstRound, updatePlayoffs } from "./playoffs";
import { startOffseason } from "./offseason";

type Db = Pool | PoolClient;

export interface FranchiseState {
  id: number;
  seasonId: number;
  seasonYear: number;
  seasonLabel: string;
  userTeamId: number;
  userTeamName: string;
  date: string;
  phase: "regular" | "playoffs" | "offseason";
  offseasonStage: string | null;
  faDay: number;
  championTeamId: number | null;
}

export async function getFranchise(db: Db): Promise<FranchiseState> {
  const r = await db.query(
    `SELECT f.id, f.season_id, s.year, s.label, f.user_team_id, t.name AS team_name, f.game_date, f.phase,
            f.offseason_stage, f.fa_day, f.champion_team_id
     FROM franchise f JOIN seasons s ON s.id=f.season_id JOIN teams t ON t.id=f.user_team_id LIMIT 1`
  );
  if (r.rows.length === 0) throw new Error("세이브 데이터가 없습니다 (seed를 먼저 실행하거나 새 게임을 시작하세요)");
  const f = r.rows[0];
  return {
    id: f.id, seasonId: f.season_id, seasonYear: f.year, seasonLabel: f.label, userTeamId: f.user_team_id,
    userTeamName: f.team_name, date: f.game_date, phase: f.phase, offseasonStage: f.offseason_stage,
    faDay: f.fa_day, championTeamId: f.champion_team_id,
  };
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function teamNameMap(db: Db): Promise<Map<number, string>> {
  const r = await db.query(`SELECT id, name FROM teams`);
  return new Map(r.rows.map((x) => [x.id, x.name]));
}

export async function buildContext(db: Db, f: FranchiseState): Promise<BuildContext> {
  return {
    db, date: f.date, seasonId: f.seasonId, userTeamId: f.userTeamId,
    players: await loadLeaguePlayers(db, f.date), teamNames: await teamNameMap(db),
  };
}

export interface GameRow {
  id: number;
  home_team_id: number;
  away_team_id: number;
  series_id: number | null;
  game_date: string;
}

/** 경기 결과 저장 + 경기 후 처리(피로/경험치/부상). 레벨업 등 능력치 변화 반환 */
export async function persistGameResult(db: Db, game: GameRow, result: GameResult, ctx: BuildContext): Promise<DevelopmentChange[]> {
  await db.query(
    `UPDATE games SET home_score=$1, away_score=$2, went_to_ot=$3, ot_periods=$4 WHERE id=$5`,
    [result.home.totalScore, result.away.totalScore, result.wentToOT, result.otPeriods, game.id]
  );
  const lines: GameLine[] = [];
  for (const [team, teamId] of [[result.home, game.home_team_id], [result.away, game.away_team_id]] as const) {
    for (const [name, b] of team.players) {
      const p = ctx.players.find((x) => x.name === name);
      if (!p) continue;
      await db.query(
        `INSERT INTO player_game_stats (game_id, player_id, team_id, pts, ast, reb, tov, blk, pf, min, fgm, fga, tpm, tpa, ftm, fta, oreb, stl)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (game_id, player_id) DO NOTHING`,
        [game.id, p.id, teamId, b.PTS, b.AST, b.REB, b.TOV, b.BLK, b.PF, b.MIN, b.FGM, b.FGA, b.TPM, b.TPA, b.FTM, b.FTA, b.OREB, b.STL]
      );
      lines.push({
        playerId: p.id, name, teamId, positionGroup: p.positionGroup, min: b.MIN, pts: b.PTS, reb: b.REB, ast: b.AST,
        stl: b.STL, blk: b.BLK, tov: b.TOV, fga: b.FGA, fgm: b.FGM, fta: b.FTA, ftm: b.FTM,
      });
    }
  }
  return processPostGame(db, game.game_date, lines, game.series_id !== null);
}

async function gamesOn(db: Db, seasonId: number, date: string): Promise<GameRow[]> {
  const r = await db.query(
    `SELECT id, home_team_id, away_team_id, series_id, game_date FROM games
     WHERE season_id=$1 AND game_date=$2 AND home_score IS NULL ORDER BY id`,
    [seasonId, date]
  );
  return r.rows;
}

export async function userGameToday(db: Db, f: FranchiseState): Promise<GameRow | null> {
  const r = await db.query(
    `SELECT id, home_team_id, away_team_id, series_id, game_date FROM games
     WHERE season_id=$1 AND game_date=$2 AND (home_team_id=$3 OR away_team_id=$3) ORDER BY id LIMIT 1`,
    [f.seasonId, f.date, f.userTeamId]
  );
  return r.rows[0] ?? null;
}

/** AI 경기 하나를 시뮬레이션해서 저장 */
async function simulateAndPersist(db: Db, ctx: BuildContext, g: GameRow) {
  const home = await buildTeamSetup(ctx, g.home_team_id, g.away_team_id, g.id);
  const away = await buildTeamSetup(ctx, g.away_team_id, g.home_team_id, g.id);
  const result = new LiveGame(home, away).runToEnd();
  await persistGameResult(db, g, result, ctx);
  return { gameId: g.id, home: home.name, away: away.name, homeScore: result.home.totalScore, awayScore: result.away.totalScore, ot: result.wentToOT };
}

/** 유저 경기를 직접 지휘하지 않고 한 번에 시뮬레이션 */
export async function quickSimUserGame(pool: Pool, gameId: number) {
  return withTx(pool, async (db) => {
    const f = await getFranchise(db);
    const g = await userGameToday(db, f);
    if (!g || g.id !== gameId) throw new Error("오늘 진행할 수 있는 우리 팀 경기가 아닙니다");
    const played = await db.query(`SELECT home_score FROM games WHERE id=$1`, [gameId]);
    if (played.rows[0].home_score !== null) throw new Error("이미 끝난 경기입니다");
    const ctx = await buildContext(db, f);
    const res = await simulateAndPersist(db, ctx, g);
    return res;
  });
}

export interface DayResult {
  date: string;
  nextDate: string;
  phase: string;
  results: { gameId: number; home: string; away: string; homeScore: number; awayScore: number; ot: boolean }[];
  userTeamChanges: DevelopmentChange[];
  injuries: { name: string; days: number }[];
  events: string[];
  trainingPlan: TrainingPlan | null;
}

/** 하루 진행 */
export async function advanceDay(pool: Pool, planOverride?: TrainingPlan): Promise<DayResult> {
  return withTx(pool, async (db) => {
    const f = await getFranchise(db);
    if (f.phase === "offseason") throw new Error("비시즌입니다. 비시즌 메뉴에서 계약/FA를 진행하세요");

    const userGame = await userGameToday(db, f);
    if (userGame) {
      const s = await db.query(`SELECT home_score FROM games WHERE id=$1`, [userGame.id]);
      if (s.rows[0].home_score === null) throw new Error("오늘은 우리 팀 경기가 있습니다. 경기를 먼저 진행하세요");
    }

    const ctx = await buildContext(db, f);
    const results: DayResult["results"] = [];
    for (const g of await gamesOn(db, f.seasonId, f.date)) results.push(await simulateAndPersist(db, ctx, g));

    // 오늘 경기를 치른 팀 (유저 경기 포함)
    const playedRes = await db.query(
      `SELECT home_team_id, away_team_id FROM games WHERE season_id=$1 AND game_date=$2 AND home_score IS NOT NULL`,
      [f.seasonId, f.date]
    );
    const played = new Set<number>();
    playedRes.rows.forEach((r) => { played.add(r.home_team_id); played.add(r.away_team_id); });

    const plan = planOverride ?? (await loadTrainingPlan(db, f.userTeamId));
    if (planOverride) {
      await db.query(
        `INSERT INTO training_plans (team_id, mode, focus, intensity) VALUES ($1,$2,$3,$4)
         ON CONFLICT (team_id) DO UPDATE SET mode=$2, focus=$3, intensity=$4`,
        [f.userTeamId, plan.mode, plan.focus, plan.intensity]
      );
    }
    const dev = await processDailyDevelopment(db, f.date, f.userTeamId, plan, played);

    // 시즌 단계 전환
    const events: string[] = [];
    let phase: FranchiseState["phase"] = f.phase;
    let nextDate = addDays(f.date, 1);
    if (phase === "regular") {
      const left = await db.query(`SELECT COUNT(*) AS n FROM games WHERE season_id=$1 AND series_id IS NULL AND home_score IS NULL`, [f.seasonId]);
      if (Number(left.rows[0].n) === 0) {
        await createFirstRound(db, f.seasonId, addDays(f.date, 4));
        phase = "playoffs";
        events.push("정규시즌 종료! 6강 플레이오프 대진이 확정되었습니다");
      }
    }
    if (phase === "playoffs") {
      const po = await updatePlayoffs(db, f.seasonId, f.date);
      events.push(...po.events);
      if (po.champion) {
        const name = ctx.teamNames.get(po.champion);
        events.push(`🏆 ${name} 우승!`);
        await db.query(`UPDATE franchise SET champion_team_id=$1 WHERE id=$2`, [po.champion, f.id]);
        phase = "offseason";
        nextDate = `${f.seasonYear + 1}-05-20`;
      }
    }
    await db.query(`UPDATE franchise SET game_date=$1, phase=$2, current_round=current_round+1 WHERE id=$3`, [nextDate, phase, f.id]);
    if (phase === "offseason") events.push(...(await startOffseason(db)));

    return {
      date: f.date, nextDate, phase, results,
      userTeamChanges: dev.changes.filter((c) => c.teamId === f.userTeamId),
      injuries: dev.injuries.filter((i) => i.teamId === f.userTeamId).map((i) => ({ name: i.name, days: i.days })),
      events,
      trainingPlan: played.has(f.userTeamId) ? null : plan,
    };
  });
}

/** 우리 팀 다음 경기일(또는 단계 전환)까지 저장된 훈련 계획으로 하루씩 진행 */
export async function advanceToNextGameDay(pool: Pool): Promise<DayResult[]> {
  const out: DayResult[] = [];
  for (let i = 0; i < 80; i++) {
    const f = await getFranchise(pool);
    if (f.phase === "offseason") break;
    const ug = await userGameToday(pool, f);
    if (ug) {
      const s = await pool.query(`SELECT home_score FROM games WHERE id=$1`, [ug.id]);
      if (s.rows[0].home_score === null) break;
    }
    const day = await advanceDay(pool);
    out.push(day);
    if (day.events.length > 0 && day.phase !== f.phase) break;
  }
  return out;
}
