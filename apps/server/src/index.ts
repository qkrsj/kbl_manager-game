/**
 * KBL Manager — API 서버 (v0)
 * 순위표, 일정, 박스스코어를 제공하는 최소 Express API.
 */
import express from "express";
import cors from "cors";
import { pool } from "./db";
import { advanceToNextGame } from "./advanceToNextGame";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ?? 4000;

/** 순위표 */
app.get("/api/standings", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT team_name, games_played, wins, losses, points_for, points_against,
              avg_points_for, avg_points_against
       FROM standings ORDER BY wins DESC`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 일정/경기결과 목록 (라운드순) */
app.get("/api/schedule", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.id, g.round, g.day_offset, ht.name AS home_team, at.name AS away_team,
              g.home_score, g.away_score, g.went_to_ot
       FROM games g
       JOIN teams ht ON ht.id = g.home_team_id
       JOIN teams at ON at.id = g.away_team_id
       ORDER BY g.round`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 특정 경기 박스스코어 */
app.get("/api/games/:id/boxscore", async (req, res) => {
  try {
    const gameId = Number(req.params.id);
    const gameRes = await pool.query(
      `SELECT g.id, g.round, ht.name AS home_team, at.name AS away_team,
              g.home_score, g.away_score, g.went_to_ot
       FROM games g
       JOIN teams ht ON ht.id = g.home_team_id
       JOIN teams at ON at.id = g.away_team_id
       WHERE g.id = $1`,
      [gameId]
    );
    if (gameRes.rows.length === 0) {
      res.status(404).json({ error: "game not found" });
      return;
    }
    const statsRes = await pool.query(
      `SELECT p.name, t.name AS team_name, s.pts, s.ast, s.reb, s.tov, s.blk, s.pf
       FROM player_game_stats s
       JOIN players p ON p.id = s.player_id
       JOIN teams t ON t.id = s.team_id
       WHERE s.game_id = $1
       ORDER BY s.pts DESC`,
      [gameId]
    );
    res.json({ game: gameRes.rows[0], players: statsRes.rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 선수 능력치 조회 */
app.get("/api/players/:name", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.name, p.position, p.position_group, p.nationality, t.name AS team_name,
              pa.finishing, pa.dunking, pa.mid_range_shooting, pa.three_point_shooting,
              pa.free_throw_shooting, pa.ball_handling, pa.passing, pa.steal, pa.shot_blocking,
              pa.defensive_rebounding, pa.offensive_rebounding, pa.stamina, pa.injury_proneness,
              pa.strength, pa.speed, pa.potential
       FROM players p
       LEFT JOIN teams t ON t.id = p.team_id
       LEFT JOIN player_attributes pa ON pa.player_id = p.id
       WHERE p.name = $1`,
      [req.params.name]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "player not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 내 franchise 현재 상태 (선택 팀, 진행 라운드) */
app.get("/api/franchise", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.id, f.current_round, t.name AS user_team, s.label AS season_label
       FROM franchise f
       JOIN teams t ON t.id = f.user_team_id
       JOIN seasons s ON s.id = f.season_id
       LIMIT 1`
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "franchise not found (run seed first)" });
      return;
    }
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 우리 팀의 다음 경기 날짜까지 진행: 그 날짜(포함) 밀린 다른 경기들도 함께 처리 */
app.post("/api/franchise/advance", async (_req, res) => {
  try {
    const result = await advanceToNextGame(pool);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/** 우리 팀 선수 목록 (로스터 설정 화면용, 현재 설정 포함) */
app.get("/api/franchise/roster", async (_req, res) => {
  try {
    const franchiseRes = await pool.query(`SELECT user_team_id FROM franchise LIMIT 1`);
    if (franchiseRes.rows.length === 0) {
      res.status(404).json({ error: "franchise not found" });
      return;
    }
    const teamId = franchiseRes.rows[0].user_team_id;
    const result = await pool.query(
      `SELECT p.id, p.name, p.position_group, p.nationality,
              COALESCE(prs.role, 'inactive') AS role,
              prs.minutes_target, prs.offense_priority
       FROM players p
       LEFT JOIN player_roster_settings prs ON prs.player_id = p.id AND prs.team_id = p.team_id
       WHERE p.team_id = $1
       ORDER BY p.position_group, p.name`,
      [teamId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * 로스터 설정 저장: 선발 정확히 5명, 후보 정확히 7명이어야 함.
 * body: { players: [{ playerId, role, minutesTarget, offensePriority }] }
 */
app.put("/api/franchise/roster", async (req, res) => {
  try {
    const franchiseRes = await pool.query(`SELECT user_team_id FROM franchise LIMIT 1`);
    if (franchiseRes.rows.length === 0) {
      res.status(404).json({ error: "franchise not found" });
      return;
    }
    const teamId = franchiseRes.rows[0].user_team_id;
    const players: { playerId: number; role: string; minutesTarget: number | null; offensePriority: number | null }[] =
      req.body.players ?? [];

    const starters = players.filter((p) => p.role === "starter");
    const bench = players.filter((p) => p.role === "bench");
    if (starters.length !== 5) {
      res.status(400).json({ error: `선발은 정확히 5명이어야 합니다 (현재 ${starters.length}명)` });
      return;
    }
    if (bench.length !== 7) {
      res.status(400).json({ error: `후보는 정확히 7명이어야 합니다 (현재 ${bench.length}명)` });
      return;
    }

    await pool.query(`DELETE FROM player_roster_settings WHERE team_id = $1`, [teamId]);
    for (const p of players) {
      await pool.query(
        `INSERT INTO player_roster_settings (team_id, player_id, role, minutes_target, offense_priority)
         VALUES ($1,$2,$3,$4,$5)`,
        [teamId, p.playerId, p.role, p.minutesTarget, p.offensePriority]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 팀 전술 설정 조회 */
app.get("/api/franchise/tactics", async (_req, res) => {
  try {
    const franchiseRes = await pool.query(`SELECT user_team_id FROM franchise LIMIT 1`);
    if (franchiseRes.rows.length === 0) {
      res.status(404).json({ error: "franchise not found" });
      return;
    }
    const teamId = franchiseRes.rows[0].user_team_id;
    const result = await pool.query(
      `SELECT pace_style, three_point_reliance, defensive_stopper_player_id, clutch_closer_player_id
       FROM team_tactics WHERE team_id = $1`,
      [teamId]
    );
    res.json(result.rows[0] ?? { pace_style: "normal", three_point_reliance: "normal", defensive_stopper_player_id: null, clutch_closer_player_id: null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 팀 전술 설정 저장 */
app.put("/api/franchise/tactics", async (req, res) => {
  try {
    const franchiseRes = await pool.query(`SELECT user_team_id FROM franchise LIMIT 1`);
    if (franchiseRes.rows.length === 0) {
      res.status(404).json({ error: "franchise not found" });
      return;
    }
    const teamId = franchiseRes.rows[0].user_team_id;
    const { paceStyle, threePointReliance, defensiveStopperPlayerId, clutchCloserPlayerId } = req.body;

    await pool.query(
      `INSERT INTO team_tactics (team_id, pace_style, three_point_reliance, defensive_stopper_player_id, clutch_closer_player_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (team_id) DO UPDATE SET
         pace_style=EXCLUDED.pace_style, three_point_reliance=EXCLUDED.three_point_reliance,
         defensive_stopper_player_id=EXCLUDED.defensive_stopper_player_id,
         clutch_closer_player_id=EXCLUDED.clutch_closer_player_id`,
      [teamId, paceStyle ?? "normal", threePointReliance ?? "normal", defensiveStopperPlayerId ?? null, clutchCloserPlayerId ?? null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 전체 팀 목록 (팀 선택 화면용) */
app.get("/api/teams", async (_req, res) => {
  try {
    const result = await pool.query(`SELECT id, name FROM teams ORDER BY name`);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * 유저 팀 선택/변경. 시즌 시작 전(current_round=0)에만 허용 —
 * 이미 경기를 진행했으면 중간에 팀을 바꾸는 건 v0에서 지원 안 함.
 * body: { teamId }
 */
app.post("/api/franchise/select-team", async (req, res) => {
  try {
    const franchiseRes = await pool.query(`SELECT id, current_round FROM franchise LIMIT 1`);
    if (franchiseRes.rows.length === 0) {
      res.status(404).json({ error: "franchise not found (run seed first)" });
      return;
    }
    const franchise = franchiseRes.rows[0];
    if (franchise.current_round > 0) {
      res.status(400).json({ error: "이미 시즌이 진행되어 팀을 변경할 수 없습니다" });
      return;
    }
    const { teamId } = req.body;
    if (!teamId) {
      res.status(400).json({ error: "teamId가 필요합니다" });
      return;
    }
    await pool.query(`UPDATE franchise SET user_team_id = $1 WHERE id = $2`, [teamId, franchise.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[server] KBL Manager API listening on port ${PORT}`);
});
