import { useState } from "react";
import { useApi, Loading, ErrorBox, Card, Rating, Bar, useApp, Modal } from "./common";
import { BoxScore } from "./BoxScore";
import { api, krw, usd, CONTRACT_TYPE_LABEL, REASON_LABEL, formatDate } from "../api";

interface PlayerDetail {
  id: number; name: string; position: string; position_group: string; nationality: string; team_name: string | null; team_id: number | null;
  height_cm: string | null; weight_kg: string | null; birth_date: string | null; age: number;
  draft_year: number | null; draft_overall_pick: number | null; draft_category: string | null;
  potential: number | null; work_ethic: number | null; injury_proneness: number | null;
  contract_type: string | null; salary_krw: number | null; salary_usd: number | null; fa_year: number | null; contract_source: string | null;
  fatigue: number | null; xp: number | null; xp_level: number | null; injured_until: string | null;
  ratings: { offense: number; defense: number; overall: number };
  attributes: { key: string; label: string; value: number }[];
  dailyTrainingGrowth: number | null; xpPerLevel: number;
  seasonStats: { label: string; playoffs: boolean; g: number; min: string; pts: string; reb: string; ast: string; stl: string; blk: string; tpm: string; fg_pct: string | null; tp_pct: string | null }[];
  recentGames: { game_id: number; game_date: string; home: string; away: string; home_score: number; away_score: number; min: string; pts: number; reb: number; ast: number; stl: number; blk: number; tpm: number }[];
  developmentLog: { log_date: string; label: string; delta: number; reason: string }[];
}

const OFFENSE = ["finishing", "dunking", "mid_range_shooting", "three_point_shooting", "free_throw_shooting", "ball_handling", "passing", "offensive_rebounding"];
const DEFENSE = ["steal", "shot_blocking", "defensive_rebounding", "strength", "speed"];
const PHYSICAL = ["stamina"];

const SOURCE_LABEL: Record<string, string> = {
  reported: "2026-27 보도 기준", estimated: "추정치", negotiated: "협상", arbitration: "보수 조정", fa: "FA 계약", rookie: "신인 계약", market: "시장 요구액",
};

function draftLabel(p: PlayerDetail): string {
  if (p.draft_category === "regional_signee") return "연고선수";
  if (p.draft_category === "foreign_or_naturalized") return "외국/귀화 (드래프트 무관)";
  if (!p.draft_overall_pick) return "정보 없음";
  const round = Math.ceil(p.draft_overall_pick / 10);
  return `${p.draft_year ?? "?"} ${round}라운드 (전체 ${p.draft_overall_pick}순위)`;
}

export function PlayerView({ id }: { id: number }) {
  const { go } = useApp();
  const { data: p, error } = useApi<PlayerDetail>(`/api/players/${id}`, [id]);
  const [box, setBox] = useState<number | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!p) return <Loading />;
  const attr = (k: string) => p.attributes.find((a) => a.key === k);
  const group = (keys: string[]) => keys.map((k) => attr(k)).filter(Boolean).map((a) => (
    <div key={a!.key} style={{ marginBottom: 6 }}>
      <div className="row small" style={{ justifyContent: "space-between" }}><span>{a!.label}</span><b>{a!.value}</b></div>
      <Bar value={a!.value - 40} max={59} />
    </div>
  ));
  const xpIn = (p.xp ?? 0) % p.xpPerLevel;

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>{p.name}</h2>
            <div className="muted">
              {p.team_id ? <a onClick={() => go({ name: "team", id: p.team_id! })}>{p.team_name}</a> : "FA (무소속)"} · {p.position} · {p.nationality}
              {p.contract_type && p.contract_type !== "domestic" && <span className="pill gray" style={{ marginLeft: 6 }}>{CONTRACT_TYPE_LABEL[p.contract_type]}</span>}
            </div>
            <div className="muted small">만 {p.age}세 · {p.height_cm ? `${Math.round(Number(p.height_cm))}cm` : "-"} / {p.weight_kg ? `${Math.round(Number(p.weight_kg))}kg` : "-"} · 드래프트: {draftLabel(p)}</div>
            {p.injured_until && <div className="bad small">부상 — {p.injured_until}까지 결장</div>}
          </div>
          <div className="row" style={{ gap: 10 }}>
            {[["오버롤", p.ratings.overall], ["공격", p.ratings.offense], ["수비", p.ratings.defense]].map(([l, v]) => (
              <div key={String(l)} className="card tight" style={{ textAlign: "center", minWidth: 80 }}>
                <div className="muted small">{l}</div><div style={{ fontSize: 26 }}><Rating value={Number(v)} /></div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid cols-3">
        <Card title="공격 세부">{group(OFFENSE)}</Card>
        <Card title="수비 세부">{group(DEFENSE)}</Card>
        <Card title="신체 · 성장">
          {group(PHYSICAL)}
          <div className="small col" style={{ gap: 4 }}>
            <div>잠재력 <b>{p.potential ?? "-"}</b> · 성실성 <b>{p.work_ethic ?? "-"}</b> · 부상 위험 <b>{p.injury_proneness ?? "-"}</b></div>
            <div>훈련 성장속도(보통 강도) <b>{p.dailyTrainingGrowth ?? "-"}</b>/일</div>
            <div>경험치 레벨 <b>Lv.{p.xp_level ?? 0}</b> ({xpIn}/{p.xpPerLevel})</div>
            <Bar value={xpIn} max={p.xpPerLevel} color="green" />
            <div>피로도 <b>{Math.round(p.fatigue ?? 0)}</b></div>
          </div>
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="계약">
          {p.contract_type ? (
            <div className="col small">
              <div>보수: <b>{p.contract_type === "domestic" ? krw(p.salary_krw) : usd(p.salary_usd)}</b> <span className="muted">({SOURCE_LABEL[p.contract_source ?? ""] ?? p.contract_source})</span></div>
              <div>FA 자격: <b>{p.fa_year}년 비시즌</b> ({p.fa_year ? `${p.fa_year - 1}-${String(p.fa_year).slice(2)} 시즌 종료 후` : ""})</div>
              <div className="muted">{p.contract_type === "domestic" ? "KBL 국내선수는 계약기간 중에도 매 시즌 보수를 재협상합니다." : "외국선수·아시아쿼터는 1년 단위로 계약합니다."}</div>
            </div>
          ) : <p className="muted">계약 없음</p>}
        </Card>
        <Card title="능력치 변화 기록">
          {p.developmentLog.length === 0 ? <p className="muted small">변화 없음</p> : (
            <div className="row small" style={{ gap: 4 }}>
              {p.developmentLog.map((d, i) => (
                <span key={i} className={`pill ${d.delta > 0 ? "green" : "red"}`} title={d.log_date}>{d.label} {d.delta > 0 ? "+" : ""}{d.delta} · {REASON_LABEL[d.reason]}</span>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="시즌 기록">
        {p.seasonStats.length === 0 ? <p className="muted">이 게임에서의 기록이 아직 없습니다.</p> : (
          <table>
            <thead><tr><th>시즌</th><th className="num">G</th><th className="num">분</th><th className="num">득점</th><th className="num">리바</th><th className="num">어시</th><th className="num">스틸</th><th className="num">블록</th><th className="num">3점</th><th className="num">FG%</th><th className="num">3P%</th></tr></thead>
            <tbody>
              {p.seasonStats.map((s) => (
                <tr key={`${s.label}${s.playoffs}`}><td>{s.label}{s.playoffs ? " PO" : ""}</td><td className="num">{s.g}</td><td className="num">{s.min}</td><td className="num"><b>{s.pts}</b></td><td className="num">{s.reb}</td>
                  <td className="num">{s.ast}</td><td className="num">{s.stl}</td><td className="num">{s.blk}</td><td className="num">{s.tpm}</td><td className="num">{s.fg_pct ?? "-"}</td><td className="num">{s.tp_pct ?? "-"}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {p.recentGames.length > 0 && (
          <>
            <h4 style={{ marginTop: 12 }}>최근 경기</h4>
            <table>
              <tbody>
                {p.recentGames.map((g) => (
                  <tr key={g.game_id} className="clickable" onClick={() => setBox(g.game_id)}>
                    <td className="small muted">{formatDate(g.game_date)}</td><td>{g.home} {g.home_score}:{g.away_score} {g.away}</td>
                    <td className="num">{Math.round(Number(g.min))}분</td><td className="num"><b>{g.pts}점</b></td><td className="num">{g.reb}리바</td><td className="num">{g.ast}어시</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
      {box && <Modal onClose={() => setBox(null)}><BoxScore gameId={box} /></Modal>}
    </div>
  );
}

export function PlayerSearch() {
  const { go } = useApp();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<{ id: number; name: string; team_name: string | null; position: string }[]>([]);
  async function search(v: string) {
    setQ(v);
    if (!v.trim()) return setRows([]);
    setRows(await api(`/api/players?q=${encodeURIComponent(v)}`).catch(() => []));
  }
  return (
    <div style={{ position: "relative" }}>
      <input placeholder="선수 검색" value={q} onChange={(e) => search(e.target.value)} style={{ width: 160 }} />
      {rows.length > 0 && (
        <div className="card tight" style={{ position: "absolute", right: 0, top: 34, zIndex: 20, width: 280, maxHeight: 320, overflowY: "auto" }}>
          {rows.map((r) => (
            <div key={r.id} style={{ padding: "3px 0" }}>
              <a onClick={() => { go({ name: "player", id: r.id }); setRows([]); setQ(""); }}>{r.name}</a> <span className="muted small">{r.team_name ?? "FA"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

