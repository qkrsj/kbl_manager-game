/**
 * KBL Manager — 리그 뉴스, 다른 팀이 보낸 트레이드 제안
 * (API 서버도 시작할 때 같은 테이블을 IF NOT EXISTS로 만들므로, 이 마이그레이션을 안 돌린 DB도 동작함)
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      news_date DATE NOT NULL,
      category TEXT NOT NULL,
      headline TEXT NOT NULL,
      body TEXT,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      team2_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
      importance SMALLINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS news_date_idx ON news (news_date);
    CREATE TABLE IF NOT EXISTS trade_offers (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      offer_date DATE NOT NULL,
      expires_date DATE NOT NULL,
      ai_gives INTEGER[] NOT NULL,
      ai_wants INTEGER[] NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      resolved_date DATE
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS trade_offers; DROP TABLE IF EXISTS news;`);
};
