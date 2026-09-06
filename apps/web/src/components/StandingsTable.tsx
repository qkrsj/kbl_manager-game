import { useEffect, useState } from "react";

interface StandingRow {
  team_name: string;
  games_played: string;
  wins: string;
  losses: string;
  points_for: string;
  points_against: string;
  avg_points_for: string;
  avg_points_against: string;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

export function StandingsTable() {
  const [rows, setRows] = useState<StandingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/standings`)
      .then((r) => r.json())
      .then((data) => setRows(data))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>순위표 불러오는 중...</p>;
  if (error) return <p>에러: {error}</p>;

  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr style={{ borderBottom: "2px solid #333" }}>
          <th style={{ textAlign: "left", padding: "6px" }}>순위</th>
          <th style={{ textAlign: "left", padding: "6px" }}>팀</th>
          <th style={{ padding: "6px" }}>경기</th>
          <th style={{ padding: "6px" }}>승</th>
          <th style={{ padding: "6px" }}>패</th>
          <th style={{ padding: "6px" }}>득점</th>
          <th style={{ padding: "6px" }}>실점</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.team_name} style={{ borderBottom: "1px solid #ddd" }}>
            <td style={{ padding: "6px" }}>{i + 1}</td>
            <td style={{ padding: "6px" }}>{r.team_name}</td>
            <td style={{ padding: "6px", textAlign: "center" }}>{r.games_played}</td>
            <td style={{ padding: "6px", textAlign: "center" }}>{r.wins}</td>
            <td style={{ padding: "6px", textAlign: "center" }}>{r.losses}</td>
            <td style={{ padding: "6px", textAlign: "center" }}>{r.avg_points_for}</td>
            <td style={{ padding: "6px", textAlign: "center" }}>{r.avg_points_against}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
