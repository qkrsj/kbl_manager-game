import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { teamStyle } from "../teamColors";
import { useSettings } from "../settings";
import { ArenaBackdrop } from "./Splash";
import "./splash.css";
import "./title.css";
import "./newgame.css";

export interface ManagerProfileInput {
  name: string;
  age: number;
  playStyle: string;
  personality: string;
  direction: string;
  hometown?: string;
  motto?: string;
}

interface Option { id: string; label: string; description: string; effect?: string }
interface Options { playStyles: Option[]; personalities: Option[]; directions: Option[] }
interface NewGameTeam {
  name: string; coach: string; style: string; description: string; teamOverall: number;
  keyPlayers: { name: string; position: string; overall: number; type: string }[];
}

const FALLBACK_OPTIONS: Options = {
  playStyles: [
    { id: "run", label: "속공·트랜지션", description: "빠른 템포와 전방 압박으로 쉬운 득점을 만든다" },
    { id: "three", label: "양궁 농구", description: "볼을 돌려 3점슛 기회를 최대한 많이 만든다" },
    { id: "defense", label: "질식 수비", description: "느린 템포의 하프코트 농구, 맨투맨 수비와 리바운드" },
    { id: "inside", label: "골밑 장악", description: "빅맨 중심 포스트업과 지역방어, 리바운드 우선" },
    { id: "balanced", label: "밸런스", description: "상대에 맞춰 공수 균형을 잡는 정석 농구" },
  ],
  personalities: [
    { id: "motivator", label: "카리스마형 리더", description: "강한 장악력으로 선수단을 이끈다", effect: "경기 경험치 +15%" },
    { id: "players", label: "덕장 (선수 친화)", description: "선수와 소통하며 컨디션을 세심하게 관리한다", effect: "피로 회복 +20%" },
    { id: "tactician", label: "지장 (전술가)", description: "데이터와 전술 훈련을 중시한다", effect: "훈련 성장 +10%" },
    { id: "disciplinarian", label: "원칙주의자", description: "엄격한 규율과 몸 관리를 강조한다", effect: "부상 위험 −25%" },
  ],
  directions: [
    { id: "win_now", label: "윈나우", description: "지금 당장 우승을 노린다 — 베테랑·주전 중심", effect: "27세 이상 훈련 성장 +15%" },
    { id: "balanced", label: "균형", description: "성적과 육성을 함께 챙긴다", effect: "전원 훈련 성장 +5%" },
    { id: "rebuild", label: "리빌딩", description: "유망주에게 기회를 주고 미래를 준비한다", effect: "24세 이하 훈련 성장 +25%" },
  ],
};

const PROFILE_KEY = "km27.lastProfile";
function lastProfile(): ManagerProfileInput {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* 무시 */ }
  return { name: "", age: 42, playStyle: "balanced", personality: "tactician", direction: "balanced", hometown: "", motto: "" };
}

function ChoiceGrid({ options, value, onChange }: { options: Option[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="ng-choices">
      {options.map((o) => (
        <button key={o.id} className={`ng-choice ${value === o.id ? "on" : ""}`} onClick={() => onChange(o.id)}>
          <b>{o.label}</b>
          <span>{o.description}</span>
          {o.effect && <em>{o.effect}</em>}
        </button>
      ))}
    </div>
  );
}

/** 감독 카드 미리보기 (프로필 입력·팀 선택 화면 공용) */
export function ManagerCard({ p, options, teamName }: { p: ManagerProfileInput; options: Options; teamName?: string }) {
  const ts = teamStyle(teamName);
  const style = options.playStyles.find((o) => o.id === p.playStyle);
  const per = options.personalities.find((o) => o.id === p.personality);
  const dir = options.directions.find((o) => o.id === p.direction);
  const initials = (p.name || "감독").slice(0, 2);
  return (
    <div className="ng-card" style={{ ["--team" as string]: teamName ? ts.primary : "#c8102e" }}>
      <div className="ng-card-top">
        <div className="ng-avatar">{initials}</div>
        <div>
          <div className="ng-card-role">HEAD COACH{teamName ? ` · ${ts.short}` : ""}</div>
          <div className="ng-card-name">{p.name || "이름 없음"}</div>
          <div className="ng-card-meta">{p.age}세{p.hometown ? ` · ${p.hometown}` : ""}</div>
        </div>
      </div>
      <div className="ng-card-rows">
        <div><span>플레이 스타일</span><b>{style?.label}</b></div>
        <div><span>성격</span><b>{per?.label}</b></div>
        <div><span>운영 방향</span><b>{dir?.label}</b></div>
      </div>
      <div className="ng-card-effects">
        {per?.effect && <span>{per.effect}</span>}
        {dir?.effect && <span>{dir.effect}</span>}
      </div>
      {p.motto && <div className="ng-card-motto">“{p.motto}”</div>}
    </div>
  );
}

export function useManagerOptions() {
  const [options, setOptions] = useState<Options>(FALLBACK_OPTIONS);
  useEffect(() => { api<Options>("/api/manager/options").then(setOptions).catch(() => null); }, []);
  return options;
}

/** 새로 시작: ① 감독 프로필 만들기 → ② 팀 선택 (팀별 핵심 선수 2명) → 부임 */
export function NewGameFlow({ onBack, onStarted, hasSave }: { onBack: () => void; onStarted: () => void; hasSave: boolean }) {
  const [settings] = useSettings();
  const [step, setStep] = useState<1 | 2>(1);
  const [p, setP] = useState<ManagerProfileInput>(lastProfile);
  const options = useManagerOptions();
  const [teams, setTeams] = useState<NewGameTeam[] | null>(null);
  const [teamErr, setTeamErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<NewGameTeam[]>("/api/new-game/teams")
      .then(setTeams)
      .catch((e) => setTeamErr(`팀 목록을 불러올 수 없습니다 — 게임 서버(npm start)가 켜져 있는지 확인하세요. (${e.message})`));
  }, []);

  const set = (patch: Partial<ManagerProfileInput>) => setP((cur) => ({ ...cur, ...patch }));
  const nameOk = p.name.trim().length >= 1;
  const sortedTeams = useMemo(() => teams ?? [], [teams]);
  const pickedTeam = sortedTeams.find((t) => t.name === picked) ?? null;

  async function start() {
    if (!pickedTeam) return;
    if (hasSave && settings.confirmNewGame && !confirm("저장된 게임을 지우고 새로 시작할까요?")) return;
    setBusy(true); setErr(null);
    try {
      try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* 무시 */ }
      await api("/api/new-game", { body: { teamName: pickedTeam.name, profile: { ...p, name: p.name.trim() } } });
      onStarted();
    } catch (e) {
      const msg = String((e as Error).message);
      setErr(msg.includes("does not exist") ? `DB 테이블이 없습니다. 게임 폴더에서 npm run setup 을 먼저 실행하세요. (${msg})` : msg);
      setBusy(false);
    }
  }

  return (
    <div className="ng-screen">
      <ArenaBackdrop />
      <div className="splash-vignette" />
      <div className="ng-shade" />

      <header className="ng-header">
        <button className="ng-back" onClick={step === 1 ? onBack : () => setStep(1)}>← {step === 1 ? "메인으로" : "프로필 수정"}</button>
        <div className="ng-steps">
          <span className={step === 1 ? "on" : "done"}>1 감독 프로필</span>
          <i />
          <span className={step === 2 ? "on" : ""}>2 팀 선택</span>
        </div>
        <div className="ng-header-logo">KM<span>27</span></div>
      </header>

      {step === 1 ? (
        <main className="ng-body ng-profile">
          <section className="ng-form">
            <h1>감독 프로필</h1>
            <p className="ng-lead">당신이 선택한 팀의 새 감독으로 부임합니다. 플레이 스타일은 시작 전술이 되고, 성격과 운영 방향은 선수단 성장에 영향을 줍니다.</p>

            <div className="ng-fields">
              <label>이름<input value={p.name} maxLength={20} placeholder="예: 박지성" onChange={(e) => set({ name: e.target.value })} autoFocus /></label>
              <label>나이<input type="number" min={28} max={80} value={p.age} onChange={(e) => set({ age: Number(e.target.value) })} /></label>
              <label>출신<input value={p.hometown ?? ""} maxLength={20} placeholder="예: 서울 / 연세대" onChange={(e) => set({ hometown: e.target.value })} /></label>
              <label className="wide">좌우명<input value={p.motto ?? ""} maxLength={60} placeholder="예: 수비가 이긴다" onChange={(e) => set({ motto: e.target.value })} /></label>
            </div>

            <h2>플레이 스타일</h2>
            <ChoiceGrid options={options.playStyles} value={p.playStyle} onChange={(v) => set({ playStyle: v })} />
            <h2>성격</h2>
            <ChoiceGrid options={options.personalities} value={p.personality} onChange={(v) => set({ personality: v })} />
            <h2>운영 방향</h2>
            <ChoiceGrid options={options.directions} value={p.direction} onChange={(v) => set({ direction: v })} />
          </section>

          <aside className="ng-side">
            <ManagerCard p={p} options={options} />
            <button className="ng-primary" disabled={!nameOk} onClick={() => setStep(2)}>
              {nameOk ? "다음 — 팀 선택" : "이름을 입력하세요"}
            </button>
          </aside>
        </main>
      ) : (
        <main className="ng-body ng-teams-wrap">
          <section className="ng-teams-main">
            <h1>팀 선택</h1>
            <p className="ng-lead">2026-27 시즌을 함께할 팀을 고르세요. 선택한 팀의 기존 감독 자리를 {p.name || "당신"} 감독이 맡습니다.</p>
            {teamErr && <div className="ng-error">{teamErr}</div>}
            {!teams && !teamErr && <p className="ng-lead">팀 정보를 불러오는 중...</p>}
            <div className="ng-teams">
              {sortedTeams.map((t) => {
                const ts = teamStyle(t.name);
                return (
                  <button
                    key={t.name}
                    className={`ng-team ${picked === t.name ? "on" : ""}`}
                    style={{ ["--team" as string]: ts.primary, ["--team2" as string]: ts.secondary }}
                    onClick={() => setPicked(t.name)}
                    onDoubleClick={() => { setPicked(t.name); }}
                  >
                    <div className="ng-team-head">
                      <span className="ng-emblem" style={{ fontSize: Math.max(9, Math.min(16, 34 / (Math.max(2, ts.abbr.length) * 0.62))) }}>{ts.abbr}</span>
                      <span className="ng-team-name">
                        <small>{ts.city}</small>
                        {t.name.split(" ").slice(1).join(" ")}
                      </span>
                      <span className="ng-team-ovr"><small>전력</small>{t.teamOverall}</span>
                    </div>
                    <div className="ng-keys">
                      {t.keyPlayers.map((k) => (
                        <div key={k.name} className="ng-key">
                          <span className="ng-key-ovr">{k.overall}</span>
                          <span className="ng-key-name">{k.name}<small>{k.position} · {k.type}</small></span>
                        </div>
                      ))}
                    </div>
                    <div className="ng-team-coach">기존 감독 <s>{t.coach}</s> → <b>{p.name || "당신"}</b></div>
                  </button>
                );
              })}
            </div>
          </section>

          <aside className="ng-side">
            <ManagerCard p={p} options={options} teamName={pickedTeam?.name} />
            {pickedTeam ? (
              <div className="ng-picked">
                <div className="ng-picked-team" style={{ color: teamStyle(pickedTeam.name).primary }}>{pickedTeam.name}</div>
                <div className="ng-picked-sub">핵심 선수 · {pickedTeam.keyPlayers.map((k) => k.name).join(", ")}</div>
              </div>
            ) : <div className="ng-picked ng-picked-sub">왼쪽에서 팀을 고르세요</div>}
            {err && <div className="ng-error">{err}</div>}
            <button className="ng-primary" disabled={!pickedTeam || busy} onClick={start}>
              {busy ? "리그를 만드는 중..." : pickedTeam ? `${teamStyle(pickedTeam.name).short} 감독으로 부임` : "팀을 선택하세요"}
            </button>
          </aside>
        </main>
      )}

      {busy && (
        <div className="ng-busy">
          <div className="ng-spinner" />
          <div>2026-27 시즌 리그를 만드는 중...</div>
          <small>선수 능력치 계산과 일정 생성에 몇 초 걸립니다</small>
        </div>
      )}
    </div>
  );
}
