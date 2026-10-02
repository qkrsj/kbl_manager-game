import { useEffect, useState } from "react";
import "./team.css";
import { useApi, Loading, ErrorBox, Card, Rating, PlayerLink, FatigueBar, useApp } from "./common";
import { api, salaryLabel, krw, usd, CONTRACT_TYPE_LABEL, PACE_LABEL, THREE_LABEL, DEFENSE_LABEL } from "../api";
import type { RosterPlayer, Payroll, Coach } from "../api";
import { LineupCourt } from "./LineupCourt";
import type { CourtItem } from "./LineupCourt";
import { assignSlots, slotFit, SLOT_LABELS } from "../lineup";

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
  return { role, minutesTarget: p.suggestedMinutes, offensePriority: null as number | null, lineupSlot: null as number | null };
}

function suggestedAll(roster: RosterPlayer[]) {
  const order = [...roster].sort((a, b) => b.suggestedMinutes - a.suggestedMinutes);
  const out: Record<number, RoleEdit> = {};
  order.forEach((p, i) => { out[p.id] = suggestedSetting(p, i); });
  return withSlots(roster, out, false);
}

type RoleEdit = { role: string; minutesTarget: number | null; offensePriority: number | null; lineupSlot: number | null };

/** 선발 선수마다 코트 칸(PG~C)을 하나씩 — 저장된 칸은 지키고(keepSaved), 나머지는 포지션에 맞게 자동 배치 */
function withSlots(roster: RosterPlayer[], edit: Record<number, RoleEdit>, keepSaved = true): Record<number, RoleEdit> {
  const starters = roster.filter((p) => edit[p.id]?.role === "starter");
  const fixed = new Map<number, number>();
  if (keepSaved) starters.forEach((p) => { const s = edit[p.id].lineupSlot; if (s) fixed.set(p.id, s); });
  const order = assignSlots(starters.map((p) => ({ key: p.id, position: p.position })), fixed);
  const next: Record<number, RoleEdit> = {};
  for (const p of roster) next[p.id] = { ...edit[p.id], lineupSlot: null };
  order.forEach((id, i) => { if (id !== null) next[id] = { ...next[id], lineupSlot: i + 1 }; });
  return next;
}

function MinutesRow({ p, e, onChange, onMove, date, offseason, onRelease }: {
  p: RosterPlayer; e: RoleEdit; date?: string; offseason: boolean;
  onChange: (patch: Partial<RoleEdit>) => void; onMove: (role: string) => void; onRelease: () => void;
}) {
  const min = Number(e.minutesTarget ?? 0);
  const injured = p.injuredUntil && date && p.injuredUntil > date;
  return (
    <div className={`mr ${e.role}`}>
      <Rating value={p.overall} />
      <div className="mr-name">
        <span><PlayerLink id={p.id} name={p.name} />{p.contractType !== "domestic" && <span className="pill gray">{CONTRACT_TYPE_LABEL[p.contractType]}</span>}{injured && <span className="pill red">부상</span>}</span>
        <small>{e.role === "starter" && e.lineupSlot ? <b className="mr-slot">{SLOT_LABELS[e.lineupSlot - 1]}</b> : null}{p.position} · {p.age}세{p.stats ? ` · 평균 ${p.stats.min}분 ${p.stats.pts}점` : ""}</small>
      </div>
      <div className="mr-fatigue" title={`피로도 ${Math.round(p.fatigue)}`}><FatigueBar fatigue={p.fatigue} /></div>
      {e.role !== "inactive" ? (
        <div className="mr-min">
          <button className="small" onClick={() => onChange({ minutesTarget: Math.max(0, min - 2) })}>−</button>
          <input type="range" min={0} max={40} step={1} value={min} onChange={(ev) => onChange({ minutesTarget: Number(ev.target.value) })} />
          <button className="small" onClick={() => onChange({ minutesTarget: Math.min(40, min + 2) })}>+</button>
          <b className="mr-min-val">{min}<small>분</small></b>
        </div>
      ) : <div className="mr-min muted small">경기에 나오지 않음</div>}
      <div className="mr-move">
        {e.role !== "starter" && <button className="small" onClick={() => onMove("starter")} title="선발로">▲ 선발</button>}
        {e.role !== "bench" && <button className="small" onClick={() => onMove("bench")} title="후보로">{e.role === "starter" ? "▼ 후보" : "▲ 후보"}</button>}
        {e.role !== "inactive" && <button className="small" onClick={() => onMove("inactive")} title="엔트리 제외">✕</button>}
        {offseason && <button className="small danger" onClick={onRelease}>방출</button>}
      </div>
    </div>
  );
}

/** 내 팀: 출전시간·역할 설정 (선발 / 후보 / 엔트리 제외로 나눠 보기 쉽게) */
export function MyRosterView() {
  const { refresh } = useApp();
  const { data: roster, error, reload } = useApi<RosterPlayer[]>("/api/franchise/roster");
  const { data: fr } = useApi<{ date: string; phase: string; offseasonStage: string | null }>("/api/franchise");
  const [edit, setEdit] = useState<Record<number, RoleEdit>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!roster) return;
    const anyConfigured = roster.some((p) => p.role === "starter" || p.role === "bench");
    if (!anyConfigured) { setEdit(suggestedAll(roster)); return; }
    const next: Record<number, RoleEdit> = {};
    roster.forEach((p) => {
      next[p.id] = { role: p.role ?? "bench", minutesTarget: p.minutesTarget ?? p.suggestedMinutes, offensePriority: p.offensePriority, lineupSlot: p.lineupSlot };
    });
    setEdit(withSlots(roster, next));
    setDirty(false);
  }, [roster]);

  if (error) return <ErrorBox error={error} />;
  if (!roster || Object.keys(edit).length === 0) return <Loading />;

  const roleOf = (p: RosterPlayer) => edit[p.id]?.role ?? "bench";
  const byMin = (a: RosterPlayer, b: RosterPlayer) => (Number(edit[b.id]?.minutesTarget) || 0) - (Number(edit[a.id]?.minutesTarget) || 0) || b.overall - a.overall;
  const starters = roster.filter((p) => roleOf(p) === "starter").sort((a, b) => (edit[a.id]?.lineupSlot ?? 9) - (edit[b.id]?.lineupSlot ?? 9) || byMin(a, b));
  const bench = roster.filter((p) => roleOf(p) === "bench").sort(byMin);
  const inactive = roster.filter((p) => roleOf(p) === "inactive").sort((a, b) => b.overall - a.overall);
  const active = [...starters, ...bench];
  const totalMin = active.reduce((a, p) => a + (Number(edit[p.id]?.minutesTarget) || 0), 0);
  const foreignMin = active.filter((p) => p.contractType === "foreign").reduce((a, p) => a + (Number(edit[p.id]?.minutesTarget) || 0), 0);
  const groupCount = (g: string) => starters.filter((p) => p.positionGroup === g).length;
  const offseason = fr?.phase === "offseason";

  const set = (id: number, patch: Partial<RoleEdit>) => { setEdit({ ...edit, [id]: { ...edit[id], ...patch } }); setDirty(true); };
  const minutesFor = (cur: number, role: string) => (role === "inactive" ? 0 : role === "starter" ? Math.max(cur, 24) : cur === 0 ? 10 : Math.min(cur, 24));
  const slotHolder = (slot: number) => starters.find((p) => edit[p.id]?.lineupSlot === slot) ?? null;

  /** 코트 칸에 선수 놓기: 선발끼리는 자리 바꾸기, 후보를 놓으면 원래 있던 선수와 역할·출전시간을 맞바꿈 */
  const place = (slot: number, id: number) => {
    const moving = edit[id];
    const occupant = slotHolder(slot);
    if (!moving || occupant?.id === id) return;
    const next = { ...edit };
    if (moving.role === "starter") {
      if (occupant) next[occupant.id] = { ...next[occupant.id], lineupSlot: moving.lineupSlot };
      next[id] = { ...moving, lineupSlot: slot };
    } else {
      const myMin = Number(moving.minutesTarget) || 0;
      if (occupant) {
        const theirMin = Number(next[occupant.id].minutesTarget) || 0;
        next[occupant.id] = { ...next[occupant.id], role: "bench", lineupSlot: null, minutesTarget: moving.role === "inactive" ? minutesFor(theirMin, "bench") : myMin };
        next[id] = { ...moving, role: "starter", lineupSlot: slot, minutesTarget: theirMin };
      } else {
        next[id] = { ...moving, role: "starter", lineupSlot: slot, minutesTarget: minutesFor(myMin, "starter") };
      }
    }
    setEdit(next); setDirty(true);
  };
  const move = (p: RosterPlayer, role: string) => {
    if (role === "starter") {
      // 빈 칸 중 포지션이 가장 맞는 곳, 빈 칸이 없으면 가장 맞는 칸의 선수와 교체
      const open = [1, 2, 3, 4, 5].filter((s) => !slotHolder(s));
      const pool = open.length ? open : [1, 2, 3, 4, 5];
      const best = pool.reduce((a, b) => (slotFit(p.position, b) < slotFit(p.position, a) ? b : a));
      place(best, p.id);
      return;
    }
    const cur = Number(edit[p.id]?.minutesTarget) || 0;
    set(p.id, { role, minutesTarget: minutesFor(cur, role), lineupSlot: null });
  };
  const toItem = (p: RosterPlayer): CourtItem => {
    const m = Number(edit[p.id]?.minutesTarget) || 0;
    const injured = !!(p.injuredUntil && fr?.date && p.injuredUntil > fr.date);
    return {
      key: String(p.id), name: p.name, position: p.position, overall: p.overall, foreign: p.contractType === "foreign",
      note: roleOf(p) === "inactive" ? "엔트리 제외" : `${m}분${injured ? " · 부상" : ""}`,
      detail: p.fatigue > 0 ? <FatigueBar fatigue={p.fatigue} /> : undefined,
    };
  };
  const courtSlots = [1, 2, 3, 4, 5].map((s) => { const h = slotHolder(s); return h ? toItem(h) : null; });
  const foreignStarters = starters.filter((p) => p.contractType === "foreign").length;
  const awkward = starters.filter((p) => slotFit(p.position, edit[p.id]?.lineupSlot ?? 3) >= 2);

  async function save() {
    setErr(null); setMsg(null);
    try {
      const r = await api<{ warning: string | null }>("/api/franchise/roster", {
        method: "PUT",
        body: { players: roster!.map((p) => ({ playerId: p.id, ...edit[p.id] })) },
      });
      setMsg(r.warning ?? "저장 완료 — 다음 경기부터 이 출전시간대로 로테이션합니다");
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

  const totalState = Math.abs(totalMin - 200) <= 10 ? "ok" : totalMin > 200 ? "over" : "under";
  const row = (p: RosterPlayer) => (
    <MinutesRow key={p.id} p={p} e={edit[p.id]} date={fr?.date} offseason={offseason}
      onChange={(patch) => set(p.id, patch)} onMove={(r) => move(p, r)} onRelease={() => release(p)} />
  );

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="mr-summary">
        <div className={`mr-stat ${totalState}`}>
          <span>출전시간 합계</span>
          <b>{totalMin}<small> / 200분</small></b>
          <div className="mr-meter"><div style={{ width: `${Math.min(100, (totalMin / 200) * 100)}%` }} /></div>
          <small>{totalState === "ok" ? "적정" : totalState === "over" ? `${totalMin - 200}분 많음 (비율대로 줄여서 적용)` : `${200 - totalMin}분 부족 (비율대로 늘려서 적용)`}</small>
        </div>
        <div className={`mr-stat ${foreignMin > 60 ? "over" : "ok"}`}>
          <span>외국선수 출전시간</span>
          <b>{foreignMin}<small> / 60분</small></b>
          <div className="mr-meter"><div style={{ width: `${Math.min(100, (foreignMin / 60) * 100)}%` }} /></div>
          <small>1·4쿼터 1명, 2·3쿼터 2명까지</small>
        </div>
        <div className={`mr-stat ${starters.length === 5 ? "ok" : "over"}`}>
          <span>선발</span>
          <b>{starters.length}<small> / 5명</small></b>
          <small>가드 {groupCount("G")} · 포워드 {groupCount("F")} · 센터 {groupCount("C")}</small>
        </div>
        <div className={`mr-stat ${bench.length >= 5 ? "ok" : "over"}`}>
          <span>후보</span>
          <b>{bench.length}<small>명</small></b>
          <small>5명 이상 · 엔트리 제외 {inactive.length}명</small>
        </div>
        <div className="mr-actions">
          <button onClick={() => { setEdit(suggestedAll(roster)); setDirty(true); }}>감독 추천값으로</button>
          <button className="primary" onClick={save}>{dirty ? "변경 저장" : "저장"}</button>
        </div>
      </div>
      <ErrorBox error={err} />
      {msg && <div className="notice">{msg}</div>}

      <Card title="선발 라인업 — 코트에 끌어다 놓기">
        <LineupCourt
          slots={courtSlots}
          pool={[...bench, ...inactive].map(toItem)}
          poolTitle={`후보 ${bench.length}명${inactive.length ? ` · 엔트리 제외 ${inactive.length}명` : ""}`}
          onPlace={(slot, key) => place(slot, Number(key))}
          onRemove={(slot) => { const h = slotHolder(slot); if (h) move(h, "bench"); }}
          footer={<p className="small muted" style={{ margin: 0 }}>후보를 선발 칸에 놓으면 원래 선수와 <b>역할·출전시간을 맞바꿉니다</b>. 코트의 선수를 이 목록으로 끌면 후보로 내려갑니다.</p>}
        />
        {foreignStarters > 1 && <p className="bad small">1쿼터에는 외국선수가 1명만 뛸 수 있습니다 — 선발 외국선수는 1명까지 (현재 {foreignStarters}명)</p>}
        {awkward.length > 0 && <p className="small" style={{ color: "var(--warn)" }}>포지션이 어색한 배치: {awkward.map((p) => p.name).join(", ")} — 뛸 수는 있지만 칸에 맞는 선수가 좋습니다</p>}
      </Card>

      <div className="mr-dist" title="출전시간 분배">
        {active.map((p) => {
          const m = Number(edit[p.id]?.minutesTarget) || 0;
          return m > 0 ? <div key={p.id} className={`mr-seg ${roleOf(p)}`} style={{ flexGrow: m }} title={`${p.name} ${m}분`}><span>{p.name} {m}</span></div> : null;
        })}
      </div>

      <Card title={`선발 ${starters.length}명`}>
        <div className="mr-list">{starters.map(row)}{starters.length === 0 && <p className="muted small">위 코트에 선수를 끌어다 놓으세요</p>}</div>
      </Card>
      <Card title={`후보 ${bench.length}명`}>
        <div className="mr-list">{bench.map(row)}</div>
      </Card>
      {inactive.length > 0 && (
        <Card title={`엔트리 제외 ${inactive.length}명`}>
          <div className="mr-list">{inactive.map(row)}</div>
        </Card>
      )}
      <p className="small muted">경기 중에는 목표 출전시간과 체력에 맞춰 자동으로 교체됩니다. 공격 1·2·3옵션은 <b>전술</b> 탭에서 정합니다.</p>
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
  const options: (number | null)[] = [t.option1_player_id ?? null, t.option2_player_id ?? null, t.option3_player_id ?? null];
  const auto: number[] = t.auto_options ?? [];
  const nameOf = (id: number | null) => roster.find((p) => p.id === id)?.name ?? "-";
  const setOption = (i: number, id: number | null) => {
    const next = [...options];
    // 같은 선수를 다른 옵션에 두면 그 자리는 비움
    next.forEach((v, j) => { if (v === id && j !== i) next[j] = null; });
    next[i] = id;
    setT({ ...t, option1_player_id: next[0], option2_player_id: next[1], option3_player_id: next[2] });
  };
  async function save() {
    try {
      await api("/api/franchise/tactics", {
        method: "PUT",
        body: {
          paceStyle: t.pace_style, threePointReliance: t.three_point_reliance, defenseScheme: t.defense_scheme,
          reboundEmphasis: t.rebound_emphasis, defensiveStopperPlayerId: t.defensive_stopper_player_id, clutchCloserPlayerId: t.clutch_closer_player_id,
          offenseOptions: options,
        },
      });
      setMsg("저장 완료");
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }
  const sorted = [...roster].sort((a, b) => b.offense - a.offense);
  const LABEL = ["1옵션 (에이스)", "2옵션", "3옵션"];
  const SHARE = ["공격 비중 가장 높음 — 득점 리더", "두 번째 공격 루트", "세 번째 공격 루트"];
  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title="공격 옵션 (1·2·3옵션)" right={<button className="primary" onClick={save}>저장</button>}>
        <p className="small muted" style={{ marginTop: 0 }}>
          지정한 선수 위주로 공을 돌리고 슛 기회를 줍니다. 1옵션은 확실히 많이, 2·3옵션은 단계적으로 덜 — 세 명 모두 20점대가 나오지는 않고 보통 1옵션 20점 안팎, 2옵션 10점대 중후반, 3옵션 10점 안팎이 됩니다.
          비워 두면 공격 능력치·득점력 순으로 자동 지정됩니다.
        </p>
        <div className="opt-grid">
          {options.map((id, i) => (
            <div key={i} className={`opt-slot o${i + 1}`}>
              <span className="opt-rank">{i + 1}</span>
              <div className="opt-body">
                <b>{LABEL[i]}</b>
                <small>{SHARE[i]}</small>
                <select value={id ?? ""} onChange={(e) => setOption(i, e.target.value ? Number(e.target.value) : null)}>
                  <option value="">자동 ({nameOf(auto[i] ?? null)})</option>
                  {sorted.map((p) => <option key={p.id} value={p.id}>{p.name} — 공격 {p.offense}{p.stats ? ` · ${p.stats.pts}점` : ""}</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="팀 전술 (기본값 — 경기별 게임플랜으로 덮어쓸 수 있음)" right={<div className="row">{msg && <span className="muted small">{msg}</span>}<button className="primary" onClick={save}>저장</button></div>}>
        <div className="tac-grid">
          <div className="tac-item"><span>템포</span>
            <div className="seg-light">{Object.entries(PACE_LABEL).map(([k, v]) => <button key={k} className={t.pace_style === k ? "on" : ""} onClick={() => setT({ ...t, pace_style: k })}>{v}</button>)}</div>
            <small className="muted">빠르면 포제션 수↑ (득점·실점 모두 증가)</small></div>
          <div className="tac-item"><span>3점슛 비중</span>
            <div className="seg-light">{Object.entries(THREE_LABEL).map(([k, v]) => <button key={k} className={t.three_point_reliance === k ? "on" : ""} onClick={() => setT({ ...t, three_point_reliance: k })}>{v}</button>)}</div></div>
          <div className="tac-item"><span>수비 전술</span>
            <div className="seg-light">{Object.entries(DEFENSE_LABEL).map(([k, v]) => <button key={k} className={t.defense_scheme === k ? "on" : ""} onClick={() => setT({ ...t, defense_scheme: k })}>{v}</button>)}</div>
            <small className="muted">지역방어: 골밑 실점↓ 3점 허용↑ · 압박: 턴오버 유도↑ 체력 소모↑</small></div>
          <div className="tac-item"><span>리바운드 강조</span>
            <label><input type="checkbox" checked={!!t.rebound_emphasis} onChange={(e) => setT({ ...t, rebound_emphasis: e.target.checked })} /> 리바운드 경합에 가담</label></div>
          <div className="tac-item"><span>수비 스토퍼</span>
            <select value={t.defensive_stopper_player_id ?? ""} onChange={(e) => setT({ ...t, defensive_stopper_player_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">없음</option>{roster.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select><small className="muted">상대 에이스를 포지션 상관없이 전담 마크</small></div>
          <div className="tac-item"><span>클러치 해결사</span>
            <select value={t.clutch_closer_player_id ?? ""} onChange={(e) => setT({ ...t, clutch_closer_player_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">없음</option>{roster.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select><small className="muted">4쿼터·연장에 공격을 몰아줌</small></div>
        </div>
      </Card>
    </div>
  );
}
