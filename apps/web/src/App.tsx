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
import { Splash } from "./components/Splash";

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
  const [showSplash, setShowSplash] = useState(true);

  const refresh = useCallback(() => {
    api<Franchise>("/api/franchise")
      .then((f) => { setFranchise(f); setLoadError(null); })
      .catch((e) => setLoadError(String(e.message)));
    setVersion((v) => v + 1);
  }, []);
  useEffect(refresh, [refresh]);

  const finishSplash = useCallback(() => setShowSplash(false), []);

  const go = (v: View) => {
    setView(v);
    window.scrollTo(0, 0);
  };

  let body;
  if (loadError && !franchise) {
    // 세이브가 없으면(첫 실행) 로딩 화면 다음에 바로 팀 선택
    body = <NewGameView />;
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

  if (showSplash) return <Splash onDone={finishSplash} />;

  return (
    <AppContext.Provider value={{ go, refresh, version, userTeamId: franchise?.userTeamId ?? null }}>
      <div className="layout">
        <nav className="sidebar">
          <div className="logo">KM27</div>
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
