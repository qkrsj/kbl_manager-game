import { useCallback, useEffect, useState } from "react";
import { api, formatDate, PHASE_LABEL, STAGE_LABEL } from "./api";
import type { Franchise } from "./api";
import { AppContext } from "./components/common";
import type { View } from "./components/common";
import { DashboardView } from "./components/Dashboard";
import { TodayView } from "./components/Today";
import { LiveGameView } from "./components/LiveGame";
import { MyRosterView, TacticsView, TeamView } from "./components/Team";
import { TrainingView } from "./components/Training";
import { ScheduleView } from "./components/Schedule";
import { LeagueView } from "./components/League";
import { PlayerView, PlayerSearch } from "./components/Player";
import { OffseasonView } from "./components/Offseason";
import { SalaryCapView, NewGameView } from "./components/Misc";

const NAV: { view: View["name"]; label: string }[] = [
  { view: "dashboard", label: "🏠 메인" },
  { view: "today", label: "📅 오늘" },
  { view: "roster", label: "👥 내 팀" },
  { view: "tactics", label: "📋 전술" },
  { view: "training", label: "💪 훈련" },
  { view: "schedule", label: "🗓 일정" },
  { view: "league", label: "🏆 순위·기록" },
  { view: "cap", label: "💰 샐러리캡" },
  { view: "offseason", label: "✍️ 비시즌" },
];

function App() {
  const [view, setView] = useState<View>({ name: "dashboard" });
  const [franchise, setFranchise] = useState<Franchise | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => {
    api<Franchise>("/api/franchise")
      .then((f) => { setFranchise(f); setLoadError(null); })
      .catch((e) => setLoadError(String(e.message)));
    setVersion((v) => v + 1);
  }, []);
  useEffect(refresh, [refresh]);

  const go = (v: View) => {
    setView(v);
    window.scrollTo(0, 0);
  };

  let body;
  if (loadError && !franchise) {
    body = view.name === "newgame" ? <NewGameView /> : (
      <div className="card">
        <h3>세이브 데이터를 불러올 수 없습니다</h3>
        <p className="muted">{loadError}</p>
        <p>API 서버(<code>apps/server</code>: <code>npm start</code>)가 실행 중인지 확인하고, 새 게임을 시작하세요.</p>
        <button className="primary" onClick={() => go({ name: "newgame" })}>새 게임</button>
      </div>
    );
  } else {
    switch (view.name) {
      case "dashboard": body = <DashboardView />; break;
      case "today": body = <TodayView />; break;
      case "live": body = <LiveGameView sessionId={view.sessionId} />; break;
      case "roster": body = <MyRosterView />; break;
      case "tactics": body = <TacticsView />; break;
      case "training": body = <TrainingView />; break;
      case "schedule": body = <ScheduleView />; break;
      case "league": body = <LeagueView />; break;
      case "player": body = <PlayerView id={view.id} />; break;
      case "team": body = <TeamView id={view.id} />; break;
      case "cap": body = <SalaryCapView />; break;
      case "offseason": body = <OffseasonView />; break;
      case "newgame": body = <NewGameView />; break;
    }
  }

  return (
    <AppContext.Provider value={{ go, refresh, version, userTeamId: franchise?.userTeamId ?? null }}>
      <div className="layout">
        <nav className="sidebar">
          <div className="logo">KBL Manager</div>
          {NAV.map((n) => (
            <button key={n.view} className={`nav-item ${view.name === n.view ? "active" : ""}`} onClick={() => go({ name: n.view } as View)}>
              {n.label}
            </button>
          ))}
          <div className="nav-sep" />
          <button className={`nav-item ${view.name === "newgame" ? "active" : ""}`} onClick={() => go({ name: "newgame" })}>🔄 새 게임</button>
        </nav>
        <div className="main">
          {franchise && (
            <div className="topbar">
              <span className="date">{formatDate(franchise.date)}</span>
              <span className="pill">{franchise.seasonLabel} {PHASE_LABEL[franchise.phase]}{franchise.offseasonStage ? ` · ${STAGE_LABEL[franchise.offseasonStage] ?? ""}` : ""}</span>
              <b>{franchise.userTeamName}</b>
              <span className="spacer" />
              <PlayerSearch />
              {franchise.phase === "offseason"
                ? <button className="primary" onClick={() => go({ name: "offseason" })}>비시즌 진행 ▶</button>
                : <button className="primary" onClick={() => go({ name: "today" })}>오늘 진행 ▶</button>}
            </div>
          )}
          <div className="content">{body}</div>
        </div>
      </div>
    </AppContext.Provider>
  );
}

export default App;
