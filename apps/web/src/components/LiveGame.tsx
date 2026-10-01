import { useEffect, useState } from "react";
import { Loading, ErrorBox, Card, Rating, useApp, Bar } from "./common";
import { api, PACE_LABEL, THREE_LABEL, DEFENSE_LABEL, REASON_LABEL } from "../api";
import type { DevChange } from "../api";

interface LivePlayer { name: string; positionGroup: string; isForeign: boolean; overall: number; targetMinutes: number; energy: number; fouls: number }
interface LiveBox { name: string; MIN: number; PTS: number; REB: number; AST: number; STL: number; BLK: number; TOV: number; PF: number; FGM: number; FGA: number; TPM: number; TPA: number; FTM: number; FTA: number }
interface LiveSide {
  name: string; score: number; quarterScores: number[]; onCourt: string[]; manualLineup: string[] | null;
  context: { defenseScheme: string; threeWeightMultiplier?: number; reboundEmphasis?: boolean; doubleTeamTarget?: string | null };
  paceFactor: number; players: LivePlayer[]; box: LiveBox[];
}
interface LiveState {
  sessionId: string; gameId: number; userSide: "home" | "away"; nextQuarter: number; segmentsPlayed: number; finished: boolean;
  home: LiveSide; away: LiveSide;
  log: { quarter: number; clock: string; team: string; text: string; homeScore: number; awayScore: number; scoring: boolean }[];
  developmentChanges?: DevChange[];
}

const quarterLabel = (q: number) => (q >= 5 ? `연장 ${q - 4}` : `${q}쿼터`);
const maxForeign = (q: number) => (q === 2 || q === 3 ? 2 : 1);
const paceKey = (f: number) => (f > 1.05 ? "fast" : f < 0.95 ? "slow" : "normal");
const threeKey = (m?: number) => (!m ? "normal" : m > 1.1 ? "high" : m < 0.9 ? "low" : "normal");

function BoxTable({ side }: { side: LiveSide }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>선수</th><th className="num">분</th><th className="num">득점</th><th className="num">리바</th><th className="num">어시</th><th className="num">스틸</th><th className="num">블록</th><th className="num">TO</th><th className="num">파울</th><th className="num">야투</th><th className="num">3점</th><th className="num">FT</th></tr></thead>
        <tbody>
          {side.box.filter((b) => b.MIN > 0).sort((a, b) => b.MIN - a.MIN).map((b) => (
            <tr key={b.name} className={side.onCourt.includes(b.name) ? "mine" : ""}>
              <td>{b.name}</td><td className="num">{Math.round(b.MIN)}</td><td className="num"><b>{b.PTS}</b></td><td className="num">{b.REB}</td>
              <td className="num">{b.AST}</td><td className="num">{b.STL}</td><td className="num">{b.BLK}</td><td className="num">{b.TOV}</td>
              <td className={`num ${b.PF >= 4 ? "bad" : ""}`}>{b.PF}</td><td className="num">{b.FGM}-{b.FGA}</td><td className="num">{b.TPM}-{b.TPA}</td><td className="num">{b.FTM}-{b.FTA}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LiveGameView({ sessionId }: { sessionId: string }) {
  const { go, refresh } = useApp();
  const [state, setState] = useState<LiveState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[] | null>(null); // null = 자동 로테이션
  const [tab, setTab] = useState<"mine" | "opp">("mine");

  useEffect(() => {
    api<LiveState>(`/api/live/${sessionId}`).then(setState).catch((e) => setErr(String(e.message)));
  }, [sessionId]);

  if (err && !state) return <div><ErrorBox error={err} /><button onClick={() => go({ name: "today" })}>오늘 화면으로</button></div>;
  if (!state) return <Loading />;

  const mine = state[state.userSide];
  const opp = state[state.userSide === "home" ? "away" : "home"];
  const q = state.nextQuarter;
  const foreignSelected = (selected ?? []).filter((n) => mine.players.find((p) => p.name === n)?.isForeign).length;

  async function step(mode: "segment" | "quarter" | "end", tactics?: Record<string, unknown>) {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = { mode, lineup: selected, tactics };
      const s = await api<LiveState>(`/api/live/${sessionId}/step`, { body });
      setState(s);
      if (s.finished) refresh();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function changeTactics(t: Record<string, unknown>) {
    try {
      setState(await api<LiveState>(`/api/live/${sessionId}/update`, { body: { tactics: t } }));
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }

  function toggle(name: string) {
    const cur = selected ?? [...mine.onCourt];
    setSelected(cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]);
  }

  const lineupError = selected && (selected.length !== 5 ? `5명을 선택하세요 (현재 ${selected.length}명)` : foreignSelected > maxForeign(q) ? `${quarterLabel(q)}에는 외국선수 최대 ${maxForeign(q)}명` : null);

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card>
        <div className="scoreboard">
          <div className="team"><div><b>{state.home.name}</b></div><div className="score">{state.home.score}</div></div>
          <div className="col" style={{ alignItems: "center" }}>
            <span className="pill">{state.finished ? "경기 종료" : state.segmentsPlayed === 0 ? "경기 전" : `${quarterLabel(q)} ${state.segmentsPlayed % 2 === 1 && q < 5 ? "후반 5분" : "시작"} 전`}</span>
            <table style={{ width: "auto" }}>
              <thead><tr><th />{state.home.quarterScores.map((_, i) => <th key={i} className="num">{i < 4 ? i + 1 : `OT${i - 3}`}</th>)}</tr></thead>
              <tbody>
                {[state.home, state.away].map((s) => <tr key={s.name}><td className="small">{s.name.split(" ").slice(0, 2).join(" ")}</td>{s.quarterScores.map((v, i) => <td key={i} className="num">{v}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
          <div className="team"><div><b>{state.away.name}</b></div><div className="score">{state.away.score}</div></div>
        </div>
      </Card>

      <ErrorBox error={err} />

      {state.finished ? (
        <Card title="경기 종료">
          <p className="big">{mine.score > opp.score ? "🎉 승리!" : "패배"}</p>
          {state.developmentChanges && state.developmentChanges.length > 0 && (
            <div className="row small" style={{ gap: 6 }}>
              {state.developmentChanges.map((c, i) => <span key={i} className="pill green">{c.name} {c.label} +{c.delta} ({REASON_LABEL[c.reason]})</span>)}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => go({ name: "today" })}>오늘 화면으로 (다음 날 진행)</button>
          </div>
        </Card>
      ) : (
        <div className="grid cols-2">
          <Card title={`작전 타임 — 다음: ${quarterLabel(q)}`} right={<span className="small muted">외국선수 최대 {maxForeign(q)}명</span>}>
            <div className="col">
              <div className="row">
                <label>템포 <select value={paceKey(mine.paceFactor)} onChange={(e) => changeTactics({ paceStyle: e.target.value })}>
                  {Object.entries(PACE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></label>
                <label>3점 <select value={threeKey(mine.context.threeWeightMultiplier)} onChange={(e) => changeTactics({ threePointReliance: e.target.value })}>
                  {Object.entries(THREE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></label>
                <label>수비 <select value={mine.context.defenseScheme} onChange={(e) => changeTactics({ defenseScheme: e.target.value })}>
                  {Object.entries(DEFENSE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></label>
              </div>
              <div className="row">
                <label>더블팀 <select value={mine.context.doubleTeamTarget ?? ""} onChange={(e) => changeTactics({ doubleTeamTarget: e.target.value || null })}>
                  <option value="">없음</option>
                  {opp.players.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select></label>
                <label><input type="checkbox" checked={!!mine.context.reboundEmphasis} onChange={(e) => changeTactics({ reboundEmphasis: e.target.checked })} /> 리바운드 강조</label>
              </div>
              <div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b>라인업 {selected ? "(직접 지정)" : "(자동 로테이션)"}</b>
                  {selected && <button className="small" onClick={() => setSelected(null)}>자동으로 되돌리기</button>}
                </div>
                <table>
                  <thead><tr><th /><th>선수</th><th>OVR</th><th>체력</th><th className="num">파울</th><th className="num">목표</th></tr></thead>
                  <tbody>
                    {[...mine.players].sort((a, b) => Number(mine.onCourt.includes(b.name)) - Number(mine.onCourt.includes(a.name)) || b.targetMinutes - a.targetMinutes).map((p) => {
                      const on = (selected ?? mine.onCourt).includes(p.name);
                      return (
                        <tr key={p.name} className="clickable" onClick={() => p.fouls < 5 && toggle(p.name)}>
                          <td><input type="checkbox" readOnly checked={on} disabled={p.fouls >= 5} /></td>
                          <td>{p.name} <span className="muted small">{p.positionGroup}{p.isForeign ? " · 외국" : ""}</span></td>
                          <td><Rating value={p.overall} /></td>
                          <td style={{ width: 80 }}><Bar value={p.energy} color={p.energy < 50 ? "red" : p.energy < 70 ? "orange" : "green"} /></td>
                          <td className={`num ${p.fouls >= 4 ? "bad" : ""}`}>{p.fouls >= 5 ? "퇴장" : p.fouls}</td>
                          <td className="num small">{Math.round(p.targetMinutes)}분</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {lineupError && <p className="bad small">{lineupError}</p>}
              </div>
              <div className="row">
                <button className="primary" disabled={busy || !!lineupError} onClick={() => step("segment")}>5분 진행 ▶</button>
                <button disabled={busy || !!lineupError} onClick={() => step("quarter")}>쿼터 끝까지 ⏩</button>
                <button disabled={busy || !!lineupError} onClick={() => step("end")}>경기 끝까지 ⏭</button>
              </div>
            </div>
          </Card>
          <Card title="중계">
            <div className="pbp">
              {[...state.log].reverse().map((l, i) => (
                <div key={i} className={l.scoring ? "scoring" : ""}>
                  <span className="muted small">{quarterLabel(l.quarter)} {l.clock}</span> [{l.team.split(" ").slice(0, 2).join(" ")}] {l.text}
                  <span className="muted small"> ({l.homeScore}-{l.awayScore})</span>
                </div>
              ))}
              {state.log.length === 0 && <p className="muted">경기 시작 전입니다. 선발 라인업과 전술을 확인하고 진행하세요.</p>}
            </div>
          </Card>
        </div>
      )}

      <Card>
        <div className="tabs">
          <button className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>{mine.name}</button>
          <button className={tab === "opp" ? "active" : ""} onClick={() => setTab("opp")}>{opp.name}</button>
        </div>
        <BoxTable side={tab === "mine" ? mine : opp} />
      </Card>
    </div>
  );
}
