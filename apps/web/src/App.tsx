import { useEffect, useState } from "react";
import { StandingsTable } from "./components/StandingsTable";
import { ScheduleList } from "./components/ScheduleList";
import { BoxScoreView } from "./components/BoxScoreView";
import { AdvanceRoundPanel } from "./components/AdvanceRoundPanel";
import { TeamSelect } from "./components/TeamSelect";
import { RosterSettings } from "./components/RosterSettings";
import { TacticsSettings } from "./components/TacticsSettings";
import { PlayoffBracket } from "./components/PlayoffBracket";
import { PlayerSearch } from "./components/PlayerSearch";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

type Tab = "game" | "team" | "roster" | "tactics" | "player";

function App() {
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("game");
  const [currentTeam, setCurrentTeam] = useState<string>("");
  const [playoffRefreshKey, setPlayoffRefreshKey] = useState(0);
  const [selectedPlayerName, setSelectedPlayerName] = useState<string | undefined>(undefined);

  function refreshFranchise() {
    fetch(`${API_BASE}/api/franchise`)
      .then((r) => r.json())
      .then((d) => setCurrentTeam(d.user_team ?? ""))
      .catch(() => {});
  }

  useEffect(refreshFranchise, []);

  const tabs: { key: Tab; label: string }[] = [
    { key: "game", label: "경기 진행" },
    { key: "team", label: "팀 선택" },
    { key: "roster", label: "로스터 설정" },
    { key: "tactics", label: "전술 설정" },
    { key: "player", label: "선수 검색" },
  ];

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "20px", fontFamily: "sans-serif" }}>
      <h1>KBL Manager</h1>
      <p style={{ color: "#555" }}>현재 운영중인 팀: <strong>{currentTeam || "불러오는 중..."}</strong></p>

      <div style={{ display: "flex", gap: "8px", borderBottom: "1px solid #ddd", marginBottom: "20px" }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "8px 16px",
              border: "none",
              borderBottom: tab === t.key ? "3px solid #2563eb" : "3px solid transparent",
              background: "none",
              fontWeight: tab === t.key ? "bold" : "normal",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "team" && <TeamSelect currentTeam={currentTeam} onSelected={refreshFranchise} />}
      {tab === "roster" && (
        <RosterSettings
          onSelectPlayer={(name) => {
            setSelectedPlayerName(name);
            setTab("player");
          }}
        />
      )}
      {tab === "tactics" && <TacticsSettings />}
      {tab === "player" && <PlayerSearch initialName={selectedPlayerName} />}

      {tab === "game" && (
        <>
          <h2>내 팀 운영</h2>
          <AdvanceRoundPanel onAdvanced={() => setPlayoffRefreshKey((k) => k + 1)} />

          <h2 style={{ marginTop: "32px" }}>플레이오프</h2>
          <PlayoffBracket refreshKey={playoffRefreshKey} />

          <h2 style={{ marginTop: "32px" }}>순위표</h2>
          <StandingsTable />

          <h2 style={{ marginTop: "32px" }}>일정 / 박스스코어</h2>
          <div style={{ display: "flex", gap: "24px" }}>
            <div style={{ flex: 1 }}>
              <ScheduleList onSelectGame={setSelectedGameId} />
            </div>
            <div style={{ flex: 1 }}>
              <BoxScoreView gameId={selectedGameId} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
