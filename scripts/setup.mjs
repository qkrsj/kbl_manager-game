/**
 * KBL Manager — 최초 설치 스크립트 (Windows / macOS / Linux 공통)
 *
 *   npm run setup
 *
 * 1) 서버·웹·DB 패키지 설치 (npm install)
 * 2) PostgreSQL에 게임 전용 계정(kbl_app)과 DB(kbl_manager) 생성
 *    — PostgreSQL 설치 때 정한 "postgres" 계정 비밀번호를 한 번 물어봅니다
 * 3) DB 테이블 생성 (마이그레이션)
 * 4) 2026-27 시즌 새 게임 데이터 생성
 *
 * 환경변수로 바꿀 수 있는 값: PGHOST(기본 localhost), PGPORT(5432),
 * PGADMIN_USER(postgres), PGADMIN_PASSWORD(입력 생략용)
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.PGHOST ?? "localhost";
const PORT = Number(process.env.PGPORT ?? 5432);
const APP_USER = "kbl_app";
const APP_PASSWORD = "devpassword";
const APP_DB = "kbl_manager";

function step(n, msg) {
  console.log(`\n[${n}/4] ${msg}`);
}

function run(cmd, cwd, env = {}) {
  const r = spawnSync(cmd, { cwd: path.join(root, cwd), stdio: "inherit", shell: true, env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`\n❌ 실패: ${cmd} (${cwd})`);
    process.exit(1);
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`❌ Node.js 20 이상이 필요합니다 (현재 ${process.versions.node}). https://nodejs.org 에서 LTS 버전을 설치하세요.`);
  process.exit(1);
}

step(1, "패키지 설치 중... (처음엔 몇 분 걸릴 수 있습니다)");
run("npm install", "packages/db");
run("npm install", "apps/server");
run("npm install", "apps/web");

step(2, "PostgreSQL에 게임용 계정과 DB 만들기");
const require = createRequire(path.join(root, "packages/db/package.json"));
const { Client } = require("pg");
const adminUser = process.env.PGADMIN_USER ?? "postgres";
const adminPassword = process.env.PGADMIN_PASSWORD ?? (await ask(`PostgreSQL 설치 때 정한 '${adminUser}' 계정 비밀번호를 입력하세요: `));
const admin = new Client({ host: HOST, port: PORT, user: adminUser, password: adminPassword, database: "postgres" });
try {
  await admin.connect();
} catch (e) {
  console.error(`\n❌ PostgreSQL 접속 실패: ${e.message}`);
  console.error("   - PostgreSQL이 설치·실행 중인지 확인하세요 (Windows: 서비스 'postgresql-x64-16' 실행 중)");
  console.error("   - 비밀번호가 맞는지 확인하세요");
  process.exit(1);
}
const role = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [APP_USER]);
if (role.rows.length === 0) {
  await admin.query(`CREATE ROLE ${APP_USER} WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
  console.log(`  계정 ${APP_USER} 생성`);
} else {
  console.log(`  계정 ${APP_USER} 이미 있음`);
}
const db = await admin.query(`SELECT 1 FROM pg_database WHERE datname=$1`, [APP_DB]);
if (db.rows.length === 0) {
  await admin.query(`CREATE DATABASE ${APP_DB} OWNER ${APP_USER}`);
  console.log(`  DB ${APP_DB} 생성`);
} else {
  console.log(`  DB ${APP_DB} 이미 있음`);
}
await admin.end();

step(3, "DB 테이블 생성 (마이그레이션)");
run("npm run migrate:up", "packages/db", {
  DATABASE_URL: `postgres://${APP_USER}:${APP_PASSWORD}@${HOST}:${PORT}/${APP_DB}`,
});

step(4, "2026-27 시즌 새 게임 데이터 생성");
run("npm run seed", "apps/server");

console.log("\n✅ 설치 완료! 이제 아래 명령으로 게임을 실행하세요:\n\n   npm start\n\n그다음 브라우저에서 http://localhost:5173 을 여세요.");
