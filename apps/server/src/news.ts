/**
 * KBL Manager — 리그 뉴스
 *
 * 하루를 진행할 때마다 그날의 주요 소식을 news 테이블에 쌓는다.
 *  - 경기: 우리 팀 경기 결과, 30점·20리바·트리플더블 같은 대기록, 연승·연패
 *  - 부상(경기 중·훈련 중)과 복귀, 우리 팀 선수 성장
 *  - 트레이드(성사·우리 팀에 온 제안), 플레이오프·우승 같은 시즌 이벤트
 * 화면: 상단 [뉴스] 메뉴에서 날짜별로, 달력에서 [다음]을 누르면 그날 소식을 바로 보여준다.
 */
import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;

export type NewsCategory = "game" | "record" | "streak" | "injury" | "return" | "growth" | "trade" | "trade_offer" | "season";

export interface NewsItem {
  date: string;
  category: NewsCategory;
  headline: string;
  body?: string | null;
  teamId?: number | null;
  team2Id?: number | null;
  playerId?: number | null;
  gameId?: number | null;
  importance?: number; // 1 일반 · 2 주요 · 3 톱뉴스
}

export async function ensureNewsSchema(db: Db) {
  await db.query(`
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
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS news_date_idx ON news (news_date)`);
}

export async function addNews(db: Db, items: NewsItem[]) {
  for (const n of items) {
    await db.query(
      `INSERT INTO news (news_date, category, headline, body, team_id, team2_id, player_id, game_id, importance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [n.date, n.category, n.headline, n.body ?? null, n.teamId ?? null, n.team2Id ?? null, n.playerId ?? null, n.gameId ?? null, n.importance ?? 1]
    );
  }
}

/** "창원 LG 세이커스" → "LG" */
export function shortTeam(name: string): string {
  const parts = name.split(" ");
  return parts.length >= 2 ? parts[1] : name;
}

export interface BoxLine { playerId: number; name: string; teamId: number; min: number; pts: number; reb: number; ast: number; stl: number; blk: number }

/** 경기 하나가 끝났을 때 나오는 뉴스: 우리 팀 결과, 대기록, 연승·연패 */
export async function gameNews(
  db: Db,
  g: { id: number; date: string; homeId: number; awayId: number; homeName: string; awayName: string; homeScore: number; awayScore: number; ot: boolean; playoff: boolean },
  lines: BoxLine[],
  userTeamId: number | null
) {
  const items: NewsItem[] = [];
  const homeWon = g.homeScore > g.awayScore;
  const [wId, lId] = homeWon ? [g.homeId, g.awayId] : [g.awayId, g.homeId];
  const [wName, lName] = homeWon ? [g.homeName, g.awayName] : [g.awayName, g.homeName];
  const [wPts, lPts] = homeWon ? [g.homeScore, g.awayScore] : [g.awayScore, g.homeScore];
  const top = (teamId: number) => [...lines].filter((l) => l.teamId === teamId).sort((a, b) => b.pts - a.pts)[0];
  const ot = g.ot ? " (연장)" : "";
  const kind = g.playoff ? "플레이오프 " : "";

  if (userTeamId !== null && (g.homeId === userTeamId || g.awayId === userTeamId)) {
    const won = wId === userTeamId;
    const mine = top(userTeamId);
    const opp = won ? lName : wName;
    items.push({
      date: g.date, category: "game", teamId: userTeamId, team2Id: won ? lId : wId, gameId: g.id, importance: 3,
      headline: won
        ? `${shortTeam(won ? wName : lName)}, ${shortTeam(opp)} 꺾고 ${kind}승리 ${wPts}-${lPts}${ot}`
        : `${shortTeam(lName)}, ${shortTeam(opp)}에 ${kind}패배 ${lPts}-${wPts}${ot}`,
      body: mine ? `${mine.name} ${mine.pts}점 ${mine.reb}리바운드 ${mine.ast}어시스트로 팀 내 최다 득점` : null,
    });
  } else if (wPts - lPts >= 25 || g.ot) {
    items.push({
      date: g.date, category: "game", teamId: wId, team2Id: lId, gameId: g.id, importance: 1,
      headline: g.ot ? `${shortTeam(wName)}, 연장 접전 끝에 ${shortTeam(lName)} 제압 ${wPts}-${lPts}` : `${shortTeam(wName)}, ${shortTeam(lName)}에 ${wPts - lPts}점 차 대승`,
      body: top(wId) ? `${top(wId)!.name} ${top(wId)!.pts}점` : null,
    });
  }

  // 대기록
  for (const l of lines) {
    const team = shortTeam(l.teamId === g.homeId ? g.homeName : g.awayName);
    const doubles = [l.pts, l.reb, l.ast, l.stl, l.blk].filter((x) => x >= 10).length;
    const mine = l.teamId === userTeamId;
    if (doubles >= 3) {
      items.push({ date: g.date, category: "record", teamId: l.teamId, playerId: l.playerId, gameId: g.id, importance: 3,
        headline: `${team} ${l.name}, 트리플더블! ${l.pts}점 ${l.reb}리바운드 ${l.ast}어시스트` });
    } else if (l.pts >= 30) {
      items.push({ date: g.date, category: "record", teamId: l.teamId, playerId: l.playerId, gameId: g.id, importance: l.pts >= 38 || mine ? 3 : 2,
        headline: `${team} ${l.name}, ${l.pts}점 폭발${l.reb >= 10 ? ` (${l.reb}리바운드)` : ""}` });
    } else if (l.reb >= 18) {
      items.push({ date: g.date, category: "record", teamId: l.teamId, playerId: l.playerId, gameId: g.id, importance: 2,
        headline: `${team} ${l.name}, 리바운드 ${l.reb}개로 골밑 장악` });
    } else if (l.ast >= 13) {
      items.push({ date: g.date, category: "record", teamId: l.teamId, playerId: l.playerId, gameId: g.id, importance: 2,
        headline: `${team} ${l.name}, 어시스트 ${l.ast}개로 공격 지휘` });
    }
  }

  // 연승·연패 (5·7·10연승 등 고비마다)
  if (!g.playoff) {
    for (const [teamId, name] of [[g.homeId, g.homeName], [g.awayId, g.awayName]] as const) {
      const streak = await currentStreak(db, teamId, g.date);
      const n = Math.abs(streak);
      if (n >= 5 && (n === 5 || n === 7 || n >= 10)) {
        items.push({
          date: g.date, category: "streak", teamId, importance: teamId === userTeamId || n >= 7 ? 2 : 1,
          headline: streak > 0 ? `${shortTeam(name)}, 파죽의 ${n}연승` : `${shortTeam(name)}, ${n}연패 수렁`,
        });
      }
    }
  }
  await addNews(db, items);
}

/** 양수 = 연승, 음수 = 연패 (해당 날짜까지 정규시즌 경기 기준) */
async function currentStreak(db: Db, teamId: number, upTo: string): Promise<number> {
  const r = await db.query(
    `SELECT home_team_id, home_score, away_score FROM games
     WHERE (home_team_id=$1 OR away_team_id=$1) AND home_score IS NOT NULL AND series_id IS NULL AND game_date <= $2
     ORDER BY game_date DESC, id DESC LIMIT 15`,
    [teamId, upTo]
  );
  let streak = 0;
  for (const row of r.rows) {
    const won = row.home_team_id === teamId ? row.home_score > row.away_score : row.away_score > row.home_score;
    if (streak === 0) streak = won ? 1 : -1;
    else if ((streak > 0) === won) streak += won ? 1 : -1;
    else break;
  }
  return streak;
}

/** 부상 뉴스 (우리 팀은 전부, 다른 팀은 7일 이상만) */
export function injuryNews(
  date: string, injuries: { playerId?: number; name: string; teamId: number | null; days: number; during: "game" | "training" }[],
  teamNames: Map<number, string>, userTeamId: number
): NewsItem[] {
  return injuries
    .filter((i) => i.teamId !== null && (i.teamId === userTeamId || i.days >= 7))
    .map((i) => ({
      date, category: "injury" as const, teamId: i.teamId, playerId: i.playerId ?? null,
      importance: i.teamId === userTeamId ? 2 : i.days >= 14 ? 2 : 1,
      headline: `${shortTeam(teamNames.get(i.teamId!) ?? "")} ${i.name}, ${i.during === "game" ? "경기 중" : "훈련 중"} 부상 — 약 ${i.days}일 결장 예상`,
    }));
}

/** 날짜별 뉴스 + 그날 경기 결과 */
export async function newsForDate(db: Db, date: string, userTeamId: number) {
  const news = await db.query(
    `SELECT id, news_date::text AS date, category, headline, body, team_id AS "teamId", team2_id AS "team2Id",
            player_id AS "playerId", game_id AS "gameId", importance,
            (team_id = $2 OR team2_id = $2) AS mine
     FROM news WHERE news_date = $1 ORDER BY (team_id = $2 OR team2_id = $2) DESC NULLS LAST, importance DESC, id`,
    [date, userTeamId]
  );
  const games = await db.query(
    `SELECT g.id, g.home_team_id AS "homeId", g.away_team_id AS "awayId", ht.name AS home, at.name AS away,
            g.home_score AS "homeScore", g.away_score AS "awayScore", g.went_to_ot AS ot,
            CASE ps.round WHEN 'round1' THEN '6강 PO' WHEN 'round2' THEN '4강 PO' WHEN 'final' THEN '챔피언결정전' END AS "playoffLabel"
     FROM games g JOIN teams ht ON ht.id=g.home_team_id JOIN teams at ON at.id=g.away_team_id
     LEFT JOIN playoff_series ps ON ps.id = g.series_id
     WHERE g.game_date = $1 ORDER BY (g.home_team_id=$2 OR g.away_team_id=$2) DESC, g.id`,
    [date, userTeamId]
  );
  return { date, news: news.rows, games: games.rows };
}

/** 뉴스가 있는 날짜 목록 (최근순) */
export async function newsDates(db: Db, userTeamId: number) {
  const r = await db.query(
    `SELECT news_date::text AS date, COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE team_id=$1 OR team2_id=$1)::int AS mine,
            MAX(importance)::int AS top
     FROM news GROUP BY news_date ORDER BY news_date DESC LIMIT 400`,
    [userTeamId]
  );
  return r.rows;
}
