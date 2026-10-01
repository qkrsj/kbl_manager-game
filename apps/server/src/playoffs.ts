/**
 * KBL Manager — 플레이오프 (날짜 기반)
 * 정규시즌 1~6위 진출. 6강전(3v6, 4v5, 5전3선) -> 4강전(1v4·5승자, 2v3·6승자, 5전3선) -> 챔피언결정전(7전4선)
 * 6강/4강 2-2-1, 챔프전 2-3-2 홈 배정 (상위 시드가 먼저 홈).
 *
 * v1: 시리즈 경기를 미리 날짜에 배정해 games 테이블에 "예정 경기"로 넣어 두고,
 *     정규시즌과 똑같이 하루씩 진행한다 (유저 팀 경기는 직접 지휘 가능).
 *     시리즈가 일찍 끝나면 남은 예정 경기는 삭제한다.
 */
import { Pool, PoolClient } from "pg";
import { addDays } from "../../../packages/simulation-engine/seasonScheduler";

type Db = Pool | PoolClient;

const BO5_PATTERN = [
  { offset: 0, higherHome: true },
  { offset: 2, higherHome: true },
  { offset: 5, higherHome: false },
  { offset: 7, higherHome: false },
  { offset: 10, higherHome: true },
];
const BO7_PATTERN = [
  { offset: 0, higherHome: true },
  { offset: 2, higherHome: true },
  { offset: 5, higherHome: false },
  { offset: 7, higherHome: false },
  { offset: 9, higherHome: false },
  { offset: 12, higherHome: true },
  { offset: 14, higherHome: true },
];

export const ROUND_LABEL: Record<string, string> = { round1: "6강 플레이오프", round2: "4강 플레이오프", final: "챔피언결정전" };

function winsNeeded(bestOf: number): number {
  return bestOf === 7 ? 4 : 3;
}

/** 정규시즌 최종 순위 (승 → 득실차 순) */
export async function regularSeasonRanking(db: Db, seasonId: number): Promise<number[]> {
  const r = await db.query(
    `SELECT team_id FROM standings WHERE season_id=$1
     ORDER BY wins DESC, (points_for - points_against) DESC, points_for DESC`,
    [seasonId]
  );
  return r.rows.map((x) => x.team_id);
}

async function createSeries(db: Db, seasonId: number, round: string, slot: string, bestOf: number, higher: number, lower: number, startDate: string) {
  const s = await db.query(
    `INSERT INTO playoff_series (season_id, round, slot, best_of, higher_seed_team_id, lower_seed_team_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [seasonId, round, slot, bestOf, higher, lower]
  );
  const seriesId = s.rows[0].id;
  const pattern = bestOf === 7 ? BO7_PATTERN : BO5_PATTERN;
  for (let i = 0; i < pattern.length; i++) {
    const step = pattern[i];
    const date = addDays(startDate, step.offset);
    await db.query(
      `INSERT INTO games (season_id, round, day_offset, game_date, home_team_id, away_team_id, home_score, away_score,
                          went_to_ot, ot_periods, series_id, game_number_in_series)
       VALUES ($1,0,0,$2,$3,$4,NULL,NULL,FALSE,0,$5,$6)`,
      [seasonId, date, step.higherHome ? higher : lower, step.higherHome ? lower : higher, seriesId, i + 1]
    );
  }
}

export async function createFirstRound(db: Db, seasonId: number, startDate: string): Promise<void> {
  const seeds = await regularSeasonRanking(db, seasonId);
  if (seeds.length < 6) throw new Error("순위표에 6팀 미만 — 정규시즌이 아직 안 끝났습니다");
  await createSeries(db, seasonId, "round1", "A", 5, seeds[2], seeds[5], startDate);
  await createSeries(db, seasonId, "round1", "B", 5, seeds[3], seeds[4], startDate);
}

/**
 * 오늘 끝난 플레이오프 경기들을 시리즈 전적에 반영하고, 끝난 시리즈의 남은 예정 경기를 지우고,
 * 다음 라운드를 생성한다. 챔피언이 결정되면 우승팀 id 반환.
 */
export async function updatePlayoffs(db: Db, seasonId: number, today: string): Promise<{ champion: number | null; events: string[] }> {
  const events: string[] = [];
  const series = await db.query(`SELECT * FROM playoff_series WHERE season_id=$1 AND winner_team_id IS NULL`, [seasonId]);
  for (const s of series.rows) {
    const g = await db.query(
      `SELECT home_team_id, home_score, away_score FROM games WHERE series_id=$1 AND home_score IS NOT NULL`,
      [s.id]
    );
    let hw = 0;
    let lw = 0;
    for (const row of g.rows) {
      const homeWon = row.home_score > row.away_score;
      const higherWon = (row.home_team_id === s.higher_seed_team_id) === homeWon;
      if (higherWon) hw++; else lw++;
    }
    const need = winsNeeded(s.best_of);
    const winner = hw >= need ? s.higher_seed_team_id : lw >= need ? s.lower_seed_team_id : null;
    await db.query(
      `UPDATE playoff_series SET higher_seed_wins=$1, lower_seed_wins=$2, games_played=$3, winner_team_id=$4 WHERE id=$5`,
      [hw, lw, hw + lw, winner, s.id]
    );
    if (winner) {
      await db.query(`DELETE FROM games WHERE series_id=$1 AND home_score IS NULL`, [s.id]);
      const name = await db.query(`SELECT name FROM teams WHERE id=$1`, [winner]);
      events.push(`${ROUND_LABEL[s.round]} 종료: ${name.rows[0].name} 진출 (${Math.max(hw, lw)}승 ${Math.min(hw, lw)}패)`);
    }
  }

  const all = await db.query(`SELECT round, slot, winner_team_id, higher_seed_team_id FROM playoff_series WHERE season_id=$1`, [seasonId]);
  const byRound = (r: string) => all.rows.filter((x) => x.round === r);
  const done = (r: string) => byRound(r).length > 0 && byRound(r).every((x) => x.winner_team_id !== null);
  const nextStart = async () => {
    const last = await db.query(`SELECT MAX(game_date) AS d FROM games WHERE season_id=$1 AND series_id IS NOT NULL`, [seasonId]);
    const lastDate: string = last.rows[0].d ?? today;
    return addDays(lastDate > today ? lastDate : today, 3);
  };

  if (done("round1") && byRound("round2").length === 0) {
    const seeds = await regularSeasonRanking(db, seasonId);
    const winA = byRound("round1").find((x) => x.slot === "A")!.winner_team_id;
    const winB = byRound("round1").find((x) => x.slot === "B")!.winner_team_id;
    const start = await nextStart();
    await createSeries(db, seasonId, "round2", "C", 5, seeds[1], winA, start);
    await createSeries(db, seasonId, "round2", "D", 5, seeds[0], winB, start);
    events.push("4강 플레이오프 대진 확정");
  }
  if (done("round2") && byRound("final").length === 0) {
    const seeds = await regularSeasonRanking(db, seasonId);
    const rank = new Map(seeds.map((t, i) => [t, i]));
    const [c, d] = [byRound("round2").find((x) => x.slot === "C")!.winner_team_id, byRound("round2").find((x) => x.slot === "D")!.winner_team_id];
    const higher = (rank.get(c) ?? 99) < (rank.get(d) ?? 99) ? c : d;
    const lower = higher === c ? d : c;
    await createSeries(db, seasonId, "final", "F", 7, higher, lower, await nextStart());
    events.push("챔피언결정전 대진 확정");
  }
  const final = byRound("final")[0];
  const finalNow = final ? await db.query(`SELECT winner_team_id FROM playoff_series WHERE season_id=$1 AND round='final'`, [seasonId]) : null;
  return { champion: finalNow?.rows[0]?.winner_team_id ?? null, events };
}

export async function playoffBracket(db: Db, seasonId: number) {
  const result = await db.query(
    `SELECT s.id, s.round, s.slot, s.best_of, s.higher_seed_wins, s.lower_seed_wins,
            ht.name AS higher_seed_team, lt.name AS lower_seed_team, wt.name AS winner_team
     FROM playoff_series s
     JOIN teams ht ON ht.id = s.higher_seed_team_id
     JOIN teams lt ON lt.id = s.lower_seed_team_id
     LEFT JOIN teams wt ON wt.id = s.winner_team_id
     WHERE s.season_id = $1
     ORDER BY CASE s.round WHEN 'round1' THEN 1 WHEN 'round2' THEN 2 ELSE 3 END, s.slot`,
    [seasonId]
  );
  return result.rows;
}
