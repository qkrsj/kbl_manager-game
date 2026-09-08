/**
 * KBL Manager — 플레이오프 시스템
 * 6강전(5전3선) -> 4강전(5전3선) -> 챔피언결정전(7전4선)
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE playoff_series (
      id                SERIAL PRIMARY KEY,
      season_id         INTEGER NOT NULL REFERENCES seasons(id),
      round             TEXT NOT NULL CHECK (round IN ('round1','round2','final')),
      slot              TEXT NOT NULL, -- 'A'(3v6) / 'B'(4v5) / 'C'(2vWinnerA) / 'D'(1vWinnerB) / 'F'(final)
      best_of           INTEGER NOT NULL CHECK (best_of IN (5,7)),
      higher_seed_team_id  INTEGER NOT NULL REFERENCES teams(id),
      lower_seed_team_id   INTEGER NOT NULL REFERENCES teams(id),
      higher_seed_wins  INTEGER NOT NULL DEFAULT 0,
      lower_seed_wins   INTEGER NOT NULL DEFAULT 0,
      winner_team_id    INTEGER REFERENCES teams(id),
      games_played      INTEGER NOT NULL DEFAULT 0
    );

    -- games 테이블에 플레이오프 경기 연결 컬럼 추가 (정규시즌 경기는 NULL)
    ALTER TABLE games ADD COLUMN series_id INTEGER REFERENCES playoff_series(id);
    ALTER TABLE games ADD COLUMN game_number_in_series INTEGER;

    -- franchise에 시즌 진행 단계 추가 (regular / playoffs_round1 / playoffs_round2 / final / done)
    ALTER TABLE franchise ADD COLUMN phase TEXT NOT NULL DEFAULT 'regular';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE franchise DROP COLUMN IF EXISTS phase;
    ALTER TABLE games DROP COLUMN IF EXISTS series_id;
    ALTER TABLE games DROP COLUMN IF EXISTS game_number_in_series;
    DROP TABLE IF EXISTS playoff_series;
  `);
};
