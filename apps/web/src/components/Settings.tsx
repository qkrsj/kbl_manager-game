import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { API_BASE, api } from "../api";
import { DEFAULT_SETTINGS, useSettings } from "../settings";
import type { Settings } from "../settings";

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.v} className={value === o.v ? "on" : ""} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle ${value ? "on" : ""}`} role="switch" aria-checked={value} onClick={() => onChange(!value)}>
      <span />
    </button>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <div className="set-label">{label}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

/** 설정 패널 (타이틀 화면·게임 화면 공용) — 화면/시작/게임/정보 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, set] = useSettings();
  const [server, setServer] = useState<"checking" | "ok" | "fail">("checking");
  useEffect(() => {
    api("/api/new-game/teams").then(() => setServer("ok")).catch(() => setServer("fail"));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <aside className="settings-panel" onClick={(e) => e.stopPropagation()} aria-label="설정">
        <div className="settings-head">
          <h2>설정</h2>
          <button className="settings-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        <section>
          <h3>화면</h3>
          <Row label="테마">
            <Seg<Settings["theme"]> value={s.theme} onChange={(v) => set({ theme: v })}
              options={[{ v: "system", label: "시스템" }, { v: "light", label: "라이트" }, { v: "dark", label: "다크" }]} />
          </Row>
          <Row label="글자 크기">
            <Seg<Settings["fontSize"]> value={s.fontSize} onChange={(v) => set({ fontSize: v })}
              options={[{ v: "small", label: "작게" }, { v: "normal", label: "보통" }, { v: "large", label: "크게" }]} />
          </Row>
          <Row label="화면 효과" hint="배경 움직임·화면 전환 애니메이션">
            <Toggle value={s.motion} onChange={(v) => set({ motion: v })} />
          </Row>
        </section>

        <section>
          <h3>시작 화면</h3>
          <Row label="로딩 화면 보기" hint="끄면 바로 메인 화면으로 넘어갑니다">
            <Toggle value={s.showSplash} onChange={(v) => set({ showSplash: v })} />
          </Row>
          <Row label="배경 어둡기" hint={`${s.coverDim}%`}>
            <input type="range" min={0} max={70} step={5} value={s.coverDim} onChange={(e) => set({ coverDim: Number(e.target.value) })} />
          </Row>
        </section>

        <section>
          <h3>게임</h3>
          <Row label="새로 시작 전 확인" hint="저장된 게임을 덮어쓰기 전에 한 번 더 묻기">
            <Toggle value={s.confirmNewGame} onChange={(v) => set({ confirmNewGame: v })} />
          </Row>
        </section>

        <section>
          <h3>정보</h3>
          <Row label="게임 서버" hint={API_BASE}>
            <span className={`set-status ${server}`}>{server === "checking" ? "확인 중" : server === "ok" ? "연결됨" : "연결 안 됨"}</span>
          </Row>
          {server === "fail" && <p className="set-note">게임 폴더에서 <code>npm start</code>로 서버를 켜 주세요.</p>}
          <p className="set-note">
            표지 사진 바꾸기: <code>apps/web/public/splash/player.png</code>(투명 배경 PNG)와 <code>background.jpg</code>를 넣고 새로고침.
          </p>
          <p className="set-note">설정은 이 브라우저에만 저장됩니다.</p>
        </section>

        <button className="settings-reset" onClick={() => set(DEFAULT_SETTINGS)}>설정 기본값으로</button>
      </aside>
    </div>
  );
}
