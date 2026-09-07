import { useState } from "react";
import { StandingsTable } from "./components/StandingsTable";
import { ScheduleList } from "./components/ScheduleList";
import { BoxScoreView } from "./components/BoxScoreView";
import { AdvanceRoundPanel } from "./components/AdvanceRoundPanel";

function App() {
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "20px", fontFamily: "sans-serif" }}>
      <h1>KBL Manager</h1>

      <h2>내 팀 운영</h2>
      <AdvanceRoundPanel />

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
    </div>
  );
}

export default App;
