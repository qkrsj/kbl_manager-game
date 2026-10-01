/**
 * KBL Manager — API 서버
 *
 * 메인(대시보드) / 팀·선수 정보 / 순위·개인기록 / 하루 진행 / 경기 직접 지휘 / 훈련 /
 * 로스터·전술·게임플랜 / 샐러리캡 / 비시즌(연봉협상·FA·드래프트) API.
 */
import express, { Request, Response } from "express";
import cors from "cors";
import { pool } from "./db";
import { getFranchise, advanceDay, advanceToNextGameDay, quickSimUserGame, userGameToday } from "./season";
import { startLiveGame, getLiveGame, updateLiveGame, stepLiveGame } from "./liveGames";
import { loadLeaguePlayers, coachForTeam, ageOn } from "./rosterBuilder";
import { aiMinutesPlan } from "./coaches";
import { teamPayroll, DOMESTIC_CAP, SOFT_CAP_LIMIT, MIN_CAP_RATIO, FOREIGN_TOTAL_CAP_USD, ASIA_CAP_USD, MAX_DOMESTIC_ROSTER, MIN_SALARY } from "./salaryCap";
import { TRAINING_FOCUS, XP_PER_LEVEL, loadTrainingPlan, dailyGrowthRate } from "./development";
import { playoffBracket, ROUND_LABEL } from "./playoffs";
import {
  offseasonOverview, offerNegotiation, freeAgentList, makeFaOffer, withdrawFaOffer, releasePlayer,
  advanceOffseason, startNewSeason,
} from "./offseason";
import { seedDatabase, availableTeams } from "./seed";
import { ATTR_LABEL, SIM_ATTR_KEYS, computeRatings } from "./ratings";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ?? 4000;

type Handler = (req: Request, res: Response) => Promise<unknown>;
/** 공통 에러 처리: 게임 규칙 위반 등은 400 + 한국어 메시지 */
const route = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
};

// ============================================================
// 공용 조회 헬퍼
// ============================================================

async function standingsFor(seasonId: number) {
  const r = await pool.query(
    `SELECT t.id AS team_id, t.name AS team_name,
            COALESCE(s.games_played,0)::int AS games_played, COALESCE(s.wins,0)::int AS wins, COALESCE(s.losses,0)::int AS losses,
            COALESCE(s.points_for,0)::int AS points_for, COALESCE(s.points_against,0)::int AS points_against,
            s.avg_points_for, s.avg_points_against
     FROM teams t LEFT JOIN standings s ON s.team_id=t.id AND s.season_id=$1
     ORDER BY COALESCE(s.wins,0) DESC, COALESCE(s.points_for,0)-COALESCE(s.points_against,0) DESC, t.name`,
    [seasonId]
  );
  const top = r.rows[0];
  // 최근 5경기 / 연승·연패
  const recent = await pool.query(
    `SELECT team_id, won FROM (
       SELECT home_team_id AS team_id, home_score > away_score AS won, game_date, id FROM games WHERE season_id=$1 AND series_id IS NULL AND home_score IS NOT NULL
       UNION ALL
       SELECT away_team_id, away_score > home_score, game_date, id FROM games WHERE season_id=$1 AND series_id IS NULL AND home_score IS NOT NULL
     ) x ORDER BY game_date DESC, id DESC`,
    [seasonId]
  );
  const byTeam = new Map<number, boolean[]>();
  recent.rows.forEach((g) => byTeam.set(g.team_id, [...(byTeam.get(g.team_id) ?? []), g.won]));
  return r.rows.map((row, i) => {
    const results = byTeam.get(row.team_id) ?? [];
    let streak = "";
    if (results.length) {
      let n = 0;
      while (n < results.length && results[n] === results[0]) n++;
      streak = `${n}${results[0] ? "연승" : "연패"}`;
    }
    return {
      rank: i + 1, ...row,
      win_pct: row.games_played ? Math.round((row.wins / row.games_played) * 1000) / 1000 : 0,
      games_behind: top ? ((top.wins - row.wins) + (row.losses - top.losses)) / 2 : 0,
      last5: results.slice(0, 5).map((w) => (w ? "W" : "L")).join(""),
      streak,
    };
  });
}

const LEADER_STATS: Record<string, { label: string; expr: string }> = {
  pts: { label: "득점", expr: "AVG(s.pts)" },
  reb: { label: "리바운드", expr: "AVG(s.reb)" },
  ast: { label: "어시스트", expr: "AVG(s.ast)" },
  stl: { label: "스틸", expr: "AVG(s.stl)" },
  blk: { label: "블록", expr: "AVG(s.blk)" },
  tpm: { label: "3점슛", expr: "AVG(s.tpm)" },
  eff: { label: "공헌도", expr: "AVG(s.pts + s.reb + s.ast + s.stl + s.blk - s.tov - (s.fga - s.fgm) - (s.fta - s.ftm))" },
};

async function leaders(seasonId: number, stat: string, limit: number, playoffs = false) {
  const def = LEADER_STATS[stat] ?? LEADER_STATS.pts;
  const maxGames = await pool.query(
    `SELECT COALESCE(MAX(c),0) AS m FROM (SELECT COUNT(*) AS c FROM games g, LATERAL (VALUES (g.home_team_id),(g.away_team_id)) v(t)
     WHERE g.season_id=$1 AND g.home_score IS NOT NULL AND (g.series_id IS NOT NULL) = $2 GROUP BY v.t) x`,
    [seasonId, playoffs]
  );
  const minGames = Math.max(1, Math.floor(Number(maxGames.rows[0].m) * 0.5));
  const r = await pool.query(
    `SELECT p.id AS player_id, p.name, t.name AS team_name, COUNT(*)::int AS games, ROUND(${def.expr}::numeric, 1) AS value,
            ROUND(AVG(s.min)::numeric,1) AS min
     FROM player_game_stats s JOIN games g ON g.id=s.game_id JOIN players p ON p.id=s.player_id JOIN teams t ON t.id=s.team_id
     WHERE g.season_id=$1 AND (g.series_id IS NOT NULL) = $3 AND s.min > 0
     GROUP BY p.id, p.name, t.name HAVING COUNT(*) >= $2
     ORDER BY value DESC LIMIT $4`,
    [seasonId, minGames, playoffs, limit]
  );
  return { stat, label: def.label, minGames, rows: r.rows };
}

async function teamSeasonStats(seasonId: number, teamId: number) {
  const r = await pool.query(
    `SELECT s.player_id, COUNT(*)::int AS g, ROUND(AVG(s.min)::numeric,1) AS min, ROUND(AVG(s.pts)::numeric,1) AS pts,
            ROUND(AVG(s.reb)::numeric,1) AS reb, ROUND(AVG(s.ast)::numeric,1) AS ast, ROUND(AVG(s.stl)::numeric,1) AS stl,
            ROUND(AVG(s.blk)::numeric,1) AS blk, ROUND(AVG(s.tov)::numeric,1) AS tov, ROUND(AVG(s.tpm)::numeric,1) AS tpm,
            CASE WHEN SUM(s.fga)>0 THEN ROUND(100.0*SUM(s.fgm)/SUM(s.fga),1) END AS fg_pct,
            CASE WHEN SUM(s.tpa)>0 THEN ROUND(100.0*SUM(s.tpm)/SUM(s.tpa),1) END AS tp_pct,
            CASE WHEN SUM(s.fta)>0 THEN ROUND(100.0*SUM(s.ftm)/SUM(s.fta),1) END AS ft_pct
     FROM player_game_stats s JOIN games g ON g.id=s.game_id
     WHERE g.season_id=$1 AND s.team_id=$2 AND g.series_id IS NULL AND s.min > 0 GROUP BY s.player_id`,
    [seasonId, teamId]
  );
  return new Map(r.rows.map((x) => [x.player_id, x]));
}

async function teamRoster(teamId: number) {
  const f = await getFranchise(pool);
  const players = (await loadLeaguePlayers(pool, f.date)).filter((p) => p.teamId === teamId);
  const stats = await teamSeasonStats(f.seasonId, teamId);
  const extra = await pool.query(
    `SELECT p.id, p.birth_date, p.height_cm, p.draft_year, p.draft_overall_pick, c.salary_krw, c.salary_usd, c.fa_year, c.source,
            pc.xp, pc.xp_level, ptf.focus AS personal_focus
     FROM players p LEFT JOIN contracts c ON c.player_id=p.id LEFT JOIN player_condition pc ON pc.player_id=p.id
     LEFT JOIN player_training_focus ptf ON ptf.player_id=p.id WHERE p.team_id=$1`,
    [teamId]
  );
  const ex = new Map(extra.rows.map((r) => [r.id, r]));
  // 감독 AI 기준 추천 출전시간 (유저가 출전시간을 설정하지 않았을 때의 기본값)
  const teamName = (await pool.query(`SELECT name FROM teams WHERE id=$1`, [teamId])).rows[0]?.name ?? "";
  const suggested = aiMinutesPlan(
    players.filter((p) => !p.injuredUntil || p.injuredUntil <= f.date)
      .map((p) => ({ name: p.name, isForeign: p.isForeign, overall: p.ratings.overall, age: p.age, fatigue: p.fatigue })),
    { ...coachForTeam(teamName), rotationDepth: 0.5 }
  );
  return players.map((p) => {
    const e = ex.get(p.id);
    return {
      id: p.id, name: p.name, position: p.position, positionGroup: p.positionGroup, nationality: p.nationality,
      contractType: p.contractType, age: p.age, heightCm: e?.height_cm ? Number(e.height_cm) : null,
      overall: p.ratings.overall, offense: p.ratings.offense, defense: p.ratings.defense, potential: p.potential,
      fatigue: Math.round(p.fatigue), injuredUntil: p.injuredUntil, role: p.role, minutesTarget: p.minutesTarget,
      offensePriority: p.offensePriority, salaryKrw: e?.salary_krw ?? null, salaryUsd: e?.salary_usd ?? null,
      faYear: e?.fa_year ?? null, contractSource: e?.source ?? null, xp: e?.xp ?? 0, xpLevel: e?.xp_level ?? 0,
      personalFocus: e?.personal_focus ?? null, draftYear: e?.draft_year, draftPick: e?.draft_overall_pick,
      stats: stats.get(p.id) ?? null,
      suggestedMinutes: Math.round(suggested.get(p.name) ?? 0),
    };
  }).sort((a, b) => b.overall - a.overall);
}

// ============================================================
// 게임 / 메인
// ============================================================

app.post("/api/new-game", route(async (req) => {
  const team = req.body.teamName ? String(req.body.teamName) : Number(req.body.teamId) || undefined;
  const out = await seedDatabase(pool, team);
  return { ok: true, ...out };
}));

/** 새 게임 팀 선택용 목록 (DB 상태와 무관하게 항상 10개 팀) */
app.get("/api/new-game/teams", route(async () => availableTeams()));

app.get("/api/franchise", route(async () => {
  const f = await getFranchise(pool);
  return { ...f, season_label: f.seasonLabel, user_team: f.userTeamName };
}));

app.get("/api/dashboard", route(async () => {
  const f = await getFranchise(pool);
  const standings = await standingsFor(f.seasonId);
  const mine = standings.find((s) => s.team_id === f.userTeamId);
  const next = await pool.query(
    `SELECT g.id, g.game_date, g.home_team_id, ht.name AS home, at.name AS away, g.series_id
     FROM games g JOIN teams ht ON ht.id=g.home_team_id JOIN teams at ON at.id=g.away_team_id
     WHERE g.season_id=$1 AND g.home_score IS NULL AND (g.home_team_id=$2 OR g.away_team_id=$2)
     ORDER BY g.game_date LIMIT 1`,
    [f.seasonId, f.userTeamId]
  );
  const recent = await pool.query(
    `SELECT g.id, g.game_date, ht.name AS home, at.name AS away, g.home_score, g.away_score, g.home_team_id, g.went_to_ot
     FROM games g JOIN teams ht ON ht.id=g.home_team_id JOIN teams at ON at.id=g.away_team_id
     WHERE g.season_id=$1 AND g.home_score IS NOT NULL AND (g.home_team_id=$2 OR g.away_team_id=$2)
     ORDER BY g.game_date DESC LIMIT 5`,
    [f.seasonId, f.userTeamId]
  );
  const roster = await teamRoster(f.userTeamId);
  const payroll = await teamPayroll(pool, f.userTeamId);
  const leaderBoards = await Promise.all(["pts", "reb", "ast", "stl", "blk", "tpm"].map((s) => leaders(f.seasonId, s, 5)));
  const todayGame = await userGameToday(pool, f);
  return {
    franchise: f,
    myTeam: {
      id: f.userTeamId, name: f.userTeamName, coach: coachForTeam(f.userTeamName), standing: mine,
      payroll, capLimit: DOMESTIC_CAP,
      topPlayers: roster.slice(0, 6), injured: roster.filter((p) => p.injuredUntil && p.injuredUntil > f.date),
      nextGame: next.rows[0] ?? null, recent: recent.rows,
    },
    todayGame,
    standings,
    leaders: leaderBoards,
  };
}));

app.get("/api/standings", route(async (req) => {
  const f = await getFranchise(pool);
  return standingsFor(req.query.seasonId ? Number(req.query.seasonId) : f.seasonId);
}));

app.get("/api/leaders", route(async (req) => {
  const f = await getFranchise(pool);
  const stat = String(req.query.stat ?? "pts");
  return leaders(f.seasonId, stat, Number(req.query.limit ?? 20), req.query.playoffs === "true");
}));

app.get("/api/seasons", route(async () => (await pool.query(`SELECT id, label, year FROM seasons ORDER BY year`)).rows));

app.get("/api/teams", route(async () => {
  const r = await pool.query(`SELECT t.id, t.name, c.name AS coach, c.style FROM teams t LEFT JOIN coaches c ON c.team_id=t.id ORDER BY t.name`);
  return r.rows;
}));

app.get("/api/teams/:id", route(async (req) => {
  const teamId = Number(req.params.id);
  const t = await pool.query(`SELECT id, name FROM teams WHERE id=$1`, [teamId]);
  if (!t.rows[0]) throw new Error("팀을 찾을 수 없습니다");
  return {
    team: t.rows[0], coach: coachForTeam(t.rows[0].name),
    payroll: await teamPayroll(pool, teamId), roster: await teamRoster(teamId),
  };
}));

app.get("/api/salary-cap", route(async () => {
  const teams = (await pool.query(`SELECT id, name FROM teams ORDER BY name`)).rows;
  const rows = [];
  for (const t of teams) rows.push({ ...t, ...(await teamPayroll(pool, t.id)) });
  return {
    rules: {
      domesticCap: DOMESTIC_CAP, softCapLimit: SOFT_CAP_LIMIT, minCapRatio: MIN_CAP_RATIO, minSalary: MIN_SALARY,
      foreignTotalCapUsd: FOREIGN_TOTAL_CAP_USD, asiaCapUsd: ASIA_CAP_USD, maxDomesticRoster: MAX_DOMESTIC_ROSTER,
    },
    teams: rows,
  };
}));

app.get("/api/schedule", route(async (req) => {
  const f = await getFranchise(pool);
  const teamId = req.query.teamId === "all" ? null : Number(req.query.teamId ?? f.userTeamId);
  const r = await pool.query(
    `SELECT g.id, g.game_date, g.round, ht.name AS home_team, at.name AS away_team, g.home_team_id, g.away_team_id,
            g.home_score, g.away_score, g.went_to_ot, g.series_id, g.game_number_in_series, ps.round AS playoff_round
     FROM games g JOIN teams ht ON ht.id = g.home_team_id JOIN teams at ON at.id = g.away_team_id
     LEFT JOIN playoff_series ps ON ps.id=g.series_id
     WHERE g.season_id=$1 AND ($2::int IS NULL OR g.home_team_id=$2 OR g.away_team_id=$2)
     ORDER BY g.game_date, g.id`,
    [f.seasonId, teamId]
  );
  return r.rows.map((g) => ({ ...g, playoff_label: g.playoff_round ? ROUND_LABEL[g.playoff_round] : null }));
}));

app.get("/api/games/:id/boxscore", route(async (req) => {
  const gameId = Number(req.params.id);
  const gameRes = await pool.query(
    `SELECT g.id, g.game_date, ht.name AS home_team, at.name AS away_team, g.home_team_id, g.away_team_id,
            g.home_score, g.away_score, g.went_to_ot, g.ot_periods
     FROM games g JOIN teams ht ON ht.id = g.home_team_id JOIN teams at ON at.id = g.away_team_id WHERE g.id = $1`,
    [gameId]
  );
  if (gameRes.rows.length === 0) throw new Error("경기를 찾을 수 없습니다");
  const statsRes = await pool.query(
    `SELECT p.id AS player_id, p.name, s.team_id, t.name AS team_name, s.min, s.pts, s.reb, s.oreb, s.ast, s.stl, s.blk, s.tov, s.pf,
            s.fgm, s.fga, s.tpm, s.tpa, s.ftm, s.fta
     FROM player_game_stats s JOIN players p ON p.id = s.player_id JOIN teams t ON t.id = s.team_id
     WHERE s.game_id = $1 ORDER BY s.team_id, s.min DESC`,
    [gameId]
  );
  return { game: gameRes.rows[0], players: statsRes.rows };
}));

// ============================================================
// 선수
// ============================================================

app.get("/api/players", route(async (req) => {
  const q = String(req.query.q ?? "").trim();
  const r = await pool.query(
    `SELECT p.id, p.name, t.name AS team_name, p.position, p.position_group FROM players p LEFT JOIN teams t ON t.id=p.team_id
     WHERE NOT p.is_retired AND ($1 = '' OR p.name ILIKE '%' || $1 || '%') ORDER BY p.name LIMIT 30`,
    [q]
  );
  return r.rows;
}));

async function playerDetail(playerId: number) {
  const f = await getFranchise(pool);
  const r = await pool.query(
    `SELECT p.id, p.name, p.position, p.position_group, p.nationality, t.name AS team_name, p.team_id,
            p.height_cm, p.weight_kg, p.birth_date, p.draft_year, p.draft_overall_pick, p.draft_category, p.is_retired,
            pa.*, c.contract_type, c.salary_krw, c.salary_usd, c.fa_year, c.source AS contract_source,
            pc.fatigue, pc.xp, pc.xp_level, pc.injured_until
     FROM players p LEFT JOIN teams t ON t.id = p.team_id
     LEFT JOIN player_attributes pa ON pa.player_id = p.id
     LEFT JOIN contracts c ON c.player_id=p.id LEFT JOIN player_condition pc ON pc.player_id=p.id
     WHERE p.id = $1`,
    [playerId]
  );
  const p = r.rows[0];
  if (!p) throw new Error("선수를 찾을 수 없습니다");
  const ratings = computeRatings(p, p.position_group);
  const seasons = await pool.query(
    `SELECT se.label, (g.series_id IS NOT NULL) AS playoffs, COUNT(*)::int AS g, ROUND(AVG(s.min)::numeric,1) AS min,
            ROUND(AVG(s.pts)::numeric,1) AS pts, ROUND(AVG(s.reb)::numeric,1) AS reb, ROUND(AVG(s.ast)::numeric,1) AS ast,
            ROUND(AVG(s.stl)::numeric,1) AS stl, ROUND(AVG(s.blk)::numeric,1) AS blk, ROUND(AVG(s.tpm)::numeric,1) AS tpm,
            CASE WHEN SUM(s.fga)>0 THEN ROUND(100.0*SUM(s.fgm)/SUM(s.fga),1) END AS fg_pct,
            CASE WHEN SUM(s.tpa)>0 THEN ROUND(100.0*SUM(s.tpm)/SUM(s.tpa),1) END AS tp_pct
     FROM player_game_stats s JOIN games g ON g.id=s.game_id JOIN seasons se ON se.id=g.season_id
     WHERE s.player_id=$1 AND s.min > 0 GROUP BY se.label, se.year, (g.series_id IS NOT NULL) ORDER BY se.year, playoffs`,
    [playerId]
  );
  const games = await pool.query(
    `SELECT g.id AS game_id, g.game_date, ht.name AS home, at.name AS away, g.home_score, g.away_score, s.min, s.pts, s.reb, s.ast, s.stl, s.blk, s.tpm
     FROM player_game_stats s JOIN games g ON g.id=s.game_id JOIN teams ht ON ht.id=g.home_team_id JOIN teams at ON at.id=g.away_team_id
     WHERE s.player_id=$1 ORDER BY g.game_date DESC LIMIT 10`,
    [playerId]
  );
  const devLog = await pool.query(
    `SELECT log_date, attribute, delta, reason FROM development_log WHERE player_id=$1 ORDER BY id DESC LIMIT 40`,
    [playerId]
  );
  const age = ageOn(p.birth_date, f.date);
  const lp = (await loadLeaguePlayers(pool, f.date, { includeFreeAgents: true })).find((x) => x.id === playerId);
  return {
    ...p, age, ratings,
    attributes: SIM_ATTR_KEYS.map((k) => ({ key: k, label: ATTR_LABEL[k], value: p[k] })),
    dailyTrainingGrowth: lp ? Math.round(dailyGrowthRate(lp, "normal") * 1000) / 1000 : null,
    xpPerLevel: XP_PER_LEVEL,
    seasonStats: seasons.rows,
    recentGames: games.rows,
    developmentLog: devLog.rows.map((d) => ({ ...d, label: ATTR_LABEL[d.attribute as keyof typeof ATTR_LABEL] ?? d.attribute })),
  };
}

app.get("/api/players/:id", route(async (req) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id)) return playerDetail(id);
  const r = await pool.query(`SELECT id FROM players WHERE name=$1 LIMIT 1`, [req.params.id]);
  if (!r.rows[0]) throw new Error("선수를 찾을 수 없습니다");
  return playerDetail(r.rows[0].id);
}));

// ============================================================
// 내 팀 운영: 팀 선택 / 로스터 / 전술 / 훈련 / 게임플랜
// ============================================================

app.post("/api/franchise/select-team", route(async (req) => {
  const f = await getFranchise(pool);
  const played = await pool.query(`SELECT COUNT(*) AS n FROM games WHERE home_score IS NOT NULL`);
  if (Number(played.rows[0].n) > 0) throw new Error("이미 시즌이 진행되어 팀을 변경할 수 없습니다 (새 게임으로 시작하세요)");
  const teamId = Number(req.body.teamId);
  if (!teamId) throw new Error("teamId가 필요합니다");
  await pool.query(`UPDATE franchise SET user_team_id = $1 WHERE id = $2`, [teamId, f.id]);
  return { ok: true };
}));

app.get("/api/franchise/roster", route(async () => {
  const f = await getFranchise(pool);
  return teamRoster(f.userTeamId);
}));

/**
 * 로스터(출전시간) 설정 저장: 선발 정확히 5명, 후보 5~12명.
 * body: { players: [{ playerId, role, minutesTarget, offensePriority }] }
 */
app.put("/api/franchise/roster", route(async (req) => {
  const f = await getFranchise(pool);
  const players: { playerId: number; role: string; minutesTarget: number | null; offensePriority: number | null }[] = req.body.players ?? [];
  const starters = players.filter((p) => p.role === "starter");
  const bench = players.filter((p) => p.role === "bench");
  if (starters.length !== 5) throw new Error(`선발은 정확히 5명이어야 합니다 (현재 ${starters.length}명)`);
  if (bench.length < 5) throw new Error(`후보는 최소 5명이어야 합니다 (현재 ${bench.length}명)`);
  const own = await pool.query(`SELECT id FROM players WHERE team_id=$1`, [f.userTeamId]);
  const ownIds = new Set(own.rows.map((r) => r.id));
  if (players.some((p) => !ownIds.has(p.playerId))) throw new Error("우리 팀 선수가 아닌 선수가 포함되어 있습니다");
  const total = players.filter((p) => p.role !== "inactive").reduce((a, p) => a + (Number(p.minutesTarget) || 0), 0);
  await pool.query(`DELETE FROM player_roster_settings WHERE team_id = $1`, [f.userTeamId]);
  for (const p of players) {
    await pool.query(
      `INSERT INTO player_roster_settings (team_id, player_id, role, minutes_target, offense_priority) VALUES ($1,$2,$3,$4,$5)`,
      [f.userTeamId, p.playerId, p.role, p.minutesTarget, p.offensePriority]
    );
  }
  return { ok: true, totalMinutes: total, warning: Math.abs(total - 200) > 15 ? `목표 출전시간 합계가 ${total}분입니다 (경기당 200분 기준 — 실제 출전시간은 비율대로 배분됩니다)` : null };
}));

app.get("/api/franchise/tactics", route(async () => {
  const f = await getFranchise(pool);
  const r = await pool.query(
    `SELECT pace_style, three_point_reliance, defense_scheme, rebound_emphasis, defensive_stopper_player_id, clutch_closer_player_id
     FROM team_tactics WHERE team_id = $1`,
    [f.userTeamId]
  );
  return r.rows[0] ?? { pace_style: "normal", three_point_reliance: "normal", defense_scheme: "man", rebound_emphasis: false, defensive_stopper_player_id: null, clutch_closer_player_id: null };
}));

app.put("/api/franchise/tactics", route(async (req) => {
  const f = await getFranchise(pool);
  const { paceStyle, threePointReliance, defenseScheme, reboundEmphasis, defensiveStopperPlayerId, clutchCloserPlayerId } = req.body;
  await pool.query(
    `INSERT INTO team_tactics (team_id, pace_style, three_point_reliance, defense_scheme, rebound_emphasis, defensive_stopper_player_id, clutch_closer_player_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (team_id) DO UPDATE SET pace_style=$2, three_point_reliance=$3, defense_scheme=$4, rebound_emphasis=$5,
       defensive_stopper_player_id=$6, clutch_closer_player_id=$7`,
    [f.userTeamId, paceStyle ?? "normal", threePointReliance ?? "normal", defenseScheme ?? "man", !!reboundEmphasis,
      defensiveStopperPlayerId ?? null, clutchCloserPlayerId ?? null]
  );
  return { ok: true };
}));

app.get("/api/franchise/training", route(async () => {
  const f = await getFranchise(pool);
  const plan = await loadTrainingPlan(pool, f.userTeamId);
  const focuses = Object.entries(TRAINING_FOCUS).map(([key, v]) => ({ key, label: v.label, attributes: v.attrs.map((a) => ATTR_LABEL[a]) }));
  const roster = await teamRoster(f.userTeamId);
  const players = await loadLeaguePlayers(pool, f.date);
  const recent = await pool.query(
    `SELECT d.log_date, p.name, d.attribute, d.delta, d.reason FROM development_log d JOIN players p ON p.id=d.player_id
     WHERE p.team_id=$1 ORDER BY d.id DESC LIMIT 40`,
    [f.userTeamId]
  );
  return {
    plan, focuses,
    players: roster.map((r) => {
      const lp = players.find((p) => p.id === r.id);
      return {
        id: r.id, name: r.name, age: r.age, positionGroup: r.positionGroup, overall: r.overall, potential: r.potential,
        fatigue: r.fatigue, injuredUntil: r.injuredUntil, personalFocus: r.personalFocus, xp: r.xp, xpLevel: r.xpLevel,
        growthRate: lp ? Math.round(dailyGrowthRate(lp, plan.intensity) * 1000) / 1000 : 0,
      };
    }),
    recentChanges: recent.rows.map((d) => ({ ...d, label: ATTR_LABEL[d.attribute as keyof typeof ATTR_LABEL] ?? d.attribute })),
  };
}));

app.put("/api/franchise/training", route(async (req) => {
  const f = await getFranchise(pool);
  const { mode, focus, intensity, personalFocus } = req.body as { mode?: string; focus?: string; intensity?: string; personalFocus?: Record<string, string | null> };
  if (mode || focus || intensity) {
    if (focus && !(focus in TRAINING_FOCUS)) throw new Error("알 수 없는 훈련 초점입니다");
    const cur = await loadTrainingPlan(pool, f.userTeamId);
    await pool.query(
      `INSERT INTO training_plans (team_id, mode, focus, intensity) VALUES ($1,$2,$3,$4)
       ON CONFLICT (team_id) DO UPDATE SET mode=$2, focus=$3, intensity=$4`,
      [f.userTeamId, mode ?? cur.mode, focus ?? cur.focus, intensity ?? cur.intensity]
    );
  }
  if (personalFocus) {
    for (const [pid, fc] of Object.entries(personalFocus)) {
      if (fc === null || fc === "") await pool.query(`DELETE FROM player_training_focus WHERE player_id=$1`, [Number(pid)]);
      else await pool.query(
        `INSERT INTO player_training_focus (player_id, focus) VALUES ($1,$2) ON CONFLICT (player_id) DO UPDATE SET focus=$2`,
        [Number(pid), fc]
      );
    }
  }
  return { ok: true };
}));

/** 오늘 정보: 날짜, 단계, 우리 팀 경기(있으면), 다른 경기들, 훈련 계획 */
app.get("/api/franchise/today", route(async () => {
  const f = await getFranchise(pool);
  const g = await userGameToday(pool, f);
  let game = null;
  if (g) {
    const r = await pool.query(
      `SELECT g.id, g.home_team_id, g.away_team_id, ht.name AS home, at.name AS away, g.home_score, g.away_score,
              g.series_id, g.game_number_in_series, ps.round AS playoff_round, ps.higher_seed_wins, ps.lower_seed_wins,
              ps.higher_seed_team_id
       FROM games g JOIN teams ht ON ht.id=g.home_team_id JOIN teams at ON at.id=g.away_team_id
       LEFT JOIN playoff_series ps ON ps.id=g.series_id WHERE g.id=$1`,
      [g.id]
    );
    const row = r.rows[0];
    const opponentId = row.home_team_id === f.userTeamId ? row.away_team_id : row.home_team_id;
    const opp = await teamRoster(opponentId);
    const plan = await pool.query(`SELECT * FROM game_plans WHERE game_id=$1 AND team_id=$2`, [g.id, f.userTeamId]);
    game = {
      ...row, isHome: row.home_team_id === f.userTeamId, played: row.home_score !== null,
      playoffLabel: row.playoff_round ? ROUND_LABEL[row.playoff_round] : null,
      opponent: { id: opponentId, name: row.home_team_id === f.userTeamId ? row.away : row.home, coach: coachForTeam(row.home_team_id === f.userTeamId ? row.away : row.home), topPlayers: opp.slice(0, 8) },
      gamePlan: plan.rows[0] ?? null,
    };
  }
  const others = await pool.query(
    `SELECT g.id, ht.name AS home, at.name AS away, g.home_score, g.away_score FROM games g
     JOIN teams ht ON ht.id=g.home_team_id JOIN teams at ON at.id=g.away_team_id
     WHERE g.season_id=$1 AND g.game_date=$2 AND g.home_team_id<>$3 AND g.away_team_id<>$3`,
    [f.seasonId, f.date, f.userTeamId]
  );
  return { franchise: f, game, otherGames: others.rows, trainingPlan: await loadTrainingPlan(pool, f.userTeamId) };
}));

app.put("/api/franchise/gameplan/:gameId", route(async (req) => {
  const f = await getFranchise(pool);
  const gameId = Number(req.params.gameId);
  const { doubleTeamPlayerId, paceStyle, threePointReliance, defenseScheme, reboundEmphasis } = req.body;
  await pool.query(
    `INSERT INTO game_plans (game_id, team_id, double_team_player_id, pace_style, three_point_reliance, defense_scheme, rebound_emphasis)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (game_id, team_id) DO UPDATE SET double_team_player_id=$3, pace_style=$4, three_point_reliance=$5, defense_scheme=$6, rebound_emphasis=$7`,
    [gameId, f.userTeamId, doubleTeamPlayerId ?? null, paceStyle ?? null, threePointReliance ?? null, defenseScheme ?? null, reboundEmphasis ?? null]
  );
  return { ok: true };
}));

// ============================================================
// 진행
// ============================================================

app.post("/api/franchise/advance-day", route(async (req) => advanceDay(pool, req.body?.plan)));
app.post("/api/franchise/advance-to-game", route(async () => {
  const days = await advanceToNextGameDay(pool);
  return { days };
}));
// (구버전 호환) 다음 경기까지 진행
app.post("/api/franchise/advance", route(async () => ({ days: await advanceToNextGameDay(pool) })));

app.post("/api/franchise/games/:id/quick-sim", route(async (req) => quickSimUserGame(pool, Number(req.params.id))));
app.post("/api/franchise/games/:id/live", route(async (req) => startLiveGame(pool, Number(req.params.id))));
app.get("/api/live/:sid", route(async (req) => getLiveGame(String(req.params.sid))));
app.post("/api/live/:sid/update", route(async (req) => updateLiveGame(String(req.params.sid), req.body ?? {})));
app.post("/api/live/:sid/step", route(async (req) => stepLiveGame(pool, String(req.params.sid), req.body ?? {})));

app.get("/api/franchise/playoffs", route(async () => {
  const f = await getFranchise(pool);
  return (await playoffBracket(pool, f.seasonId)).map((s) => ({ ...s, round_label: ROUND_LABEL[s.round] }));
}));

app.get("/api/transactions", route(async () => {
  const r = await pool.query(
    `SELECT t.season_year, t.tx_date, t.kind, t.description, tm.name AS team_name FROM transactions t
     LEFT JOIN teams tm ON tm.id=t.team_id WHERE t.kind <> 'market' ORDER BY t.id DESC LIMIT 100`
  );
  return r.rows;
}));

// ============================================================
// 비시즌
// ============================================================

app.get("/api/offseason", route(async () => offseasonOverview(pool)));
app.post("/api/offseason/negotiations/:id/offer", route(async (req) =>
  offerNegotiation(pool, Number(req.params.id), Number(req.body.amount), Number(req.body.years ?? 1))));
app.get("/api/offseason/free-agents", route(async () => freeAgentList(pool)));
app.post("/api/offseason/free-agents/:id/offer", route(async (req) =>
  makeFaOffer(pool, Number(req.params.id), Number(req.body.amount), Number(req.body.years ?? 1))));
app.delete("/api/offseason/free-agents/:id/offer", route(async (req) => withdrawFaOffer(pool, Number(req.params.id))));
app.post("/api/offseason/release/:playerId", route(async (req) => releasePlayer(pool, Number(req.params.playerId))));
app.post("/api/offseason/advance", route(async () => advanceOffseason(pool)));
app.post("/api/offseason/start-season", route(async () => startNewSeason(pool)));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[server] KBL Manager API listening on port ${PORT}`);
  });
}

export { app };
