import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loading, ErrorBox, Card, Rating, useApp, Bar } from "./common";
import { api, PACE_LABEL, THREE_LABEL, DEFENSE_LABEL, REASON_LABEL } from "../api";
import type { DevChange } from "../api";
import { teamStyle } from "../teamColors";
import "./live.css";

// ============================================================
// 서버 데이터 타입
// ============================================================

interface LivePlayer { name: string; positionGroup: string; isForeign: boolean; overall: number; targetMinutes: number; energy: number; fouls: number }
interface LiveBox { name: string; MIN: number; PTS: number; REB: number; AST: number; STL: number; BLK: number; TOV: number; PF: number; FGM: number; FGA: number; TPM: number; TPA: number; FTM: number; FTA: number }
interface LiveSide {
  name: string; score: number; quarterScores: number[]; onCourt: string[]; manualLineup: string[] | null;
  context: { defenseScheme: string; threeWeightMultiplier?: number; reboundEmphasis?: boolean; doubleTeamTarget?: string | null };
  paceFactor: number; players: LivePlayer[]; box: LiveBox[];
}
type Side = "home" | "away";
interface Beat {
  kind: "bring" | "pass" | "shot" | "ft" | "turnover" | "steal" | "foul" | "block" | "oreb" | "dreb" | "info";
  side: Side; actor: string; target?: string; shotType?: "paint" | "mid" | "three"; made?: boolean; points?: number; text: string;
}
interface Play {
  seq: number; quarter: number; clockStart: string; clockEnd: string; offense: Side; beats: Beat[]; points: number;
  homeScore: number; awayScore: number; homeOnCourt: string[]; awayOnCourt: string[]; quarterEnd?: boolean;
}
interface LiveState {
  sessionId: string; gameId: number; userSide: Side; nextQuarter: number; segmentsPlayed: number; finished: boolean;
  home: LiveSide; away: LiveSide; quarterInProgress: boolean; plays: Play[]; lastSeq: number;
  developmentChanges?: DevChange[];
}

interface FeedLine { key: string; quarter: number; clock: string; text: string; side: Side; scoring: boolean; home: number; away: number; big?: boolean }

const quarterLabel = (q: number) => (q >= 5 ? `연장 ${q - 4}` : `${q}쿼터`);
const maxForeign = (q: number) => (q === 2 || q === 3 ? 2 : 1);
const paceKey = (f: number) => (f > 1.05 ? "fast" : f < 0.95 ? "slow" : "normal");
const threeKey = (m?: number) => (!m ? "normal" : m > 1.1 ? "high" : m < 0.9 ? "low" : "normal");
const SPEEDS = [1, 2, 4] as const;
const BEAT_MS: Record<Beat["kind"], number> = {
  bring: 700, pass: 650, shot: 1100, ft: 650, turnover: 900, steal: 900, foul: 800, block: 900, oreb: 800, dreb: 700, info: 900,
};
const CHUNK = 3; // 한 번에 받아오는 포제션 수 (작게 해야 작전타임 변경이 바로 반영됨)

// ============================================================
// 코트 좌표 (전체 코트 940×500, 홈팀은 오른쪽 골대로 공격)
// ============================================================

const W = 940, H = 500;
const HOOP = { right: { x: 893, y: 250 }, left: { x: 47, y: 250 } };
// 오른쪽 골대를 공격할 때의 공격 위치: 탑, 왼쪽 윙, 오른쪽 윙, 코너, 포스트
const OFF_SPOTS = [
  { x: 650, y: 250 }, { x: 720, y: 105 }, { x: 720, y: 395 }, { x: 870, y: 440 }, { x: 830, y: 175 },
];

function spotsFor(attackRight: boolean) {
  return OFF_SPOTS.map((p) => (attackRight ? p : { x: W - p.x, y: p.y }));
}

/** 공격 5명을 위치에 배정: 가드 → 탑·윙, 포워드 → 윙·코너, 센터 → 포스트 */
function arrange(names: string[], groups: Map<string, string>): string[] {
  const order = { G: 0, F: 1, C: 2 } as Record<string, number>;
  const sorted = [...names].sort((a, b) => (order[groups.get(a) ?? "F"] ?? 1) - (order[groups.get(b) ?? "F"] ?? 1));
  // 위치 순서: 탑(가드), 왼쪽 윙(가드), 오른쪽 윙(포워드), 코너(포워드), 포스트(센터)
  return sorted;
}

function Court({ play, beat, homeName, awayName, groups, userSide }: {
  play: Play | null; beat: Beat | null; homeName: string; awayName: string; groups: Map<string, string>; userSide: Side;
}) {
  const hs = teamStyle(homeName), as = teamStyle(awayName);
  const attackRight = (play?.offense ?? "home") === "home";
  const offSpots = spotsFor(attackRight);
  const hoop = attackRight ? HOOP.right : HOOP.left;
  const offNames = play ? arrange(play.offense === "home" ? play.homeOnCourt : play.awayOnCourt, groups) : [];
  const defNames = play ? arrange(play.offense === "home" ? play.awayOnCourt : play.homeOnCourt, groups) : [];
  const pos = new Map<string, { x: number; y: number }>();
  offNames.forEach((n, i) => pos.set(n, offSpots[i] ?? offSpots[0]));
  defNames.forEach((n, i) => {
    const o = offSpots[i] ?? offSpots[0];
    pos.set(n, { x: o.x + (hoop.x - o.x) * 0.24, y: o.y + (hoop.y - o.y) * 0.24 });
  });

  // 공 위치: 슛이면 골대, 그 외엔 동작한 선수
  let ball = pos.get(offNames[0] ?? "") ?? { x: W / 2, y: H / 2 };
  if (beat) {
    if (beat.kind === "shot") ball = hoop;
    else if (beat.kind === "pass" && beat.target) ball = pos.get(beat.target) ?? ball;
    else ball = pos.get(beat.actor) ?? ball;
  }
  const flash = beat && ((beat.kind === "shot" && beat.made) || (beat.kind === "ft" && beat.made)) ? `+${beat.points}` : null;
  const colorOf = (side: Side) => (side === "home" ? hs.primary : as.primary);
  const offSide = play?.offense ?? "home";
  const defSide: Side = offSide === "home" ? "away" : "home";

  return (
    <svg className="court" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="코트">
      <defs>
        <linearGradient id="floor" x1="0" x2="1">
          <stop offset="0" stopColor="#c98b4f" /><stop offset="0.5" stopColor="#d9a066" /><stop offset="1" stopColor="#c98b4f" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={W} height={H} rx="14" fill="url(#floor)" />
      <g stroke="rgba(255,255,255,0.85)" strokeWidth="3" fill="none">
        <rect x="12" y="12" width={W - 24} height={H - 24} />
        <line x1={W / 2} y1="12" x2={W / 2} y2={H - 12} />
        <circle cx={W / 2} cy={H / 2} r="58" />
        {[false, true].map((right) => {
          const bx = right ? W - 12 : 12, dir = right ? -1 : 1;
          return (
            <g key={String(right)}>
              <rect x={right ? bx - 180 : bx} y={250 - 70} width="180" height="140" fill={right ? hs.primary : as.primary} fillOpacity="0.28" />
              <circle cx={bx + dir * 180} cy={250} r="58" />
              <path d={`M ${bx} 40 L ${bx + dir * 90} 40 A 225 225 0 0 ${right ? 0 : 1} ${bx + dir * 90} 460 L ${bx} 460`} />
            </g>
          );
        })}
      </g>
      {/* 골대 */}
      {[HOOP.left, HOOP.right].map((h, i) => (
        <g key={i}>
          <line x1={i === 0 ? 24 : W - 24} y1={h.y - 26} x2={i === 0 ? 24 : W - 24} y2={h.y + 26} stroke="#fff" strokeWidth="5" />
          <circle cx={h.x} cy={h.y} r="11" stroke="#ff6a00" strokeWidth="4" fill="none" />
        </g>
      ))}
      {/* 팀 로고 문자 */}
      <text x={W * 0.25} y={H / 2 + 14} textAnchor="middle" fontSize="44" fontWeight="900" fill="rgba(255,255,255,0.16)">{as.abbr}</text>
      <text x={W * 0.75} y={H / 2 + 14} textAnchor="middle" fontSize="44" fontWeight="900" fill="rgba(255,255,255,0.16)">{hs.abbr}</text>

      {/* 선수 */}
      {[...defNames.map((n) => ({ n, side: defSide })), ...offNames.map((n) => ({ n, side: offSide }))].map(({ n, side }) => {
        const p = pos.get(n)!;
        const active = beat && (beat.actor === n || beat.target === n);
        return (
          <g key={`${side}-${n}`} className="court-player" style={{ transform: `translate(${p.x}px, ${p.y}px)` }}>
            <circle r={active ? 19 : 16} fill={colorOf(side)} stroke={side === userSide ? "#fff" : "rgba(0,0,0,0.6)"} strokeWidth={active ? 4 : 2.5} />
            <text y="5" textAnchor="middle" fontSize="12" fontWeight="800" fill="#fff">{groups.get(n) ?? ""}</text>
            <text y="34" textAnchor="middle" fontSize="13" fontWeight="700" fill="#fff" stroke="rgba(0,0,0,0.55)" strokeWidth="3" paintOrder="stroke">{n}</text>
          </g>
        );
      })}
      {/* 공 */}
      {play && (
        <g className="court-ball" style={{ transform: `translate(${ball.x + 12}px, ${ball.y - 14}px)` }}>
          <circle r="9" fill="#f97316" stroke="#7c2d12" strokeWidth="2" />
        </g>
      )}
      {flash && <text key={`${play?.seq}-${beat?.text}`} className="court-flash" x={hoop.x} y={hoop.y - 34} textAnchor="middle">{flash}</text>}
      {beat && beat.kind === "shot" && !beat.made && <text className="court-miss" x={hoop.x} y={hoop.y - 34} textAnchor="middle">✕</text>}
    </svg>
  );
}

function BoxTable({ side }: { side: LiveSide }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>선수</th><th className="num">분</th><th className="num">득점</th><th className="num">리바</th><th className="num">어시</th><th className="num">스틸</th><th className="num">블록</th><th className="num">TO</th><th className="num">파울</th><th className="num">야투</th><th className="num">3점</th><th className="num">FT</th></tr></thead>
        <tbody>
          {side.box.filter((b) => b.MIN > 0 || b.PTS > 0).sort((a, b) => b.PTS - a.PTS || b.MIN - a.MIN).map((b) => (
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

// ============================================================
// 작전타임 패널 (전술 + 라인업)
// ============================================================

function TimeoutPanel({ state, quarter, onApply, onClose, busy }: {
  state: LiveState; quarter: number; busy: boolean;
  onApply: (body: { lineup?: string[] | null; tactics?: Record<string, unknown> }) => void; onClose: () => void;
}) {
  const mine = state[state.userSide];
  const opp = state[state.userSide === "home" ? "away" : "home"];
  const [selected, setSelected] = useState<string[] | null>(mine.manualLineup);
  const [tactics, setTactics] = useState<Record<string, unknown>>({});
  const foreignSelected = (selected ?? []).filter((n) => mine.players.find((p) => p.name === n)?.isForeign).length;
  const lineupError = selected && (selected.length !== 5 ? `5명을 선택하세요 (현재 ${selected.length}명)` : foreignSelected > maxForeign(quarter) ? `${quarterLabel(quarter)}에는 외국선수 최대 ${maxForeign(quarter)}명` : null);
  const cur = { pace: paceKey(mine.paceFactor), three: threeKey(mine.context.threeWeightMultiplier), def: mine.context.defenseScheme, dbl: mine.context.doubleTeamTarget ?? "", reb: !!mine.context.reboundEmphasis };
  const val = <T,>(k: string, d: T) => (k in tactics ? tactics[k] as T : d);
  function toggle(name: string) {
    const base = selected ?? [...mine.onCourt];
    setSelected(base.includes(name) ? base.filter((n) => n !== name) : [...base, name]);
  }
  return (
    <div className="timeout">
      <div className="timeout-head">
        <h3>⏸ 작전타임 — {quarterLabel(quarter)}</h3>
        <button className="small" onClick={onClose}>닫기</button>
      </div>
      <div className="timeout-grid">
        <div className="col">
          <b>전술</b>
          <label>템포 <select value={val("paceStyle", cur.pace)} onChange={(e) => setTactics({ ...tactics, paceStyle: e.target.value })}>
            {Object.entries(PACE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
          <label>3점 비중 <select value={val("threePointReliance", cur.three)} onChange={(e) => setTactics({ ...tactics, threePointReliance: e.target.value })}>
            {Object.entries(THREE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
          <label>수비 <select value={val("defenseScheme", cur.def)} onChange={(e) => setTactics({ ...tactics, defenseScheme: e.target.value })}>
            {Object.entries(DEFENSE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
          <label>더블팀 <select value={val("doubleTeamTarget", cur.dbl) ?? ""} onChange={(e) => setTactics({ ...tactics, doubleTeamTarget: e.target.value || null })}>
            <option value="">없음</option>
            {opp.players.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select></label>
          <label><input type="checkbox" checked={val("reboundEmphasis", cur.reb)} onChange={(e) => setTactics({ ...tactics, reboundEmphasis: e.target.checked })} /> 리바운드 강조</label>
        </div>
        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>코트 위 5명 {selected ? "(직접 지정)" : "(자동 로테이션)"}</b>
            {selected && <button className="small" onClick={() => setSelected(null)}>자동으로</button>}
          </div>
          <div className="lineup-pick">
            {[...mine.players].sort((a, b) => Number(mine.onCourt.includes(b.name)) - Number(mine.onCourt.includes(a.name)) || b.overall - a.overall).map((p) => {
              const on = (selected ?? mine.onCourt).includes(p.name);
              const out = p.fouls >= 5;
              return (
                <button key={p.name} className={`lp ${on ? "on" : ""}`} disabled={out} onClick={() => toggle(p.name)}>
                  <Rating value={p.overall} />
                  <span className="lp-name">{p.name}<small>{p.positionGroup}{p.isForeign ? " · 외국" : ""}</small></span>
                  <span className="lp-energy"><Bar value={p.energy} color={p.energy < 50 ? "red" : p.energy < 70 ? "orange" : "green"} /></span>
                  <span className={`lp-fouls ${p.fouls >= 4 ? "bad" : ""}`}>{out ? "퇴장" : `파울 ${p.fouls}`}</span>
                </button>
              );
            })}
          </div>
          {lineupError && <p className="bad small">{lineupError}</p>}
        </div>
      </div>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
        <button className="primary" disabled={busy || !!lineupError} onClick={() => onApply({ lineup: selected, tactics: Object.keys(tactics).length ? tactics : undefined })}>
          적용하고 경기 재개 ▶
        </button>
      </div>
    </div>
  );
}

// ============================================================
// 메인: 실시간 중계
// ============================================================

export function LiveGameView({ sessionId }: { sessionId: string }) {
  const { go, refresh } = useApp();
  const [state, setState] = useState<LiveState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [queue, setQueue] = useState<Play[]>([]);
  const [cur, setCur] = useState<{ play: Play; idx: number } | null>(null);
  const [shown, setShown] = useState<{ home: number; away: number; quarter: number; clock: string; play: Play | null }>({ home: 0, away: 0, quarter: 1, clock: "10:00", play: null });
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [qScore, setQScore] = useState<Record<number, { home: number; away: number }>>({}); // 쿼터별 마지막으로 보여준 누적 점수
  const [paused, setPaused] = useState(true);
  const [banner, setBanner] = useState<string | null>("경기 시작 전 — ▶ 를 누르면 점프볼!");
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [timeout, setTimeoutOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Side>("home");
  const lastSeq = useRef(0);
  // 스킵할 때 최신 재생 상태를 읽기 위한 ref (await 중에 바뀐 값을 놓치지 않게)
  const curRef = useRef(cur);
  const queueRef = useRef(queue);
  curRef.current = cur;
  queueRef.current = queue;
  const fetching = useRef(false);

  useEffect(() => {
    api<LiveState>(`/api/live/${sessionId}?since=0`).then((s) => {
      setState(s);
      setTab(s.userSide);
      lastSeq.current = s.lastSeq;
      if (s.lastSeq > 0) {
        const last = s.plays[s.plays.length - 1];
        setShown({ home: s.home.score, away: s.away.score, quarter: last.quarter, clock: last.clockEnd, play: last });
      }
    }).catch((e) => setErr(String(e.message)));
  }, [sessionId]);

  useEffect(() => {
    if (!shown.play) return;
    setQScore((q) => ({ ...q, [shown.quarter]: { home: shown.home, away: shown.away } }));
  }, [shown]);

  const groups = useMemo(() => {
    const m = new Map<string, string>();
    state?.home.players.forEach((p) => m.set(p.name, p.positionGroup));
    state?.away.players.forEach((p) => m.set(p.name, p.positionGroup));
    return m;
  }, [state]);

  /** 중계 줄 추가. startIdx = 이 포제션 안에서 첫 동작의 순번 (key 중복 방지), withEnd = 쿼터 종료 줄까지 */
  const pushFeed = useCallback((play: Play, beats: Beat[], startIdx: number, withEnd: boolean) => {
    const lines: FeedLine[] = beats.map((b, i) => ({
      key: `${play.seq}-${startIdx + i}`, quarter: play.quarter, clock: play.clockEnd, text: b.text, side: b.side,
      scoring: (b.kind === "shot" && !!b.made) || (b.kind === "ft" && !!b.made),
      home: play.homeScore, away: play.awayScore,
      big: b.kind === "shot" && !!b.made && b.shotType === "three",
    }));
    if (withEnd && play.quarterEnd) lines.push({ key: `${play.seq}-end`, quarter: play.quarter, clock: "0:00", text: `${quarterLabel(play.quarter)} 종료 (${play.awayScore} : ${play.homeScore})`, side: play.offense, scoring: false, home: play.homeScore, away: play.awayScore, big: true });
    const newestFirst = [...lines].reverse(); // 업데이트 함수 밖에서 뒤집기 (StrictMode가 함수를 두 번 불러도 순서 유지)
    setFeed((f) => [...newestFirst, ...f].slice(0, 300));
  }, []);

  const step = useCallback(async (mode: "chunk" | "quarter" | "end", extra: Record<string, unknown> = {}) => {
    if (fetching.current) return null;
    fetching.current = true;
    setBusy(true);
    try {
      const s = await api<LiveState>(`/api/live/${sessionId}/step`, { body: { mode, count: CHUNK, since: lastSeq.current, ...extra } });
      lastSeq.current = s.lastSeq;
      if (mode === "chunk") setQueue((q) => [...q, ...s.plays]); // 상태 갱신보다 먼저 큐에 넣어야 중복 요청이 안 생김
      setState(s);
      if (s.finished) refresh();
      return s;
    } catch (e) {
      setErr(String((e as Error).message));
      setPaused(true);
      return null;
    } finally {
      fetching.current = false;
      setBusy(false);
    }
  }, [sessionId, refresh]);

  // ---- 재생 루프: 한 동작씩 ----
  useEffect(() => {
    if (!state || paused || timeout) return;
    if (!cur) {
      if (queue.length > 0) {
        const [next, ...rest] = queue;
        setQueue(rest);
        setCur({ play: next, idx: 0 });
        setShown((s) => ({ ...s, quarter: next.quarter, clock: next.clockStart, play: next }));
        return;
      }
      if (state.finished) { setPaused(true); setBanner(null); return; }
      void step("chunk");
      return;
    }
    const beat = cur.play.beats[cur.idx];
    const delay = (beat ? BEAT_MS[beat.kind] : 400) / speed;
    const t = window.setTimeout(() => {
      if (beat) pushFeed(cur.play, [beat], cur.idx, false);
      const nextIdx = cur.idx + 1;
      if (nextIdx < cur.play.beats.length) {
        setCur({ play: cur.play, idx: nextIdx });
      } else {
        const p = cur.play;
        setShown({ home: p.homeScore, away: p.awayScore, quarter: p.quarter, clock: p.clockEnd, play: p });
        if (p.quarterEnd) {
          pushFeed(p, [], p.beats.length, true);
          setPaused(true);
          setBanner(`${quarterLabel(p.quarter)} 종료 — 작전타임을 쓰거나 ▶ 로 다음 쿼터를 시작하세요`);
        }
        setCur(null);
      }
    }, delay);
    return () => window.clearTimeout(t);
  }, [state, paused, timeout, cur, queue, speed, step, pushFeed]);

  /** 받아둔 포제션을 화면에 즉시 다 반영 (스킵) */
  const flushAll = useCallback((extra: Play[]) => {
    const c = curRef.current, q = queueRef.current;
    if (c) pushFeed(c.play, c.play.beats.slice(c.idx), c.idx, true);
    [...q, ...extra].forEach((p) => pushFeed(p, p.beats, 0, true));
    const pending = [...(c ? [c.play] : []), ...q, ...extra];
    const last = pending[pending.length - 1];
    if (last) setShown({ home: last.homeScore, away: last.awayScore, quarter: last.quarter, clock: last.clockEnd, play: last });
    curRef.current = null;
    queueRef.current = [];
    setCur(null);
    setQueue([]);
  }, [pushFeed]);

  async function skipQuarter() {
    setPaused(true); // 서버 응답을 기다리는 동안 재생이 진행되지 않게
    // 화면이 아직 보여주지 않은 포제션 중에 쿼터 끝이 있으면 그것만 다 보여주면 됨
    const pending = [...(cur ? [cur.play] : []), ...queue];
    const endsQuarter = pending.some((p) => p.quarterEnd);
    if (endsQuarter || (!state?.quarterInProgress && pending.length > 0)) {
      flushAll([]);
    } else {
      const s = await step("quarter");
      if (!s) return;
      flushAll(s.plays);
    }
    setPaused(true);
    setBanner(state?.finished ? null : "쿼터를 건너뛰었습니다 — ▶ 로 계속");
  }

  async function skipGame() {
    if (!confirm("경기 끝까지 바로 진행할까요?")) return;
    setPaused(true);
    const s = await step("end");
    if (!s) return;
    flushAll(s.plays);
    setPaused(true);
    setBanner(null);
  }

  async function applyTimeout(body: { lineup?: string[] | null; tactics?: Record<string, unknown> }) {
    setBusy(true);
    try {
      const s = await api<LiveState>(`/api/live/${sessionId}/update`, { body: { ...body, since: lastSeq.current } });
      setState(s);
      setTimeoutOpen(false);
      setPaused(false);
      setBanner(null);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  if (err && !state) return <div><ErrorBox error={err} /><button onClick={() => go({ name: "today" })}>오늘 화면으로</button></div>;
  if (!state) return <Loading />;

  const home = state.home, away = state.away;
  const hs = teamStyle(home.name), as = teamStyle(away.name);
  const mine = state[state.userSide];
  const opp = state[state.userSide === "home" ? "away" : "home"];
  const beat = cur ? cur.play.beats[cur.idx] ?? null : null;
  const done = state.finished && !cur && queue.length === 0;
  const myScore = state.userSide === "home" ? shown.home : shown.away;
  const oppScore = state.userSide === "home" ? shown.away : shown.home;
  const caption = beat?.text ?? (done ? `경기 종료 — ${teamStyle(state.away.name).short} ${shown.away} : ${shown.home} ${teamStyle(state.home.name).short}` : banner ?? feed[0]?.text ?? "");

  return (
    <div className="live">
      <div className="live-board" style={{ ["--home" as string]: hs.primary, ["--away" as string]: as.primary }}>
        <div className="lb-team away">
          <span className="emblem" style={{ width: 42, height: 42, background: as.primary, fontSize: 12 }}>{as.abbr}</span>
          <div><b>{as.short}</b><small>원정{state.userSide === "away" ? " · 우리 팀" : ""}</small></div>
          <span className="lb-score">{shown.away}</span>
        </div>
        <div className="lb-mid">
          <span className="lb-q">{done ? "경기 종료" : quarterLabel(shown.quarter)}</span>
          <span className="lb-clock">{done ? "FINAL" : cur ? cur.play.clockStart : shown.clock}</span>
          <table className="lb-quarters">
            <tbody>
              {(["away", "home"] as Side[]).map((side) => {
                const quarters = Math.max(4, ...Object.keys(qScore).map(Number));
                return (
                  <tr key={side}>
                    <td>{teamStyle(state[side].name).abbr}</td>
                    {Array.from({ length: quarters }, (_, i) => {
                      const q = i + 1;
                      const end = qScore[q];
                      if (!end) return <td key={q}>-</td>;
                      const prev = Object.entries(qScore).filter(([k]) => Number(k) < q).sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1] ?? { home: 0, away: 0 };
                      return <td key={q}>{end[side] - prev[side]}</td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="lb-team home">
          <span className="lb-score">{shown.home}</span>
          <div><b>{hs.short}</b><small>홈{state.userSide === "home" ? " · 우리 팀" : ""}</small></div>
          <span className="emblem" style={{ width: 42, height: 42, background: hs.primary, fontSize: 12 }}>{hs.abbr}</span>
        </div>
      </div>

      <div className="live-main">
        <div className="live-court-wrap">
          <Court play={cur?.play ?? shown.play} beat={beat} homeName={home.name} awayName={away.name} groups={groups} userSide={state.userSide} />
          <div className={`live-caption ${beat && ((beat.kind === "shot" && beat.made) || beat.kind === "block" || beat.kind === "steal") ? "hot" : ""}`}>
            {beat && <span className="cap-side" style={{ background: beat.side === "home" ? hs.primary : as.primary }}>{beat.side === "home" ? hs.short : as.short}</span>}
            {caption}
          </div>
          <div className="live-controls">
            {!done && (paused
              ? <button className="primary" onClick={() => { setPaused(false); setBanner(null); }} disabled={busy}>▶ {feed.length === 0 ? "점프볼" : "계속"}</button>
              : <button onClick={() => setPaused(true)}>❚❚ 일시정지</button>)}
            {!done && <button onClick={() => { setPaused(true); setTimeoutOpen(true); }}>⏸ 작전타임</button>}
            <div className="seg-light">
              {SPEEDS.map((s) => <button key={s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>{s}x</button>)}
            </div>
            <span className="spacer" />
            {!done && <button onClick={skipQuarter} disabled={busy}>⏩ 쿼터 스킵</button>}
            {!done && <button onClick={skipGame} disabled={busy}>⏭ 경기 스킵</button>}
          </div>
          <ErrorBox error={err} />
          {timeout && !done && (
            <TimeoutPanel state={state} quarter={state.quarterInProgress ? shown.quarter : state.nextQuarter} busy={busy}
              onApply={applyTimeout} onClose={() => setTimeoutOpen(false)} />
          )}
          {done && (
            <Card title="경기 종료">
              <p className="big">{myScore > oppScore ? "🎉 승리!" : "패배"} <span className="muted" style={{ fontSize: 18 }}>{mine.name} {myScore} : {oppScore} {opp.name}</span></p>
              {state.developmentChanges && state.developmentChanges.length > 0 && (
                <div className="row small" style={{ gap: 6 }}>
                  {state.developmentChanges.map((c, i) => <span key={i} className="pill green">{c.name} {c.label} +{c.delta} ({REASON_LABEL[c.reason]})</span>)}
                </div>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => go({ name: "today" })}>달력으로 (다음 날 진행)</button>
              </div>
            </Card>
          )}
        </div>

        <div className="live-side">
          <div className="live-feed-head">문자 중계</div>
          <div className="live-feed">
            {feed.length === 0 && <p className="muted small">경기 시작 전입니다.</p>}
            {feed.map((l) => (
              <div key={l.key} className={`lf ${l.scoring ? "scoring" : ""} ${l.big ? "big" : ""}`}>
                <span className="lf-dot" style={{ background: l.side === "home" ? hs.primary : as.primary }} />
                <span className="lf-time">{quarterLabel(l.quarter).replace("쿼터", "Q")} {l.clock}</span>
                <span className="lf-text">{l.text}</span>
                {l.scoring && <span className="lf-score">{l.away}-{l.home}</span>}
              </div>
            ))}
          </div>
          <div className="live-oncourt">
            {[mine, opp].map((t) => (
              <div key={t.name}>
                <b className="small">{teamStyle(t.name).short} 코트 위</b>
                {t.players.filter((p) => t.onCourt.includes(p.name)).map((p) => (
                  <div key={p.name} className="oc-row">
                    <span>{p.name}</span>
                    <span style={{ width: 60 }}><Bar value={p.energy} color={p.energy < 50 ? "red" : p.energy < 70 ? "orange" : "green"} /></span>
                    <span className={`small ${p.fouls >= 4 ? "bad" : "muted"}`}>F{p.fouls}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <Card>
        <div className="tabs">
          <button className={tab === "away" ? "active" : ""} onClick={() => setTab("away")}>{away.name}</button>
          <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>{home.name}</button>
        </div>
        <BoxTable side={tab === "home" ? home : away} />
        <p className="muted small">박스스코어는 서버가 진행한 시점 기준이라 중계보다 몇 포제션 앞설 수 있습니다.</p>
      </Card>
    </div>
  );
}
