/**
 * KBL Manager — 시즌 진행 (하루 단위)
 *
 * 한 번 "다음 날"을 누를 때마다 하루가 지나간다.
 *  - 유저 팀 경기가 있는 날: 먼저 경기를 치러야 함 (직접 지휘 = liveGames.ts, 빠른 시뮬 = quickSimUserGame)
 *  - 그 날의 나머지 경기(AI끼리)는 하루를 넘길 때 시뮬레이션
 *  - 경기가 없는 팀은 훈련/휴식 (유저 팀은 유저가 고른 계획) → development.ts
 *  - 정규시즌이 끝나면 플레이오프 생성, 챔피언이 결정되면 비시즌(offseason.ts)으로 전환
 */
import { maybeAiTrade } from "./trades";
import { Pool, PoolClient } from "pg";
import { GameResult, LiveGame } from "../../../packages/simulation-engine/gameSimulator";
import { addDays } from "../../../packages/simulation-engine/seasonScheduler";
import { loadLeaguePlayers, buildTeamSetup, BuildContext } from "./rosterBuilder";
import { processDailyDevelopment, processPostGame, loadTrainingPlan, TrainingPlan, GameLine, DevelopmentChange } from "./development";
import { createFirstRound, updatePlayoffs } from "./playoffs";
import { startOffseason } from "./offseason";
import { addNews, gameNews, injuryNews, shortTeam, NewsItem } from "./news";
import { maybeAiOfferToUser, expireTradeOffers } from "./trades";

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
  const injuries: { playerId: number; name: string; teamId: number; days: number }[] = [];
  const changes = await processPostGame(db, game.game_date, lines, game.series_id !== null, injuries);
  // 뉴스: 경기 결과·대기록·연승, 경기 중 부상
  await gameNews(db, {
    id: game.id, date: game.game_date, homeId: game.home_team_id, awayId: game.away_team_id,
    homeName: ctx.teamNames.get(game.home_team_id) ?? "", awayName: ctx.teamNames.get(game.away_team_id) ?? "",
    homeScore: result.home.totalScore, awayScore: result.away.totalScore, ot: result.wentToOT, playoff: game.series_id !== null,
  }, lines, ctx.userTeamId);
  await addNews(db, injuryNews(game.game_date, injuries.map((i) => ({ ...i, during: "game" as const })), ctx.teamNames, ctx.userTeamId));
  return changes;
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
  userGame: { gameId: number; home: string; away: string; homeScore: number; awayScore: number; ot: boolean; won: boolean } | null;
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
    const news: NewsItem[] = injuryNews(f.date, dev.injuries.map((i) => ({ ...i, during: "training" as const })), ctx.teamNames, f.userTeamId);
    const grown = dev.changes.filter((c) => c.teamId === f.userTeamId && c.delta > 0);
    if (grown.length > 0) {
      const byPlayer = new Map<string, string[]>();
      grown.forEach((c) => byPlayer.set(c.name, [...(byPlayer.get(c.name) ?? []), `${c.label} +${c.delta}`]));
      news.push({ date: f.date, category: "growth", teamId: f.userTeamId, importance: 1,
        headline: `${shortTeam(f.userTeamName)} 훈련 성과 — ${[...byPlayer.keys()].slice(0, 3).join(", ")}${byPlayer.size > 3 ? ` 외 ${byPlayer.size - 3}명` : ""} 능력치 상승`,
        body: [...byPlayer.entries()].map(([n, l]) => `${n}: ${l.join(", ")}`).join(" / ") });
    }
    // 내일 부상에서 돌아오는 우리 팀 선수
    const back = await db.query(
      `SELECT p.id, p.name FROM players p JOIN player_condition pc ON pc.player_id=p.id WHERE p.team_id=$1 AND pc.injured_until=$2`,
      [f.userTeamId, addDays(f.date, 1)]
    );
    back.rows.forEach((r) => news.push({ date: f.date, category: "return", teamId: f.userTeamId, playerId: r.id, importance: 2, headline: `${r.name}, 부상 털고 복귀 준비 완료` }));

    // 시즌 단계 전환
    const events: string[] = [];
    const aiTrade = await maybeAiTrade(db); // AI 팀끼리 트레이드 (아주 드물게)
    if (aiTrade) { events.push(aiTrade); news.push({ date: f.date, category: "trade", importance: 3, headline: aiTrade.replace("[트레이드] ", "트레이드 성사: ") }); }
    await expireTradeOffers(db, f.date);
    const offer = await maybeAiOfferToUser(db); // 다른 팀이 우리 팀에 트레이드 문의
    if (offer) { events.push(offer.headline); news.push({ date: f.date, category: "trade_offer", teamId: f.userTeamId, team2Id: offer.teamId, importance: 3, headline: offer.headline, body: offer.body }); }
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
    events.filter((e) => !e.startsWith("[트레이드]") && e !== offer?.headline)
      .forEach((e) => news.push({ date: f.date, category: "season", importance: 3, headline: e }));
    await addNews(db, news);

    const ug = userGame ? await db.query(`SELECT home_score, away_score, went_to_ot FROM games WHERE id=$1`, [userGame.id]) : null;
    const ugRow = ug?.rows[0];
    return {
      date: f.date, nextDate, phase, results,
      userTeamChanges: dev.changes.filter((c) => c.teamId === f.userTeamId),
      injuries: dev.injuries.filter((i) => i.teamId === f.userTeamId).map((i) => ({ name: i.name, days: i.days })),
      events,
      trainingPlan: played.has(f.userTeamId) ? null : plan,
      userGame: userGame && ugRow && ugRow.home_score !== null ? {
        gameId: userGame.id, home: ctx.teamNames.get(userGame.home_team_id) ?? "", away: ctx.teamNames.get(userGame.away_team_id) ?? "",
        homeScore: ugRow.home_score, awayScore: ugRow.away_score, ot: ugRow.went_to_ot,
        won: (userGame.home_team_id === f.userTeamId) === (ugRow.home_score > ugRow.away_score),
      } : null,
    };
  });
}

/**
 * 달력에서 고른 날짜까지 저장된 훈련 계획으로 하루씩 진행.
 * 중간에 우리 팀 경기일이 오면 그날 멈춘다 (경기는 직접 치러야 하므로). 시즌 단계가 바뀌어도 멈춤.
 */
export async function advanceUntil(pool: Pool, target: string, opts: { simUserGames?: boolean } = {}): Promise<{ days: DayResult[]; stoppedAt: string; reason: string; simulated: number }> {
  let simulated = 0;
  const out: DayResult[] = [];
  for (let i = 0; i < 200; i++) {
    const f = await getFranchise(pool);
    if (f.phase === "offseason") return { days: out, stoppedAt: f.date, reason: "비시즌이 시작되었습니다", simulated };
    if (f.date >= target) return { days: out, stoppedAt: f.date, reason: "선택한 날짜에 도착했습니다", simulated };
    const ug = await userGameToday(pool, f);
    if (ug) {
      const s = await pool.query(`SELECT home_score FROM games WHERE id=$1`, [ug.id]);
      if (s.rows[0].home_score === null) {
        if (!opts.simUserGames) return { days: out, stoppedAt: f.date, reason: "우리 팀 경기일이라 멈췄습니다", simulated };
        await quickSimUserGame(pool, ug.id); // 경기 있는 날도 자동 진행: 저장된 출전시간·전술로 시뮬레이션
        simulated++;
      }
    }
    const day = await advanceDay(pool);
    out.push(day);
    if (day.phase !== f.phase) return { days: out, stoppedAt: day.nextDate, reason: day.events[0] ?? "시즌 단계가 바뀌었습니다", simulated };
  }
  const f = await getFranchise(pool);
  return { days: out, stoppedAt: f.date, reason: "", simulated };
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

/**
 * 상단 [다음] 버튼.
 *  - 오늘 우리 팀 경기가 아직이면 진행하지 않고 "경기 준비" 화면으로 보냄
 *  - 아니면 저장된 훈련 계획으로 하루 진행 → 다음 날이 경기일인지 훈련일인지 알려줌
 */
export async function nextStep(pool: Pool): Promise<
  | { action: "offseason" }
  | { action: "gameday"; gameId: number }
  | { action: "advanced"; day: DayResult; next: "gameday" | "training" | "offseason" }
> {
  const f = await getFranchise(pool);
  if (f.phase === "offseason") return { action: "offseason" };
  const ug = await userGameToday(pool, f);
  if (ug) {
    const s = await pool.query(`SELECT home_score FROM games WHERE id=$1`, [ug.id]);
    if (s.rows[0].home_score === null) return { action: "gameday", gameId: ug.id };
  }
  const day = await advanceDay(pool);
  const nf = await getFranchise(pool);
  if (nf.phase === "offseason") return { action: "advanced", day, next: "offseason" };
  const nextGame = await userGameToday(pool, nf);
  return { action: "advanced", day, next: nextGame ? "gameday" : "training" };
}
