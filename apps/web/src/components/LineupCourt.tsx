import { useState } from "react";
import type { ReactNode, DragEvent } from "react";
import { Rating } from "./common";
import { SLOT_LABELS, SLOT_NAMES, slotFit, positionShort } from "../lineup";
import "./lineupCourt.css";

export interface CourtItem {
  key: string;
  name: string;
  position: string;
  overall: number;
  foreign?: boolean;
  disabled?: boolean;      // 끌어올 수 없음 (부상·퇴장 등)
  disabledLabel?: string;
  note?: ReactNode;        // 이름 옆 작은 글씨 (출전시간·파울 등)
  detail?: ReactNode;      // 카드 아래쪽 (체력 바 등)
}

type Sel = { from: "slot"; slot: number } | { from: "pool"; key: string } | null;

/** 반코트 위 칸 위치 (%, 골대가 위쪽) */
const SPOTS: [number, number][] = [[50, 80], [22, 60], [77, 54], [24, 27], [69, 17]];

/**
 * 농구 코트에 PG·SG·SF·PF·C 칸을 그리고, 후보 목록에서 끌어다 놓거나(드래그)
 * 클릭 두 번(선수 → 칸)으로 배치한다. 칸끼리 끌면 자리 바꾸기.
 */
export function LineupCourt({ slots, pool, poolTitle, onPlace, onRemove, footer }: {
  slots: (CourtItem | null)[];
  pool: CourtItem[];
  poolTitle: string;
  onPlace: (slot: number, key: string) => void;   // slot: 1~5
  onRemove?: (slot: number) => void;
  footer?: ReactNode;
}) {
  const [sel, setSel] = useState<Sel>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<number | "pool" | null>(null);

  const all = [...slots.filter((s): s is CourtItem => !!s), ...pool];
  const find = (key: string | null) => (key ? all.find((p) => p.key === key) ?? null : null);
  const slotOf = (key: string) => slots.findIndex((s) => s?.key === key) + 1;
  const active = drag ? find(drag) : sel?.from === "pool" ? find(sel.key) : sel?.from === "slot" ? slots[sel.slot - 1] : null;

  function clickSlot(slot: number) {
    const here = slots[slot - 1];
    if (!sel) { if (here && !here.disabled) setSel({ from: "slot", slot }); return; }
    if (sel.from === "pool") onPlace(slot, sel.key);
    else if (sel.slot !== slot) { const moving = slots[sel.slot - 1]; if (moving) onPlace(slot, moving.key); }
    setSel(null);
  }
  function clickPool(p: CourtItem) {
    if (p.disabled) return;
    if (sel?.from === "slot") { onPlace(sel.slot, p.key); setSel(null); return; }
    setSel(sel?.from === "pool" && sel.key === p.key ? null : { from: "pool", key: p.key });
  }
  const start = (e: DragEvent, key: string) => {
    e.dataTransfer.setData("text/plain", key);
    e.dataTransfer.effectAllowed = "move";
    setDrag(key);
    setSel(null);
  };
  const end = () => { setDrag(null); setOver(null); };
  const dropOnSlot = (e: DragEvent, slot: number) => {
    e.preventDefault();
    const key = e.dataTransfer.getData("text/plain") || drag;
    if (key && slotOf(key) !== slot) onPlace(slot, key);
    end();
  };
  const dropOnPool = (e: DragEvent) => {
    e.preventDefault();
    const key = e.dataTransfer.getData("text/plain") || drag;
    const s = key ? slotOf(key) : 0;
    if (s > 0 && onRemove) onRemove(s);
    end();
  };
  const allow = (e: DragEvent, target: number | "pool") => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== target) setOver(target); };

  return (
    <div className="lc">
      <div className="lc-court" onClick={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
        <svg className="lc-lines" viewBox="0 0 500 470" preserveAspectRatio="none" aria-hidden>
          <rect x="168" y="0" width="164" height="193" className="lc-paint" />
          <path d="M30 0 V95 A226 226 0 0 0 470 95 V0" className="lc-line" />
          <rect x="168" y="0" width="164" height="193" className="lc-line" />
          <circle cx="250" cy="193" r="60" className="lc-line" />
          <path d="M190 470 A60 60 0 0 1 310 470" className="lc-line" />
          <line x1="220" y1="40" x2="280" y2="40" className="lc-line thick" />
          <circle cx="250" cy="54" r="12" className="lc-hoop" />
        </svg>
        {slots.map((p, i) => {
          const slot = i + 1;
          const fit = p ? slotFit(p.position, slot) : 0;
          const hintFit = active && active.key !== p?.key ? slotFit(active.position, slot) : null;
          const selected = sel?.from === "slot" && sel.slot === slot;
          return (
            <div key={slot}
              className={`lc-slot ${p ? "filled" : "empty"} ${selected ? "sel" : ""} ${over === slot ? "over" : ""} ${hintFit !== null ? `hint-${Math.min(hintFit, 2)}` : ""}`}
              style={{ left: `${SPOTS[i][0]}%`, top: `${SPOTS[i][1]}%` }}
              onClick={() => clickSlot(slot)}
              onDragOver={(e) => allow(e, slot)} onDragLeave={() => setOver(null)} onDrop={(e) => dropOnSlot(e, slot)}
              data-slot={SLOT_LABELS[i]}>
              <span className="lc-label" title={SLOT_NAMES[i]}>{SLOT_LABELS[i]}</span>
              {p ? (
                <div className="lc-card" draggable={!p.disabled} onDragStart={(e) => start(e, p.key)} onDragEnd={end}>
                  <Rating value={p.overall} />
                  <div className="lc-text">
                    <b>{p.name}{p.foreign && <i className="lc-f">외</i>}</b>
                    <small className={`fit-${Math.min(fit, 2)}`} title={fit >= 2 ? "포지션이 어색한 칸" : fit === 1 ? "인접 포지션" : "제 포지션"}>{positionShort(p.position)}{fit >= 2 ? " ⚠" : ""}</small>
                    {p.note && <small>{p.note}</small>}
                  </div>
                  {p.detail && <div className="lc-detail">{p.detail}</div>}
                  {onRemove && <button className="lc-x" title="후보로 내리기" onClick={(e) => { e.stopPropagation(); onRemove(slot); }}>×</button>}
                </div>
              ) : <div className="lc-empty">{SLOT_NAMES[i]}<small>여기로 끌어다 놓기</small></div>}
            </div>
          );
        })}
      </div>

      <div className={`lc-pool ${over === "pool" ? "over" : ""}`} onDragOver={(e) => allow(e, "pool")} onDragLeave={() => setOver(null)} onDrop={dropOnPool}>
        <div className="lc-pool-head"><b>{poolTitle}</b><small>{sel ? "이제 코트의 칸을 누르세요" : "선수를 코트 칸으로 끌거나, 선수 → 칸 순서로 클릭"}</small></div>
        <div className="lc-pool-list">
          {pool.map((p) => {
            const selected = sel?.from === "pool" && sel.key === p.key;
            return (
              <div key={p.key} className={`lc-chip ${selected ? "sel" : ""} ${p.disabled ? "disabled" : ""}`}
                draggable={!p.disabled} onDragStart={(e) => start(e, p.key)} onDragEnd={end} onClick={() => clickPool(p)} data-key={p.key}>
                <Rating value={p.overall} />
                <div className="lc-text">
                  <b>{p.name}{p.foreign && <i className="lc-f">외</i>}</b>
                  <small>{positionShort(p.position)}{p.note ? <> · {p.note}</> : null}{p.disabled && p.disabledLabel ? ` · ${p.disabledLabel}` : ""}</small>
                </div>
                {p.detail && <div className="lc-detail">{p.detail}</div>}
              </div>
            );
          })}
          {pool.length === 0 && <p className="muted small">후보가 없습니다</p>}
        </div>
        {footer}
      </div>
    </div>
  );
}
