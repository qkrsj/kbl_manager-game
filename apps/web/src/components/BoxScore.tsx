import { useApi, Loading, ErrorBox, PlayerLink, pct } from "./common";
import { formatDate } from "../api";

interface BoxRow {
  player_id: number; name: string; team_id: number; team_name: string; min: string; pts: number; reb: number; oreb: number;
  ast: number; stl: number; blk: number; tov: number; pf: number; fgm: number; fga: number; tpm: number; tpa: number; ftm: number; fta: number;
}

export function BoxScoreTable({ rows }: { rows: BoxRow[] }) {
  const played = rows.filter((r) => Number(r.min) > 0);
  const total = played.reduce(
    (a, r) => ({ pts: a.pts + r.pts, reb: a.reb + r.reb, ast: a.ast + r.ast, stl: a.stl + r.stl, blk: a.blk + r.blk, tov: a.tov + r.tov, fgm: a.fgm + r.fgm, fga: a.fga + r.fga, tpm: a.tpm + r.tpm, tpa: a.tpa + r.tpa, ftm: a.ftm + r.ftm, fta: a.fta + r.fta }),
    { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0 }
  );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>선수</th><th className="num">분</th><th className="num">득점</th><th className="num">리바</th><th className="num">어시</th>
            <th className="num">스틸</th><th className="num">블록</th><th className="num">TO</th><th className="num">파울</th>
            <th className="num">야투</th><th className="num">3점</th><th className="num">자유투</th>
          </tr>
        </thead>
        <tbody>
          {played.map((r) => (
            <tr key={r.player_id}>
              <td><PlayerLink id={r.player_id} name={r.name} /></td>
              <td className="num">{Math.round(Number(r.min))}</td>
              <td className="num"><b>{r.pts}</b></td><td className="num">{r.reb}</td><td className="num">{r.ast}</td>
              <td className="num">{r.stl}</td><td className="num">{r.blk}</td><td className="num">{r.tov}</td><td className="num">{r.pf}</td>
              <td className="num">{r.fgm}-{r.fga}</td><td className="num">{r.tpm}-{r.tpa}</td><td className="num">{r.ftm}-{r.fta}</td>
            </tr>
          ))}
          <tr>
            <td><b>합계</b></td><td />
            <td className="num"><b>{total.pts}</b></td><td className="num">{total.reb}</td><td className="num">{total.ast}</td>
            <td className="num">{total.stl}</td><td className="num">{total.blk}</td><td className="num">{total.tov}</td><td />
            <td className="num">{pct(total.fgm, total.fga)}</td><td className="num">{pct(total.tpm, total.tpa)}</td><td className="num">{pct(total.ftm, total.fta)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function BoxScore({ gameId }: { gameId: number }) {
  const { data, error } = useApi<{ game: any; players: BoxRow[] }>(`/api/games/${gameId}/boxscore`, [gameId]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const g = data.game;
  if (g.home_score === null) return <p className="muted">아직 열리지 않은 경기입니다 ({formatDate(g.game_date)})</p>;
  return (
    <div className="col">
      <div className="scoreboard">
        <div className="team"><div>{g.home_team}</div><div className="score">{g.home_score}</div><div className="muted small">홈</div></div>
        <div className="muted">{formatDate(g.game_date)}{g.went_to_ot ? ` · ${g.ot_periods}OT` : ""}</div>
        <div className="team"><div>{g.away_team}</div><div className="score">{g.away_score}</div><div className="muted small">원정</div></div>
      </div>
      <h4>{g.home_team}</h4>
      <BoxScoreTable rows={data.players.filter((p) => p.team_id === g.home_team_id)} />
      <h4 style={{ marginTop: 12 }}>{g.away_team}</h4>
      <BoxScoreTable rows={data.players.filter((p) => p.team_id === g.away_team_id)} />
    </div>
  );
}
