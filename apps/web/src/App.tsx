import { useCallback, useEffect, useState } from "react";
import { api, formatDate, PHASE_LABEL, STAGE_LABEL } from "./api";
import type { Franchise, Standing } from "./api";
import { AppContext } from "./components/common";
import type { View } from "./components/common";
import { TodayView } from "./components/Today";
import { LiveGameView } from "./components/LiveGame";
import { MyRosterView, TacticsView, TeamView } from "./components/Team";
import { TrainingView } from "./components/Training";
import { ScheduleView } from "./components/Schedule";
import { PlayerView, PlayerSearch } from "./components/Player";
import { OffseasonView } from "./components/Offseason";
import { SalaryCapView } from "./components/Misc";
import { Splash } from "./components/Splash";
import { TitleScreen } from "./components/Title";
import { NewGameFlow } from "./components/NewGame";
import { SettingsPanel } from "./components/Settings";
import {
  HubHome, MyTeamOverview, TeamsBrowser, TeamCompare, LeagueSection, OfficeView,
  SECTIONS, sectionOf, SubTabs, MYTEAM_TABS, SCHEDULE_TABS, emblemFont,
} from "./components/Hub";
import { useSettings } from "./settings";
import { teamStyle } from "./teamColors";

type Screen = "splash" | "title" | "newgame" | "game";
type FranchiseWithManager = Franchise & { manager?: { name: string } | null };

function App() {
  const [settings] = useSettings();
  const [screen, setScreen] = useState<Screen>(() => (settings.showSplash ? "splash" : "title"));
  const [view, setView] = useState<View>({ name: "dashboard" });
  const [franchise, setFranchise] = useState<FranchiseWithManager | null>(null);
  const [record, setRecord] = useState<Standing | null>(null);
  const [version, setVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const refresh = useCallback(() => {
    api<FranchiseWithManager>("/api/franchise")
      .then(async (f) => {
        setFranchise(f);
        const st = await api<Standing[]>("/api/standings").catch(() => []);
        setRecord(st.find((s) => s.team_id === f.userTeamId) ?? null);
      })
      .catch(() => { setFranchise(null); setRecord(null); });
    setVersion((v) => v + 1);
  }, []);
  useEffect(refresh, [refresh]);

  const go = useCallback((v: View) => {
    setMenuOpen(false);
    if (v.name === "newgame") { setScreen("newgame"); return; }
    setView(v);
    window.scrollTo(0, 0);
  }, []);

  const enterGame = useCallback(() => {
    refresh();
    setView({ name: "dashboard" });
    setScreen("game");
    window.scrollTo(0, 0);
  }, [refresh]);

  const finishSplash = useCallback(() => setScreen("title"), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  if (screen === "splash") return <Splash onDone={finishSplash} />;
  if (screen === "title") return <TitleScreen onContinue={enterGame} onNewGame={() => setScreen("newgame")} />;
  if (screen === "newgame") return <NewGameFlow hasSave={!!franchise} onBack={() => setScreen("title")} onStarted={enterGame} />;

  const section = sectionOf(view);
  const ts = teamStyle(franchise?.userTeamName);

  let body;
  switch (view.name) {
    case "dashboard": body = <HubHome />; break;
    case "myteam": body = <MyTeamOverview />; break;
    case "roster": body = <><SubTabs items={MYTEAM_TABS} current="roster" /><MyRosterView /></>; break;
    case "tactics": body = <><SubTabs items={MYTEAM_TABS} current="tactics" /><TacticsView /></>; break;
    case "cap": body = <><SubTabs items={MYTEAM_TABS} current="cap" /><SalaryCapView /></>; break;
    case "teams": body = <TeamsBrowser />; break;
    case "team": body = (
      <>
        <div><button onClick={() => go({ name: "teams" })}>← 다른 팀 목록</button></div>
        <TeamCompare teamId={view.id} />
        <TeamView id={view.id} />
      </>
    ); break;
    case "league": body = <LeagueSection tab={view.tab} />; break;
    case "training": body = <TrainingView />; break;
    case "today": body = <><SubTabs items={SCHEDULE_TABS} current="today" /><TodayView /></>; break;
    case "schedule": body = <><SubTabs items={SCHEDULE_TABS} current="schedule" /><ScheduleView /></>; break;
    case "live": body = <LiveGameView sessionId={view.sessionId} />; break;
    case "office": body = <OfficeView />; break;
    case "player": body = <PlayerView id={view.id} />; break;
    case "offseason": body = <OffseasonView />; break;
  }

  const offseason = franchise?.phase === "offseason";

  return (
    <AppContext.Provider value={{ go, refresh, version, userTeamId: franchise?.userTeamId ?? null, openSettings }}>
      <div className="game" style={{ ["--team" as string]: ts.primary }}>
        <header className="game-header">
          <div className="gh-top">
            <button className="gh-logo" onClick={() => go({ name: "dashboard" })} title="홈">KM<span>27</span></button>
            {franchise && (
              <div className="gh-team">
                <span className="emblem" style={{ width: 34, height: 34, background: ts.primary, fontSize: emblemFont(ts.abbr, 34) }}>{ts.abbr}</span>
                <div className="gh-team-text">
                  <div className="gh-team-name">{franchise.userTeamName}</div>
                  <div className="gh-team-sub">
                    {franchise.manager?.name ? `${franchise.manager.name} 감독 · ` : ""}
                    {record ? `${record.wins}승 ${record.losses}패 · ${record.rank}위` : "0승 0패"}
                  </div>
                </div>
              </div>
            )}
            <span className="gh-spacer" />
            {franchise && (
              <div className="gh-date">
                <b>{formatDate(franchise.date)}</b>
                <span>{franchise.seasonLabel} {PHASE_LABEL[franchise.phase]}{franchise.offseasonStage ? ` · ${STAGE_LABEL[franchise.offseasonStage] ?? ""}` : ""}</span>
              </div>
            )}
            <div className="gh-search"><PlayerSearch /></div>
            {franchise && (offseason
              ? <button className="gh-advance" onClick={() => go({ name: "offseason" })}>비시즌 진행 ▶</button>
              : <button className="gh-advance" onClick={() => go({ name: "today" })}>오늘 진행 ▶</button>)}
            <div className="gh-menu">
              <button className="gh-icon" onClick={() => setMenuOpen((o) => !o)} aria-label="메뉴">☰</button>
              {menuOpen && (
                <div className="gh-menu-pop" onMouseLeave={() => setMenuOpen(false)}>
                  <button onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}>⚙ 설정</button>
                  <button onClick={() => go({ name: "office" })}>🎽 감독실</button>
                  <button onClick={() => { setMenuOpen(false); setScreen("title"); }}>🏠 메인 화면으로</button>
                  <button onClick={() => { setMenuOpen(false); setScreen("newgame"); }}>🔄 새로 시작</button>
                </div>
              )}
            </div>
          </div>
          <nav className="gh-nav" aria-label="게임 메뉴">
            {SECTIONS.filter((s) => s.key !== "offseason" || offseason).map((s) => (
              <button key={s.key} className={section === s.key ? "on" : ""} onClick={() => go(s.view)}>
                <span>{s.icon}</span>{s.label}{s.key === "offseason" && <i className="dot" />}
              </button>
            ))}
          </nav>
        </header>

        <main className="game-content">
          {!franchise && version > 1 ? (
            <div className="notice">
              저장된 게임이 없습니다. <button className="primary" onClick={() => setScreen("newgame")}>새로 시작</button>
            </div>
          ) : (
            <div className="col" style={{ gap: 16 }}>{body}</div>
          )}
        </main>

        {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      </div>
    </AppContext.Provider>
  );
}

export default App;
