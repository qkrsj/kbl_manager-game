/**
 * KBL Manager — 매니저 모드 지원 마이그레이션
 * - games.home_score/away_score를 NULL 허용으로 변경 (NULL = 아직 안 뛴 예정 경기)
 * - franchise 테이블 추가: 유저가 선택한 팀 + 진행 상황(현재 라운드) 저장
 *   (v0에서는 단일 세이브 슬롯만 지원, 유저 인증 시스템은 미구현)
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE games ALTER COLUMN home_score DROP NOT NULL;
    ALTER TABLE games ALTER COLUMN away_score DROP NOT NULL;
    ALTER TABLE games ALTER COLUMN home_score DROP DEFAULT;
    ALTER TABLE games ALTER COLUMN away_score DROP DEFAULT;

    CREATE TABLE franchise (
      id                SERIAL PRIMARY KEY,
      season_id         INTEGER NOT NULL REFERENCES seasons(id),
      user_team_id      INTEGER NOT NULL REFERENCES teams(id),
      current_round     INTEGER NOT NULL DEFAULT 0   -- 여기까지 진행 완료 (0 = 시즌 시작 전)
    );
  `);

  // standings 뷰는 이제 "스코어가 있는(=이미 뛴) 경기만" 집계하도록 재정의해야 함
  // (NULL 스코어인 예정 경기가 순위표 계산에 섞이면 안 되므로)
  pgm.sql(`
    DROP VIEW IF EXISTS standings;
    CREATE VIEW standings AS
    WITH team_games AS (
      SELECT season_id, home_team_id AS team_id, home_score AS scored, away_score AS allowed,
             (home_score > away_score) AS won
      FROM games WHERE home_score IS NOT NULL
      UNION ALL
      SELECT season_id, away_team_id AS team_id, away_score AS scored, home_score AS allowed,
             (away_score > home_score) AS won
      FROM games WHERE away_score IS NOT NULL
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
    DROP TABLE IF EXISTS franchise;
    ALTER TABLE games ALTER COLUMN home_score SET NOT NULL;
    ALTER TABLE games ALTER COLUMN away_score SET NOT NULL;
  `);
};
