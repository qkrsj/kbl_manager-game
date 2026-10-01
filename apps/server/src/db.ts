import { Pool, types } from "pg";

// DATE 컬럼을 JS Date(로컬 타임존 변환)가 아니라 'YYYY-MM-DD' 문자열 그대로 받는다.
// 게임 내 날짜 계산이 서버 타임존에 따라 하루씩 밀리는 문제 방지.
types.setTypeParser(1082, (v: string) => v);

export const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "kbl_app",
  password: process.env.PGPASSWORD ?? "devpassword",
  database: process.env.PGDATABASE ?? "kbl_manager",
});
