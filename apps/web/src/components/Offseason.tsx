import { useState } from "react";
import { useApi, Loading, ErrorBox, Card, Rating, PlayerLink, Bar, useApp } from "./common";
import { api, krw, usd, CONTRACT_TYPE_LABEL } from "../api";
import type { Payroll } from "../api";

interface Negotiation {
  id: number; kind: "salary" | "fa_resign" | "foreign_resign"; asking_amount: number; asking_years: number; last_offer: number | null;
  last_offer_years: number | null; rounds: number; status: string; fair_value: number; message: string | null;
  player_id: number; name: string; position_group: string; age: number; contract_type: string; salary_krw: number | null; salary_usd: number | null;
}

interface Overview {
  stage: string | null; faDay: number; faDays: number; endYear: number; payroll: Payroll;
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
const STATUS_LABEL: Record<string, string> = { open: "협상 중", accepted: "계약 완료", declined: "결렬", arbitration: "보수 조정" };

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

function NegotiationRow({ n, onDone }: { n: Negotiation; onDone: () => void }) {
  const [amount, setAmount] = useState<number>(n.asking_amount);
  const [years, setYears] = useState<number>(n.asking_years);
  const [reply, setReply] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isKrw = n.contract_type === "domestic";
  async function offer() {
    setErr(null);
    try {
      const r = await api<{ message: string }>(`/api/offseason/negotiations/${n.id}/offer`, { body: { amount, years } });
      setReply(r.message);
      onDone();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }
  const current = isKrw ? n.salary_krw : n.salary_usd;
  return (
    <tr>
      <td><PlayerLink id={n.player_id} name={n.name} /> <span className="muted small">{n.position_group} · {n.age}세</span></td>
      <td><span className="pill gray">{KIND_LABEL[n.kind]}</span></td>
      <td>{money(n.contract_type, current)}</td>
      <td><b>{money(n.contract_type, n.asking_amount)}</b>{n.kind === "fa_resign" ? ` · ${n.asking_years}년` : ""}</td>
      <td className="muted small">{money(n.contract_type, n.fair_value)}</td>
      <td>
        {n.status === "open" ? (
          <div className="row" style={{ gap: 4 }}>
            <input type="number" step={isKrw ? 100 : 10000} value={amount} onChange={(e) => setAmount(Number(e.target.value))} style={{ width: 110 }} />
            <span className="small muted">{isKrw ? "만원" : "$"}</span>
            {n.kind === "fa_resign" && <select value={years} onChange={(e) => setYears(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((y) => <option key={y} value={y}>{y}년</option>)}</select>}
            <button className="small primary" onClick={offer}>제시 ({n.rounds}/4)</button>
          </div>
        ) : <span className={n.status === "accepted" ? "good" : "warn"}>{STATUS_LABEL[n.status]}</span>}
        {err && <div className="bad small">{err}</div>}
        <div className="small muted" style={{ whiteSpace: "normal", maxWidth: 380 }}>{reply ?? n.message}</div>
      </td>
    </tr>
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
          <p className="small muted">
            계약기간이 남은 국내선수는 매년 보수를 재협상합니다. 4번 안에 합의하지 못하면 KBL 재정위원회 보수 조정으로 넘어가 선수 요구액과 구단 제시액 중 공정가치에 가까운 쪽으로 결정됩니다.
            계약이 끝난 FA는 원소속 구단과 먼저 협상하고, 결렬되면 FA 시장에 나갑니다. 재계약은 샐러리캡의 105%(31.5억)까지 허용됩니다.
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>선수</th><th>구분</th><th>현재 보수</th><th>요구액</th><th>공정가치</th><th>제시 / 결과</th></tr></thead>
              <tbody>{data.negotiations.map((n) => <NegotiationRow key={n.id} n={n} onDone={reload} />)}</tbody>
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
