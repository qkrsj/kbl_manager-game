import { useEffect, useState } from "react";
import { useApi, Loading, ErrorBox, Card, Rating, useApp } from "./common";
import { api, krw, usd, CONTRACT_TYPE_LABEL, formatDate } from "../api";
import { teamStyle } from "../teamColors";
import "./trade.css";

interface TP {
  id: number; name: string; positionGroup: string; contractType: string; age: number; overall: number; potential: number | null;
  projected: number; salaryKrw: number | null; salaryUsd: number | null; value: number;
}
interface TeamView { id: number; name: string; mode: string; modeLabel: string; rank: number; players: TP[] }
interface Ctx {
  window: { open: boolean; reason: string | null; deadline: string | null };
  me: TeamView; partner: TeamView | null;
  teams: { id: number; name: string; mode: string; modeLabel: string }[];
}
interface Evaluation {
  accepted: boolean; verdict: string; reasons: string[];
  user: { get: number; give: number; gainPct: number };
  ai: { get: number; give: number; gainPct: number; mode: string; modeLabel: string };
  ruleError: string | null; windowError: string | null;
  executed?: boolean; description?: string | null;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
const salary = (p: TP) => (p.contractType === "domestic" ? krw(p.salaryKrw) : usd(p.salaryUsd));

function Meter({ label, gain }: { label: string; gain: number }) {
  // −30% ~ +30% 를 0~100%로
  const pos = Math.max(0, Math.min(100, 50 + gain * (50 / 0.3)));
  const tone = gain >= 0 ? "good" : gain >= -0.1 ? "warn" : "bad";
  return (
    <div className="tm">
      <div className="tm-head"><span>{label}</span><b className={tone}>{pct(gain)}</b></div>
      <div className="tm-track"><span className="tm-mid" /><span className={`tm-dot ${tone}`} style={{ left: `${pos}%` }} /></div>
      <div className="tm-scale"><span>손해</span><span>공정</span><span>이득</span></div>
    </div>
  );
}

function PlayerPick({ p, on, onToggle, side }: { p: TP; on: boolean; onToggle: () => void; side: "give" | "get" }) {
  const growth = p.projected - p.overall;
  return (
    <label className={`tp ${on ? `on ${side}` : ""}`}>
      <input type="checkbox" checked={on} onChange={onToggle} />
      <Rating value={p.overall} />
      <span className="tp-name">
        {p.name}
        <small>{p.positionGroup} · {p.age}세{p.contractType !== "domestic" ? ` · ${CONTRACT_TYPE_LABEL[p.contractType]}` : ""}{growth >= 2 ? ` · 성장 +${Math.round(growth)}` : ""}</small>
      </span>
      <span className="tp-pot">{p.potential ?? "-"}</span>
      <span className="tp-sal">{salary(p)}</span>
    </label>
  );
}

interface OfferPlayer { id: number; name: string; overall: number; positionGroup: string; age: number; teamId: number | null }
interface Offer {
  id: number; teamId: number; teamName: string; offerDate: string; expiresDate: string; status: string; note: string | null; resolvedDate: string | null;
  gives: OfferPlayer[]; wants: OfferPlayer[];
  aiGain: number | null; userGain: number | null;          // 제안할 때의 양 팀 평가
  evaluation: (Evaluation & { error?: string }) | null;     // 지금 기준 (규정 위반 여부 확인용)
}
const OFFER_STATUS: Record<string, string> = { pending: "답변 대기", accepted: "수락 · 성사", rejected: "거절", expired: "기한 만료", withdrawn: "상대가 철회" };

/** 다른 팀이 우리 팀에 보낸 트레이드 제안 */
function TradeOffers({ onDone }: { onDone: () => void }) {
  const { refresh } = useApp();
  const { data, reload } = useApi<Offer[]>("/api/trade/offers");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const pending = data.filter((o) => o.status === "pending");
  const recent = data.filter((o) => o.status !== "pending").slice(0, 5);
  async function respond(o: Offer, accept: boolean) {
    setBusy(true);
    try {
      const r = await api<{ executed: boolean; message: string }>(`/api/trade/offers/${o.id}`, { body: { accept } });
      setMsg(r.message);
      reload(); refresh(); onDone();
    } catch (e) {
      setMsg(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  const names = (ps: OfferPlayer[]) => ps.map((p) => `${p.name}(${p.overall})`).join(" + ");
  return (
    <Card title={<span>📨 받은 트레이드 제안 {pending.length > 0 && <span className="pill red">{pending.length}</span>}</span>}>
      {pending.length === 0 && <p className="muted small" style={{ margin: 0 }}>지금 답할 제안이 없습니다. 시즌 중(트레이드 마감 전)에 다른 팀이 우리 선수를 원하면 제안이 옵니다.</p>}
      {pending.map((o) => {
        const ts = teamStyle(o.teamName);
        const ev = o.evaluation;
        return (
          <div key={o.id} className="offer" style={{ ["--team" as string]: ts.primary }}>
            <div className="offer-head">
              <span className="emblem" style={{ width: 34, height: 34, background: ts.primary, fontSize: 10 }}>{ts.abbr}</span>
              <div><b>{o.teamName}</b><small>{formatDate(o.offerDate)} 제안 · {formatDate(o.expiresDate)}까지 답변</small></div>
            </div>
            <div className="trade-summary">
              <div><span className="muted small">우리가 받는 선수</span><b>{names(o.gives)}</b></div>
              <span className="trade-arrow">⇄</span>
              <div><span className="muted small">상대가 원하는 선수</span><b>{names(o.wants)}</b></div>
            </div>
            <div className="trade-meters">
              <Meter label="우리 팀 평가" gain={o.userGain ?? ev?.user.gainPct ?? 0} />
              <Meter label={`${ts.short} 평가${ev?.ai ? ` (${ev.ai.modeLabel})` : ""}`} gain={o.aiGain ?? ev?.ai.gainPct ?? 0} />
            </div>
            {ev?.error && <p className="bad small">{ev.error}</p>}
            {ev && !ev.error && (ev.ruleError || ev.windowError) && <p className="bad small">⛔ {ev.windowError ?? ev.ruleError}</p>}
            <p className="small muted" style={{ margin: 0 }}>상대가 먼저 낸 제안이라 기한 안에 수락하면 이 조건 그대로 성사됩니다 (규정 위반만 아니면).</p>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button disabled={busy} onClick={() => respond(o, false)}>거절</button>
              <button className="primary" disabled={busy} onClick={() => respond(o, true)}>수락</button>
            </div>
          </div>
        );
      })}
      {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
      {recent.length > 0 && (
        <details className="offer-history">
          <summary className="small muted">지난 제안 {recent.length}건</summary>
          <table><tbody>
            {recent.map((o) => (
              <tr key={o.id}><td className="small muted">{formatDate(o.offerDate)}</td><td className="small">{teamStyle(o.teamName).short}: {names(o.gives)} ⇄ {names(o.wants)}</td><td className="small">{OFFER_STATUS[o.status] ?? o.status}</td></tr>
            ))}
          </tbody></table>
        </details>
      )}
    </Card>
  );
}

/** 트레이드: 상대 팀 고르기 → 보낼 선수·받을 선수 체크 → 양 팀 평가를 보고 제안 */
export function TradeView() {
  const { refresh } = useApp();
  const [partnerId, setPartnerId] = useState<number | null>(null);
  const { data, error, reload } = useApi<Ctx>(`/api/trade${partnerId ? `?teamId=${partnerId}` : ""}`, [partnerId]);
  const { data: history, reload: reloadHistory } = useApi<{ season_year: number; tx_date: string | null; description: string }[]>("/api/trade/history");
  const [give, setGive] = useState<number[]>([]);
  const [receive, setReceive] = useState<number[]>([]);
  const [ev, setEv] = useState<Evaluation | null>(null);
  const [result, setResult] = useState<Evaluation | null>(null);
  const [suggest, setSuggest] = useState<{ give: { id: number; name: string; overall: number }[]; userGainPct: number; aiGainPct: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setGive([]); setReceive([]); setEv(null); setSuggest(null); }, [partnerId]);
  useEffect(() => {
    if (!partnerId || give.length === 0 || receive.length === 0) { setEv(null); return; }
    const t = window.setTimeout(() => {
      api<Evaluation>("/api/trade/evaluate", { body: { teamId: partnerId, give, receive } }).then(setEv).catch((e) => setErr(String(e.message)));
    }, 250);
    return () => window.clearTimeout(t);
  }, [partnerId, give, receive]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const toggle = (list: number[], set: (v: number[]) => void, id: number) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const partner = data.partner;

  async function propose() {
    if (!partnerId) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<Evaluation>("/api/trade/propose", { body: { teamId: partnerId, give, receive } });
      setResult(r);
      if (r.executed) { setGive([]); setReceive([]); setEv(null); reload(); reloadHistory(); refresh(); }
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  async function findPackage() {
    if (!partnerId || receive.length === 0) return;
    setBusy(true); setErr(null);
    try { setSuggest(await api("/api/trade/suggest", { body: { teamId: partnerId, receive } })); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  }

  const giveP = data.me.players.filter((p) => give.includes(p.id));
  const recvP = partner?.players.filter((p) => receive.includes(p.id)) ?? [];

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className={`trade-window ${data.window.open ? "open" : "closed"}`}>
        <b>{data.window.open ? "트레이드 가능" : "트레이드 불가"}</b>
        <span>{data.window.reason ?? (data.window.deadline ? `마감: ${formatDate(data.window.deadline)} (4라운드 종료)` : "")}</span>
        <span className="spacer" />
        <span className="small">우리 팀 상황: <b>{data.me.modeLabel}</b> ({data.me.rank}위)</span>
      </div>

      <TradeOffers onDone={() => { reload(); reloadHistory(); }} />

      <Card title="트레이드 상대">
        <div className="trade-teams">
          {data.teams.map((t) => {
            const ts = teamStyle(t.name);
            return (
              <button key={t.id} className={`trade-team ${partnerId === t.id ? "on" : ""}`} style={{ ["--team" as string]: ts.primary }} onClick={() => setPartnerId(t.id)}>
                <span className="emblem" style={{ width: 30, height: 30, background: ts.primary, fontSize: 9 }}>{ts.abbr}</span>
                <span><b>{ts.short}</b><small>{t.modeLabel}</small></span>
              </button>
            );
          })}
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          팀 상황에 따라 원하는 선수가 다릅니다 — 우승 경쟁 팀은 당장 잘하는 선수를, 리빌딩 팀은 젊고 잠재력 높은 선수를 더 높게 봅니다.
          양 팀 모두에게 이득(윈윈)이어야 성사됩니다.
        </p>
      </Card>

      {partner && (
        <>
          <div className="trade-board">
            <Card title={<span>보낼 선수 · {teamStyle(data.me.name).short}</span>}>
              <div className="tp-head"><span /><span>OVR</span><span>선수</span><span>잠재력</span><span>보수</span></div>
              <div className="tp-list">
                {data.me.players.map((p) => <PlayerPick key={p.id} p={p} side="give" on={give.includes(p.id)} onToggle={() => toggle(give, setGive, p.id)} />)}
              </div>
            </Card>
            <Card title={<span>받을 선수 · {teamStyle(partner.name).short} <span className="pill gray">{partner.modeLabel}</span></span>}>
              <div className="tp-head"><span /><span>OVR</span><span>선수</span><span>잠재력</span><span>보수</span></div>
              <div className="tp-list">
                {partner.players.map((p) => <PlayerPick key={p.id} p={p} side="get" on={receive.includes(p.id)} onToggle={() => toggle(receive, setReceive, p.id)} />)}
              </div>
            </Card>
          </div>

          <Card title="트레이드 평가">
            <div className="trade-summary">
              <div><span className="muted small">보내는 선수</span><b>{giveP.map((p) => `${p.name}(${p.overall})`).join(", ") || "-"}</b></div>
              <span className="trade-arrow">⇄</span>
              <div><span className="muted small">받는 선수</span><b>{recvP.map((p) => `${p.name}(${p.overall})`).join(", ") || "-"}</b></div>
            </div>
            {ev ? (
              <>
                <div className="trade-meters">
                  <Meter label="우리 팀 평가" gain={ev.user.gainPct} />
                  <Meter label={`${teamStyle(partner.name).short} 평가 (${ev.ai.modeLabel})`} gain={ev.ai.gainPct} />
                </div>
                <div className={`trade-verdict ${ev.accepted ? "yes" : "no"}`}>
                  {ev.accepted ? "✅ 지금 제안하면 수락할 가능성이 높습니다" : ev.verdict === "불가" ? "⛔ 규정상 할 수 없는 트레이드입니다" : "❌ 지금 조건으로는 거절할 것 같습니다"}
                  <ul>{ev.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
              </>
            ) : <p className="muted small">양쪽에서 선수를 1명 이상 고르면 평가가 나옵니다.</p>}
            <ErrorBox error={err} />
            <div className="row">
              <button className="primary" disabled={busy || give.length === 0 || receive.length === 0 || !data.window.open} onClick={propose}>트레이드 제안</button>
              <button disabled={busy || receive.length === 0} onClick={findPackage}>이 선수를 받으려면? (카드 찾기)</button>
            </div>
            {suggest && (
              <div className="trade-suggest">
                {suggest.length === 0 ? <p className="muted small">상대가 받아들일 만한 1~2명 조합을 찾지 못했습니다.</p> : suggest.map((s, i) => (
                  <button key={i} onClick={() => { setGive(s.give.map((g) => g.id)); setSuggest(null); }}>
                    {s.give.map((g) => `${g.name}(${g.overall})`).join(" + ")}
                    <small>우리 {pct(s.userGainPct)} · 상대 {pct(s.aiGainPct)}</small>
                  </button>
                ))}
              </div>
            )}
            {result && (
              <div className={`notice ${result.executed ? "" : "error"}`} style={{ marginTop: 10 }}>
                {result.executed ? `트레이드 성사! ${result.description}` : `거절: ${result.reasons.join(" / ")}`}
              </div>
            )}
          </Card>
        </>
      )}

      <Card title="트레이드 기록">
        {!history || history.length === 0 ? <p className="muted small">아직 트레이드가 없습니다. AI 팀끼리의 트레이드는 한 시즌에 많아야 1건만 일어납니다.</p> : (
          <table><tbody>
            {history.map((h, i) => <tr key={i}><td className="small muted">{h.tx_date ? formatDate(h.tx_date) : h.season_year}</td><td>{h.description}</td></tr>)}
          </tbody></table>
        )}
      </Card>
    </div>
  );
}
