import { useEffect, useMemo, useState } from "react";
import { useApi, Loading, ErrorBox, Card, Rating, PlayerLink, FatigueBar } from "./common";
import { api, INTENSITY_LABEL, REASON_LABEL } from "../api";
import type { TrainingPlan } from "../api";
import "./training.css";

type Mode = "rest" | "train";
type Intensity = TrainingPlan["intensity"];
interface Personal { mode: Mode | ""; focus: string; intensity: Intensity | "" }

interface TrainingData {
  plan: TrainingPlan;
  focuses: { key: string; label: string; attributes: string[] }[];
  players: {
    id: number; name: string; age: number; positionGroup: string; overall: number; potential: number | null; fatigue: number;
    injuredUntil: string | null; xp: number; xpLevel: number; growthRate: number;
    personalFocus: string | null; personalIntensity: Intensity | null; personalMode: Mode | null;
    effective: { mode: Mode; focus: string; intensity: Intensity };
  }[];
  recentChanges: { log_date: string; name: string; label: string; delta: number; reason: string }[];
}

const INTENSITIES: Intensity[] = ["light", "normal", "intense"];

/** 훈련: 팀 전체를 한 번에 정하거나, 선수마다 방식·초점·강도를 따로 정한다 (빈 칸 = 팀 계획을 따름) */
export function TrainingView() {
  const { data, error, reload } = useApi<TrainingData>("/api/franchise/training");
  const [plan, setPlan] = useState<TrainingPlan | null>(null);
  const [personal, setPersonal] = useState<Record<number, Personal>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState<Personal>({ mode: "", focus: "", intensity: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data) return;
    setPlan(data.plan);
    const p: Record<number, Personal> = {};
    data.players.forEach((x) => { p[x.id] = { mode: x.personalMode ?? "", focus: x.personalFocus ?? "", intensity: x.personalIntensity ?? "" }; });
    setPersonal(p);
    setDirty(false);
  }, [data]);

  const focusLabel = useMemo(() => new Map((data?.focuses ?? []).map((f) => [f.key, f.label])), [data]);
  if (error) return <ErrorBox error={error} />;
  if (!data || !plan) return <Loading />;

  const overrides = Object.values(personal).filter((p) => p.mode || p.focus || p.intensity).length;
  const setP = (id: number, patch: Partial<Personal>) => { setPersonal({ ...personal, [id]: { ...personal[id], ...patch } }); setDirty(true); };

  async function save(applyToAll = false) {
    try {
      await api("/api/franchise/training", {
        method: "PUT",
        body: {
          ...plan, applyToAll,
          personal: applyToAll ? undefined : Object.fromEntries(Object.entries(personal).map(([k, v]) => [k, { mode: v.mode || null, focus: v.focus || null, intensity: v.intensity || null }])),
        },
      });
      setMsg(applyToAll ? "전체 선수가 팀 훈련 계획을 똑같이 따릅니다" : "저장 완료 — 경기 없는 날 이 계획으로 훈련합니다");
      reload();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  function applyBulk() {
    const next = { ...personal };
    selected.forEach((id) => {
      next[id] = {
        mode: bulk.mode || next[id].mode,
        focus: bulk.focus || next[id].focus,
        intensity: bulk.intensity || next[id].intensity,
      };
    });
    setPersonal(next);
    setDirty(true);
    setSelected(new Set());
  }

  const toggleSel = (id: number) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };
  const maxRate = Math.max(...data.players.map((p) => p.growthRate), 0.001);
  const effective = (id: number) => {
    const p = personal[id];
    return { mode: (p?.mode || plan.mode) as Mode, focus: p?.focus || plan.focus, intensity: (p?.intensity || plan.intensity) as Intensity };
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      {msg && <div className="notice">{msg}</div>}

      <Card title="팀 전체 훈련" right={<span className="muted small">선수별 설정 {overrides}명</span>}>
        <div className="tr-team">
          <div className="tr-field">
            <span>방식</span>
            <div className="seg-light">
              <button className={plan.mode === "train" ? "on" : ""} onClick={() => setPlan({ ...plan, mode: "train" })}>훈련</button>
              <button className={plan.mode === "rest" ? "on" : ""} onClick={() => setPlan({ ...plan, mode: "rest" })}>휴식</button>
            </div>
          </div>
          <div className="tr-field">
            <span>강도</span>
            <div className="seg-light">
              {INTENSITIES.map((k) => <button key={k} className={plan.intensity === k ? "on" : ""} onClick={() => setPlan({ ...plan, intensity: k })}>{INTENSITY_LABEL[k]}</button>)}
            </div>
          </div>
        </div>
        <div className="tr-focus-grid">
          {data.focuses.map((f) => (
            <button key={f.key} className={`tr-focus ${plan.focus === f.key ? "on" : ""}`} onClick={() => setPlan({ ...plan, focus: f.key })}>
              <b>{f.label}</b><span>{f.attributes.join(" · ")}</span>
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => save(false)}>저장 (선수별 설정은 유지)</button>
          <button onClick={() => { if (confirm("선수별 설정을 모두 지우고, 전체 선수에게 이 팀 훈련을 똑같이 적용할까요?")) save(true); }}>전체 선수에게 똑같이 적용</button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          하루 성장치 = 나이(22세 이하 최고) × 잠재력 × 성실성 × 강도. 강하게 할수록 빨리 늘지만 피로와 부상 위험이 커집니다. 30세 이상은 운동능력이 조금씩 떨어집니다.
        </p>
      </Card>

      <Card title="선수별 훈련" right={dirty ? <button className="primary" onClick={() => save(false)}>변경 저장</button> : <span className="muted small">빈 칸 = 팀 훈련을 따름</span>}>
        <div className="tr-bulk">
          <span className="small"><b>{selected.size}</b>명 선택</span>
          <select value={bulk.mode} onChange={(e) => setBulk({ ...bulk, mode: e.target.value as Mode | "" })}>
            <option value="">방식 그대로</option><option value="train">훈련</option><option value="rest">휴식</option>
          </select>
          <select value={bulk.focus} onChange={(e) => setBulk({ ...bulk, focus: e.target.value })}>
            <option value="">초점 그대로</option>
            {data.focuses.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <select value={bulk.intensity} onChange={(e) => setBulk({ ...bulk, intensity: e.target.value as Intensity | "" })}>
            <option value="">강도 그대로</option>
            {INTENSITIES.map((k) => <option key={k} value={k}>{INTENSITY_LABEL[k]}</option>)}
          </select>
          <button disabled={selected.size === 0} onClick={applyBulk}>선택한 선수에게 적용</button>
          <button className="small" onClick={() => setSelected(new Set(data.players.filter((p) => p.age <= 24).map((p) => p.id)))}>24세 이하 선택</button>
          <button className="small" onClick={() => setSelected(new Set(data.players.filter((p) => p.fatigue >= 50).map((p) => p.id)))}>피로 높은 선수 선택</button>
          <button className="small" onClick={() => { setPersonal(Object.fromEntries(data.players.map((p) => [p.id, { mode: "", focus: "", intensity: "" }]))); setDirty(true); }}>전원 팀 훈련 따르기</button>
        </div>
        <div className="table-wrap">
          <table className="tr-table">
            <thead>
              <tr><th /><th>선수</th><th className="num">나이</th><th>OVR</th><th>잠재력</th><th>피로</th><th>방식</th><th>훈련 초점</th><th>강도</th><th>오늘 성장</th></tr>
            </thead>
            <tbody>
              {data.players.map((p) => {
                const own = personal[p.id] ?? { mode: "", focus: "", intensity: "" };
                const eff = effective(p.id);
                const custom = !!(own.mode || own.focus || own.intensity);
                return (
                  <tr key={p.id} className={custom ? "tr-custom" : ""}>
                    <td><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSel(p.id)} /></td>
                    <td><PlayerLink id={p.id} name={p.name} /> <span className="muted small">{p.positionGroup}</span>
                      {p.injuredUntil && <span className="pill red">부상</span>}{custom && <span className="pill">개인</span>}</td>
                    <td className="num">{p.age}</td><td><Rating value={p.overall} /></td><td>{p.potential ?? "-"}</td>
                    <td><FatigueBar fatigue={p.fatigue} /></td>
                    <td>
                      <select value={own.mode} onChange={(e) => setP(p.id, { mode: e.target.value as Mode | "" })}>
                        <option value="">팀({plan.mode === "rest" ? "휴식" : "훈련"})</option><option value="train">훈련</option><option value="rest">휴식</option>
                      </select>
                    </td>
                    <td>
                      <select value={own.focus} disabled={eff.mode === "rest"} onChange={(e) => setP(p.id, { focus: e.target.value })}>
                        <option value="">팀({focusLabel.get(plan.focus)})</option>
                        {data.focuses.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={own.intensity} disabled={eff.mode === "rest"} onChange={(e) => setP(p.id, { intensity: e.target.value as Intensity | "" })}>
                        <option value="">팀({INTENSITY_LABEL[plan.intensity]})</option>
                        {INTENSITIES.map((k) => <option key={k} value={k}>{INTENSITY_LABEL[k]}</option>)}
                      </select>
                    </td>
                    <td style={{ width: 110 }}>
                      {eff.mode === "rest" ? <span className="muted small">휴식 (회복↑)</span> : (
                        <><div className="small">{p.growthRate.toFixed(3)}/일</div><div className="bar green"><div style={{ width: `${(p.growthRate / maxRate) * 100}%` }} /></div></>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">"오늘 성장"은 저장된 설정 기준입니다. 바꾼 뒤 저장하면 다시 계산됩니다.</p>
      </Card>

      <Card title="최근 능력치 변화">
        {data.recentChanges.length === 0 ? <p className="muted">아직 변화가 없습니다.</p> : (
          <table>
            <tbody>
              {data.recentChanges.map((c, i) => (
                <tr key={i}><td className="small muted">{c.log_date}</td><td>{c.name}</td><td>{c.label}</td>
                  <td className={c.delta > 0 ? "good" : "bad"}>{c.delta > 0 ? "+" : ""}{c.delta}</td><td className="small muted">{REASON_LABEL[c.reason] ?? c.reason}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
