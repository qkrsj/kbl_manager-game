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

interface RegularResult {
  phase: "regular";
  targetDay: number;
  userTeamGame: {
    gameId: number;
    home: string;
    away: string;
    homeScore: number;
    awayScore: number;
    wentToOT: boolean;
    boxScore: BoxScoreEntry[];
  } | null;
  otherGames: { gameId: number; day: number; home: string; away: string; homeScore: number; awayScore: number }[];
}

interface PlayoffResult {
  phase: "playoffs";
  round: string;
  slot: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  seriesComplete: boolean;
  seriesWinner: string | null;
}

interface DoneResult {
  phase: "done";
  champion: string | null;
}

type AdvanceResult = RegularResult | PlayoffResult | DoneResult;

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";
const ROUND_LABEL: Record<string, string> = { round1: "6강전", round2: "4강전", final: "챔피언결정전" };

export function AdvanceRoundPanel({ onAdvanced }: { onAdvanced?: () => void }) {
  const [result, setResult] = useState<AdvanceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdvance() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/franchise/advance`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "알 수 없는 오류");
        return;
      }
      setResult(data);
      onAdvanced?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ border: "1px solid #ccc", padding: "16px", borderRadius: "8px" }}>
      <button onClick={handleAdvance} disabled={loading} style={{ padding: "10px 20px", fontSize: "16px" }}>
        {loading ? "시뮬레이션 중..." : "다음 경기 진행"}
      </button>

      {error && <p style={{ color: "red" }}>{error}</p>}

      {result?.phase === "regular" && (
        <div style={{ marginTop: "16px" }}>
          <h3>Day {result.targetDay} 결과 (정규시즌)</h3>

          {result.userTeamGame && (
            <div style={{ marginBottom: "16px" }}>
              <h4>
                우리 팀 경기: {result.userTeamGame.home} {result.userTeamGame.homeScore} : {result.userTeamGame.awayScore}{" "}
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

          {result.otherGames.length > 0 && (
            <>
              <h4>그 사이 밀려있던 다른 경기 결과 ({result.otherGames.length}경기)</h4>
              <ul>
                {result.otherGames.map((g) => (
                  <li key={g.gameId}>
                    Day{g.day} · {g.home} {g.homeScore} - {g.awayScore} {g.away}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {result?.phase === "playoffs" && (
        <div style={{ marginTop: "16px" }}>
          <h3>{ROUND_LABEL[result.round] ?? result.round} 결과</h3>
          <p>
            {result.home} {result.homeScore} : {result.awayScore} {result.away}
          </p>
          {result.seriesComplete && (
            <p style={{ fontWeight: "bold", color: "#2563eb" }}>시리즈 종료! {result.seriesWinner} 승리</p>
          )}
        </div>
      )}

      {result?.phase === "done" && (
        <div style={{ marginTop: "16px" }}>
          <h3 style={{ color: "#eab308" }}>🏆 시즌 종료! 우승팀: {result.champion}</h3>
        </div>
      )}
    </div>
  );
}
