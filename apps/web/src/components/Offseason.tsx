import { Fragment, useState } from "react";
import { useApi, Loading, ErrorBox, Card, Rating, PlayerLink, Bar, useApp } from "./common";
import { api, krw, usd, CONTRACT_TYPE_LABEL } from "../api";
import "./offseason.css";
import type { Payroll } from "../api";

interface Negotiation {
  id: number; kind: "salary" | "fa_resign" | "foreign_resign"; asking_amount: number; asking_years: number; last_offer: number | null;
  last_offer_years: number | null; rounds: number; status: string; fair_value: number; message: string | null;
  player_id: number; name: string; position_group: string; age: number; contract_type: string; salary_krw: number | null; salary_usd: number | null;
  history: { round: number; offer?: number; ask: number; mood?: string }[] | null;
  mood: string | null;
  ruling: Ruling | null;
}

interface Ruling {
  amount: number; side: "player" | "team" | "middle"; recordValue: number; playerAsk: number; teamOffer: number; current: number;
  stats: { games: number; mpg: number; ppg: number; rpg: number; apg: number; eff: number; pct: number };
  comps: { name: string; team: string | null; salary: number; ppg: number; rpg: number; apg: number; games: number }[];
  reasons: string[]; summary: string;
}

interface Overview {
  stage: string | null; faDay: number; faDays: number; endYear: number; payroll: Payroll; maxRounds: number;
  negotiations: Negotiation[];
  transactions: { kind: string; description: string; team_name: string | null }[];
}

interface FreeAgent {
  id: number; name: string; position: string; positionGroup: string; nationality: string; age: number; contractType: string;
  previousTeam: string | null; previousSalary: number; overall: number; offense: number; defense: number; potential: number | null;
  ppg: number; rpg: number; apg: number; askingAmount: number; desiredYears: number; offers: number; myOffer: number | null;
  myOfferYears: number | null; compensation: { tier: string; amount: number }; isGenerated: boolean;
}

const KIND_LABEL = { salary: "연봉협상", fa_resign: "FA 재계약", foreign_resign: "외국선수 재계약" };
const STATUS_LABEL: Record<string, string> = { open: "협상 중", accepted: "계약 완료", declined: "결렬", arbitration: "보수 조정 판결" };

const money = (type: string, v: number | null) => (type === "domestic" ? krw(v) : usd(v));

function PayrollBar({ payroll }: { payroll: Payroll }) {
  const pctv = Math.round(payroll.usageRatio * 1000) / 10;
  return (
    <div className="row small" style={{ gap: 24 }}>
      <div style={{ minWidth: 260 }}>
        국내 보수 {krw(payroll.domesticTotal)} / 30억 ({pctv}%) · 잔여 {krw(Math.max(0, payroll.capRoom))}
        <Bar value={pctv} color={pctv > 100 ? "red" : pctv < 70 ? "orange" : "green"} />
      </div>
      <div>국내선수 {payroll.domesticCount}명 (12~18명)</div>
      <div>외국선수 {payroll.foreignCount}/2명 · {usd(payroll.foreignTotalUsd)} / $1,000,000</div>
      <div>아시아쿼터 {payroll.asiaCount}/1명</div>
    </div>
  );
}

const MOOD_CLASS: Record<string, string> = { 만족: "green", 타협: "green", "거의 합의": "green", "좁혀지는 중": "orange", "격차 큼": "red", 불쾌: "red", 결렬: "red" };

/** 보수 조정 판결문 */
function RulingCard({ r }: { r: Ruling }) {
  const sideLabel = r.side === "player" ? "선수 측 승" : r.side === "team" ? "구단 측 승" : "절충";
  const lo = Math.min(r.teamOffer, r.playerAsk), hi = Math.max(r.teamOffer, r.playerAsk);
  const pos = (v: number) => (hi > lo ? Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)) : 50);
  return (
    <div className={`ruling ${r.side}`}>
      <div className="ruling-head">
        <span>⚖️ KBL 재정위원회 보수 조정 판결</span>
        <b>{krw(r.amount)}</b>
        <span className={`pill ${r.side === "team" ? "green" : r.side === "player" ? "red" : "gray"}`}>{sideLabel}</span>
      </div>
      <div className="ruling-scale">
        <div className="rs-track">
          <i className="rs-mark team" style={{ left: "0%" }} />
          <i className="rs-mark player" style={{ left: "100%" }} />
          <i className="rs-record" style={{ left: `${pos(r.recordValue)}%` }} title="기록으로 본 적정 보수" />
          <i className="rs-final" style={{ left: `${pos(r.amount)}%` }} />
        </div>
        <div className="rs-labels"><span>구단 제시 {krw(r.teamOffer)}</span><span>기록 가치 {krw(r.recordValue)}</span><span>선수 요구 {krw(r.playerAsk)}</span></div>
      </div>
      <p className="ruling-summary">{r.summary}</p>
      <ul className="ruling-reasons">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
      {r.comps.length > 0 && (
        <table className="ruling-comps">
          <thead><tr><th>비교 선수 (기록 비슷)</th><th className="num">경기</th><th className="num">득점</th><th className="num">리바</th><th className="num">어시</th><th className="num">보수</th></tr></thead>
          <tbody>{r.comps.map((c) => (
            <tr key={c.name}><td>{c.name} <span className="muted small">{c.team ?? ""}</span></td><td className="num">{c.games}</td><td className="num">{c.ppg.toFixed(1)}</td><td className="num">{c.rpg.toFixed(1)}</td><td className="num">{c.apg.toFixed(1)}</td><td className="num">{krw(c.salary)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function NegotiationRow({ n, maxRounds, onDone }: { n: Negotiation; maxRounds: number; onDone: () => void }) {
  const isKrw = n.contract_type === "domestic";
  const current = isKrw ? n.salary_krw : n.salary_usd;
  // 첫 제시 기본값: 현재 보수 (이후엔 지난 제시액)
  const [amount, setAmount] = useState<number>(() => n.last_offer ?? current ?? n.asking_amount);
  const [years, setYears] = useState<number>(n.asking_years);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  async function call(path: string, body: Record<string, unknown>) {
    setErr(null); setBusy(true);
    try {
      await api(path, { body });
      onDone();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  const history = (n.history ?? []).filter((h) => h.round > 0);
  const step = isKrw ? 100 : 10000;
  const change = current ? (n.asking_amount - current) / current : 0;
  return (
    <Fragment>
      <tr className={`neg-row ${n.status}`}>
        <td><PlayerLink id={n.player_id} name={n.name} /> <span className="muted small">{n.position_group} · {n.age}세</span></td>
        <td><span className="pill gray">{KIND_LABEL[n.kind]}</span></td>
        <td>{money(n.contract_type, current)}</td>
        <td>
          <b>{money(n.contract_type, n.asking_amount)}</b>{n.kind === "fa_resign" ? ` · ${n.asking_years}년` : ""}
          {current ? <small className={change > 0.02 ? "bad" : change < -0.02 ? "good" : "muted"}> ({change >= 0 ? "+" : ""}{Math.round(change * 100)}%)</small> : null}
        </td>
        <td className="muted small">{money(n.contract_type, n.fair_value)}</td>
        <td>
          {n.status === "open" ? (
            <div className="neg-actions">
              <div className="row" style={{ gap: 4 }}>
                <button className="small" onClick={() => setAmount(Math.max(step, amount - step * (isKrw ? 5 : 1)))}>−</button>
                <input type="number" step={step} value={amount} onChange={(e) => setAmount(Number(e.target.value))} style={{ width: 104 }} />
                <button className="small" onClick={() => setAmount(amount + step * (isKrw ? 5 : 1))}>+</button>
                <span className="small muted">{isKrw ? "만원" : "$"}</span>
                {n.kind === "fa_resign" && <select value={years} onChange={(e) => setYears(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((y) => <option key={y} value={y}>{y}년</option>)}</select>}
                <button className="small primary" disabled={busy} onClick={() => call(`/api/offseason/negotiations/${n.id}/offer`, { amount, years })}>제시 ({n.rounds}/{maxRounds})</button>
                {n.kind === "salary" && n.last_offer !== null && (
                  <button className="small" disabled={busy} title="마지막 제시액과 선수 요구액 사이에서 재정위원회가 기록을 보고 결정" onClick={() => { if (confirm("재정위원회에 보수 조정을 신청할까요? 판결은 되돌릴 수 없습니다.")) call(`/api/offseason/negotiations/${n.id}/arbitration`, {}); }}>⚖️ 조정 신청</button>
                )}
              </div>
              {n.mood && <span className={`pill ${MOOD_CLASS[n.mood] ?? "gray"}`}>{n.mood}</span>}
            </div>
          ) : (
            <span className={n.status === "accepted" ? "good" : "warn"}>
              {STATUS_LABEL[n.status]}{n.status === "arbitration" && n.ruling ? ` · ${krw(n.ruling.amount)}` : n.status === "accepted" && n.last_offer ? ` · ${money(n.contract_type, n.last_offer)}` : ""}
            </span>
          )}
          {err && <div className="bad small">{err}</div>}
          <div className="small muted neg-msg">{n.message}</div>
          {(history.length > 0 || n.ruling) && <a className="small" onClick={() => setOpen(!open)}>{open ? "접기" : n.ruling ? "판결문 · 협상 기록 보기" : `협상 기록 (${history.length})`}</a>}
        </td>
      </tr>
      {open && (
        <tr className="neg-detail"><td colSpan={6}>
          {history.length > 0 && (
            <div className="neg-history">
              {history.map((h) => (
                <div key={h.round} className="nh">
                  <span className="nh-round">{h.round}차</span>
                  <span>구단 <b>{money(n.contract_type, h.offer ?? null)}</b></span>
                  <span className="muted">→</span>
                  <span>선수 <b>{money(n.contract_type, h.ask)}</b></span>
                  {h.mood && <span className={`pill ${MOOD_CLASS[h.mood] ?? "gray"}`}>{h.mood}</span>}
                </div>
              ))}
            </div>
          )}
          {n.ruling && <RulingCard r={n.ruling} />}
        </td></tr>
      )}
    </Fragment>
  );
}

function FreeAgentMarket({ onChange }: { onChange: () => void }) {
  const [type, setType] = useState("domestic");
  const { data, error, reload } = useApi<FreeAgent[]>("/api/offseason/free-agents");
  const [offer, setOffer] = useState<Record<number, { amount: number; years: number }>>({});
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const list = data.filter((f) => f.contractType === type);
  async function submit(f: FreeAgent) {
    setErr(null);
    const o = offer[f.id] ?? { amount: f.askingAmount, years: f.desiredYears };
    try {
      await api(`/api/offseason/free-agents/${f.id}/offer`, { body: o });
      reload(); onChange();
    } catch (e) {
      setErr(`${f.name}: ${(e as Error).message}`);
    }
  }
  async function withdraw(f: FreeAgent) {
    await api(`/api/offseason/free-agents/${f.id}/offer`, { method: "DELETE" });
    reload(); onChange();
  }
  return (
    <Card title="FA 시장" right={
      <div className="tabs" style={{ marginBottom: 0, borderBottom: "none" }}>
        {Object.entries(CONTRACT_TYPE_LABEL).map(([k, v]) => <button key={k} className={type === k ? "active" : ""} onClick={() => setType(k)}>{v} ({data.filter((f) => f.contractType === k).length})</button>)}
      </div>
    }>
      <p className="small muted">
        제안을 넣고 "FA 하루 진행"을 누르면 선수가 모든 구단 제안 중 하나를 고릅니다 (금액·계약기간·팀 성적·원소속팀 여부 고려, 날이 갈수록 눈높이를 낮춤).
        외부 영입은 샐러리캡 30억 이하로만 가능하며, 직전 시즌 보수 30위 이내 선수는 원소속팀에 보수 100%, 31~40위는 50%의 보상금이 발생합니다.
        {type === "foreign" && " 외국선수 후보는 해외리그 기록과 리그 수준을 반영해 평가했습니다."}
      </p>
      <ErrorBox error={err} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>선수</th><th className="num">나이</th><th>OVR</th><th>공/수</th><th>잠재력</th><th>지난 시즌</th><th>이전 소속</th><th>요구 조건</th><th>보상</th><th className="num">제안 수</th><th>내 제안</th></tr></thead>
          <tbody>
            {list.map((f) => {
              const o = offer[f.id] ?? { amount: f.myOffer ?? f.askingAmount, years: f.myOfferYears ?? f.desiredYears };
              const isKrw = f.contractType === "domestic";
              return (
                <tr key={f.id}>
                  <td><PlayerLink id={f.id} name={f.name} /> <span className="muted small">{f.positionGroup}{f.isGenerated ? " · 신규" : ""}</span></td>
                  <td className="num">{f.age}</td><td><Rating value={f.overall} /></td><td className="small">{f.offense}/{f.defense}</td><td>{f.potential ?? "-"}</td>
                  <td className="small">{f.ppg ? `${f.ppg.toFixed(1)}점 ${f.rpg.toFixed(1)}리 ${f.apg.toFixed(1)}어` : "-"}</td>
                  <td className="small">{f.previousTeam ?? "-"}</td>
                  <td><b>{money(f.contractType, f.askingAmount)}</b>{isKrw ? ` · ${f.desiredYears}년` : ""}</td>
                  <td className="small">{f.compensation.amount > 0 ? <span className="warn">{krw(f.compensation.amount)}</span> : "-"}</td>
                  <td className="num">{f.offers}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <input type="number" step={isKrw ? 100 : 10000} value={o.amount} onChange={(e) => setOffer({ ...offer, [f.id]: { ...o, amount: Number(e.target.value) } })} style={{ width: 100 }} />
                      {isKrw && <select value={o.years} onChange={(e) => setOffer({ ...offer, [f.id]: { ...o, years: Number(e.target.value) } })}>{[1, 2, 3, 4, 5].map((y) => <option key={y} value={y}>{y}년</option>)}</select>}
                      <button className="small primary" onClick={() => submit(f)}>{f.myOffer ? "수정" : "제안/계약"}</button>
                      {f.myOffer && <button className="small" onClick={() => withdraw(f)}>철회</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function OffseasonView() {
  const { refresh, go } = useApp();
  const { data, error, reload } = useApi<Overview>("/api/offseason");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [marketKey, setMarketKey] = useState(0);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.stage) return <Card title="비시즌"><p>지금은 시즌 중입니다. 비시즌(챔피언결정전 종료 후)에 연봉협상·FA·드래프트가 열립니다.</p></Card>;

  async function advance() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ events: string[] }>("/api/offseason/advance", { body: {} });
      setEvents(r.events);
      reload(); refresh(); setMarketKey((k) => k + 1);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  async function startSeason() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ seasonLabel: string; warnings: string[] }>("/api/offseason/start-season", { body: {} });
      alert(`${r.seasonLabel} 시즌 시작!${r.warnings.length ? `\n\n${r.warnings.join("\n")}` : ""}`);
      refresh();
      go({ name: "dashboard" });
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const steps = [["resign", "1. 연봉협상·재계약"], ["fa", `2. FA 시장${data.stage === "fa" ? ` (${data.faDay}/${data.faDays}일)` : ""}`], ["ready", "3. 드래프트·새 시즌"]];
  const idx = steps.findIndex(([k]) => k === data.stage);

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="stepper">
        {steps.map(([k, l], i) => <span key={k} className={`step ${i === idx ? "active" : i < idx ? "done" : ""}`}>{l}</span>)}
      </div>
      <Card title={`${data.endYear} 비시즌 — 샐러리캡`}><PayrollBar payroll={data.payroll} /></Card>
      <ErrorBox error={err} />
      {events.length > 0 && <Card title="진행 결과">{events.map((e, i) => <div key={i} className="small">{e}</div>)}</Card>}

      {data.stage === "resign" && (
        <Card title="연봉협상 · 재계약" right={<button className="primary" disabled={busy} onClick={advance}>협상 마감 → FA 시장 개장</button>}>
          <div className="neg-guide small">
            <p><b>연봉협상</b> — 계약기간이 남은 국내선수는 매년 보수를 다시 정합니다. 요구액은 <b>지난 시즌 기록</b>(출전·효율, 기록이 비슷한 선수들의 보수)을 기준으로 하고, 기록 상위권일수록 인상 폭이 큽니다.</p>
            <p><b>서로 양보</b> — 금액을 제시하면 선수도 매번 요구액을 낮춥니다. 협상이 길어질수록, 제시가 합리적일수록 많이 양보하고 중간 어딘가에서 사인합니다. 지난번보다 깎은 제시나 헐값 제시엔 거의 물러서지 않습니다.</p>
            <p><b>보수 조정</b> — {data.maxRounds ?? 5}번 안에 합의하지 못하거나 <b>⚖️ 조정 신청</b>을 누르면 FA 시장 개장 전에 KBL 재정위원회가 <b>선수 요구액과 구단 제시액 사이에서 선수 기록을 보고</b> 금액을 판결합니다. 제시 없이 협상을 마감하면 현재 보수를 구단 제시액으로 봅니다.</p>
            <p className="muted">FA 재계약은 원소속 구단 우선 협상이며, 결렬되면 FA 시장에 나갑니다. 재계약은 샐러리캡의 105%(31.5억)까지 허용됩니다.</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>선수</th><th>구분</th><th>현재 보수</th><th>선수 요구액</th><th>적정 보수</th><th>제시 / 결과</th></tr></thead>
              <tbody>{data.negotiations.map((n) => <NegotiationRow key={n.id} n={n} maxRounds={data.maxRounds ?? 5} onDone={reload} />)}</tbody>
            </table>
          </div>
        </Card>
      )}

      {data.stage === "fa" && (
        <>
          <Card title={`FA 시장 ${data.faDay}일차 / ${data.faDays}일`} right={<button className="primary" disabled={busy} onClick={advance}>{data.faDay >= data.faDays ? "FA 마감 → 신인 드래프트" : "FA 하루 진행 ▶"}</button>}>
            <p className="small muted">로스터 정리(방출)는 [내 팀] 화면에서 할 수 있습니다.</p>
          </Card>
          <FreeAgentMarket key={marketKey} onChange={reload} />
        </>
      )}

      {data.stage === "ready" && (
        <>
        <Card title="새 시즌 준비" right={<button className="primary" disabled={busy} onClick={startSeason}>{data.endYear}-{data.endYear + 1} 시즌 시작 ▶</button>}>
          <p>신인 드래프트가 끝났습니다. [내 팀]에서 로스터와 출전시간을 확인하세요. 시즌을 시작하면 비시즌 훈련 성장·노화가 반영되고 새 일정이 만들어집니다.</p>
          <p className="small muted">조건: 국내선수 12~18명, 외국선수 1명 이상, 보수 총액 31.5억 이하 (30억 초과분 사치세, 70% 미달 시 제재금).</p>
          <p className="small muted">아직 계약하지 못한 잔여 FA·외국선수 후보는 아래에서 바로 계약할 수 있습니다 (공정가치의 85% 이상 제시 시 즉시 계약).</p>
        </Card>
        <FreeAgentMarket key={marketKey} onChange={() => { reload(); refresh(); }} />
        </>
      )}

      <Card title="이적 · 계약 소식">
        {data.transactions.length === 0 ? <p className="muted small">아직 없음</p> : data.transactions.map((t, i) => <div key={i} className="small">• {t.description}</div>)}
      </Card>
    </div>
  );
}
