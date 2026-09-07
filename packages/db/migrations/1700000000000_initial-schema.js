/**
 * KBL Manager — 초기 스키마 마이그레이션
 * ../schema.sql에 있던 DDL을 node-pg-migrate 마이그레이션으로 이전.
 * (schema.sql은 사람이 읽는 참고용 문서로 계속 유지, 실제 적용은 이 파일이 담당)
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE teams (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      short_name    TEXT
    );

    CREATE TABLE players (
      id                  SERIAL PRIMARY KEY,
      name                TEXT NOT NULL,
      team_id             INTEGER REFERENCES teams(id),
      nationality         TEXT NOT NULL,
      position            TEXT,
      position_group      TEXT CHECK (position_group IN ('G','F','C')),
      height_cm           NUMERIC(5,1),
      weight_kg           NUMERIC(5,1),
      birth_date          DATE,
      is_foreign_import   BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (name, team_id)
    );

    CREATE TABLE seasons (
      id          SERIAL PRIMARY KEY,
      label       TEXT NOT NULL UNIQUE,
      start_date  DATE NOT NULL
    );

    CREATE TABLE player_attributes (
      id                    SERIAL PRIMARY KEY,
      player_id             INTEGER NOT NULL REFERENCES players(id),
      season_id             INTEGER NOT NULL REFERENCES seasons(id),

      finishing             SMALLINT CHECK (finishing BETWEEN 0 AND 99),
      dunking               SMALLINT CHECK (dunking BETWEEN 0 AND 99),
      mid_range_shooting    SMALLINT CHECK (mid_range_shooting BETWEEN 0 AND 99),
      three_point_shooting  SMALLINT CHECK (three_point_shooting BETWEEN 0 AND 99),
      free_throw_shooting   SMALLINT CHECK (free_throw_shooting BETWEEN 0 AND 99),
      ball_handling         SMALLINT CHECK (ball_handling BETWEEN 0 AND 99),
      passing               SMALLINT CHECK (passing BETWEEN 0 AND 99),
      steal                 SMALLINT CHECK (steal BETWEEN 0 AND 99),
      shot_blocking         SMALLINT CHECK (shot_blocking BETWEEN 0 AND 99),
      defensive_rebounding  SMALLINT CHECK (defensive_rebounding BETWEEN 0 AND 99),
      offensive_rebounding  SMALLINT CHECK (offensive_rebounding BETWEEN 0 AND 99),
      stamina               SMALLINT CHECK (stamina BETWEEN 0 AND 99),
      injury_proneness      SMALLINT CHECK (injury_proneness BETWEEN 0 AND 99),
      strength              SMALLINT CHECK (strength BETWEEN 0 AND 99),
      speed                 SMALLINT CHECK (speed BETWEEN 0 AND 99),
      potential             SMALLINT CHECK (potential BETWEEN 0 AND 99),

      consistency           SMALLINT CHECK (consistency BETWEEN 0 AND 99),
      clutch                SMALLINT CHECK (clutch BETWEEN 0 AND 99),
      work_ethic            SMALLINT CHECK (work_ethic BETWEEN 0 AND 99),

      UNIQUE (player_id, season_id)
    );

    CREATE TABLE games (
      id                SERIAL PRIMARY KEY,
      season_id         INTEGER NOT NULL REFERENCES seasons(id),
      round             INTEGER NOT NULL,
      day_offset        INTEGER NOT NULL,
      home_team_id      INTEGER NOT NULL REFERENCES teams(id),
      away_team_id      INTEGER NOT NULL REFERENCES teams(id),
      home_score        INTEGER NOT NULL,
      away_score        INTEGER NOT NULL,
      went_to_ot        BOOLEAN NOT NULL DEFAULT FALSE,
      ot_periods        INTEGER NOT NULL DEFAULT 0,
      home_rest_days    INTEGER,
      away_rest_days    INTEGER
    );

    CREATE TABLE player_game_stats (
      id          SERIAL PRIMARY KEY,
      game_id     INTEGER NOT NULL REFERENCES games(id),
      player_id   INTEGER NOT NULL REFERENCES players(id),
      team_id     INTEGER NOT NULL REFERENCES teams(id),
      pts         INTEGER NOT NULL DEFAULT 0,
      ast         INTEGER NOT NULL DEFAULT 0,
      reb         INTEGER NOT NULL DEFAULT 0,
      tov         INTEGER NOT NULL DEFAULT 0,
      blk         INTEGER NOT NULL DEFAULT 0,
      pf          INTEGER NOT NULL DEFAULT 0,
      UNIQUE (game_id, player_id)
    );

    CREATE INDEX idx_games_season ON games(season_id);
    CREATE INDEX idx_games_home_team ON games(home_team_id);
    CREATE INDEX idx_games_away_team ON games(away_team_id);
    CREATE INDEX idx_player_game_stats_game ON player_game_stats(game_id);
    CREATE INDEX idx_player_game_stats_player ON player_game_stats(player_id);
    CREATE INDEX idx_player_attributes_season ON player_attributes(season_id);

    CREATE VIEW standings AS
    WITH team_games AS (
      SELECT season_id, home_team_id AS team_id, home_score AS scored, away_score AS allowed,
             (home_score > away_score) AS won
      FROM games
      UNION ALL
      SELECT season_id, away_team_id AS team_id, away_score AS scored, home_score AS allowed,
             (away_score > home_score) AS won
      FROM games
    )
    SELECT
      t.name AS team_name,
      tg.season_id,
      COUNT(*) AS games_played,
      SUM(CASE WHEN tg.won THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN tg.won THEN 0 ELSE 1 END) AS losses,
      SUM(tg.scored) AS points_for,
      SUM(tg.allowed) AS points_against,
      ROUND(AVG(tg.scored), 1) AS avg_points_for,
      ROUND(AVG(tg.allowed), 1) AS avg_points_against
    FROM team_games tg
    JOIN teams t ON t.id = tg.team_id
    GROUP BY t.name, tg.season_id
    ORDER BY wins DESC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW IF EXISTS standings;
    DROP TABLE IF EXISTS player_game_stats;
    DROP TABLE IF EXISTS games;
    DROP TABLE IF EXISTS player_attributes;
    DROP TABLE IF EXISTS seasons;
    DROP TABLE IF EXISTS players;
    DROP TABLE IF EXISTS teams;
  `);
};
