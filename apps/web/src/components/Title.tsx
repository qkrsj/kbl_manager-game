import { useEffect, useState } from "react";
import { api, formatDate, PHASE_LABEL } from "../api";
import type { Franchise, Standing } from "../api";
import { ArenaBackdrop, useImage } from "./Splash";
import { SettingsPanel } from "./Settings";
import { useSettings } from "../settings";
import { teamStyle } from "../teamColors";
import "./splash.css";
import "./title.css";

export interface SaveSummary {
  franchise: Franchise & { manager?: { name: string } | null };
  wins: number;
  losses: number;
  rank: number | null;
}

/** 저장된 게임 요약 (없으면 null) */
export function useSaveSummary(version = 0) {
  const [save, setSave] = useState<SaveSummary | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const f = await api<SaveSummary["franchise"]>("/api/franchise");
        const st = await api<Standing[]>("/api/standings").catch(() => [] as Standing[]);
        const mine = st.find((s) => s.team_id === f.userTeamId);
        if (alive) setSave({ franchise: f, wins: mine?.wins ?? 0, losses: mine?.losses ?? 0, rank: mine?.rank ?? null });
      } catch {
        if (alive) setSave(null);
      }
    })();
    return () => { alive = false; };
  }, [version]);
  return save;
}

/** 로딩 화면 다음의 메인(타이틀) 화면 — 표지 사진 + 왼쪽 메뉴(이어서 하기 / 새로 시작) + 오른쪽 설정 */
export function TitleScreen({ onContinue, onNewGame }: { onContinue: () => void; onNewGame: () => void }) {
  const playerImg = useImage("/splash/player.png");
  const bgImg = useImage("/splash/background.jpg");
  const save = useSaveSummary();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings] = useSettings();
  const [focusState, setFocus] = useState(0);
  const canContinue = !!save;
  const focus = canContinue ? focusState : 1; // 저장된 게임이 없으면 "새로 시작"에 커서

  const items = [
    { key: "continue", label: "이어서 하기", disabled: !canContinue, action: onContinue },
    { key: "new", label: "새로 시작", disabled: false, action: onNewGame },
  ];

  // 키보드: ↑↓ 선택, Enter 실행 (2K 메뉴처럼)
  useEffect(() => {
    if (settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocus((f) => (f + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      } else if (e.key === "Enter") {
        const it = items[focus];
        if (!it.disabled) it.action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ts = save ? teamStyle(save.franchise.userTeamName) : null;

  return (
    <div className="title-screen">
      {bgImg ? <div className="splash-photo-bg" style={{ backgroundImage: "url(/splash/background.jpg)" }} /> : <ArenaBackdrop />}
      <div className="splash-streaks" />
      <div className="splash-vignette" />
      <div className="title-dim" style={{ opacity: settings.coverDim / 100 }} />

      <div className="title-cover">
        {playerImg ? <img src="/splash/player.png" alt="KM27 표지" /> : null}
      </div>
      <div className="title-left-shade" />

      <div className="title-logo">
        <div className="splash-badge small"><span>KBL</span></div>
        <div>
          <div className="title-logo-text"><span className="km">KM</span><span className="yr">27</span></div>
          <div className="title-logo-sub">KBL MANAGER 2026-27</div>
        </div>
      </div>

      <nav className="title-menu" aria-label="메인 메뉴">
        <button
          className={`title-item ${focus === 0 ? "focused" : ""}`}
          disabled={!canContinue}
          onMouseEnter={() => canContinue && setFocus(0)}
          onClick={onContinue}
        >
          <span className="title-item-label">이어서 하기</span>
          {save === undefined ? (
            <span className="title-item-sub">저장된 게임 확인 중...</span>
          ) : save ? (
            <span className="title-save">
              <span className="title-save-team" style={{ borderColor: ts!.primary }}>
                <i style={{ background: ts!.primary }} />{save.franchise.userTeamName}
              </span>
              <span className="title-item-sub">
                {save.franchise.manager?.name ? `${save.franchise.manager.name} 감독 · ` : ""}
                {save.franchise.seasonLabel} {PHASE_LABEL[save.franchise.phase]} · {save.wins}승 {save.losses}패{save.rank ? ` (${save.rank}위)` : ""}
              </span>
              <span className="title-item-sub">{formatDate(save.franchise.date)}</span>
            </span>
          ) : (
            <span className="title-item-sub">저장된 게임이 없습니다 — 새로 시작하세요</span>
          )}
        </button>

        <button
          className={`title-item ${focus === 1 ? "focused" : ""}`}
          onMouseEnter={() => setFocus(1)}
          onClick={onNewGame}
        >
          <span className="title-item-label">새로 시작</span>
          <span className="title-item-sub">감독 프로필을 만들고 팀을 선택합니다</span>
        </button>
        <div className="title-hint">↑↓ 선택 · Enter 시작</div>
      </nav>

      <div className="title-right">
        <button className="title-settings-btn" onClick={() => setSettingsOpen(true)}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)" />
          </svg>
          <span>설정</span>
        </button>
      </div>

      <div className="title-footer">KM27 · 2026-27 시즌 데이터 기준</div>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
