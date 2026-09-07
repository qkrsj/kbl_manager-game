/**
 * KBL Manager — 유저 팀 전용 로스터/전술 설정
 * ⚠️ 이 설정들은 franchise.user_team_id에 해당하는 팀에만 적용됨.
 *    나머지 9팀은 항상 실제 KBL 기록 기반 자동 로직(기존 엔진) 그대로 사용.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 팀 단위 전술 설정 (유저 팀만 행이 존재, 없으면 기본 엔진 동작)
    CREATE TABLE team_tactics (
      team_id                       INTEGER PRIMARY KEY REFERENCES teams(id),
      pace_style                    TEXT NOT NULL DEFAULT 'normal' CHECK (pace_style IN ('fast','normal','slow')),
      three_point_reliance          TEXT NOT NULL DEFAULT 'normal' CHECK (three_point_reliance IN ('high','normal','low')),
      defensive_stopper_player_id   INTEGER REFERENCES players(id),
      clutch_closer_player_id       INTEGER REFERENCES players(id)
    );

    -- 선수별 로스터 설정 (유저 팀 소속 선수만 행이 존재)
    CREATE TABLE player_roster_settings (
      team_id           INTEGER NOT NULL REFERENCES teams(id),
      player_id         INTEGER NOT NULL REFERENCES players(id),
      role              TEXT NOT NULL DEFAULT 'inactive' CHECK (role IN ('starter','bench','inactive')),
      minutes_target    NUMERIC(4,1) CHECK (minutes_target BETWEEN 0 AND 40),
      offense_priority  SMALLINT CHECK (offense_priority BETWEEN 1 AND 3),
      PRIMARY KEY (team_id, player_id)
    );

    -- 선발은 정확히 5명, 후보는 정확히 7명이어야 함 (애플리케이션 레벨에서 검증,
    -- DB 레벨 강제는 CHECK 제약으로 표현하기 어려워 API 검증으로 처리)
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS player_roster_settings;
    DROP TABLE IF EXISTS team_tactics;
  `);
};
