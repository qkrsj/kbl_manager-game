import { useEffect, useState } from "react";

interface SeriesRow {
  round: "round1" | "round2" | "final";
  slot: string;
  best_of: number;
  higher_seed_wins: number;
  lower_seed_wins: number;
  higher_seed_team: string;
  lower_seed_team: string;
  winner_team: string | null;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";
const ROUND_LABEL: Record<SeriesRow["round"], string> = { round1: "6강전", round2: "4강전", final: "챔피언결정전" };

export function PlayoffBracket({ refreshKey }: { refreshKey?: number }) {
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/franchise/playoffs`)
      .then((r) => r.json())
      .then((data) => setSeries(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  if (loading) return <p>플레이오프 정보 불러오는 중...</p>;
  if (series.length === 0) return <p>아직 플레이오프가 시작되지 않았습니다.</p>;

  const rounds: SeriesRow["round"][] = ["round1", "round2", "final"];

  return (
    <div style={{ display: "flex", gap: "24px" }}>
      {rounds.map((round) => {
        const seriesInRound = series.filter((s) => s.round === round);
        if (seriesInRound.length === 0) return null;
        return (
          <div key={round} style={{ flex: 1 }}>
            <h4>{ROUND_LABEL[round]}</h4>
            {seriesInRound.map((s) => {
              const higherWon = s.winner_team === s.higher_seed_team;
              const lowerWon = s.winner_team === s.lower_seed_team;
              return (
                <div
                  key={s.slot}
                  style={{
                    border: "1px solid #ccc",
                    borderRadius: "6px",
                    padding: "8px",
                    marginBottom: "12px",
                    fontSize: "13px",
                  }}
                >
                  <div style={{ fontWeight: higherWon ? "bold" : "normal", color: higherWon ? "#2563eb" : undefined }}>
                    {s.higher_seed_team} — {s.higher_seed_wins}승
                  </div>
                  <div style={{ fontWeight: lowerWon ? "bold" : "normal", color: lowerWon ? "#2563eb" : undefined }}>
                    {s.lower_seed_team} — {s.lower_seed_wins}승
                  </div>
                  <div style={{ color: "#888", marginTop: "4px" }}>
                    {s.best_of}전{Math.ceil(s.best_of / 2)}선
                    {s.winner_team && ` · ${s.winner_team} 승리`}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
