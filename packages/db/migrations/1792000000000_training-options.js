/**
 * KBL Manager — 선수별 훈련 강도·휴식, 공격 1·2·3옵션
 * (API 서버도 시작할 때 같은 컬럼을 IF NOT EXISTS로 추가하므로, 이 마이그레이션을 안 돌린 DB도 동작함)
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE player_training_focus ALTER COLUMN focus DROP NOT NULL;
    ALTER TABLE player_training_focus ADD COLUMN IF NOT EXISTS intensity TEXT;
    ALTER TABLE player_training_focus ADD COLUMN IF NOT EXISTS mode TEXT;
    ALTER TABLE team_tactics ADD COLUMN IF NOT EXISTS option1_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL;
    ALTER TABLE team_tactics ADD COLUMN IF NOT EXISTS option2_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL;
    ALTER TABLE team_tactics ADD COLUMN IF NOT EXISTS option3_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE team_tactics DROP COLUMN IF EXISTS option1_player_id, DROP COLUMN IF EXISTS option2_player_id, DROP COLUMN IF EXISTS option3_player_id;
    ALTER TABLE player_training_focus DROP COLUMN IF EXISTS intensity, DROP COLUMN IF EXISTS mode;
  `);
};
