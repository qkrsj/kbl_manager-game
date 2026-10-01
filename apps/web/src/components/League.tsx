import { useState } from "react";
import { useApi, Loading, ErrorBox, PlayerLink, TeamLink, Card, useApp } from "./common";
import type { Standing, LeaderBoard } from "../api";

export function StandingsTable({ rows, compact }: { rows: Standing[]; compact?: boolean }) {
  const { userTeamId } = useApp();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th><th>팀</th><th className="num">경기</th><th className="num">승</th><th className="num">패</th>
            <th className="num">승률</th><th className="num">승차</th>
            {!compact && <><th className="num">득점</th><th className="num">실점</th><th className="num">득실</th></>}
            <th>최근5</th><th>연속</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.team_id} className={s.team_id === userTeamId ? "mine" : ""}>
              <td>{s.rank}{s.rank <= 6 ? <span className="pill" style={{ marginLeft: 4 }}>PO</span> : null}</td>
              <td><TeamLink id={s.team_id} name={s.team_name} /></td>
              <td className="num">{s.games_played}</td><td className="num">{s.wins}</td><td className="num">{s.losses}</td>
              <td className="num">{s.win_pct.toFixed(3)}</td><td className="num">{s.games_behind === 0 ? "-" : s.games_behind}</td>
              {!compact && <>
                <td className="num">{s.games_played ? (s.points_for / s.games_played).toFixed(1) : "-"}</td>
                <td className="num">{s.games_played ? (s.points_against / s.games_played).toFixed(1) : "-"}</td>
                <td className="num">{s.points_for - s.points_against > 0 ? "+" : ""}{s.points_for - s.points_against}</td>
              </>}
              <td className="small">{s.last5.split("").map((c, i) => <span key={i} className={c === "W" ? "good" : "bad"}>{c}</span>)}</td>
              <td className="small">{s.streak}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LeaderMini({ board }: { board: LeaderBoard }) {
  return (
    <div className="card tight">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>{board.label}</b><span className="muted small">경기당</span>
      </div>
      {board.rows.length === 0 && <p className="muted small">기록 없음</p>}
      <table>
        <tbody>
          {board.rows.map((r, i) => (
            <tr key={r.player_id}>
              <td style={{ width: 18 }}>{i + 1}</td>
              <td><PlayerLink id={r.player_id} name={r.name} /><div className="muted small">{r.team_name}</div></td>
              <td className="num"><b>{r.value}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STAT_TABS = [
  ["pts", "득점"], ["reb", "리바운드"], ["ast", "어시스트"], ["stl", "스틸"], ["blk", "블록"], ["tpm", "3점슛"], ["eff", "공헌도"],
] as const;

function LeadersFull() {
  const [stat, setStat] = useState("pts");
  const [playoffs, setPlayoffs] = useState(false);
  const { data, error } = useApi<LeaderBoard>(`/api/leaders?stat=${stat}&limit=30&playoffs=${playoffs}`, [stat, playoffs]);
  return (
    <Card title="개인 순위" right={<label className="small"><input type="checkbox" checked={playoffs} onChange={(e) => setPlayoffs(e.target.checked)} /> 플레이오프</label>}>
      <div className="tabs">
        {STAT_TABS.map(([k, l]) => <button key={k} className={stat === k ? "active" : ""} onClick={() => setStat(k)}>{l}</button>)}
      </div>
      <ErrorBox error={error} />
      {!data ? <Loading /> : (
        <>
          <p className="muted small">규정 경기수: {data.minGames}경기 이상</p>
          <table>
            <thead><tr><th>#</th><th>선수</th><th>팀</th><th className="num">경기</th><th className="num">출전시간</th><th className="num">{data.label}</th></tr></thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={r.player_id}>
                  <td>{i + 1}</td><td><PlayerLink id={r.player_id} name={r.name} /></td><td>{r.team_name}</td>
                  <td className="num">{r.games}</td><td className="num">{r.min}</td><td className="num"><b>{r.value}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

interface Series {
  id: number; round: string; round_label: string; slot: string; best_of: number; higher_seed_wins: number; lower_seed_wins: number;
  higher_seed_team: string; lower_seed_team: string; winner_team: string | null;
}

export function PlayoffBracket() {
  const { data } = useApi<Series[]>("/api/franchise/playoffs");
  if (!data || data.length === 0) return <p className="muted">정규시즌 1~6위가 플레이오프에 진출합니다 (6강·4강 5전3선승, 챔피언결정전 7전4선승).</p>;
  const rounds = ["round1", "round2", "final"];
  return (
    <div className="grid cols-3">
      {rounds.map((r) => {
        const list = data.filter((s) => s.round === r);
        if (list.length === 0) return null;
        return (
          <div key={r} className="col">
            <b>{list[0].round_label}</b>
            {list.map((s) => (
              <div key={s.id} className="card tight">
                {[[s.higher_seed_team, s.higher_seed_wins], [s.lower_seed_team, s.lower_seed_wins]].map(([t, w]) => (
                  <div key={String(t)} className="row" style={{ justifyContent: "space-between", fontWeight: s.winner_team === t ? 700 : 400 }}>
                    <span>{t}{s.winner_team === t ? " ✔" : ""}</span><span>{w}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function LeagueView() {
  const { data, error } = useApi<Standing[]>("/api/standings");
  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title="팀 순위">
        <ErrorBox error={error} />
        {data ? <StandingsTable rows={data} /> : <Loading />}
      </Card>
      <Card title="플레이오프"><PlayoffBracket /></Card>
      <LeadersFull />
    </div>
  );
}
