import { useEffect, useState } from "react";

interface ScheduleRow {
  id: number;
  round: number;
  day_offset: number;
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
  went_to_ot: boolean;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

export function ScheduleList({ onSelectGame }: { onSelectGame: (gameId: number) => void }) {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/schedule`)
      .then((r) => r.json())
      .then((data) => setRows(data))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>일정 불러오는 중...</p>;

  return (
    <div style={{ maxHeight: 500, overflowY: "auto" }}>
      {rows.map((g) => (
        <div
          key={g.id}
          onClick={() => onSelectGame(g.id)}
          style={{
            padding: "8px",
            borderBottom: "1px solid #eee",
            cursor: "pointer",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            R{g.round}. {g.home_team} vs {g.away_team}
          </span>
          <span>
            {g.home_score} - {g.away_score}
            {g.went_to_ot ? " (OT)" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
