/**
 * KBL Manager — 헤드리스 검증 스크립트
 * API와 같은 함수들로 시즌 1개(정규시즌 → 플레이오프 → 비시즌 → 다음 시즌 시작)를 자동 진행하고
 * 득점 분포·개인기록·성장·계약 결과를 출력한다.
 *
 *   npm run simulate              # 새 게임 시드 후 1시즌
 *   npm run simulate -- --live    # 우리 팀 경기를 LiveGame 세션(구간 진행)으로 치름
 */
import { pool } from "../src/db";
import { seedDatabase } from "../src/seed";
import { advanceDay, getFranchise, userGameToday, quickSimUserGame } from "../src/season";
import { startLiveGame, stepLiveGame } from "../src/liveGames";
import { advanceOffseason, startNewSeason, offseasonOverview, offerNegotiation, freeAgentList, makeFaOffer } from "../src/offseason";

const useLive = process.argv.includes("--live");

async function main() {
  const t0 = Date.now();
  await seedDatabase(pool, 1, console.log);

  let days = 0;
  for (;;) {
    const f = await getFranchise(pool);
    if (f.phase === "offseason") break;
    const g = await userGameToday(pool, f);
    if (g) {
      const s = await pool.query(`SELECT home_score FROM games WHERE id=$1`, [g.id]);
      if (s.rows[0].home_score === null) {
        if (useLive) {
          const st = await startLiveGame(pool, g.id);
          await stepLiveGame(pool, st.sessionId, { mode: "quarter", tactics: { defenseScheme: "zone" } });
          await stepLiveGame(pool, st.sessionId, { mode: "end" });
        } else {
          await quickSimUserGame(pool, g.id);
        }
      }
    }
    const plan = days % 3 === 2 ? { mode: "rest" as const, focus: "balanced" as const, intensity: "light" as const } : { mode: "train" as const, focus: "shooting" as const, intensity: "normal" as const };
    const r = await advanceDay(pool, plan);
    days++;
    r.events.forEach((e) => console.log(`[${r.date}] ${e}`));
    if (days > 400) throw new Error("시즌이 끝나지 않음");
  }
  console.log(`\n정규시즌+플레이오프 ${days}일 진행 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const avg = await pool.query(`SELECT ROUND(AVG(home_score)::numeric,1) h, ROUND(AVG(away_score)::numeric,1) a, SUM(CASE WHEN went_to_ot THEN 1 ELSE 0 END) ot, COUNT(*) n FROM games`);
  console.log("평균 득점", avg.rows[0]);
  const team = await pool.query(
    `SELECT ROUND(SUM(fgm)::numeric/NULLIF(SUM(fga),0)*100,1) fg, ROUND(SUM(tpm)::numeric/NULLIF(SUM(tpa),0)*100,1) tp,
            ROUND(SUM(ftm)::numeric/NULLIF(SUM(fta),0)*100,1) ft, ROUND(SUM(tpa)::numeric/COUNT(DISTINCT game_id)/2,1) tpa_per_team,
            ROUND(SUM(reb)::numeric/COUNT(DISTINCT game_id)/2,1) reb, ROUND(SUM(ast)::numeric/COUNT(DISTINCT game_id)/2,1) ast,
            ROUND(SUM(tov)::numeric/COUNT(DISTINCT game_id)/2,1) tov, ROUND(SUM(stl)::numeric/COUNT(DISTINCT game_id)/2,1) stl,
            ROUND(SUM(min)::numeric/COUNT(DISTINCT game_id)/2,1) min_per_team
     FROM player_game_stats`
  );
  console.log("팀 경기당", team.rows[0]);
  const lead = await pool.query(
    `SELECT p.name, COUNT(*) g, ROUND(AVG(s.pts)::numeric,1) pts, ROUND(AVG(s.reb)::numeric,1) reb, ROUND(AVG(s.ast)::numeric,1) ast, ROUND(AVG(s.min)::numeric,1) min
     FROM player_game_stats s JOIN players p ON p.id=s.player_id WHERE s.min>0 GROUP BY p.name ORDER BY AVG(s.pts) DESC LIMIT 10`
  );
  console.table(lead.rows);
  const foreignMin = await pool.query(
    `SELECT ROUND(AVG(m)::numeric,1) avg_foreign_minutes_per_team_game FROM (
       SELECT s.game_id, s.team_id, SUM(s.min) m FROM player_game_stats s JOIN contracts c ON c.player_id=s.player_id
       WHERE c.contract_type='foreign' GROUP BY s.game_id, s.team_id) x`
  );
  console.log("팀당 외국선수 출전시간(분, 규정상 최대 60)", foreignMin.rows[0]);
  const dev = await pool.query(`SELECT reason, COUNT(*) n, SUM(delta) s FROM development_log GROUP BY reason`);
  console.table(dev.rows);

  // ---- 비시즌 ----
  const ov = await offseasonOverview(pool);
  console.log(`\n비시즌 단계: ${ov.stage}, 협상 ${ov.negotiations.length}건`);
  for (const n of ov.negotiations.slice(0, 4)) {
    const res = await offerNegotiation(pool, n.id, Number(n.asking_amount), n.asking_years);
    console.log(`  협상 ${n.name}(${n.kind}): ${res.status} — ${res.message}`);
  }
  console.log((await advanceOffseason(pool)).events.slice(0, 8));
  const fas = await freeAgentList(pool);
  console.log(`FA 시장 ${fas.length}명. 상위:`, fas.slice(0, 5).map((x) => `${x.name}(${x.overall}, 요구 ${x.askingAmount})`).join(", "));
  const target = fas.find((x) => x.contractType === "domestic");
  if (target) {
    try {
      await makeFaOffer(pool, target.id, Math.round(target.askingAmount * 1.05), target.desiredYears);
      console.log(`  ${target.name}에게 제안`);
    } catch (e) {
      console.log(`  제안 실패: ${(e as Error).message}`);
    }
  }
  // 우리 팀 외국선수 공백 메우기: 외국선수 시장에서 가장 좋은 후보 2명에게 제안
  const foreigners = fas.filter((x) => x.contractType === "foreign").slice(0, 4);
  let budget = 1000000;
  for (const fx of foreigners) {
    const amt = Math.min(fx.askingAmount, budget - 250000);
    try { await makeFaOffer(pool, fx.id, amt, 1); budget -= amt; console.log(`  외국선수 ${fx.name}에게 $${amt} 제안`); } catch (e) { console.log(`  제안 실패: ${(e as Error).message}`); }
  }
  for (let d = 0; d < 10; d++) {
    const r = await advanceOffseason(pool);
    r.events.slice(0, 10).forEach((e) => console.log("  ", e));
    if (r.stage === "ready") break;
  }
  const ns = await startNewSeason(pool).catch((e) => ({ error: (e as Error).message }));
  console.log("새 시즌:", ns);
  const f2 = await getFranchise(pool);
  console.log(`현재: ${f2.seasonLabel} ${f2.date} ${f2.phase}`);
  const caps = await pool.query(
    `SELECT t.name, SUM(c.salary_krw) FILTER (WHERE c.contract_type='domestic') krw, COUNT(*) FILTER (WHERE c.contract_type='domestic') dom,
            COUNT(*) FILTER (WHERE c.contract_type='foreign') fr, COUNT(*) FILTER (WHERE c.contract_type='asia') asia
     FROM players p JOIN contracts c ON c.player_id=p.id JOIN teams t ON t.id=p.team_id WHERE NOT p.is_retired GROUP BY t.name`
  );
  console.table(caps.rows);
  console.log(`총 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
