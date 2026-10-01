import { useEffect, useState } from "react";
import { useApi, Loading, ErrorBox, Card, Rating, PlayerLink, FatigueBar } from "./common";
import { api, INTENSITY_LABEL, REASON_LABEL } from "../api";
import type { TrainingPlan } from "../api";

interface TrainingData {
  plan: TrainingPlan;
  focuses: { key: string; label: string; attributes: string[] }[];
  players: { id: number; name: string; age: number; positionGroup: string; overall: number; potential: number | null; fatigue: number;
    injuredUntil: string | null; personalFocus: string | null; xp: number; xpLevel: number; growthRate: number }[];
  recentChanges: { log_date: string; name: string; label: string; delta: number; reason: string }[];
}

export function TrainingView() {
  const { data, error, reload } = useApi<TrainingData>("/api/franchise/training");
  const [plan, setPlan] = useState<TrainingPlan | null>(null);
  const [focus, setFocus] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    setPlan(data.plan);
    const f: Record<number, string> = {};
    data.players.forEach((p) => { f[p.id] = p.personalFocus ?? ""; });
    setFocus(f);
  }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!data || !plan) return <Loading />;

  async function save() {
    try {
      await api("/api/franchise/training", { method: "PUT", body: { ...plan, personalFocus: Object.fromEntries(Object.entries(focus).map(([k, v]) => [k, v || null])) } });
      setMsg("저장 완료 — 경기 없는 날 이 계획으로 훈련합니다");
      reload();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  const maxRate = Math.max(...data.players.map((p) => p.growthRate), 0.001);
  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title="기본 훈련 계획" right={<button className="primary" onClick={save}>저장</button>}>
        <div className="row">
          <label><input type="radio" checked={plan.mode === "rest"} onChange={() => setPlan({ ...plan, mode: "rest" })} /> 휴식</label>
          <label><input type="radio" checked={plan.mode === "train"} onChange={() => setPlan({ ...plan, mode: "train" })} /> 훈련</label>
          <label>팀 훈련 초점 <select value={plan.focus} onChange={(e) => setPlan({ ...plan, focus: e.target.value })}>
            {data.focuses.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select></label>
          <label>강도 <select value={plan.intensity} onChange={(e) => setPlan({ ...plan, intensity: e.target.value as TrainingPlan["intensity"] })}>
            {Object.entries(INTENSITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
          {msg && <span className="small muted">{msg}</span>}
        </div>
        <p className="small muted">
          {data.focuses.map((f) => `${f.label}: ${f.attributes.join("·")}`).join("  /  ")}
        </p>
        <p className="small muted">
          하루 성장치 = 나이(22세 이하 최고, 33세 이상 최저) × 잠재력(드래프트 순위·나이·기록 추세) × 성실성 × 강도. 소수점 누적치가 1을 넘으면 능력치 +1.
          30세 이상은 매일 스피드·체력·덩크·파워 등 운동능력이 조금씩 떨어집니다. 경기에 뛰면 경험치가 쌓이고 레벨업 때 선수에게 맞는 능력치가 오릅니다.
        </p>
      </Card>

      <Card title="선수별 훈련">
        <div className="table-wrap">
          <table>
            <thead><tr><th>선수</th><th className="num">나이</th><th>OVR</th><th>잠재력</th><th>훈련 성장속도</th><th>경험치</th><th>피로</th><th>개인 훈련 초점</th></tr></thead>
            <tbody>
              {data.players.map((p) => (
                <tr key={p.id}>
                  <td><PlayerLink id={p.id} name={p.name} /> <span className="muted small">{p.positionGroup}</span>{p.injuredUntil && <span className="pill red">부상</span>}</td>
                  <td className="num">{p.age}</td><td><Rating value={p.overall} /></td><td>{p.potential ?? "-"}</td>
                  <td style={{ width: 120 }}><div className="small">{p.growthRate.toFixed(3)}/일</div><div className="bar green"><div style={{ width: `${(p.growthRate / maxRate) * 100}%` }} /></div></td>
                  <td className="small">Lv.{p.xpLevel} ({p.xp % 300}/300)</td>
                  <td><FatigueBar fatigue={p.fatigue} /></td>
                  <td>
                    <select value={focus[p.id] ?? ""} onChange={(e) => setFocus({ ...focus, [p.id]: e.target.value })}>
                      <option value="">팀 계획 따름</option>
                      {data.focuses.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
