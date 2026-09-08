/**
 * KBL Manager — 선수 개인 페이지용 드래프트 정보 컬럼 추가
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE players ADD COLUMN draft_year INTEGER;
    ALTER TABLE players ADD COLUMN draft_overall_pick INTEGER;
    ALTER TABLE players ADD COLUMN draft_category TEXT; -- 'picked' | 'regional_signee' | 'foreign_or_naturalized' | 'undrafted'
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE players DROP COLUMN IF EXISTS draft_category;
    ALTER TABLE players DROP COLUMN IF EXISTS draft_overall_pick;
    ALTER TABLE players DROP COLUMN IF EXISTS draft_year;
  `);
};
