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

app.listen(PORT, () => {
  console.log(`[server] KBL Manager API listening on port ${PORT}`);
});
