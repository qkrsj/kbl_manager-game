/**
 * KBL Manager — 게임 실행 (API 서버 + 웹 화면을 동시에 켬)
 *
 *   npm start      →  브라우저에서 http://localhost:5173
 *
 * 끌 때는 이 터미널에서 Ctrl + C
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const procs = [];

function launch(name, cwd, cmd) {
  const p = spawn(cmd, { cwd: path.join(root, cwd), shell: true, env: process.env });
  const prefix = (chunk) => chunk.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", prefix);
  p.stderr.on("data", prefix);
  p.on("exit", (code) => {
    console.log(`[${name}] 종료됨 (code ${code})`);
    shutdown();
  });
  procs.push(p);
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  procs.forEach((p) => { try { p.kill(); } catch { /* 이미 종료 */ } });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

launch("서버", "apps/server", "npm start");
launch("웹", "apps/web", "npm run dev -- --port 5173");
console.log("\nKBL Manager 실행 중... 잠시 후 브라우저에서 http://localhost:5173 을 여세요. (종료: Ctrl + C)\n");
