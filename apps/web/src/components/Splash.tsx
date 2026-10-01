import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import "./splash.css";

/**
 * KM27 로딩(타이틀) 화면 — NBA 2K 표지 스타일
 *
 * 이미지 교체: apps/web/public/splash/ 폴더에
 *   - player.png      표지 선수 사진 (배경이 투명한 누끼 PNG, 여러 명 합성도 가능 — 현재 3인 합성본)
 *   - background.jpg  경기장 배경 사진 (가로형)
 * 을 넣으면 자동으로 사용하고, 없으면 기본 일러스트/경기장 그래픽을 보여준다.
 */

const COVER_ATHLETE = { name: "변준형", nameEn: "BYUN JUN-HYUNG", team: "안양 정관장 레드부스터스" };
/** player.png(3인 합성 표지)를 쓸 때 표시하는 커버 선수들 — 화면 왼쪽부터 */
const COVER_TRIO = [
  { name: "이정현", nameEn: "LEE JUNG-HYUN", team: "고양 소노" },
  { name: "변준형", nameEn: "BYUN JUN-HYUNG", team: "안양 정관장" },
  { name: "허훈", nameEn: "HUR HOON", team: "부산 KCC" },
];

const TIPS = [
  "2·3쿼터에는 외국선수 2명이 동시에 코트에 설 수 있습니다",
  "경기 없는 날 훈련을 하면 젊고 잠재력 높은 선수일수록 빨리 성장합니다",
  "연봉협상이 4번 결렬되면 KBL 재정위원회가 보수를 결정합니다",
  "샐러리캡 30억 — 외부 FA 영입은 캡 안에서만 가능합니다",
  "상대 에이스를 더블팀하면 동료에게 오픈 찬스가 생깁니다",
];

const STEPS = ["선수 데이터 불러오는 중", "2026-27 시즌 일정 확인 중", "세이브 불러오는 중", "준비 완료"];
const MIN_DURATION_MS = 3200;

function useImage(src: string) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setOk(true);
    img.onerror = () => setOk(false);
    img.src = src;
  }, [src]);
  return ok;
}

/** 이미지가 없을 때 쓰는 정관장 유니폼 선수 일러스트 (드리블 자세) */
function PlayerIllustration() {
  const skin = "#e3b48d";
  const skinShade = "#c48d66";
  const red = "#c8102e";
  const redDark = "#8f0a20";
  return (
    <svg className="splash-player-svg" viewBox="0 0 400 620" aria-label={`${COVER_ATHLETE.name} 일러스트`}>
      <defs>
        <linearGradient id="jersey" x1="0" x2="1">
          <stop offset="0" stopColor={redDark} />
          <stop offset="0.45" stopColor={red} />
          <stop offset="1" stopColor={redDark} />
        </linearGradient>
        <radialGradient id="ball" cx="0.35" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#ffb05c" />
          <stop offset="1" stopColor="#c45a12" />
        </radialGradient>
      </defs>
      <ellipse cx="200" cy="600" rx="120" ry="14" fill="rgba(0,0,0,0.45)" />
      {/* 다리 */}
      <path d="M176 360 L148 452 L132 556" stroke={skin} strokeWidth="46" strokeLinecap="round" fill="none" />
      <path d="M226 360 L264 452 L282 556" stroke={skinShade} strokeWidth="46" strokeLinecap="round" fill="none" />
      {/* 신발 */}
      <path d="M104 560 h52 a10 10 0 0 1 10 10 v10 h-74 v-8 a12 12 0 0 1 12 -12z" fill="#f5f5f5" />
      <path d="M262 560 h40 a14 14 0 0 1 14 14 v6 h-66 v-8 a12 12 0 0 1 12 -12z" fill="#f5f5f5" />
      <rect x="96" y="574" width="70" height="6" fill={red} />
      <rect x="252" y="574" width="64" height="6" fill={red} />
      {/* 반바지 */}
      <path d="M142 298 L260 298 L282 404 L214 410 L201 356 L188 410 L120 404 Z" fill="url(#jersey)" />
      <path d="M134 330 L124 402" stroke="#fff" strokeWidth="8" />
      <path d="M268 330 L278 402" stroke="#fff" strokeWidth="8" />
      {/* 오른팔(화면 오른쪽) — 수비수를 막는 자세 */}
      <path d="M256 186 L300 252 L314 198" stroke={skinShade} strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* 몸통(유니폼) */}
      <path d="M168 148 Q200 168 232 148 L266 174 Q252 236 258 304 L142 304 Q148 236 134 174 Z" fill="url(#jersey)" />
      <path d="M168 148 Q200 174 232 148" stroke="#fff" strokeWidth="6" fill="none" />
      <path d="M134 174 Q152 204 148 238" stroke="#fff" strokeWidth="5" fill="none" />
      <path d="M266 174 Q248 204 252 238" stroke="#fff" strokeWidth="5" fill="none" />
      <text x="200" y="222" textAnchor="middle" fill="#fff" fontSize="22" fontWeight="900" fontFamily="sans-serif">정관장</text>
      <text x="200" y="282" textAnchor="middle" fill="#fff" fontSize="52" fontWeight="900" fontFamily="Anton, Impact, sans-serif" stroke={redDark} strokeWidth="2">KM</text>
      {/* 왼팔(화면 왼쪽) — 드리블 */}
      <path d="M144 186 L108 266 L98 330" stroke={skin} strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* 공 */}
      <g className="splash-ball">
        <circle cx="92" cy="374" r="32" fill="url(#ball)" />
        <path d="M60 374 H124 M92 342 V406 M70 351 Q92 374 70 397 M114 351 Q92 374 114 397" stroke="#5a2a08" strokeWidth="2.5" fill="none" />
      </g>
      {/* 목·머리 */}
      <rect x="185" y="126" width="30" height="30" rx="9" fill={skinShade} />
      <ellipse cx="200" cy="100" rx="31" ry="37" fill={skin} />
      <path d="M169 96 Q170 58 200 58 Q232 58 231 96 Q222 76 200 76 Q178 76 169 96 Z" fill="#1b1b1b" />
      <rect x="168" y="84" width="64" height="10" rx="4" fill={red} />
      <ellipse cx="200" cy="112" rx="16" ry="8" fill={skinShade} opacity="0.35" />
    </svg>
  );
}

/** 이미지가 없을 때 쓰는 경기장 그래픽: 조명 + 관중석 보케 + 코트 바닥 */
function ArenaBackdrop() {
  const dots = useMemo(() => {
    // 결정적 의사난수 (렌더마다 위치가 바뀌지 않게)
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    return Array.from({ length: 140 }, (_, i) => ({
      key: i,
      left: rnd() * 100,
      top: 8 + rnd() * 52,
      size: 3 + rnd() * 16,
      hue: rnd() < 0.55 ? 0 : rnd() < 0.5 ? 38 : 210,
      alpha: 0.15 + rnd() * 0.45,
      delay: rnd() * 4,
    }));
  }, []);
  return (
    <div className="splash-arena">
      <div className="splash-lights" />
      {dots.map((d) => (
        <span
          key={d.key}
          className="splash-bokeh"
          style={{
            left: `${d.left}%`, top: `${d.top}%`, width: d.size, height: d.size,
            background: `hsla(${d.hue}, 85%, ${d.hue === 0 ? 55 : 70}%, ${d.alpha})`,
            animationDelay: `${d.delay}s`,
          }}
        />
      ))}
      <div className="splash-floor">
        <svg viewBox="0 0 1000 300" preserveAspectRatio="none">
          <rect x="370" y="0" width="260" height="300" fill="rgba(200,16,46,0.55)" />
          <path d="M370 0 V300 M630 0 V300 M0 2 H1000" stroke="rgba(255,255,255,0.7)" strokeWidth="4" fill="none" />
          <path d="M120 0 Q500 520 880 0" stroke="rgba(255,255,255,0.6)" strokeWidth="4" fill="none" />
          <circle cx="500" cy="300" r="110" stroke="rgba(255,255,255,0.6)" strokeWidth="4" fill="none" />
        </svg>
      </div>
    </div>
  );
}

export function Splash({ onDone }: { onDone: () => void }) {
  const playerImg = useImage("/splash/player.png");
  const bgImg = useImage("/splash/background.jpg");
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState(0);
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const started = Date.now();
    let dataReady = false;
    // 실제로 세이브/서버 상태를 미리 불러온다 (실패해도 다음 화면에서 안내)
    api("/api/franchise").catch(() => null).finally(() => { dataReady = true; });
    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      const timePct = Math.min(1, elapsed / MIN_DURATION_MS);
      const pct = dataReady ? timePct : Math.min(0.9, timePct);
      setProgress(pct);
      setStep(Math.min(STEPS.length - 1, Math.floor(pct * (STEPS.length - 1) + 0.0001)));
      if (pct >= 1) {
        clearInterval(timer);
        setLeaving(true);
        setTimeout(onDone, 700);
      }
    }, 50);
    return () => clearInterval(timer);
  }, [onDone]);

  const skip = () => {
    if (progress >= 0.9) { setLeaving(true); setTimeout(onDone, 300); }
  };

  return (
    <div className={`splash ${leaving ? "leaving" : ""}`} onClick={skip}>
      {bgImg ? <div className="splash-photo-bg" style={{ backgroundImage: "url(/splash/background.jpg)" }} /> : <ArenaBackdrop />}
      <div className="splash-streaks" />
      <div className="splash-vignette" />

      <div className="splash-title">
        <div className="splash-badge"><span>KBL</span></div>
        <h1><span className="km">KM</span><span className="yr">27</span></h1>
      </div>

      <div className="splash-player">
        {playerImg ? <img src="/splash/player.png" alt={COVER_TRIO.map((a) => a.name).join(", ")} /> : <PlayerIllustration />}
      </div>

      {playerImg ? (
        <div className="splash-cover-tag">
          <div className="label">COVER ATHLETES</div>
          {COVER_TRIO.map((a) => (
            <div key={a.name} className="trio-row"><span className="name small-name">{a.nameEn}</span><span className="team">{a.name} · {a.team}</span></div>
          ))}
        </div>
      ) : (
        <div className="splash-cover-tag">
          <div className="label">COVER ATHLETE</div>
          <div className="name">{COVER_ATHLETE.nameEn}</div>
          <div className="team">{COVER_ATHLETE.name} · {COVER_ATHLETE.team}</div>
        </div>
      )}

      <div className="splash-bottom">
        <div className="splash-sub">KBL MANAGER 2026-27</div>
        <div className="splash-progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        <div className="splash-status">{STEPS[step]}{progress < 1 ? "..." : ""} <span>{Math.round(progress * 100)}%</span></div>
        <div className="splash-tip">TIP · {tip}</div>
      </div>
    </div>
  );
}
