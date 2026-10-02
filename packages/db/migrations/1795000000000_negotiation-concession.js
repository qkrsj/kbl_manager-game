/**
 * KBL Manager — 연봉협상: 선수의 합의 가능선(비공개), 제시 기록, 분위기, 보수 조정 판결
 * (API 서버도 시작할 때 같은 컬럼을 IF NOT EXISTS로 추가하므로, 이 마이그레이션을 안 돌린 DB도 동작함)
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS min_amount INTEGER;
    ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS history JSONB;
    ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS mood TEXT;
    ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS ruling JSONB;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE negotiations DROP COLUMN IF EXISTS min_amount, DROP COLUMN IF EXISTS history, DROP COLUMN IF EXISTS mood, DROP COLUMN IF EXISTS ruling;`);
};
