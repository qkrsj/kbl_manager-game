import { useEffect, useMemo, useState } from "react";
import { teamStyle } from "../teamColors";
import "./calendar.css";
import { useApi, Loading, ErrorBox, Card, Rating, PlayerLink, useApp, Modal } from "./common";
import { BoxScore } from "./BoxScore";
import { api, formatDate, PACE_LABEL, THREE_LABEL, DEFENSE_LABEL, INTENSITY_LABEL, REASON_LABEL } from "../api";
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

/** 하루 진행 결과 요약 */
export function DayResultView({ days }: { days: DayResult[] }) {
  const [box, setBox] = useState<number | null>(null);
  if (days.length === 0) return null;
  const changes = days.flatMap((d) => d.userTeamChanges);
  const injuries = days.flatMap((d) => d.injuries);
  const events = days.flatMap((d) => d.events.map((e) => `${formatDate(d.date)} · ${e}`));
  const last = days[days.length - 1];
  return (
    <Card title={days.length === 1 ? `${formatDate(last.date)} 결과` : `${formatDate(days[0].date)} ~ ${formatDate(last.date)} (${days.length}일)`}>
      {events.map((e, i) => <div key={i} className="notice">{e}</div>)}
      {injuries.length > 0 && <div className="error">🚑 부상: {injuries.map((i) => `${i.name} (${i.days}일)`).join(", ")}</div>}
      {changes.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <b>우리 팀 능력치 변화</b>
          <div className="row small" style={{ gap: 6, marginTop: 4 }}>
            {changes.map((c, i) => (
              <span key={i} className={`pill ${c.delta > 0 ? "green" : "red"}`}>
                {c.name} {c.label} {c.delta > 0 ? "+" : ""}{c.delta} ({REASON_LABEL[c.reason] ?? c.reason})
              </span>
            ))}
          </div>
        </div>
      )}
      {last.results.length > 0 && (
        <>
          <b>다른 경기 결과 ({formatDate(last.date)})</b>
          <table>
            <tbody>
              {last.results.map((r) => (
                <tr key={r.gameId} className="clickable" onClick={() => setBox(r.gameId)}>
                  <td>{r.home}</td><td className="num"><b>{r.homeScore}</b></td><td className="muted">:</td>
                  <td><b>{r.awayScore}</b></td><td>{r.away}{r.ot ? " (OT)" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {box && <Modal onClose={() => setBox(null)}><BoxScore gameId={box} /></Modal>}
    </Card>
  );
}

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

function TrainingPanel({ plan, setPlan }: { plan: TrainingPlan; setPlan: (p: TrainingPlan) => void }) {
  const { data } = useApi<{ focuses: Focus[] }>("/api/franchise/training");
  return (
    <div className="col">
      <div className="row">
        <label><input type="radio" checked={plan.mode === "rest"} onChange={() => setPlan({ ...plan, mode: "rest" })} /> 휴식 (피로 회복↑)</label>
        <label><input type="radio" checked={plan.mode === "train"} onChange={() => setPlan({ ...plan, mode: "train" })} /> 훈련</label>
      </div>
      {plan.mode === "train" && (
        <div className="row">
          <label>훈련 초점 <select value={plan.focus} onChange={(e) => setPlan({ ...plan, focus: e.target.value })}>
            {data?.focuses.map((f) => <option key={f.key} value={f.key}>{f.label} ({f.attributes.join("·")})</option>)}
          </select></label>
          <label>강도 <select value={plan.intensity} onChange={(e) => setPlan({ ...plan, intensity: e.target.value as TrainingPlan["intensity"] })}>
            {Object.entries(INTENSITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        </div>
      )}
      <p className="muted small">성장 속도는 나이·잠재력(드래프트 순위·커리어 기록 추세 반영)·성실성에 따라 다릅니다. 강도가 높을수록 성장이 빠르지만 피로가 쌓이고 부상 위험이 커집니다. 선수별 개인 훈련은 [훈련] 메뉴에서 지정하세요.</p>
    </div>
  );
}

interface SchedGame {
  id: number; game_date: string; home_team: string; away_team: string; home_team_id: number; away_team_id: number;
  home_score: number | null; away_score: number | null; went_to_ot: boolean; playoff_label: string | null;
}

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** 달력: 우리 팀 경기(상대·홈/원정·결과), 오늘, 리그 휴식기. 미래 날짜를 고르면 그날까지 진행 */
function SeasonCalendar({ today, userTeamId, busy, onAdvanceTo, onOpenBox }: {
  today: string; userTeamId: number; busy: boolean; onAdvanceTo: (date: string) => void; onOpenBox: (gameId: number) => void;
}) {
  const { data: mine } = useApi<SchedGame[]>("/api/schedule?teamId=");
  const { data: all } = useApi<SchedGame[]>("/api/schedule?teamId=all");
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => { setMonth(today.slice(0, 7)); setPicked(null); }, [today]);

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

  return (
    <div className="cal">
      <div className="cal-head">
        <button className="small" onClick={() => shift(-1)}>‹</button>
        <b>{y}년 {m}월</b>
        <button className="small" onClick={() => shift(1)}>›</button>
        <span className="muted small">{monthGames.length}경기{played.length ? ` · ${wins}승 ${played.length - wins}패` : ""}</span>
        <span className="cal-spacer" />
        <button className="small" onClick={() => setMonth(today.slice(0, 7))}>오늘</button>
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
          return (
            <div
              key={key}
              className={`cal-cell ${isToday ? "today" : ""} ${past ? "past" : ""} ${picked === key ? "picked" : ""} ${g ? "has-game" : ""} ${breakDay ? "break" : ""} ${clickable ? "clickable" : ""}`}
              onClick={() => { if (g && result) onOpenBox(g.id); else if (clickable) setPicked(picked === key ? null : key); }}
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
            </div>
          );
        })}
      </div>
      <div className="cal-foot">
        {picked ? (
          <>
            <span><b>{formatDate(picked)}</b>까지 저장된 훈련 계획으로 진행합니다 (중간에 우리 팀 경기일이 오면 그날 멈춤)</span>
            <button className="primary" disabled={busy} onClick={() => onAdvanceTo(picked)}>이 날까지 진행 ⏩</button>
          </>
        ) : (
          <span className="muted small">미래 날짜를 누르면 그 날까지 한 번에 진행할 수 있습니다 · 지난 경기를 누르면 박스스코어</span>
        )}
      </div>
    </div>
  );
}

export function TodayView() {
  const { go, refresh } = useApp();
  const { data, error, reload } = useApi<Today>("/api/franchise/today");
  const [plan, setPlan] = useState<TrainingPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState<DayResult[]>([]);
  const [box, setBox] = useState<number | null>(null);

  useEffect(() => { if (data && !plan) setPlan(data.trainingPlan); }, [data, plan]);

  if (error) return <ErrorBox error={error} />;
  if (!data || !plan) return <Loading />;
  const f = data.franchise;
  if (f.phase === "offseason") {
    return <Card title="비시즌"><p>시즌이 끝났습니다. 비시즌 메뉴에서 연봉협상·FA·드래프트를 진행하세요.</p><button className="primary" onClick={() => go({ name: "offseason" })}>비시즌으로 →</button></Card>;
  }
  const g = data.game;

  async function run<T>(fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      after?.(r);
      refresh();
      reload();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const nextDay = () => run(() => api<DayResult>("/api/franchise/advance-day", { body: { plan } }), (r) => setDays([r]));
  const toGame = () => run(() => api<{ days: DayResult[] }>("/api/franchise/advance-to-game", { body: {} }), (r) => setDays(r.days));
  const advanceTo = (date: string) => run(() => api<{ days: DayResult[]; reason: string }>("/api/franchise/advance-until", { body: { date } }), (r) => { setDays(r.days); setErr(r.reason && r.days.length === 0 ? r.reason : null); });
  const startLive = () => run(() => api<{ sessionId: string }>(`/api/franchise/games/${g!.id}/live`, { body: {} }), (r) => go({ name: "live", sessionId: r.sessionId }));
  const quickSim = () => run(() => api(`/api/franchise/games/${g!.id}/quick-sim`, { body: {} }), () => setBox(g!.id));

  const opponentName = g ? g.opponent.name : "";
  return (
    <div className="col" style={{ gap: 16 }}>
      <SeasonCalendar today={f.date} userTeamId={f.userTeamId} busy={busy} onAdvanceTo={advanceTo} onOpenBox={setBox} />
      <ErrorBox error={err} />
      {g && !g.played && (
        <Card title={<span>🏀 오늘은 경기일 — {g.isHome ? `vs ${opponentName} (홈)` : `@ ${opponentName} (원정)`} {g.playoffLabel && <span className="pill">{g.playoffLabel} {g.game_number_in_series}차전</span>}</span>}>
          <div className="grid cols-2">
            <div>
              <h4>상대 전력 · {g.opponent.coach.name} 감독 ({g.opponent.coach.style})</h4>
              <p className="muted small">{g.opponent.coach.description}</p>
              <table>
                <thead><tr><th>선수</th><th>OVR</th><th className="num">득점</th><th className="num">리바</th><th className="num">어시</th></tr></thead>
                <tbody>
                  {g.opponent.topPlayers.map((p) => (
                    <tr key={p.id}><td><PlayerLink id={p.id} name={p.name} /> <span className="muted small">{p.positionGroup}</span></td><td><Rating value={p.overall} /></td>
                      <td className="num">{p.stats?.pts ?? "-"}</td><td className="num">{p.stats?.reb ?? "-"}</td><td className="num">{p.stats?.ast ?? "-"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="col">
              <h4>게임플랜</h4>
              <GamePlanForm game={g} onSaved={reload} />
              <div className="row" style={{ marginTop: 8 }}>
                <button onClick={() => go({ name: "roster" })}>출전시간·로스터</button>
                <button onClick={() => go({ name: "tactics" })}>팀 전술</button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" disabled={busy} onClick={startLive}>▶ 경기 직접 지휘</button>
                <button disabled={busy} onClick={quickSim}>빠른 시뮬레이션</button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {g && g.played && (
        <Card title="오늘 경기 종료">
          <p>{g.home} <b>{g.home_score}</b> : <b>{g.away_score}</b> {g.away} — <a onClick={() => setBox(g.id)}>박스스코어 보기</a></p>
          <p className="muted small">우리 팀은 경기 후 회복합니다. 다음 날로 넘어가면 오늘 열린 다른 경기들이 진행됩니다.</p>
          <button className="primary" disabled={busy} onClick={nextDay}>다음 날 ▶</button>
        </Card>
      )}

      {!g && (
        <Card title={`${formatDate(f.date)} — 경기 없는 날`}>
          <TrainingPanel plan={plan} setPlan={setPlan} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy} onClick={nextDay}>{plan.mode === "rest" ? "휴식하고" : "훈련하고"} 다음 날 ▶</button>
            <button disabled={busy} onClick={toGame} title="저장된 훈련 계획으로 다음 경기일까지 하루씩 자동 진행">다음 경기일까지 ⏩</button>
          </div>
        </Card>
      )}

      {data.otherGames.length > 0 && (
        <Card title="오늘의 다른 경기">
          <table><tbody>
            {data.otherGames.map((o) => (
              <tr key={o.id}><td>{o.home}</td><td className="num">{o.home_score ?? ""}</td><td className="muted">vs</td><td>{o.away_score ?? ""}</td><td>{o.away}</td></tr>
            ))}
          </tbody></table>
        </Card>
      )}

      <DayResultView days={days} />
      {busy && <p className="muted">진행 중...</p>}
      {box && <Modal onClose={() => setBox(null)}><BoxScore gameId={box} /></Modal>}
    </div>
  );
}
