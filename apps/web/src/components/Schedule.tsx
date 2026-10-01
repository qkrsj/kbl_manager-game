import { useState } from "react";
import { useApi, Loading, ErrorBox, Card, Modal, useApp } from "./common";
import { BoxScore } from "./BoxScore";
import { formatDate } from "../api";

interface Game {
  id: number; game_date: string; home_team: string; away_team: string; home_team_id: number; away_team_id: number;
  home_score: number | null; away_score: number | null; went_to_ot: boolean; playoff_label: string | null; game_number_in_series: number | null;
}

export function ScheduleView() {
  const { userTeamId } = useApp();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const { data, error } = useApi<Game[]>(`/api/schedule?teamId=${scope === "all" ? "all" : ""}`, [scope]);
  const [box, setBox] = useState<number | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const byMonth = new Map<string, Game[]>();
  data.forEach((g) => {
    const k = g.game_date.slice(0, 7);
    byMonth.set(k, [...(byMonth.get(k) ?? []), g]);
  });
  const mine = data.filter((g) => g.home_score !== null && (g.home_team_id === userTeamId || g.away_team_id === userTeamId));
  const wins = mine.filter((g) => (g.home_team_id === userTeamId ? g.home_score! > g.away_score! : g.away_score! > g.home_score!)).length;

  return (
    <Card title="일정 / 결과" right={
      <div className="row">
        {scope === "mine" && <span className="muted small">{wins}승 {mine.length - wins}패</span>}
        <select value={scope} onChange={(e) => setScope(e.target.value as "mine" | "all")}><option value="mine">우리 팀</option><option value="all">전체 경기</option></select>
      </div>
    }>
      <p className="muted small">2026-27 KBL 일정 원칙(10/3 개막 · 4/11 종료 · 평일 1경기·주말 3경기 · FIBA 휴식기/올스타 브레이크)에 맞춰 생성된 일정입니다. 개막일 대진(KCC-LG, 소노-가스공사, 정관장-현대모비스)은 실제와 같습니다.</p>
      {[...byMonth.entries()].map(([month, games]) => (
        <div key={month} style={{ marginBottom: 12 }}>
          <h4>{month.replace("-", "년 ")}월</h4>
          <table>
            <tbody>
              {games.map((g) => {
                const isMine = g.home_team_id === userTeamId || g.away_team_id === userTeamId;
                const played = g.home_score !== null;
                let result = "";
                if (played && isMine) {
                  const won = g.home_team_id === userTeamId ? g.home_score! > g.away_score! : g.away_score! > g.home_score!;
                  result = won ? "승" : "패";
                }
                return (
                  <tr key={g.id} className={`clickable ${isMine && scope === "all" ? "mine" : ""}`} onClick={() => played && setBox(g.id)}>
                    <td className="small muted" style={{ width: 120 }}>{formatDate(g.game_date)}</td>
                    <td>{g.playoff_label && <span className="pill">{g.playoff_label} {g.game_number_in_series}차전</span>}</td>
                    <td style={{ textAlign: "right" }}>{g.home_team}</td>
                    <td className="num" style={{ width: 70, textAlign: "center" }}>{played ? <b>{g.home_score} : {g.away_score}</b> : <span className="muted">vs</span>}</td>
                    <td>{g.away_team}{g.went_to_ot ? " (OT)" : ""}</td>
                    <td className={result === "승" ? "good" : "bad"}><b>{result}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {box && <Modal onClose={() => setBox(null)}><BoxScore gameId={box} /></Modal>}
    </Card>
  );
}
