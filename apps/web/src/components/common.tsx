import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, ratingClass } from "../api";
import type { DayResult } from "../api";

// ============================================================
// 화면 이동 (라우터 대신 간단한 상태 기반 내비게이션)
// ============================================================

export type View =
  | { name: "dashboard" }                       // 홈(허브)
  | { name: "today" }
  | { name: "gameday" }                         // 오늘 경기 준비
  | { name: "news"; date?: string }             // 날짜별 뉴스
  | { name: "live"; sessionId: string }
  | { name: "myteam" }                          // 내 팀 개요
  | { name: "roster" }
  | { name: "tactics" }
  | { name: "cap" }
  | { name: "teams" }                           // 다른 팀 둘러보기
  | { name: "team"; id: number }
  | { name: "league"; tab?: "standings" | "players" | "teams" | "playoffs" }
  | { name: "training" }
  | { name: "schedule" }
  | { name: "office" }                          // 감독실
  | { name: "trade" }                           // 트레이드
  | { name: "player"; id: number }
  | { name: "offseason" }
  | { name: "newgame" };

export interface AppContextValue {
  go: (v: View) => void;
  refresh: () => void;   // 상단바(날짜/단계) 갱신
  version: number;       // 진행할 때마다 증가 → 화면들이 다시 불러옴
  userTeamId: number | null;
  openSettings: () => void;
  next: () => void;                    // 상단 [다음]: 경기일이면 경기 준비, 아니면 하루 진행
  advancing: boolean;
  lastReport: { date: string; day: DayResult } | null; // 마지막으로 진행한 날의 결과 (달력 옆 소식)
  setReport: (r: { date: string; day: DayResult } | null) => void;
}

export const AppContext = createContext<AppContextValue>({
  go: () => {}, refresh: () => {}, version: 0, userTeamId: null, openSettings: () => {},
  next: () => {}, advancing: false, lastReport: null, setReport: () => {},
});
export const useApp = () => useContext(AppContext);

/** GET 요청 + 로딩/에러 상태. deps가 바뀌거나 앱 version이 바뀌면 다시 불러온다. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const { version } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    if (!path) return;
    setLoading(true);
    api<T>(path)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, ...deps]);
  useEffect(load, [load]);
  return { data, error, loading, reload: load, setData };
}

export function Loading() {
  return <p className="muted">불러오는 중...</p>;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error">{error}</div> : null;
}

export function Rating({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="muted">-</span>;
  return <span className={`rating ${ratingClass(value)}`}>{value}</span>;
}

export function Bar({ value, max = 100, color }: { value: number; max?: number; color?: "green" | "red" | "orange" }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={`bar ${color ?? ""}`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PlayerLink({ id, name }: { id: number; name: string }) {
  const { go } = useApp();
  return <a onClick={() => go({ name: "player", id })}>{name}</a>;
}

export function TeamLink({ id, name }: { id: number; name: string }) {
  const { go, userTeamId } = useApp();
  return <a onClick={() => go(id === userTeamId ? { name: "myteam" } : { name: "team", id })}>{name}</a>;
}

export function Card({ title, children, right }: { title?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="card">
      {(title || right) && (
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          {title ? <h3 style={{ margin: 0 }}>{title}</h3> : <span />}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function FatigueBar({ fatigue }: { fatigue: number }) {
  const color = fatigue >= 60 ? "red" : fatigue >= 35 ? "orange" : "green";
  return (
    <div title={`피로도 ${fatigue}`} style={{ width: 70 }}>
      <Bar value={fatigue} color={color} />
    </div>
  );
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 12px", overflowY: "auto" }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 980, width: "100%" }}>
        <div style={{ textAlign: "right" }}><button className="small" onClick={onClose}>닫기</button></div>
        {children}
      </div>
    </div>
  );
}

export function pct(m: number, a: number) {
  return a > 0 ? `${Math.round((m / a) * 1000) / 10}%` : "-";
}
