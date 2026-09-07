import { useState } from "react";

interface BoxScoreEntry {
  name: string;
  team: string;
  pts: number;
  ast: number;
  reb: number;
  tov: number;
  blk: number;
  pf: number;
}

interface AdvanceRoundResult {
  round: number;
  userTeamGame: {
    gameId: number;
    home: string;
    away: string;
    homeScore: number;
    awayScore: number;
    wentToOT: boolean;
    boxScore: BoxScoreEntry[];
  } | null;
  otherGames: { gameId: number; home: string; away: string; homeScore: number; awayScore: number }[];
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

export function AdvanceRoundPanel() {
  const [result, setResult] = useState<AdvanceRoundResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdvance() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/franchise/advance-round`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "알 수 없는 오류");
        return;
      }
      setResult(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ border: "1px solid #ccc", padding: "16px", borderRadius: "8px" }}>
      <button onClick={handleAdvance} disabled={loading} style={{ padding: "10px 20px", fontSize: "16px" }}>
        {loading ? "시뮬레이션 중..." : "다음 라운드 진행"}
      </button>

      {error && <p style={{ color: "red" }}>{error}</p>}

      {result && (
        <div style={{ marginTop: "16px" }}>
          <h3>R{result.round} 결과</h3>

          {result.userTeamGame && (
            <div style={{ marginBottom: "16px" }}>
              <h4>
                내 팀 경기: {result.userTeamGame.home} {result.userTeamGame.homeScore} : {result.userTeamGame.awayScore}{" "}
                {result.userTeamGame.away}
                {result.userTeamGame.wentToOT ? " (연장)" : ""}
              </h4>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #ccc" }}>
                    <th style={{ textAlign: "left", padding: "4px" }}>선수</th>
                    <th style={{ padding: "4px" }}>팀</th>
                    <th style={{ padding: "4px" }}>PTS</th>
                    <th style={{ padding: "4px" }}>AST</th>
                    <th style={{ padding: "4px" }}>REB</th>
                  </tr>
                </thead>
                <tbody>
                  {result.userTeamGame.boxScore
                    .filter((p) => p.pts > 0 || p.ast > 0 || p.reb > 0)
                    .sort((a, b) => b.pts - a.pts)
                    .map((p) => (
                      <tr key={p.name}>
                        <td style={{ padding: "4px" }}>{p.name}</td>
                        <td style={{ padding: "4px" }}>{p.team}</td>
                        <td style={{ padding: "4px", textAlign: "center" }}>{p.pts}</td>
                        <td style={{ padding: "4px", textAlign: "center" }}>{p.ast}</td>
                        <td style={{ padding: "4px", textAlign: "center" }}>{p.reb}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          <h4>다른 경기 결과</h4>
          <ul>
            {result.otherGames.map((g) => (
              <li key={g.gameId}>
                {g.home} {g.homeScore} - {g.awayScore} {g.away}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
