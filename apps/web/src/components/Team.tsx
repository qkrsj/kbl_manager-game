import { useEffect, useState } from "react";
import { useApi, Loading, ErrorBox, Card, Rating, PlayerLink, FatigueBar, useApp } from "./common";
import { api, salaryLabel, krw, usd, CONTRACT_TYPE_LABEL, PACE_LABEL, THREE_LABEL, DEFENSE_LABEL } from "../api";
import type { RosterPlayer, Payroll, Coach } from "../api";

function RosterTable({ roster, date }: { roster: RosterPlayer[]; date?: string }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>선수</th><th>포지션</th><th className="num">나이</th><th>OVR</th><th>공격</th><th>수비</th><th>잠재력</th>
            <th className="num">G</th><th className="num">분</th><th className="num">득점</th><th className="num">리바</th><th className="num">어시</th>
            <th>보수</th><th className="num">FA</th><th>피로</th>
          </tr>
        </thead>
        <tbody>
          {roster.map((p) => (
            <tr key={p.id}>
              <td><PlayerLink id={p.id} name={p.name} /> {p.contractType !== "domestic" && <span className="pill gray">{CONTRACT_TYPE_LABEL[p.contractType]}</span>}
                {p.injuredUntil && (!date || p.injuredUntil > date) && <span className="pill red">부상</span>}</td>
              <td className="small">{p.position}</td><td className="num">{p.age}</td>
              <td><Rating value={p.overall} /></td><td><Rating value={p.offense} /></td><td><Rating value={p.defense} /></td>
              <td>{p.potential ?? "-"}</td>
              <td className="num">{p.stats?.g ?? 0}</td><td className="num">{p.stats?.min ?? "-"}</td><td className="num">{p.stats?.pts ?? "-"}</td>
              <td className="num">{p.stats?.reb ?? "-"}</td><td className="num">{p.stats?.ast ?? "-"}</td>
              <td>{salaryLabel(p)}</td><td className="num">{p.faYear ?? "-"}</td><td><FatigueBar fatigue={p.fatigue} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TeamView({ id }: { id: number }) {
  const { data, error } = useApi<{ team: { id: number; name: string }; coach: Coach; payroll: Payroll; roster: RosterPlayer[] }>(`/api/teams/${id}`, [id]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title={data.team.name}>
        <div className="row small" style={{ gap: 24 }}>
          <div><span className="muted">감독</span> <b>{data.coach.name}</b> — {data.coach.style}</div>
          <div><span className="muted">전술</span> 템포 {PACE_LABEL[data.coach.paceStyle]} · 3점 {THREE_LABEL[data.coach.threePointReliance]} · {DEFENSE_LABEL[data.coach.defenseScheme]}</div>
          <div><span className="muted">국내 보수 총액</span> {krw(data.payroll.domesticTotal)} ({Math.round(data.payroll.usageRatio * 1000) / 10}%)</div>
          <div><span className="muted">외국선수</span> {usd(data.payroll.foreignTotalUsd)}</div>
        </div>
        <p className="muted small">{data.coach.description}</p>
      </Card>
      <Card title="로스터"><RosterTable roster={data.roster} /></Card>
    </div>
  );
}

/** 감독 AI 기준 추천값: 출전시간 상위 5명 선발, 나머지 출전시간 있는 선수 후보 */
function suggestedSetting(p: RosterPlayer, rankByMinutes: number) {
  const role = p.suggestedMinutes > 0 ? (rankByMinutes < 5 ? "starter" : "bench") : rankByMinutes < 12 ? "bench" : "inactive";
  return { role, minutesTarget: p.suggestedMinutes, offensePriority: null as number | null };
}

function suggestedAll(roster: RosterPlayer[]) {
  const order = [...roster].sort((a, b) => b.suggestedMinutes - a.suggestedMinutes);
  const out: Record<number, { role: string; minutesTarget: number | null; offensePriority: number | null }> = {};
  order.forEach((p, i) => { out[p.id] = suggestedSetting(p, i); });
  return out;
}

/** 내 팀: 로스터 + 출전시간/역할 설정 */
export function MyRosterView() {
  const { refresh } = useApp();
  const { data: roster, error, reload } = useApi<RosterPlayer[]>("/api/franchise/roster");
  const { data: fr } = useApi<{ date: string; phase: string; offseasonStage: string | null }>("/api/franchise");
  const [edit, setEdit] = useState<Record<number, { role: string; minutesTarget: number | null; offensePriority: number | null }>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!roster) return;
    const anyConfigured = roster.some((p) => p.role === "starter" || p.role === "bench");
    if (!anyConfigured) return setEdit(suggestedAll(roster));
    const next: typeof edit = {};
    roster.forEach((p) => {
      next[p.id] = { role: p.role ?? "bench", minutesTarget: p.minutesTarget ?? p.suggestedMinutes, offensePriority: p.offensePriority };
    });
    setEdit(next);
  }, [roster]);

  if (error) return <ErrorBox error={error} />;
  if (!roster) return <Loading />;

  const starters = roster.filter((p) => edit[p.id]?.role === "starter");
  const totalMin = roster.filter((p) => edit[p.id]?.role !== "inactive").reduce((a, p) => a + (Number(edit[p.id]?.minutesTarget) || 0), 0);
  const foreignMin = roster.filter((p) => p.contractType === "foreign" && edit[p.id]?.role !== "inactive").reduce((a, p) => a + (Number(edit[p.id]?.minutesTarget) || 0), 0);

  async function save() {
    setErr(null); setMsg(null);
    try {
      const r = await api<{ warning: string | null }>("/api/franchise/roster", {
        method: "PUT",
        body: { players: roster!.map((p) => ({ playerId: p.id, ...edit[p.id] })) },
      });
      setMsg(r.warning ?? "저장 완료");
      reload();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }

  async function release(p: RosterPlayer) {
    if (!confirm(`${p.name} 선수를 방출할까요? (FA 시장으로 나갑니다)`)) return;
    try {
      await api(`/api/offseason/release/${p.id}`, { body: {} });
      reload(); refresh();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }

  const set = (id: number, patch: Partial<(typeof edit)[number]>) => setEdit({ ...edit, [id]: { ...edit[id], ...patch } });
  const offseason = fr?.phase === "offseason";

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title="출전시간 / 역할 설정" right={<div className="row"><button onClick={() => setEdit(suggestedAll(roster))}>감독 추천값으로</button><button className="primary" onClick={save}>저장</button></div>}>
        <p className="small muted">
          선발 5명, 후보 5명 이상. 목표 출전시간에 맞춰 경기 중 자동 로테이션됩니다 (합계 200분 기준, 현재 {totalMin}분).
          외국선수는 1·4쿼터 1명, 2·3쿼터 2명까지 뛸 수 있어 합계 최대 60분입니다 (현재 {foreignMin}분{foreignMin > 60 ? " — 초과분은 규정상 뛸 수 없음" : ""}).
          공격 옵션 1~3순위를 지정하면 그 선수에게 공격이 집중됩니다.
        </p>
        <ErrorBox error={err} />
        {msg && <div className="notice">{msg}</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>선수</th><th>OVR</th><th>역할</th><th>목표 출전시간</th><th>공격 옵션</th><th>피로</th><th className="num">시즌 출전</th>{offseason && <th />}</tr></thead>
            <tbody>
              {roster.map((p) => (
                <tr key={p.id}>
                  <td><PlayerLink id={p.id} name={p.name} /> <span className="muted small">{p.positionGroup}{p.contractType !== "domestic" ? ` · ${CONTRACT_TYPE_LABEL[p.contractType]}` : ""}</span>
                    {p.injuredUntil && fr && p.injuredUntil > fr.date && <span className="pill red">부상 ~{p.injuredUntil}</span>}</td>
                  <td><Rating value={p.overall} /></td>
                  <td>
                    <select value={edit[p.id]?.role ?? "bench"} onChange={(e) => set(p.id, { role: e.target.value })}>
                      <option value="starter">선발</option><option value="bench">후보</option><option value="inactive">엔트리 제외</option>
                    </select>
                  </td>
                  <td><input type="number" min={0} max={40} value={edit[p.id]?.minutesTarget ?? ""} onChange={(e) => set(p.id, { minutesTarget: e.target.value === "" ? null : Number(e.target.value) })} /> 분</td>
                  <td>
                    <select value={edit[p.id]?.offensePriority ?? ""} onChange={(e) => set(p.id, { offensePriority: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">-</option><option value="1">1옵션</option><option value="2">2옵션</option><option value="3">3옵션</option>
                    </select>
                  </td>
                  <td><FatigueBar fatigue={p.fatigue} /></td>
                  <td className="num">{p.stats ? `${p.stats.g}경기 ${p.stats.min}분` : "-"}</td>
                  {offseason && <td><button className="small danger" onClick={() => release(p)}>방출</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">선발: {starters.map((p) => p.name).join(", ") || "-"} ({starters.length}/5)</p>
      </Card>
      <Card title="선수단 · 계약"><RosterTable roster={roster} date={fr?.date} /></Card>
    </div>
  );
}

/** 팀 전술 */
export function TacticsView() {
  const { data: roster } = useApi<RosterPlayer[]>("/api/franchise/roster");
  const { data, error } = useApi<any>("/api/franchise/tactics");
  const [t, setT] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (data) setT(data); }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!t || !roster) return <Loading />;
  async function save() {
    try {
      await api("/api/franchise/tactics", {
        method: "PUT",
        body: {
          paceStyle: t.pace_style, threePointReliance: t.three_point_reliance, defenseScheme: t.defense_scheme,
          reboundEmphasis: t.rebound_emphasis, defensiveStopperPlayerId: t.defensive_stopper_player_id, clutchCloserPlayerId: t.clutch_closer_player_id,
        },
      });
      setMsg("저장 완료");
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }
  return (
    <Card title="팀 전술 (기본값 — 경기별 게임플랜으로 덮어쓸 수 있음)">
      <div className="col" style={{ maxWidth: 520 }}>
        <label>템포 <select value={t.pace_style} onChange={(e) => setT({ ...t, pace_style: e.target.value })}>{Object.entries(PACE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <span className="muted small"> 빠르면 포제션 수↑ (경기당 득점·실점 모두 증가)</span></label>
        <label>3점슛 비중 <select value={t.three_point_reliance} onChange={(e) => setT({ ...t, three_point_reliance: e.target.value })}>{Object.entries(THREE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>수비 전술 <select value={t.defense_scheme} onChange={(e) => setT({ ...t, defense_scheme: e.target.value })}>{Object.entries(DEFENSE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label><input type="checkbox" checked={!!t.rebound_emphasis} onChange={(e) => setT({ ...t, rebound_emphasis: e.target.checked })} /> 리바운드 강조</label>
        <label>수비 스토퍼 (상대 에이스 전담 마크) <select value={t.defensive_stopper_player_id ?? ""} onChange={(e) => setT({ ...t, defensive_stopper_player_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">없음</option>{roster.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        <label>클러치 해결사 (4쿼터·연장 공격 집중) <select value={t.clutch_closer_player_id ?? ""} onChange={(e) => setT({ ...t, clutch_closer_player_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">없음</option>{roster.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        <div className="row"><button className="primary" onClick={save}>저장</button>{msg && <span className="muted">{msg}</span>}</div>
      </div>
    </Card>
  );
}
