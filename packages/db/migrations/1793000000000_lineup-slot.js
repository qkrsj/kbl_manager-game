/**
 * KBL Manager — 선발 라인업 포지션 칸 (1=PG, 2=SG, 3=SF, 4=PF, 5=C)
 * (API 서버도 시작할 때 같은 컬럼을 IF NOT EXISTS로 추가하므로, 이 마이그레이션을 안 돌린 DB도 동작함)
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE player_roster_settings ADD COLUMN IF NOT EXISTS lineup_slot SMALLINT;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE player_roster_settings DROP COLUMN IF EXISTS lineup_slot;`);
};
