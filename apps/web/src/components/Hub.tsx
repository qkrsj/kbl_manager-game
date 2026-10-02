import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useApi, Loading, ErrorBox, Card, Rating, PlayerLink, useApp, Bar } from "./common";
import type { View } from "./common";
import { StandingsTable, LeadersFull, PlayoffBracket } from "./League";
import { api, krw, usd, formatDate, PHASE_LABEL, PACE_LABEL, THREE_LABEL, DEFENSE_LABEL, CONTRACT_TYPE_LABEL } from "../api";
import type { Franchise, Standing, LeaderBoard, RosterPlayer, Payroll, Coach } from "../api";
import { teamStyle } from "../teamColors";
import { ManagerCard, useManagerOptions } from "./NewGame";
import type { ManagerProfileInput } from "./NewGame";
import { LatestHeadlines } from "./News";
import "./newgame.css";
import "./hub.css";

// ============================================================
// 섹션 구성 (상단 메뉴)
// ============================================================

export type SectionKey = "home" | "myteam" | "teams" | "trade" | "league" | "news" | "training" | "schedule" | "office" | "offseason";

export const SECTIONS: { key: SectionKey; label: string; icon: string; view: View }[] = [
  { key: "home", label: "홈", icon: "🏠", view: { name: "dashboard" } },
  { key: "myteam", label: "내 팀", icon: "👥", view: { name: "myteam" } },
  { key: "teams", label: "다른 팀", icon: "🏀", view: { name: "teams" } },
  { key: "trade", label: "트레이드", icon: "🔁", view: { name: "trade" } },
  { key: "league", label: "순위·기록", icon: "🏆", view: { name: "league" } },
  { key: "news", label: "뉴스", icon: "📰", view: { name: "news" } },
  { key: "training", label: "훈련", icon: "💪", view: { name: "training" } },
  { key: "schedule", label: "달력·일정", icon: "📅", view: { name: "today" } },
  { key: "office", label: "감독실", icon: "🎽", view: { name: "office" } },
  { key: "offseason", label: "비시즌", icon: "✍️", view: { name: "offseason" } },
];

export function sectionOf(v: View): SectionKey | null {
  switch (v.name) {
    case "dashboard": return "home";
    case "myteam": case "roster": case "tactics": case "cap": return "myteam";
    case "teams": case "team": return "teams";
    case "league": return "league";
    case "training": return "training";
    case "today": case "schedule": case "live": case "gameday": return "schedule";
    case "news": return "news";
    case "office": return "office";
    case "trade": return "trade";
    case "offseason": return "offseason";
    default: return null;
  }
}

/** 섹션 안 하위 탭 (내 팀 / 일정) */
export function SubTabs({ items, current }: { items: { label: string; view: View }[]; current: string }) {
  const { go } = useApp();
  return (
    <div className="subtabs">
      {items.map((it) => (
        <button key={it.label} className={current === it.view.name ? "on" : ""} onClick={() => go(it.view)}>{it.label}</button>
      ))}
    </div>
  );
}

export const MYTEAM_TABS: { label: string; view: View }[] = [
  { label: "개요", view: { name: "myteam" } },
  { label: "로스터·출전시간", view: { name: "roster" } },
  { label: "전술", view: { name: "tactics" } },
  { label: "연봉·샐러리캡", view: { name: "cap" } },
];
export const SCHEDULE_TABS: { label: string; view: View }[] = [
  { label: "달력·오늘", view: { name: "today" } },
  { label: "경기 준비", view: { name: "gameday" } },
  { label: "전체 일정·결과", view: { name: "schedule" } },
];

// ============================================================
// 공용 타입
// ============================================================

interface Dashboard {
  franchise: Franchise;
  myTeam: {
    id: number; name: string; coach: Coach; standing: Standing | undefined; payroll: Payroll; capLimit: number;
    topPlayers: RosterPlayer[]; injured: RosterPlayer[];
    nextGame: { id: number; game_date: string; home: string; away: string; home_team_id: number; series_id: number | null } | null;
    recent: { id: number; game_date: string; home: string; away: string; home_score: number; away_score: number; home_team_id: number }[];
  };
  todayGame: { id: number } | null;
  standings: Standing[];
  leaders: LeaderBoard[];
}

interface TeamOverview {
  id: number; name: string; coach: string; style: string; isUser: boolean; rank: number | null; wins: number; losses: number; streak: string;
  overall: number; offense: number; defense: number; stars: { id: number; name: string; overall: number; positionGroup: string }[];
}

interface TeamStatRow {
  team_id: number; team_name: string; g: number; pts: string | null; reb: string | null; oreb: string | null; ast: string | null;
  stl: string | null; blk: string | null; tov: string | null; tpm: string | null; fg_pct: string | null; tp_pct: string | null;
  ft_pct: string | null; opp_pts: string | null; opp_reb: string | null;
}

interface ManagerInfo {
  profile: ManagerProfileInput | null;
  coach: Coach;
  teamName: string;
  career: { season: string; games: number; wins: number; losses: number; poGames: number; poWins: number }[];
}

function Tile({ title, icon, onClick, className, children, action }: {
  title: string; icon?: string; onClick?: () => void; className?: string; children: ReactNode; action?: string;
}) {
  return (
    <div className={`tile ${onClick ? "clickable" : ""} ${className ?? ""}`} onClick={onClick} role={onClick ? "button" : undefined}>
      <div className="tile-head">
        <span className="tile-title">{icon && <span className="tile-icon">{icon}</span>}{title}</span>
        {onClick && <span className="tile-more">{action ?? "열기"} →</span>}
      </div>
      <div className="tile-body">{children}</div>
    </div>
  );
}

/** 엠블럼 글자 크기: 약칭이 길수록 작게 (원 안에 들어가도록) */
export function emblemFont(abbr: string, size: number): number {
  const len = Math.max(2, abbr.length);
  return Math.max(6, Math.min(size * 0.34, (size * 0.72) / (len * 0.62)));
}

function Emblem({ name, size = 40 }: { name: string; size?: number }) {
  const ts = teamStyle(name);
  return (
    <span className="emblem" style={{ width: size, height: size, background: ts.primary, fontSize: emblemFont(ts.abbr, size) }}>{ts.abbr}</span>
  );
}

// ============================================================
// 홈 (허브)
// ============================================================

export function HubHome() {
  const { go, next, advancing } = useApp();
  const { data, error } = useApi<Dashboard>("/api/dashboard");
  const { data: training } = useApi<{ plan: { mode: string; focus: string; intensity: string }; focuses: { key: string; label: string }[];
    recentChanges: { log_date: string; name: string; label: string; delta: number; reason: string }[] }>("/api/franchise/training");
  const { data: schedule } = useApi<{ id: number; game_date: string; home_team: string; away_team: string; home_team_id: number; home_score: number | null }[]>("/api/schedule?teamId=");
  const { data: teams } = useApi<TeamOverview[]>("/api/teams-overview");
  const { data: manager } = useApi<ManagerInfo>("/api/manager");
  const { data: news } = useApi<{ tx_date: string; kind: string; description: string; team_name: string | null }[]>("/api/transactions");
  const { data: allGames } = useApi<{ id: number; game_date: string; home_team: string; away_team: string; home_score: number | null; away_score: number | null; went_to_ot: boolean }[]>("/api/schedule?teamId=all");

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const { myTeam: t, franchise: f } = data;
  const ts = teamStyle(t.name);
  const capPct = Math.round(t.payroll.usageRatio * 1000) / 10;
  const upcoming = (schedule ?? []).filter((g) => g.home_score === null).slice(0, 4);
  const power = [...(teams ?? [])].sort((a, b) => b.overall - a.overall);
  const myPower = power.findIndex((x) => x.isUser) + 1;
  const careerW = (manager?.career ?? []).reduce((a, c) => a + c.wins, 0);
  const careerL = (manager?.career ?? []).reduce((a, c) => a + c.losses, 0);
  const lead = (stat: string) => data.leaders.find((b) => b.stat === stat)?.rows[0];
  const focusLabel = training ? training.focuses.find((x) => x.key === training.plan.focus)?.label ?? training.plan.focus : "";

  return (
    <div className="hub">
      <section className="hero" style={{ ["--team" as string]: ts.primary, ["--team2" as string]: ts.secondary }}>
        <div className="hero-main">
          <Emblem name={t.name} size={72} />
          <div>
            <div className="hero-kicker">{f.seasonLabel} {PHASE_LABEL[f.phase]} · {t.coach.name} 감독</div>
            <h1 className="hero-team">{t.name}</h1>
            <div className="hero-record">
              <b>{t.standing ? `${t.standing.wins}승 ${t.standing.losses}패` : "0승 0패"}</b>
              {t.standing && <span>리그 {t.standing.rank}위</span>}
              {t.standing?.streak && <span>{t.standing.streak}</span>}
              {myPower > 0 && <span>전력 {myPower}위</span>}
            </div>
          </div>
        </div>
        <div className="hero-next">
          {f.phase === "offseason" ? (
            <>
              <div className="hero-next-label">비시즌</div>
              <div className="hero-next-game">재계약 · FA · 신인 드래프트</div>
              <button className="hero-btn" onClick={() => go({ name: "offseason" })}>비시즌 진행 ▶</button>
            </>
          ) : t.nextGame ? (
            <>
              <div className="hero-next-label">{data.todayGame ? "오늘 경기" : "다음 경기"} · {formatDate(t.nextGame.game_date)}{t.nextGame.series_id ? " · 플레이오프" : ""}</div>
              <div className="hero-matchup">
                <Emblem name={t.nextGame.home} size={34} /><span>{teamStyle(t.nextGame.home).short}</span>
                <i>VS</i>
                <span>{teamStyle(t.nextGame.away).short}</span><Emblem name={t.nextGame.away} size={34} />
              </div>
              {data.todayGame
                ? <button className="hero-btn" onClick={() => go({ name: "gameday" })}>경기 준비 ▶</button>
                : <button className="hero-btn" disabled={advancing} onClick={next}>다음 ▶</button>}
            </>
          ) : <div className="hero-next-label">남은 경기가 없습니다</div>}
        </div>
      </section>

      <div className="bento">
        <Tile title="내 팀" icon="👥" className="span-2" onClick={() => go({ name: "myteam" })} action="팀 관리">
          <div className="mini-roster">
            {t.topPlayers.slice(0, 6).map((p) => (
              <div key={p.id} className="mini-player">
                <Rating value={p.overall} />
                <span className="mp-name">{p.name}</span>
                <span className="mp-meta">{p.positionGroup}{p.contractType !== "domestic" ? ` · ${CONTRACT_TYPE_LABEL[p.contractType]}` : ""}</span>
                <span className="mp-stat">{p.stats ? `${p.stats.pts}점 ${p.stats.reb}리 ${p.stats.ast}어` : `${p.position} · ${p.age}세`}</span>
                {p.injuredUntil && p.injuredUntil > f.date ? <span className="pill red">부상</span> : p.fatigue >= 60 ? <span className="pill gray">피로</span> : null}
              </div>
            ))}
          </div>
        </Tile>

        <Tile title="순위" icon="🏆" onClick={() => go({ name: "league" })} action="전체 순위">
          <table className="mini-table">
            <tbody>
              {data.standings.slice(0, 10).map((s) => (
                <tr key={s.team_id} className={s.team_id === t.id ? "mine" : ""}>
                  <td className="num">{s.rank}</td><td>{teamStyle(s.team_name).short}</td>
                  <td className="num">{s.wins}-{s.losses}</td><td className="num muted">{s.games_behind ? s.games_behind : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Tile>

        <Tile title="일정" icon="📅" onClick={() => go({ name: "schedule" })} action="시즌 일정">
          {upcoming.length === 0 ? <p className="muted small">예정된 경기가 없습니다</p> : (
            <div className="mini-list">
              {upcoming.map((g) => {
                const home = g.home_team_id === t.id;
                const opp = home ? g.away_team : g.home_team;
                return (
                  <div key={g.id} className="mini-game">
                    <span className="mg-date">{formatDate(g.game_date).replace(/^\d+\./, "")}</span>
                    <Emblem name={opp} size={24} />
                    <span>{home ? "vs" : "@"} {teamStyle(opp).short}</span>
                  </div>
                );
              })}
            </div>
          )}
          {t.recent.length > 0 && (
            <div className="form-strip">
              최근 {t.recent.slice().reverse().map((g) => {
                const won = g.home_team_id === t.id ? g.home_score > g.away_score : g.away_score > g.home_score;
                return <span key={g.id} className={won ? "w" : "l"}>{won ? "승" : "패"}</span>;
              })}
            </div>
          )}
        </Tile>

        <Tile title="훈련" icon="💪" onClick={() => go({ name: "training" })} action="훈련 계획">
          {training ? (
            <>
              <div className="kv"><span>오늘 계획</span><b>{training.plan.mode === "rest" ? "휴식" : `${focusLabel} · ${training.plan.intensity === "intense" ? "강하게" : training.plan.intensity === "light" ? "가볍게" : "보통"}`}</b></div>
              <div className="mini-list">
                {training.recentChanges.slice(0, 4).map((c, i) => (
                  <div key={i} className="small"><span className={c.delta > 0 ? "good" : "bad"}>{c.delta > 0 ? "▲" : "▼"}</span> {c.name} {c.label}</div>
                ))}
                {training.recentChanges.length === 0 && <p className="muted small">아직 능력치 변화가 없습니다</p>}
              </div>
            </>
          ) : <Loading />}
        </Tile>

        <Tile title="다른 팀" icon="🏀" onClick={() => go({ name: "teams" })} action="팀 둘러보기">
          <div className="mini-list">
            {power.slice(0, 5).map((x, i) => (
              <div key={x.id} className={`power-row ${x.isUser ? "mine" : ""}`}>
                <span className="num">{i + 1}</span><Emblem name={x.name} size={22} /><span>{teamStyle(x.name).short}</span>
                <span className="spacer" /><Rating value={x.overall} />
              </div>
            ))}
          </div>
          <p className="muted small" style={{ margin: "6px 0 0" }}>팀 전력 순위 (상위 8명 평균 오버롤)</p>
        </Tile>

        <Tile title="개인 기록" icon="⭐" onClick={() => go({ name: "league", tab: "players" })} action="기록 보기">
          <div className="leader-cards">
            {[["pts", "득점"], ["reb", "리바운드"], ["ast", "어시스트"]].map(([k, label]) => {
              const r = lead(k);
              return (
                <div key={k} className="leader-card">
                  <span className="lc-label">{label}</span>
                  <b>{r ? r.value : "-"}</b>
                  <span className="lc-name">{r ? r.name : "기록 없음"}</span>
                </div>
              );
            })}
          </div>
        </Tile>

        <Tile title="감독실" icon="🎽" onClick={() => go({ name: "office" })} action="프로필">
          <div className="kv"><span>감독</span><b>{t.coach.name}</b></div>
          <div className="kv"><span>스타일</span><b>{t.coach.style}</b></div>
          <div className="kv"><span>통산</span><b>{careerW}승 {careerL}패</b></div>
        </Tile>

        <Tile title="연봉·샐러리캡" icon="💰" onClick={() => go({ name: "cap" })} action="상세">
          <div className="kv"><span>국내 보수</span><b>{krw(t.payroll.domesticTotal)}</b></div>
          <Bar value={capPct} color={capPct > 100 ? "red" : capPct < 70 ? "orange" : "green"} />
          <div className="kv" style={{ marginTop: 6 }}><span>소진율</span><b>{capPct}%</b></div>
          <div className="kv"><span>외국선수</span><b>{usd(t.payroll.foreignTotalUsd)}</b></div>
        </Tile>

        <Tile title="리그 소식" icon="📰" className="span-2">
          <LatestHeadlines />
          {(() => {
            const results = (allGames ?? []).filter((g) => g.home_score !== null).slice(-6).reverse();
            const items = [
              ...(news ?? []).slice(0, 3).map((n, i) => (
                <div key={`n${i}`} className="news-item">
                  <span className="news-date">{n.tx_date ? formatDate(n.tx_date).replace(/^\d+\./, "") : ""}</span>
                  {n.team_name && <Emblem name={n.team_name} size={20} />}
                  <span>{n.description}</span>
                </div>
              )),
              ...results.map((g) => {
                const homeWin = g.home_score! > g.away_score!;
                return (
                  <div key={`g${g.id}`} className="news-item">
                    <span className="news-date">{formatDate(g.game_date).replace(/^\d+\./, "")}</span>
                    <Emblem name={g.home_team} size={20} />
                    <span className={homeWin ? "news-win" : ""}>{teamStyle(g.home_team).short}</span>
                    <b className="news-score">{g.home_score} : {g.away_score}</b>
                    <span className={!homeWin ? "news-win" : ""}>{teamStyle(g.away_team).short}</span>
                    <Emblem name={g.away_team} size={20} />
                    {g.went_to_ot && <span className="pill gray">연장</span>}
                  </div>
                );
              }),
            ];
            return items.length === 0
              ? <p className="muted small">아직 소식이 없습니다. 시즌을 진행하면 경기 결과와 계약 소식이 쌓입니다.</p>
              : <div className="news">{items}</div>;
          })()}
        </Tile>
      </div>
    </div>
  );
}

// ============================================================
// 내 팀 — 개요
// ============================================================

export function MyTeamOverview() {
  const { go } = useApp();
  const { data: dash, error } = useApi<Dashboard>("/api/dashboard");
  const { data: roster } = useApi<RosterPlayer[]>("/api/franchise/roster");
  const { data: teams } = useApi<TeamOverview[]>("/api/teams-overview");
  if (error) return <ErrorBox error={error} />;
  if (!dash || !roster) return <Loading />;
  const t = dash.myTeam;
  const me = teams?.find((x) => x.isUser);
  const rankOf = (k: "overall" | "offense" | "defense") => teams ? [...teams].sort((a, b) => b[k] - a[k]).findIndex((x) => x.isUser) + 1 : null;
  const groups: { key: "G" | "F" | "C"; label: string }[] = [{ key: "G", label: "가드" }, { key: "F", label: "포워드" }, { key: "C", label: "센터" }];
  const seasonYear = dash.franchise.seasonYear;
  const expiring = roster.filter((p) => p.faYear !== null && p.faYear <= seasonYear + 1);
  const hurt = roster.filter((p) => (p.injuredUntil && p.injuredUntil > dash.franchise.date) || p.fatigue >= 50);

  return (
    <div className="col" style={{ gap: 16 }}>
      <SubTabs items={MYTEAM_TABS} current="myteam" />
      <div className="grid cols-3">
        {(["overall", "offense", "defense"] as const).map((k) => (
          <div key={k} className="stat-card">
            <span className="sc-label">{k === "overall" ? "팀 전력" : k === "offense" ? "공격력" : "수비력"}</span>
            <b>{me ? me[k] : "-"}</b>
            <span className="sc-sub">{rankOf(k) ? `리그 ${rankOf(k)}위` : ""} · 상위 8명 평균</span>
          </div>
        ))}
      </div>

      <div className="grid cols-2">
        <Card title="감독·전술" right={<button onClick={() => go({ name: "tactics" })}>전술 변경</button>}>
          <div className="kv"><span>감독</span><b>{t.coach.name} — {t.coach.style}</b></div>
          <div className="kv"><span>템포</span><b>{PACE_LABEL[t.coach.paceStyle]}</b></div>
          <div className="kv"><span>3점 의존도</span><b>{THREE_LABEL[t.coach.threePointReliance]}</b></div>
          <div className="kv"><span>수비</span><b>{DEFENSE_LABEL[t.coach.defenseScheme]}</b></div>
          <p className="muted small">{t.coach.description}</p>
        </Card>
        <Card title="관리가 필요한 선수">
          {hurt.length === 0 && expiring.length === 0 ? <p className="muted small">특이사항 없음</p> : (
            <div className="mini-list">
              {hurt.map((p) => (
                <div key={`h${p.id}`} className="small">
                  {p.injuredUntil && p.injuredUntil > dash.franchise.date ? <span className="pill red">부상</span> : <span className="pill gray">피로 {Math.round(p.fatigue)}</span>}{" "}
                  <PlayerLink id={p.id} name={p.name} />{p.injuredUntil && p.injuredUntil > dash.franchise.date ? ` (~${p.injuredUntil})` : ""}
                </div>
              ))}
              {expiring.map((p) => (
                <div key={`e${p.id}`} className="small"><span className="pill">FA {p.faYear}</span> <PlayerLink id={p.id} name={p.name} /> · {CONTRACT_TYPE_LABEL[p.contractType]}</div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="포지션별 뎁스 차트" right={<button onClick={() => go({ name: "roster" })}>출전시간 설정</button>}>
        <div className="depth">
          {groups.map((g) => (
            <div key={g.key} className="depth-col">
              <h4>{g.label}</h4>
              {roster.filter((p) => p.positionGroup === g.key).sort((a, b) => b.overall - a.overall).map((p, i) => (
                <div key={p.id} className={`depth-row ${i === 0 ? "first" : ""}`}>
                  <Rating value={p.overall} />
                  <span className="dr-name"><PlayerLink id={p.id} name={p.name} />{p.contractType !== "domestic" && <span className="pill gray">{CONTRACT_TYPE_LABEL[p.contractType]}</span>}</span>
                  <span className="dr-meta">{p.age}세{p.role === "starter" ? " · 선발" : p.role === "bench" ? " · 후보" : p.role === "inactive" ? " · 엔트리 제외" : ""}{p.minutesTarget ? ` · ${p.minutesTarget}분` : p.suggestedMinutes ? ` · 예상 ${p.suggestedMinutes}분` : ""}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ============================================================
// 다른 팀 — 둘러보기 / 비교
// ============================================================

export function TeamsBrowser() {
  const { go } = useApp();
  const { data, error } = useApi<TeamOverview[]>("/api/teams-overview");
  const [sort, setSort] = useState<"rank" | "overall" | "offense" | "defense">("rank");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const rows = [...data].sort((a, b) => sort === "rank" ? (a.rank ?? 99) - (b.rank ?? 99) : b[sort] - a[sort]);
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>다른 팀</h2>
        <div className="seg-light">
          {([["rank", "순위순"], ["overall", "전력순"], ["offense", "공격순"], ["defense", "수비순"]] as const).map(([k, l]) => (
            <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="team-grid">
        {rows.map((x) => {
          const ts = teamStyle(x.name);
          return (
            <div key={x.id} className={`team-card ${x.isUser ? "mine" : ""}`} style={{ ["--team" as string]: ts.primary }}
              onClick={() => go(x.isUser ? { name: "myteam" } : { name: "team", id: x.id })} role="button">
              <div className="tc-head">
                <Emblem name={x.name} size={44} />
                <div className="tc-name"><small>{ts.city}</small>{x.name.split(" ").slice(1).join(" ")}</div>
                <div className="tc-rank">{x.rank ?? "-"}<small>위</small></div>
              </div>
              <div className="tc-record">{x.wins}승 {x.losses}패 {x.streak && <span>· {x.streak}</span>}{x.isUser && <span className="pill">내 팀</span>}</div>
              <div className="tc-bars">
                {(["overall", "offense", "defense"] as const).map((k) => (
                  <div key={k} className="tc-bar"><span>{k === "overall" ? "전력" : k === "offense" ? "공격" : "수비"}</span><Bar value={Math.max(0, x[k] - 60)} max={35} /><b>{x[k]}</b></div>
                ))}
              </div>
              <div className="tc-stars">{x.stars.map((s) => <span key={s.id}>{s.name} <b>{s.overall}</b></span>)}</div>
              <div className="tc-coach">{x.coach} 감독 · {x.style}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 상대 팀 화면 위쪽: 우리 팀과 비교 */
export function TeamCompare({ teamId }: { teamId: number }) {
  const { data: teams } = useApi<TeamOverview[]>("/api/teams-overview");
  const { data: stats } = useApi<TeamStatRow[]>("/api/team-stats");
  const me = teams?.find((x) => x.isUser);
  const them = teams?.find((x) => x.id === teamId);
  if (!me || !them) return null;
  const ms = stats?.find((s) => s.team_id === me.id);
  const os = stats?.find((s) => s.team_id === them.id);
  const rows: [string, number | string | null | undefined, number | string | null | undefined, boolean][] = [
    ["전력", me.overall, them.overall, true], ["공격력", me.offense, them.offense, true], ["수비력", me.defense, them.defense, true],
    ["승", me.wins, them.wins, true], ["득점", ms?.pts, os?.pts, true], ["실점", ms?.opp_pts, os?.opp_pts, false],
    ["리바운드", ms?.reb, os?.reb, true], ["어시스트", ms?.ast, os?.ast, true], ["3점 성공", ms?.tpm, os?.tpm, true], ["야투율", ms?.fg_pct, os?.fg_pct, true],
  ];
  return (
    <Card title="우리 팀과 비교">
      <div className="compare">
        <div className="cmp-head"><Emblem name={me.name} size={30} /><b>{teamStyle(me.name).short}</b><span /><b>{teamStyle(them.name).short}</b><Emblem name={them.name} size={30} /></div>
        {rows.map(([label, a, b, higherBetter]) => {
          const na = a === null || a === undefined ? null : Number(a);
          const nb = b === null || b === undefined ? null : Number(b);
          const aWin = na !== null && nb !== null && (higherBetter ? na > nb : na < nb);
          const bWin = na !== null && nb !== null && (higherBetter ? nb > na : nb < na);
          return (
            <div key={label} className="cmp-row">
              <span className={`cmp-val ${aWin ? "win" : ""}`}>{na ?? "-"}</span>
              <span className="cmp-label">{label}</span>
              <span className={`cmp-val ${bWin ? "win" : ""}`}>{nb ?? "-"}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ============================================================
// 순위·기록 (탭: 팀 순위 / 개인 기록 / 팀 기록 / 플레이오프)
// ============================================================

const TEAM_STAT_COLS: { key: keyof TeamStatRow; label: string; lowGood?: boolean }[] = [
  { key: "pts", label: "득점" }, { key: "opp_pts", label: "실점", lowGood: true }, { key: "reb", label: "리바" }, { key: "oreb", label: "공리" },
  { key: "ast", label: "어시" }, { key: "stl", label: "스틸" }, { key: "blk", label: "블록" }, { key: "tov", label: "턴오버", lowGood: true },
  { key: "tpm", label: "3점" }, { key: "fg_pct", label: "야투%" }, { key: "tp_pct", label: "3점%" }, { key: "ft_pct", label: "자유투%" },
];

export function TeamStatsTable() {
  const { userTeamId, go } = useApp();
  const { data, error } = useApi<TeamStatRow[]>("/api/team-stats");
  const [sortKey, setSortKey] = useState<keyof TeamStatRow>("pts");
  const rows = useMemo(() => {
    const col = TEAM_STAT_COLS.find((c) => c.key === sortKey);
    return [...(data ?? [])].sort((a, b) => {
      const va = Number(a[sortKey] ?? -1), vb = Number(b[sortKey] ?? -1);
      return col?.lowGood ? va - vb : vb - va;
    });
  }, [data, sortKey]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (data.every((r) => r.g === 0)) return <p className="muted">아직 치른 경기가 없습니다. 경기를 진행하면 팀 기록이 쌓입니다.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>팀</th><th className="num">경기</th>
            {TEAM_STAT_COLS.map((c) => (
              <th key={c.key} className={`num sortable ${sortKey === c.key ? "sorted" : ""}`} onClick={() => setSortKey(c.key)}>{c.label}{sortKey === c.key ? " ▾" : ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.team_id} className={`clickable ${r.team_id === userTeamId ? "mine" : ""}`} onClick={() => go(r.team_id === userTeamId ? { name: "myteam" } : { name: "team", id: r.team_id })}>
              <td><span className="row" style={{ gap: 6 }}><Emblem name={r.team_name} size={20} />{teamStyle(r.team_name).short}</span></td>
              <td className="num">{r.g}</td>
              {TEAM_STAT_COLS.map((c) => <td key={c.key} className={`num ${sortKey === c.key ? "sorted" : ""}`}>{r[c.key] ?? "-"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LeagueSection({ tab = "standings" }: { tab?: "standings" | "players" | "teams" | "playoffs" }) {
  const { go } = useApp();
  const { data, error } = useApi<Standing[]>("/api/standings");
  const tabs = [["standings", "팀 순위"], ["players", "개인 기록"], ["teams", "팀 기록"], ["playoffs", "플레이오프"]] as const;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="subtabs">
        {tabs.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => go({ name: "league", tab: k })}>{l}</button>)}
      </div>
      {tab === "standings" && <Card title="팀 순위"><ErrorBox error={error} />{data ? <StandingsTable rows={data} /> : <Loading />}</Card>}
      {tab === "players" && <LeadersFull />}
      {tab === "teams" && <Card title="팀 기록 (경기당 평균, 정규시즌)" right={<span className="muted small">열 제목을 누르면 정렬</span>}><TeamStatsTable /></Card>}
      {tab === "playoffs" && <Card title="플레이오프"><PlayoffBracket /></Card>}
    </div>
  );
}

// ============================================================
// 감독실
// ============================================================

export function OfficeView() {
  const { openSettings, refresh } = useApp();
  const { data, error, reload } = useApi<ManagerInfo>("/api/manager");
  const options = useManagerOptions();
  const [edit, setEdit] = useState<ManagerProfileInput | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const profile: ManagerProfileInput = data.profile ?? {
    name: data.coach.name, age: 50, playStyle: "balanced", personality: "tactician", direction: "balanced",
  };
  const totW = data.career.reduce((a, c) => a + c.wins, 0);
  const totL = data.career.reduce((a, c) => a + c.losses, 0);
  const per = options.personalities.find((o) => o.id === profile.personality);
  const dir = options.directions.find((o) => o.id === profile.direction);

  async function save(resetTactics: boolean) {
    if (!edit) return;
    try {
      await api("/api/manager", { method: "PUT", body: { ...edit, resetTactics } });
      setMsg(resetTactics ? "프로필 저장 — 전술도 플레이 스타일에 맞게 바꿨습니다" : "프로필 저장 완료");
      setEdit(null);
      reload();
      refresh();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  return (
    <div className="office">
      <div className="office-side">
        <ManagerCard p={edit ?? profile} options={options} teamName={data.teamName} />
        {!data.profile && <p className="muted small">이 세이브는 감독 프로필 없이 시작했습니다. 프로필을 만들면 {data.teamName}의 감독이 됩니다.</p>}
        <button className="primary" onClick={() => setEdit(edit ? null : { ...profile })}>{edit ? "편집 취소" : data.profile ? "프로필 수정" : "프로필 만들기"}</button>
        <button onClick={openSettings}>⚙ 게임 설정</button>
      </div>
      <div className="col" style={{ gap: 16, minWidth: 0 }}>
        {msg && <div className="notice">{msg}</div>}
        {edit ? (
          <Card title="프로필 수정">
            <div className="office-form">
              <label>이름<input value={edit.name} maxLength={20} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label>나이<input type="number" min={28} max={80} value={edit.age} onChange={(e) => setEdit({ ...edit, age: Number(e.target.value) })} /></label>
              <label>출신<input value={edit.hometown ?? ""} maxLength={20} onChange={(e) => setEdit({ ...edit, hometown: e.target.value })} /></label>
              <label className="wide">좌우명<input value={edit.motto ?? ""} maxLength={60} onChange={(e) => setEdit({ ...edit, motto: e.target.value })} /></label>
              <label>플레이 스타일
                <select value={edit.playStyle} onChange={(e) => setEdit({ ...edit, playStyle: e.target.value })}>
                  {options.playStyles.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </label>
              <label>성격
                <select value={edit.personality} onChange={(e) => setEdit({ ...edit, personality: e.target.value })}>
                  {options.personalities.map((o) => <option key={o.id} value={o.id}>{o.label} — {o.effect}</option>)}
                </select>
              </label>
              <label>운영 방향
                <select value={edit.direction} onChange={(e) => setEdit({ ...edit, direction: e.target.value })}>
                  {options.directions.map((o) => <option key={o.id} value={o.id}>{o.label} — {o.effect}</option>)}
                </select>
              </label>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" disabled={!edit.name.trim()} onClick={() => save(false)}>저장</button>
              <button disabled={!edit.name.trim()} onClick={() => save(true)}>저장 + 전술을 플레이 스타일로 초기화</button>
            </div>
          </Card>
        ) : null}

        <div className="grid cols-3">
          <div className="stat-card"><span className="sc-label">통산 성적</span><b>{totW}승 {totL}패</b><span className="sc-sub">{totW + totL > 0 ? `승률 ${(totW / (totW + totL)).toFixed(3)}` : "아직 경기 없음"}</span></div>
          <div className="stat-card"><span className="sc-label">성격 효과</span><b className="sc-text">{per?.effect ?? "-"}</b><span className="sc-sub">{per?.label}</span></div>
          <div className="stat-card"><span className="sc-label">운영 방향 효과</span><b className="sc-text">{dir?.effect ?? "-"}</b><span className="sc-sub">{dir?.label}</span></div>
        </div>

        <Card title="시즌별 기록">
          {data.career.length === 0 ? <p className="muted small">아직 치른 경기가 없습니다.</p> : (
            <table>
              <thead><tr><th>시즌</th><th>팀</th><th className="num">정규시즌</th><th className="num">승률</th><th className="num">플레이오프</th></tr></thead>
              <tbody>
                {data.career.map((c) => (
                  <tr key={c.season}>
                    <td>{c.season}</td><td>{data.teamName}</td><td className="num">{c.wins}승 {c.losses}패</td>
                    <td className="num">{c.games ? (c.wins / c.games).toFixed(3) : "-"}</td>
                    <td className="num">{c.poGames ? `${c.poWins}승 ${c.poGames - c.poWins}패` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="감독 효과 안내">
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li><b>플레이 스타일</b>은 새 게임을 시작할 때 팀 전술(템포·3점·수비·리바운드)이 됩니다. 전술은 언제든 <b>내 팀 → 전술</b>에서 바꿀 수 있습니다.</li>
            <li><b>성격</b>과 <b>운영 방향</b> 효과는 우리 팀 선수에게만 적용됩니다.</li>
            {options.personalities.map((o) => <li key={o.id}>{o.label}: {o.effect}</li>)}
            {options.directions.map((o) => <li key={o.id}>{o.label}: {o.effect}</li>)}
          </ul>
        </Card>
      </div>
    </div>
  );
}
