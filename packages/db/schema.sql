-- KBL Manager — PostgreSQL 스키마 (v0)
-- 팀 / 선수 / 시즌별 능력치 / 경기 일정·결과 / 개인 박스스코어 를 관리한다.

CREATE TABLE teams (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,   -- 예: '서울 SK 나이츠'
  short_name    TEXT                    -- 예: 'SK'
);

CREATE TABLE players (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,     -- 동명이인은 'B' 접미사로 구분 (기존 관례 유지)
  team_id             INTEGER REFERENCES teams(id),
  nationality         TEXT NOT NULL,     -- 'KOR' | 'PHI' | 'USA' | 'TUR' | 'EGY' 등
  position            TEXT,              -- roster.csv 원본 표기 (예: '포인트 가드/슈팅 가드')
  position_group      TEXT CHECK (position_group IN ('G','F','C')),
  height_cm           NUMERIC(5,1),
  weight_kg           NUMERIC(5,1),
  birth_date          DATE,
  is_foreign_import   BOOLEAN NOT NULL DEFAULT FALSE,  -- 쿼터제 적용 대상 (PHI/귀화 제외, 라건아 등 예외 포함)
  UNIQUE (name, team_id)
);

CREATE TABLE seasons (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,   -- 예: '2026-2027'
  start_date  DATE NOT NULL
);

-- 시즌별 선수 능력치 스냅샷 (자동도출분 + 수동조정분 모두 포함, 0~99 스케일)
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
  potential             SMALLINT CHECK (potential BETWEEN 0 AND 99),  -- 용병은 NULL

  -- 수동 조정 예정 (현재는 전부 NULL, 추후 채워질 항목)
  consistency           SMALLINT CHECK (consistency BETWEEN 0 AND 99),
  clutch                SMALLINT CHECK (clutch BETWEEN 0 AND 99),
  work_ethic            SMALLINT CHECK (work_ethic BETWEEN 0 AND 99),

  UNIQUE (player_id, season_id)
);

CREATE TABLE games (
  id                SERIAL PRIMARY KEY,
  season_id         INTEGER NOT NULL REFERENCES seasons(id),
  round             INTEGER NOT NULL,   -- code-round (하루치 5경기 슬레이트 번호, 1~54)
  day_offset        INTEGER NOT NULL,   -- 시즌 시작일로부터 경과일
  home_team_id      INTEGER NOT NULL REFERENCES teams(id),
  away_team_id      INTEGER NOT NULL REFERENCES teams(id),
  home_score        INTEGER NOT NULL,
  away_score        INTEGER NOT NULL,
  went_to_ot        BOOLEAN NOT NULL DEFAULT FALSE,
  ot_periods        INTEGER NOT NULL DEFAULT 0,
  home_rest_days    INTEGER,   -- NULL = 시즌 첫 경기
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

-- 순위표는 games 테이블에서 항상 즉시 계산 가능하므로 별도 테이블 대신 뷰로 관리
-- (경기 결과가 바뀌어도 순위표가 자동으로 최신 상태를 유지함)
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
