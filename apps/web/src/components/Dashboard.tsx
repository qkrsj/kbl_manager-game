import { useApi, Loading, ErrorBox, Card, Rating, Bar, PlayerLink, useApp } from "./common";
import { StandingsTable, LeaderMini } from "./League";
import { krw, usd, formatDate, PACE_LABEL, DEFENSE_LABEL, THREE_LABEL, PHASE_LABEL } from "../api";
import type { Franchise, Standing, LeaderBoard, RosterPlayer, Payroll, Coach } from "../api";

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

export function DashboardView() {
  const { go } = useApp();
  const { data, error } = useApi<Dashboard>("/api/dashboard");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const { myTeam: t, franchise: f } = data;
  const capPct = Math.round(t.payroll.usageRatio * 1000) / 10;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid cols-2">
        <Card title={<span>내 팀 · {t.name}</span>} right={<button onClick={() => go({ name: "roster" })}>팀 관리 →</button>}>
          <div className="row" style={{ gap: 24, alignItems: "flex-start" }}>
            <div>
              <div className="muted small">{f.seasonLabel} {PHASE_LABEL[f.phase]}</div>
              <div className="big">{t.standing ? `${t.standing.wins}승 ${t.standing.losses}패` : "-"}</div>
              <div>{t.standing ? `리그 ${t.standing.rank}위 · ${t.standing.streak || "-"}` : ""}</div>
            </div>
            <div className="col small" style={{ gap: 2 }}>
              <div><span className="muted">감독</span> {t.coach.name} ({t.coach.style})</div>
              <div><span className="muted">국내 보수</span> {krw(t.payroll.domesticTotal)} / {krw(t.capLimit)} ({capPct}%)</div>
              <div style={{ width: 200 }}><Bar value={capPct} color={capPct > 100 ? "red" : capPct < 70 ? "orange" : "green"} /></div>
              <div><span className="muted">외국선수</span> {t.payroll.foreignCount}명 · {usd(t.payroll.foreignTotalUsd)}</div>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            {t.nextGame ? (
              <div className="notice row" style={{ justifyContent: "space-between" }}>
                <span>
                  다음 경기: <b>{formatDate(t.nextGame.game_date)}</b> — {t.nextGame.home_team_id === t.id ? `vs ${t.nextGame.away} (홈)` : `@ ${t.nextGame.home} (원정)`}
                  {t.nextGame.series_id ? " · 플레이오프" : ""}
                </span>
                <button className="primary" onClick={() => go({ name: "today" })}>{data.todayGame ? "오늘 경기 준비" : "오늘 일정"}</button>
              </div>
            ) : <p className="muted">남은 경기가 없습니다.</p>}
          </div>
          <h4 style={{ marginTop: 12 }}>최근 경기</h4>
          {t.recent.length === 0 ? <p className="muted small">아직 경기가 없습니다</p> : (
            <table>
              <tbody>
                {t.recent.map((g) => {
                  const home = g.home_team_id === t.id;
                  const won = home ? g.home_score > g.away_score : g.away_score > g.home_score;
                  return (
                    <tr key={g.id}>
                      <td className="small muted">{formatDate(g.game_date)}</td>
                      <td>{home ? `vs ${g.away}` : `@ ${g.home}`}</td>
                      <td className={won ? "good" : "bad"}><b>{won ? "승" : "패"}</b> {home ? `${g.home_score}-${g.away_score}` : `${g.away_score}-${g.home_score}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="핵심 선수" right={<span className="muted small">전술: {PACE_LABEL[t.coach.paceStyle]} 템포 · 3점 {THREE_LABEL[t.coach.threePointReliance]} · {DEFENSE_LABEL[t.coach.defenseScheme]}</span>}>
          <table>
            <thead><tr><th>선수</th><th>OVR</th><th className="num">득점</th><th className="num">리바</th><th className="num">어시</th><th>상태</th></tr></thead>
            <tbody>
              {t.topPlayers.map((p) => (
                <tr key={p.id}>
                  <td><PlayerLink id={p.id} name={p.name} /> <span className="muted small">{p.positionGroup}{p.contractType !== "domestic" ? ` · ${p.contractType === "foreign" ? "외국" : "AQ"}` : ""}</span></td>
                  <td><Rating value={p.overall} /></td>
                  <td className="num">{p.stats?.pts ?? "-"}</td><td className="num">{p.stats?.reb ?? "-"}</td><td className="num">{p.stats?.ast ?? "-"}</td>
                  <td className="small">{p.injuredUntil && p.injuredUntil > f.date ? <span className="pill red">부상</span> : p.fatigue >= 60 ? <span className="pill gray">피로</span> : <span className="pill green">정상</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {t.injured.length > 0 && <p className="small bad">부상자: {t.injured.map((p) => `${p.name}(~${p.injuredUntil})`).join(", ")}</p>}
        </Card>
      </div>

      <Card title="팀 순위" right={<button onClick={() => go({ name: "league" })}>전체 기록 →</button>}>
        <StandingsTable rows={data.standings} compact />
      </Card>

      <div>
        <h3>개인 순위</h3>
        <div className="grid cols-3">
          {data.leaders.map((b) => <LeaderMini key={b.stat} board={b} />)}
        </div>
      </div>
    </div>
  );
}
