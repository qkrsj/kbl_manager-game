/**
 * KBL Manager — 시즌 중 성장/하락 시스템
 * 누적 delta를 별도 테이블에 저장하고, 시뮬레이션 시점에 base 능력치에 더해서 적용.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE player_growth (
      player_id             INTEGER PRIMARY KEY REFERENCES players(id),
      season_id              INTEGER NOT NULL REFERENCES seasons(id),
      delta_finishing         SMALLINT NOT NULL DEFAULT 0,
      delta_dunking           SMALLINT NOT NULL DEFAULT 0,
      delta_mid_range_shooting SMALLINT NOT NULL DEFAULT 0,
      delta_three_point_shooting SMALLINT NOT NULL DEFAULT 0,
      delta_free_throw_shooting SMALLINT NOT NULL DEFAULT 0,
      delta_ball_handling     SMALLINT NOT NULL DEFAULT 0,
      delta_passing           SMALLINT NOT NULL DEFAULT 0,
      delta_steal             SMALLINT NOT NULL DEFAULT 0,
      delta_shot_blocking     SMALLINT NOT NULL DEFAULT 0,
      delta_defensive_rebounding SMALLINT NOT NULL DEFAULT 0,
      delta_offensive_rebounding SMALLINT NOT NULL DEFAULT 0,
      delta_strength          SMALLINT NOT NULL DEFAULT 0,
      delta_stamina           SMALLINT NOT NULL DEFAULT 0,
      last_checkpoint_games  INTEGER NOT NULL DEFAULT 0  -- 마지막으로 체크포인트를 적용한 유저팀 경기수
    );

    -- 시즌 단위로 "마지막에 처리한 체크포인트"를 안정적으로 추적 (개별 선수 순서에 의존하면
    -- 중복적용 버그가 생김 — 실측 검증 중 발견)
    CREATE TABLE season_growth_checkpoints (
      season_id              INTEGER PRIMARY KEY REFERENCES seasons(id),
      last_checkpoint_games  INTEGER NOT NULL DEFAULT 0
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS season_growth_checkpoints;
    DROP TABLE IF EXISTS player_growth;
  `);
};
