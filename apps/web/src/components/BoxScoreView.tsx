import { useEffect, useState } from "react";

interface BoxScorePlayer {
  name: string;
  team_name: string;
  pts: number;
  ast: number;
  reb: number;
  tov: number;
  blk: number;
  pf: number;
}

interface BoxScoreData {
  game: {
    id: number;
    round: number;
    home_team: string;
    away_team: string;
    home_score: number;
    away_score: number;
    went_to_ot: boolean;
  };
  players: BoxScorePlayer[];
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

export function BoxScoreView({ gameId }: { gameId: number | null }) {
  const [data, setData] = useState<BoxScoreData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (gameId === null) return;
    setLoading(true);
    fetch(`${API_BASE}/api/games/${gameId}/boxscore`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .finally(() => setLoading(false));
  }, [gameId]);

  if (gameId === null) return <p>왼쪽 목록에서 경기를 선택하세요.</p>;
  if (loading) return <p>박스스코어 불러오는 중...</p>;
  if (!data) return null;

  const { game, players } = data;
  const homePlayers = players.filter((p) => p.team_name === game.home_team);
  const awayPlayers = players.filter((p) => p.team_name === game.away_team);

  const renderTeam = (teamName: string, teamPlayers: BoxScorePlayer[]) => (
    <div style={{ marginBottom: "16px" }}>
      <h4>{teamName}</h4>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "14px" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #ccc" }}>
            <th style={{ textAlign: "left", padding: "4px" }}>선수</th>
            <th style={{ padding: "4px" }}>PTS</th>
            <th style={{ padding: "4px" }}>AST</th>
            <th style={{ padding: "4px" }}>REB</th>
            <th style={{ padding: "4px" }}>TOV</th>
            <th style={{ padding: "4px" }}>BLK</th>
            <th style={{ padding: "4px" }}>PF</th>
          </tr>
        </thead>
        <tbody>
          {teamPlayers.map((p) => (
            <tr key={p.name}>
              <td style={{ padding: "4px" }}>{p.name}</td>
              <td style={{ padding: "4px", textAlign: "center" }}>{p.pts}</td>
              <td style={{ padding: "4px", textAlign: "center" }}>{p.ast}</td>
              <td style={{ padding: "4px", textAlign: "center" }}>{p.reb}</td>
              <td style={{ padding: "4px", textAlign: "center" }}>{p.tov}</td>
              <td style={{ padding: "4px", textAlign: "center" }}>{p.blk}</td>
              <td style={{ padding: "4px", textAlign: "center" }}>{p.pf}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <h3>
        {game.home_team} {game.home_score} : {game.away_score} {game.away_team}
        {game.went_to_ot ? " (연장)" : ""}
      </h3>
      {renderTeam(game.home_team, homePlayers)}
      {renderTeam(game.away_team, awayPlayers)}
    </div>
  );
}
