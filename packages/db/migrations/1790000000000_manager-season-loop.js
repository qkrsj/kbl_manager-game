/**
 * KBL Manager — 매니저 게임 루프 (v1)
 *  - 날짜 기반 진행 (하루씩): franchise.game_date, games.game_date
 *  - 계약/샐러리캡: contracts
 *  - 컨디션/피로도/경험치/부상: player_condition
 *  - 훈련: training_plans(팀 단위), player_training_focus(선수 단위), development_log(능력치 변화 기록)
 *  - 시뮬레이션 프로필(실측 기반 슛 확률 등)을 DB로 이전: player_sim_profile
 *    (FA 이적·신인 생성 이후에도 엔진이 DB만 보고 돌아가도록)
 *  - AI 감독: coaches / 경기별 게임플랜: game_plans
 *  - 비시즌: negotiations(연봉협상·재계약), fa_offers(FA 시장 제안), transactions(이적 기록)
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE seasons ADD COLUMN year INTEGER;

    ALTER TABLE franchise ADD COLUMN game_date DATE;
    ALTER TABLE franchise ADD COLUMN offseason_stage TEXT;      -- NULL | 'resign' | 'fa' | 'draft' | 'ready'
    ALTER TABLE franchise ADD COLUMN fa_day INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE franchise ADD COLUMN champion_team_id INTEGER REFERENCES teams(id);

    ALTER TABLE games ADD COLUMN game_date DATE;
    CREATE INDEX idx_games_date ON games(game_date);

    ALTER TABLE player_game_stats ADD COLUMN min  NUMERIC(4,1) NOT NULL DEFAULT 0;
    ALTER TABLE player_game_stats ADD COLUMN fgm  INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE player_game_stats ADD COLUMN fga  INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE player_game_stats ADD COLUMN tpm  INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE player_game_stats ADD COLUMN tpa  INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE player_game_stats ADD COLUMN ftm  INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE player_game_stats ADD COLUMN fta  INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE player_game_stats ADD COLUMN oreb INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE player_game_stats ADD COLUMN stl  INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE players ADD COLUMN is_retired BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE players ADD COLUMN is_generated BOOLEAN NOT NULL DEFAULT FALSE;  -- 신인 드래프트/외국선수 시장에서 생성된 가상 선수
    ALTER TABLE players ADD COLUMN previous_team_id INTEGER REFERENCES teams(id); -- FA 직전 소속 (보상 규정용)
    ALTER TABLE players ADD COLUMN prev_salary_rank INTEGER;  -- FA 공시 시점 직전 시즌 보수 순위 (보상 규정용)

    CREATE TABLE contracts (
      player_id      INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      contract_type  TEXT NOT NULL CHECK (contract_type IN ('domestic','foreign','asia')),
      salary_krw     INTEGER,            -- 국내선수 보수 총액 (만원)
      salary_usd     INTEGER,            -- 외국선수/아시아쿼터 (달러)
      fa_year        INTEGER NOT NULL,   -- 이 해 비시즌에 FA (예: 2027 = 2026-27 시즌 후)
      source         TEXT NOT NULL DEFAULT 'estimated',  -- 'reported' | 'estimated' | 'negotiated' | 'fa' | 'rookie'
      signed_year    INTEGER
    );

    CREATE TABLE player_sim_profile (
      player_id        INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      paint_accuracy   REAL NOT NULL,
      mid_accuracy     REAL NOT NULL,
      three_accuracy   REAL NOT NULL,
      ft_accuracy      REAL NOT NULL,
      usage_percentile REAL NOT NULL,
      pts_percentile   REAL NOT NULL,
      base_attrs       JSONB NOT NULL    -- 위 확률을 산출할 당시의 능력치 (이후 성장분만큼 확률 보정)
    );

    CREATE TABLE player_condition (
      player_id          INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      fatigue            REAL NOT NULL DEFAULT 0,      -- 0(완전 회복) ~ 100(탈진)
      xp                 INTEGER NOT NULL DEFAULT 0,   -- 누적 경기 경험치
      xp_level           INTEGER NOT NULL DEFAULT 0,
      training_progress  JSONB NOT NULL DEFAULT '{}',  -- 능력치별 소수점 누적치 (±1 넘으면 실제 반영)
      injured_until      DATE,
      morale             SMALLINT NOT NULL DEFAULT 70
    );

    CREATE TABLE coaches (
      team_id               INTEGER PRIMARY KEY REFERENCES teams(id),
      name                  TEXT NOT NULL,
      style                 TEXT NOT NULL,
      description           TEXT,
      pace_style            TEXT NOT NULL,
      three_point_reliance  TEXT NOT NULL,
      defense_scheme        TEXT NOT NULL,
      rotation_depth        REAL NOT NULL,   -- 0(주전 의존) ~ 1(두터운 로테이션)
      youth_preference      REAL NOT NULL    -- 0 ~ 1
    );

    ALTER TABLE team_tactics ADD COLUMN defense_scheme TEXT NOT NULL DEFAULT 'man'
      CHECK (defense_scheme IN ('man','zone','press'));
    ALTER TABLE team_tactics ADD COLUMN rebound_emphasis BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE game_plans (
      game_id                 INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      team_id                 INTEGER NOT NULL REFERENCES teams(id),
      double_team_player_id   INTEGER REFERENCES players(id),
      pace_style              TEXT,
      three_point_reliance    TEXT,
      defense_scheme          TEXT,
      rebound_emphasis        BOOLEAN,
      PRIMARY KEY (game_id, team_id)
    );

    CREATE TABLE training_plans (
      team_id    INTEGER PRIMARY KEY REFERENCES teams(id),
      mode       TEXT NOT NULL DEFAULT 'train' CHECK (mode IN ('rest','train')),
      focus      TEXT NOT NULL DEFAULT 'balanced',
      intensity  TEXT NOT NULL DEFAULT 'normal' CHECK (intensity IN ('light','normal','intense'))
    );

    CREATE TABLE player_training_focus (
      player_id  INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      focus      TEXT NOT NULL
    );

    CREATE TABLE development_log (
      id          SERIAL PRIMARY KEY,
      player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      log_date    DATE NOT NULL,
      attribute   TEXT NOT NULL,
      delta       SMALLINT NOT NULL,
      reason      TEXT NOT NULL      -- 'training' | 'aging' | 'experience' | 'offseason'
    );
    CREATE INDEX idx_development_log_player ON development_log(player_id);

    CREATE TABLE negotiations (
      id              SERIAL PRIMARY KEY,
      season_year     INTEGER NOT NULL,
      player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      team_id         INTEGER NOT NULL REFERENCES teams(id),
      kind            TEXT NOT NULL CHECK (kind IN ('salary','fa_resign','foreign_resign')),
      asking_amount   INTEGER NOT NULL,      -- 국내: 만원, 외국/아시아: 달러
      asking_years    INTEGER NOT NULL DEFAULT 1,
      last_offer      INTEGER,
      last_offer_years INTEGER,
      rounds          INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','declined','arbitration')),
      fair_value      INTEGER NOT NULL,
      message         TEXT
    );

    CREATE TABLE fa_offers (
      id          SERIAL PRIMARY KEY,
      season_year INTEGER NOT NULL,
      player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      team_id     INTEGER NOT NULL REFERENCES teams(id),
      amount      INTEGER NOT NULL,
      years       INTEGER NOT NULL,
      offer_day   INTEGER NOT NULL,
      UNIQUE (season_year, player_id, team_id)
    );

    CREATE TABLE transactions (
      id          SERIAL PRIMARY KEY,
      season_year INTEGER NOT NULL,
      tx_date     DATE,
      team_id     INTEGER REFERENCES teams(id),
      player_id   INTEGER REFERENCES players(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      description TEXT NOT NULL
    );

    -- 순위표: 정규시즌 경기만 집계 (이전 뷰는 플레이오프 경기까지 섞여 있었음)
    DROP VIEW IF EXISTS standings;
    CREATE VIEW standings AS
    WITH team_games AS (
      SELECT season_id, home_team_id AS team_id, home_score AS scored, away_score AS allowed,
             (home_score > away_score) AS won
      FROM games WHERE home_score IS NOT NULL AND series_id IS NULL
      UNION ALL
      SELECT season_id, away_team_id AS team_id, away_score AS scored, home_score AS allowed,
             (away_score > home_score) AS won
      FROM games WHERE away_score IS NOT NULL AND series_id IS NULL
    )
    SELECT
      t.id AS team_id,
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
    GROUP BY t.id, t.name, tg.season_id
    ORDER BY wins DESC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS transactions;
    DROP TABLE IF EXISTS fa_offers;
    DROP TABLE IF EXISTS negotiations;
    DROP TABLE IF EXISTS development_log;
    DROP TABLE IF EXISTS player_training_focus;
    DROP TABLE IF EXISTS training_plans;
    DROP TABLE IF EXISTS game_plans;
    DROP TABLE IF EXISTS coaches;
    DROP TABLE IF EXISTS player_condition;
    DROP TABLE IF EXISTS player_sim_profile;
    DROP TABLE IF EXISTS contracts;
    ALTER TABLE team_tactics DROP COLUMN IF EXISTS defense_scheme;
    ALTER TABLE team_tactics DROP COLUMN IF EXISTS rebound_emphasis;
    ALTER TABLE players DROP COLUMN IF EXISTS is_retired;
    ALTER TABLE players DROP COLUMN IF EXISTS is_generated;
    ALTER TABLE players DROP COLUMN IF EXISTS previous_team_id;
    ALTER TABLE players DROP COLUMN IF EXISTS prev_salary_rank;
    ALTER TABLE player_game_stats DROP COLUMN IF EXISTS min, DROP COLUMN IF EXISTS fgm, DROP COLUMN IF EXISTS fga,
      DROP COLUMN IF EXISTS tpm, DROP COLUMN IF EXISTS tpa, DROP COLUMN IF EXISTS ftm, DROP COLUMN IF EXISTS fta,
      DROP COLUMN IF EXISTS oreb, DROP COLUMN IF EXISTS stl;
    DROP INDEX IF EXISTS idx_games_date;
    ALTER TABLE games DROP COLUMN IF EXISTS game_date;
    ALTER TABLE franchise DROP COLUMN IF EXISTS game_date, DROP COLUMN IF EXISTS offseason_stage,
      DROP COLUMN IF EXISTS fa_day, DROP COLUMN IF EXISTS champion_team_id;
    ALTER TABLE seasons DROP COLUMN IF EXISTS year;
  `);
};
