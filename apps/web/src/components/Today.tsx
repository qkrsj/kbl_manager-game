import { useEffect, useMemo, useState } from "react";
import { teamStyle } from "../teamColors";
import "./calendar.css";
import { useApi, Loading, ErrorBox, Card, Rating, PlayerLink, useApp, Modal } from "./common";
import { DayNews } from "./News";
import { BoxScore } from "./BoxScore";
import { api, formatDate, PACE_LABEL, THREE_LABEL, DEFENSE_LABEL, INTENSITY_LABEL } from "../api";
import type { Franchise, RosterPlayer, Coach, TrainingPlan, DayResult } from "../api";

interface TodayGame {
  id: number; home: string; away: string; home_team_id: number; away_team_id: number; home_score: number | null; away_score: number | null;
  isHome: boolean; played: boolean; playoffLabel: string | null; game_number_in_series: number | null;
  higher_seed_wins: number | null; lower_seed_wins: number | null; higher_seed_team_id: number | null;
  opponent: { id: number; name: string; coach: Coach; topPlayers: RosterPlayer[] };
  gamePlan: { double_team_player_id: number | null; pace_style: string | null; three_point_reliance: string | null; defense_scheme: string | null; rebound_emphasis: boolean | null } | null;
}

interface Today {
  franchise: Franchise;
  game: TodayGame | null;
  otherGames: { id: number; home: string; away: string; home_score: number | null; away_score: number | null }[];
  trainingPlan: TrainingPlan;
}

interface Focus { key: string; label: string; attributes: string[] }

function GamePlanForm({ game, onSaved }: { game: TodayGame; onSaved: () => void }) {
  const p = game.gamePlan;
  const [plan, setPlan] = useState({
    doubleTeamPlayerId: p?.double_team_player_id ?? null as number | null,
    paceStyle: p?.pace_style ?? "", threePointReliance: p?.three_point_reliance ?? "", defenseScheme: p?.defense_scheme ?? "",
    reboundEmphasis: p?.rebound_emphasis ?? false,
  });
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    try {
      await api(`/api/franchise/gameplan/${game.id}`, {
        method: "PUT",
        body: {
          doubleTeamPlayerId: plan.doubleTeamPlayerId, paceStyle: plan.paceStyle || null, threePointReliance: plan.threePointReliance || null,
          defenseScheme: plan.defenseScheme || null, reboundEmphasis: plan.reboundEmphasis,
        },
      });
      setMsg("게임플랜 저장 완료");
      onSaved();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }
  return (
    <div className="col">
      <div className="row">
        <label>템포 <select value={plan.paceStyle} onChange={(e) => setPlan({ ...plan, paceStyle: e.target.value })}>
          <option value="">팀 전술 따름</option>{Object.entries(PACE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></label>
        <label>3점 비중 <select value={plan.threePointReliance} onChange={(e) => setPlan({ ...plan, threePointReliance: e.target.value })}>
          <option value="">팀 전술 따름</option>{Object.entries(THREE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></label>
        <label>수비 <select value={plan.defenseScheme} onChange={(e) => setPlan({ ...plan, defenseScheme: e.target.value })}>
          <option value="">팀 전술 따름</option>{Object.entries(DEFENSE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></label>
      </div>
      <div className="row">
        <label>상대 에이스 더블팀 <select value={plan.doubleTeamPlayerId ?? ""} onChange={(e) => setPlan({ ...plan, doubleTeamPlayerId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">사용 안 함</option>
          {game.opponent.topPlayers.map((pl) => <option key={pl.id} value={pl.id}>{pl.name} ({pl.stats?.pts ?? "-"}점)</option>)}
        </select></label>
        <label><input type="checkbox" checked={plan.reboundEmphasis} onChange={(e) => setPlan({ ...plan, reboundEmphasis: e.target.checked })} /> 리바운드 강조</label>
        <button onClick={save}>게임플랜 저장</button>
        {msg && <span className="small muted">{msg}</span>}
      </div>
      <p className="muted small">더블팀: 대상 선수의 슛 시도·성공률이 크게 줄지만 패스를 받은 동료에게 오픈 찬스가 생깁니다. 지역방어: 골밑 실점↓ 3점 허용↑. 압박: 턴오버 유도↑, 파울·체력소모↑.</p>
    </div>
  );
}

interface SchedGame {
  id: number; game_date: string; home_team: string; away_team: string; home_team_id: number; away_team_id: number;
  home_score: number | null; away_score: number | null; went_to_ot: boolean; playoff_label: string | null;
}

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const prevDay = (d: string) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() - 1); return ymd(x); };

/** 달력 칸에 붙는 말풍선 (칸 아래로 열림, 가장자리 칸은 안쪽으로 정렬) */
function Bubble({ col, children, onClose }: { col: number; children: React.ReactNode; onClose?: () => void }) {
  const align = col <= 1 ? "left" : col >= 5 ? "right" : "center";
  return (
    <div className={`cal-bubble ${align}`} onClick={(e) => e.stopPropagation()}>
      {onClose && <button className="cal-bubble-x" onClick={onClose} aria-label="닫기">×</button>}
      {children}
    </div>
  );
}

/** 달력: 우리 팀 경기(상대·홈/원정·결과), 오늘(말풍선), 리그 휴식기. 미래 날짜를 고르면 그날까지 진행 */
function SeasonCalendar({ today, userTeamId, busy, todayBubble, onAdvanceTo, onOpenBox }: {
  today: string; userTeamId: number; busy: boolean; todayBubble: React.ReactNode;
  onAdvanceTo: (date: string, simUserGames: boolean) => void; onOpenBox: (gameId: number) => void;
}) {
  const { data: mine } = useApi<SchedGame[]>("/api/schedule?teamId=");
  const { data: all } = useApi<SchedGame[]>("/api/schedule?teamId=all");
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(null);
  const [showToday, setShowToday] = useState(true);
  const [confirm, setConfirm] = useState<{ date: string; games: number } | null>(null);
  useEffect(() => { setMonth(today.slice(0, 7)); setPicked(null); setShowToday(true); }, [today]);

  const byDate = useMemo(() => new Map((mine ?? []).map((g) => [g.game_date.slice(0, 10), g])), [mine]);
  const leagueCount = useMemo(() => {
    const m = new Map<string, number>();
    (all ?? []).forEach((g) => m.set(g.game_date.slice(0, 10), (m.get(g.game_date.slice(0, 10)) ?? 0) + 1));
    return m;
  }, [all]);
  const seasonStart = (all ?? [])[0]?.game_date.slice(0, 10);
  const seasonEnd = (all ?? []).at(-1)?.game_date.slice(0, 10);

  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const cells: (Date | null)[] = Array(first.getDay()).fill(null);
  for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) cells.push(new Date(y, m - 1, d));
  while (cells.length % 7) cells.push(null);
  const shift = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const monthGames = [...byDate.values()].filter((g) => g.game_date.startsWith(month));
  const played = monthGames.filter((g) => g.home_score !== null);
  const wins = played.filter((g) => (g.home_team_id === userTeamId ? g.home_score! > g.away_score! : g.away_score! > g.home_score!)).length;

  /** 고른 날짜까지 가는 동안 치러야 할 우리 팀 경기 수 (오늘 포함, 그날은 제외) */
  const gamesUntil = (date: string) => [...byDate.entries()].filter(([d, g]) => d >= today && d < date && g.home_score === null).length;
  const requestAdvance = (date: string) => {
    const n = gamesUntil(date);
    if (n > 0) setConfirm({ date, games: n });
    else onAdvanceTo(date, false);
  };

  return (
    <div className="cal">
      <div className="cal-head">
        <button className="small" onClick={() => shift(-1)}>‹</button>
        <b>{y}년 {m}월</b>
        <button className="small" onClick={() => shift(1)}>›</button>
        <span className="muted small">{monthGames.length}경기{played.length ? ` · ${wins}승 ${played.length - wins}패` : ""}</span>
        <span className="cal-spacer" />
        <button className="small" onClick={() => { setMonth(today.slice(0, 7)); setShowToday(true); }}>오늘</button>
      </div>
      <div className="cal-grid">
        {WEEK.map((w, i) => <div key={w} className={`cal-wd ${i === 0 ? "sun" : i === 6 ? "sat" : ""}`}>{w}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} className="cal-cell empty" />;
          const key = ymd(d);
          const g = byDate.get(key);
          const isToday = key === today;
          const past = key < today;
          const inSeason = !!seasonStart && key >= seasonStart && key <= (seasonEnd ?? key);
          const breakDay = inSeason && !leagueCount.get(key);
          const home = g ? g.home_team_id === userTeamId : false;
          const opp = g ? (home ? g.away_team : g.home_team) : "";
          const result = g && g.home_score !== null ? ((home ? g.home_score! > g.away_score! : g.away_score! > g.home_score!) ? "W" : "L") : null;
          const clickable = !past && !isToday;
          const n = picked === key ? gamesUntil(key) : 0;
          return (
            <div
              key={key}
              className={`cal-cell ${isToday ? "today" : ""} ${past ? "past" : ""} ${picked === key ? "picked" : ""} ${g ? "has-game" : ""} ${breakDay ? "break" : ""} ${clickable ? "clickable" : ""} ${(isToday && showToday) || picked === key ? "open" : ""}`}
              onClick={() => {
                if (g && result) onOpenBox(g.id);
                else if (isToday) setShowToday(!showToday);
                else if (clickable) { setPicked(picked === key ? null : key); setShowToday(false); }
              }}
            >
              <span className="cal-day">{d.getDate()}</span>
              {isToday && <span className="cal-today">오늘</span>}
              {g ? (
                <div className="cal-game">
                  <span className="emblem" style={{ width: 26, height: 26, background: teamStyle(opp).primary, fontSize: 8 }}>{teamStyle(opp).abbr}</span>
                  <span className="cal-opp">{home ? "vs" : "@"} {teamStyle(opp).short}</span>
                  {result
                    ? <span className={`cal-res ${result === "W" ? "w" : "l"}`}>{result === "W" ? "승" : "패"} {home ? `${g.home_score}-${g.away_score}` : `${g.away_score}-${g.home_score}`}</span>
                    : g.playoff_label ? <span className="cal-po">{g.playoff_label}</span> : null}
                </div>
              ) : breakDay ? <span className="cal-note">휴식기</span> : null}
              {isToday && showToday && todayBubble && <Bubble col={i % 7} onClose={() => setShowToday(false)}>{todayBubble}</Bubble>}
              {picked === key && (
                <Bubble col={i % 7} onClose={() => setPicked(null)}>
                  <b className="cb-title">{formatDate(key)}까지 진행</b>
                  <p className="small muted" style={{ margin: "4px 0 8px" }}>
                    저장된 훈련 계획으로 하루씩 진행합니다.{n > 0 ? ` 그 사이 우리 팀 경기 ${n}경기` : " 그 사이 우리 팀 경기 없음"}
                  </p>
                  <button className="primary" disabled={busy} onClick={() => requestAdvance(key)}>이 날까지 진행 ⏩</button>
                </Bubble>
              )}
            </div>
          );
        })}
      </div>
      <div className="cal-foot">
        <span className="muted small">오늘 칸의 말풍선에서 훈련을 정하고 진행 · 미래 날짜를 누르면 그날까지 한 번에 · 지난 경기를 누르면 박스스코어 · 상단 <b>다음 ▶</b>으로도 진행</span>
      </div>
      {confirm && (
        <Modal onClose={() => setConfirm(null)}>
          <div className="adv-confirm">
            <h3>경기 있는 날도 자동 진행하시겠습니까?</h3>
            <p>{formatDate(confirm.date)}까지 가는 동안 우리 팀 경기가 <b>{confirm.games}경기</b> 있습니다.</p>
            <ul className="small muted">
              <li><b>예</b> — 저장된 출전시간·전술로 우리 팀 경기도 모두 자동 시뮬레이션하고 그 날까지 진행합니다.</li>
              <li><b>아니요</b> — 첫 번째 경기일에 멈춥니다 (경기는 직접 준비).</li>
            </ul>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setConfirm(null)}>취소</button>
              <button onClick={() => { const d = confirm.date; setConfirm(null); setPicked(null); onAdvanceTo(d, false); }}>아니요</button>
              <button className="primary" onClick={() => { const d = confirm.date; setConfirm(null); setPicked(null); onAdvanceTo(d, true); }}>예, 자동 진행</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** 오늘 칸 말풍선: 훈련일 */
function TrainingBubble({ plan, setPlan, busy, onGo }: { plan: TrainingPlan; setPlan: (p: TrainingPlan) => void; busy: boolean; onGo: () => void }) {
  const { data } = useApi<{ focuses: Focus[] }>("/api/franchise/training");
  return (
    <div className="cb">
      <b className="cb-title">오늘은 훈련일</b>
      <div className="seg-light cb-mode">
        <button className={plan.mode === "train" ? "on" : ""} onClick={() => setPlan({ ...plan, mode: "train" })}>💪 훈련</button>
        <button className={plan.mode === "rest" ? "on" : ""} onClick={() => setPlan({ ...plan, mode: "rest" })}>😴 휴식</button>
      </div>
      {plan.mode === "train" ? (
        <>
          <label className="cb-row">초점 <select value={plan.focus} onChange={(e) => setPlan({ ...plan, focus: e.target.value })}>
            {data?.focuses.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select></label>
          <label className="cb-row">강도 <select value={plan.intensity} onChange={(e) => setPlan({ ...plan, intensity: e.target.value as TrainingPlan["intensity"] })}>
            {Object.entries(INTENSITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        </>
      ) : <p className="small muted" style={{ margin: "6px 0" }}>피로를 더 많이 회복합니다</p>}
      <button className="primary cb-go" disabled={busy} onClick={onGo}>{plan.mode === "rest" ? "휴식하고" : "훈련하고"} 다음 ▶</button>
      <small className="muted">선수별 개인 훈련은 [훈련] 메뉴 · 강도↑ 성장↑ 피로·부상↑</small>
    </div>
  );
}

export function TodayView() {
  const { go, refresh, next, advancing, lastReport, setReport } = useApp();
  const { data, error, reload } = useApi<Today>("/api/franchise/today");
  const [plan, setPlanState] = useState<TrainingPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState<DayResult[]>([]);
  const [box, setBox] = useState<number | null>(null);

  useEffect(() => { if (data) setPlanState(data.trainingPlan); }, [data]);

  if (error) return <ErrorBox error={error} />;
  if (!data || !plan) return <Loading />;
  const f = data.franchise;
  if (f.phase === "offseason") {
    return <Card title="비시즌"><p>시즌이 끝났습니다. 비시즌 메뉴에서 연봉협상·FA·드래프트를 진행하세요.</p><button className="primary" onClick={() => go({ name: "offseason" })}>비시즌으로 →</button></Card>;
  }
  const g = data.game;

  /** 말풍선에서 바꾼 훈련 계획은 바로 저장 → 상단 [다음]도 같은 계획으로 진행 */
  const setPlan = (p: TrainingPlan) => {
    setPlanState(p);
    api("/api/franchise/training", { method: "PUT", body: { mode: p.mode, focus: p.focus, intensity: p.intensity } }).catch((e) => setErr(String(e.message)));
  };
  const goNext = async () => {
    await api("/api/franchise/training", { method: "PUT", body: { mode: plan.mode, focus: plan.focus, intensity: plan.intensity } }).catch(() => null);
    setDays([]);
    next();
  };
  async function advanceTo(date: string, simUserGames: boolean) {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ days: DayResult[]; reason: string; simulated: number }>("/api/franchise/advance-until", { body: { date, simUserGames } });
      setDays(r.days);
      if (r.days.length) setReport({ date: r.days[r.days.length - 1].date, day: r.days[r.days.length - 1] });
      if (r.reason && r.days.length === 0) setErr(r.reason);
      refresh(); reload();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const opponentName = g ? g.opponent.name : "";
  const todayBubble = !g ? (
    <TrainingBubble plan={plan} setPlan={setPlan} busy={busy || advancing} onGo={goNext} />
  ) : !g.played ? (
    <div className="cb">
      <b className="cb-title">🏀 오늘은 경기일</b>
      <p className="small" style={{ margin: "4px 0 8px" }}>{g.isHome ? `vs ${teamStyle(opponentName).short} (홈)` : `@ ${teamStyle(opponentName).short} (원정)`}{g.playoffLabel ? ` · ${g.playoffLabel} ${g.game_number_in_series}차전` : ""}</p>
      <button className="primary cb-go" onClick={() => go({ name: "gameday" })}>경기 준비 →</button>
    </div>
  ) : (
    <div className="cb">
      <b className="cb-title">경기 종료</b>
      <p className="small" style={{ margin: "4px 0 8px" }}>{teamStyle(g.home).short} {g.home_score} : {g.away_score} {teamStyle(g.away).short} <a onClick={() => setBox(g.id)}>박스스코어</a></p>
      <button className="primary cb-go" disabled={advancing} onClick={goNext}>다음 ▶</button>
    </div>
  );
  const reportDate = lastReport?.date ?? prevDay(f.date);
  const autoGames = days.map((d) => d.userGame).filter((x): x is NonNullable<DayResult["userGame"]> => !!x);

  return (
    <div className="today-layout">
      <div className="col" style={{ gap: 12, minWidth: 0 }}>
        <SeasonCalendar today={f.date} userTeamId={f.userTeamId} busy={busy || advancing} todayBubble={todayBubble} onAdvanceTo={advanceTo} onOpenBox={setBox} />
        <ErrorBox error={err} />
        {(busy || advancing) && <p className="muted">진행 중...</p>}
      </div>
      <aside className="today-side col" style={{ gap: 12 }}>
        {days.length > 1 && (
          <Card title={`${formatDate(days[0].date)} ~ ${formatDate(days[days.length - 1].date)} (${days.length}일)`}>
            {autoGames.length > 0 ? (
              <>
                <b className="small">우리 팀 경기 {autoGames.length}경기 · {autoGames.filter((x) => x.won).length}승 {autoGames.filter((x) => !x.won).length}패</b>
                <div className="auto-games">
                  {autoGames.map((x) => (
                    <button key={x.gameId} className={`ag ${x.won ? "w" : "l"}`} onClick={() => setBox(x.gameId)}>
                      {x.won ? "승" : "패"} {teamStyle(x.away).short} {x.awayScore}:{x.homeScore} {teamStyle(x.home).short}{x.ot ? " (OT)" : ""}
                    </button>
                  ))}
                </div>
              </>
            ) : <p className="small muted">이 기간에 우리 팀 경기는 없었습니다.</p>}
            {days.flatMap((d) => d.events).map((e, i) => <div key={i} className="notice small">{e}</div>)}
          </Card>
        )}
        <Card title={`📰 ${formatDate(reportDate)} 소식`} right={<button className="small" onClick={() => go({ name: "news", date: reportDate })}>뉴스 전체 →</button>}>
          <DayNews date={reportDate} compact />
        </Card>
        {data.otherGames.length > 0 && (
          <Card title="오늘 열리는 경기">
            <table><tbody>
              {data.otherGames.map((o) => (
                <tr key={o.id}><td>{teamStyle(o.away).short}</td><td className="num">{o.away_score ?? ""}</td><td className="muted">@</td><td>{o.home_score ?? ""}</td><td>{teamStyle(o.home).short}</td></tr>
              ))}
            </tbody></table>
          </Card>
        )}
      </aside>
      {box && <Modal onClose={() => setBox(null)}><BoxScore gameId={box} /></Modal>}
    </div>
  );
}

/** 경기일: 상대 전력 · 게임플랜 · 출전시간 바로가기 → 직접 지휘 / 빠른 시뮬레이션 */
export function GameDayView() {
  const { go, refresh, next, advancing, lastReport } = useApp();
  const { data, error, reload } = useApi<Today>("/api/franchise/today");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [box, setBox] = useState<number | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const f = data.franchise;
  const g = data.game;
  if (!g) {
    return (
      <Card title={`${formatDate(f.date)} — 오늘은 경기가 없습니다`}>
        <p className="muted">훈련일입니다. 달력에서 훈련을 정하고 상단 <b>다음 ▶</b>으로 진행하세요.</p>
        <button className="primary" onClick={() => go({ name: "today" })}>달력으로</button>
      </Card>
    );
  }
  async function run<T>(fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(true); setErr(null);
    try { const r = await fn(); after?.(r); refresh(); reload(); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  }
  const startLive = () => run(() => api<{ sessionId: string }>(`/api/franchise/games/${g.id}/live`, { body: {} }), (r) => go({ name: "live", sessionId: r.sessionId }));
  const quickSim = () => run(() => api(`/api/franchise/games/${g.id}/quick-sim`, { body: {} }), () => setBox(g.id));
  const oppName = g.opponent.name;
  const os = teamStyle(oppName);
  const ms = teamStyle(f.userTeamName);
  const homeName = g.isHome ? f.userTeamName : oppName;
  const awayName = g.isHome ? oppName : f.userTeamName;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="gd-hero" style={{ ["--away" as string]: teamStyle(awayName).primary, ["--home" as string]: teamStyle(homeName).primary }}>
        <div className="gd-team"><span className="emblem" style={{ width: 54, height: 54, background: teamStyle(awayName).primary }}>{teamStyle(awayName).abbr}</span><b>{teamStyle(awayName).short}</b><small>원정</small></div>
        <div className="gd-mid">
          <small>{formatDate(f.date)}{g.playoffLabel ? ` · ${g.playoffLabel} ${g.game_number_in_series}차전` : ""}</small>
          {g.played ? <b className="gd-score">{g.away_score} : {g.home_score}</b> : <b className="gd-vs">VS</b>}
          <small>{g.isHome ? "홈 경기" : "원정 경기"}</small>
        </div>
        <div className="gd-team"><span className="emblem" style={{ width: 54, height: 54, background: teamStyle(homeName).primary }}>{teamStyle(homeName).abbr}</span><b>{teamStyle(homeName).short}</b><small>홈</small></div>
      </div>
      <ErrorBox error={err} />

      {g.played ? (
        <Card title="경기 종료">
          <p>{teamStyle(g.home).short} <b>{g.home_score}</b> : <b>{g.away_score}</b> {teamStyle(g.away).short} — <a onClick={() => setBox(g.id)}>박스스코어 보기</a></p>
          <p className="muted small">상단 <b>다음 ▶</b>을 누르면 오늘 열린 다른 경기들이 진행되고 다음 날로 넘어갑니다.</p>
          <button className="primary" disabled={advancing} onClick={next}>다음 ▶</button>
        </Card>
      ) : (
        <div className="grid cols-2">
          <Card title={<span>상대 전력 · {os.short} <span className="muted small">{g.opponent.coach.name} 감독 ({g.opponent.coach.style})</span></span>}>
            <p className="muted small" style={{ marginTop: 0 }}>{g.opponent.coach.description}</p>
            <table>
              <thead><tr><th>선수</th><th>OVR</th><th className="num">득점</th><th className="num">리바</th><th className="num">어시</th></tr></thead>
              <tbody>
                {g.opponent.topPlayers.map((p) => (
                  <tr key={p.id}><td><PlayerLink id={p.id} name={p.name} /> <span className="muted small">{p.positionGroup}</span></td><td><Rating value={p.overall} /></td>
                    <td className="num">{p.stats?.pts ?? "-"}</td><td className="num">{p.stats?.reb ?? "-"}</td><td className="num">{p.stats?.ast ?? "-"}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="게임플랜">
            <GamePlanForm game={g} onSaved={reload} />
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={() => go({ name: "roster" })}>선발·출전시간</button>
              <button onClick={() => go({ name: "tactics" })}>팀 전술</button>
            </div>
            <div className="gd-actions">
              <button className="primary big" disabled={busy} onClick={startLive} style={{ ["--team" as string]: ms.primary }}>▶ 경기 직접 지휘</button>
              <button disabled={busy} onClick={quickSim}>빠른 시뮬레이션</button>
            </div>
          </Card>
        </div>
      )}

      {lastReport && (
        <Card title={`📰 ${formatDate(lastReport.date)} 소식`} right={<button className="small" onClick={() => go({ name: "news", date: lastReport.date })}>뉴스 전체 →</button>}>
          <DayNews date={lastReport.date} compact />
        </Card>
      )}
      {box && <Modal onClose={() => setBox(null)}><BoxScore gameId={box} /></Modal>}
    </div>
  );
}
