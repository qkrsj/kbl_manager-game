/**
 * KBL Manager — 감독(사용자) 프로필
 * 새 게임에서 만든 프로필(이름·나이·플레이 스타일·성격·운영 방향)을 세이브에 저장한다.
 * (API 서버도 시작할 때 같은 컬럼을 IF NOT EXISTS로 추가하므로, 이 마이그레이션을 안 돌린 DB도 동작함)
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE franchise ADD COLUMN IF NOT EXISTS manager_profile JSONB;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE franchise DROP COLUMN IF EXISTS manager_profile;`);
};
