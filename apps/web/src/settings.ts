/** KM27 — 화면 설정 (이 브라우저에만 저장) */
import { useEffect, useState } from "react";

export interface Settings {
  theme: "system" | "light" | "dark";
  fontSize: "small" | "normal" | "large";
  showSplash: boolean;      // 시작할 때 로딩 화면
  motion: boolean;          // 화면 전환·배경 애니메이션
  confirmNewGame: boolean;  // 새로 시작 전 확인
  coverDim: number;         // 타이틀 배경 사진 어둡기 0~70 (%)
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system", fontSize: "normal", showSplash: true, motion: true, confirmNewGame: true, coverDim: 25,
};

const KEY = "km27.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function applySettings(s: Settings) {
  const root = document.documentElement;
  if (s.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", s.theme);
  root.setAttribute("data-font", s.fontSize);
  root.setAttribute("data-motion", s.motion ? "on" : "off");
}

const listeners = new Set<(s: Settings) => void>();
let current = loadSettings();

export function saveSettings(next: Settings) {
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 저장 불가(사생활 보호 모드 등) — 이번 실행 동안만 유지 */ }
  applySettings(next);
  listeners.forEach((l) => l(next));
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    return () => { listeners.delete(setS); };
  }, []);
  return [s, (patch) => saveSettings({ ...current, ...patch })];
}
