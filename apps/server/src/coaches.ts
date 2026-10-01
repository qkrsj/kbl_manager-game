/**
 * KBL Manager — AI 감독 (유저 팀을 제외한 9개 팀)
 *
 * 2026-27 시즌 실제 감독 명단을 기준으로, 감독마다 고유 성향(전술)을 부여한다.
 * ⚠️ 성향 수치는 각 감독의 알려진 팀 컬러(언론 보도·과거 팀 스타일)를 참고한 게임용 설정값이다.
 *
 * AI 팀 운영:
 *  - 출전시간: 선수 오버롤 기반 뎁스차트 → 감독의 로테이션 깊이/유망주 선호도로 분배
 *  - 외국선수: 오버롤 높은 쪽이 1옵션 (외국선수 총 출전 가능시간 60분 = 1·4쿼터 1명 + 2·3쿼터 2명)
 *  - 전술: 감독 성향(템포/3점 의존도/수비 전술) + 상대 에이스 더블팀 여부를 경기마다 결정
 */

export type PaceStyle = "fast" | "normal" | "slow";
export type ThreeReliance = "high" | "normal" | "low";
export type DefenseScheme = "man" | "zone" | "press";

export interface CoachProfile {
  teamName: string;
  name: string;
  style: string;
  description: string;
  paceStyle: PaceStyle;
  threePointReliance: ThreeReliance;
  defenseScheme: DefenseScheme;
  rotationDepth: number;     // 0(주전 의존) ~ 1(10인 로테이션)
  youthPreference: number;   // 0 ~ 1 (젊은 선수 출전시간 가산)
  doubleTeamTendency: number; // 0 ~ 1 (상대 에이스 더블팀 빈도)
}

export const COACHES: CoachProfile[] = [
  {
    teamName: "서울 SK 나이츠", name: "전희철", style: "속공·트랜지션",
    description: "강한 압박과 빠른 공수전환, 외국선수 중심의 확실한 1옵션 활용",
    paceStyle: "fast", threePointReliance: "normal", defenseScheme: "press", rotationDepth: 0.35, youthPreference: 0.3, doubleTeamTendency: 0.4,
  },
  {
    teamName: "창원 LG 세이커스", name: "조상현", style: "조직 수비",
    description: "탄탄한 맨투맨 수비와 리바운드, 느린 템포의 하프코트 농구",
    paceStyle: "slow", threePointReliance: "normal", defenseScheme: "man", rotationDepth: 0.45, youthPreference: 0.5, doubleTeamTendency: 0.6,
  },
  {
    teamName: "안양 정관장 레드부스터스", name: "유도훈", style: "수비·지역방어",
    description: "변칙 지역방어와 끈끈한 수비, 가드진 중심 운영",
    paceStyle: "slow", threePointReliance: "normal", defenseScheme: "zone", rotationDepth: 0.5, youthPreference: 0.45, doubleTeamTendency: 0.5,
  },
  {
    teamName: "고양 소노 스카이거너스", name: "손창환", style: "양궁 농구",
    description: "가드 중심의 많은 3점슛 시도와 빠른 템포",
    paceStyle: "fast", threePointReliance: "high", defenseScheme: "man", rotationDepth: 0.4, youthPreference: 0.4, doubleTeamTendency: 0.3,
  },
  {
    teamName: "부산 KCC 이지스", name: "이상민", style: "스타 활용",
    description: "국가대표급 스타 플레이어 중심의 아이솔레이션, 주전 의존도 높음",
    paceStyle: "normal", threePointReliance: "normal", defenseScheme: "man", rotationDepth: 0.2, youthPreference: 0.2, doubleTeamTendency: 0.3,
  },
  {
    teamName: "수원 KT 소닉붐", name: "문경은", style: "모션 오펜스·3점",
    description: "볼 무브먼트와 외곽슛, 베테랑 가드 활용",
    paceStyle: "normal", threePointReliance: "high", defenseScheme: "man", rotationDepth: 0.55, youthPreference: 0.35, doubleTeamTendency: 0.35,
  },
  {
    teamName: "울산 현대모비스 피버스", name: "양동근", style: "압박 수비·육성",
    description: "앞선 압박 수비와 젊은 가드 육성, 두터운 로테이션",
    paceStyle: "fast", threePointReliance: "normal", defenseScheme: "press", rotationDepth: 0.7, youthPreference: 0.8, doubleTeamTendency: 0.45,
  },
  {
    teamName: "대구 한국가스공사 페가수스", name: "강혁", style: "런앤건",
    description: "전원 압박과 빠른 템포, 많은 3점 시도",
    paceStyle: "fast", threePointReliance: "high", defenseScheme: "press", rotationDepth: 0.6, youthPreference: 0.55, doubleTeamTendency: 0.35,
  },
  {
    teamName: "원주 DB 프로미", name: "이규섭", style: "밸런스",
    description: "높이를 활용한 인사이드 공략과 균형 잡힌 공수",
    paceStyle: "normal", threePointReliance: "low", defenseScheme: "man", rotationDepth: 0.5, youthPreference: 0.5, doubleTeamTendency: 0.4,
  },
  {
    teamName: "서울 삼성 썬더스", name: "김상식", style: "모션 오펜스",
    description: "패스 중심의 모션 오펜스와 지역방어 혼용, 리빌딩",
    paceStyle: "normal", threePointReliance: "high", defenseScheme: "zone", rotationDepth: 0.65, youthPreference: 0.7, doubleTeamTendency: 0.3,
  },
];

export const PACE_FACTOR: Record<PaceStyle, number> = { fast: 1.1, normal: 1.0, slow: 0.9 };
export const THREE_MULT: Record<ThreeReliance, number> = { high: 1.35, normal: 1.0, low: 0.7 };

export interface DepthPlayer {
  name: string;
  isForeign: boolean;
  overall: number;
  age: number;
  fatigue: number;
}

/**
 * AI 감독의 출전시간 배분.
 *  - 외국선수: 1옵션 ~33분, 2옵션 ~27분 (합계 60분, 1명뿐이면 최대 34분)
 *  - 국내선수: 남은 시간(200 - 외국선수 시간)을 오버롤 순위 기반 가중치로 분배,
 *    로테이션 인원 = 7 + 로테이션 깊이×2 (7~9명), 1인 최대 34분
 *  - 유망주 선호 감독은 25세 이하에게 가산, 피로도 높은 선수는 감산
 */
export function aiMinutesPlan(players: DepthPlayer[], coach: CoachProfile): Map<string, number> {
  const minutes = new Map<string, number>();
  const foreign = players.filter((p) => p.isForeign).sort((a, b) => b.overall - a.overall);
  let foreignTotal = 0;
  if (foreign.length >= 2) {
    const gap = Math.max(0, Math.min(8, foreign[0].overall - foreign[1].overall));
    const opt1 = 30 + gap * 0.5;
    minutes.set(foreign[0].name, opt1);
    minutes.set(foreign[1].name, 60 - opt1);
    foreignTotal = 60;
    foreign.slice(2).forEach((p) => minutes.set(p.name, 0));
  } else if (foreign.length === 1) {
    minutes.set(foreign[0].name, 34);
    foreignTotal = 34;
  }

  const domesticBudget = 200 - foreignTotal;
  const domestic = players.filter((p) => !p.isForeign).map((p) => {
    let score = p.overall;
    if (p.age <= 25) score += coach.youthPreference * 3;
    if (p.fatigue > 70) score -= (p.fatigue - 70) * 0.15;
    return { p, score };
  }).sort((a, b) => b.score - a.score);

  const rotationSize = Math.min(domestic.length, 7 + Math.round(coach.rotationDepth * 2));
  const steep = 1.6 - coach.rotationDepth * 0.8; // 주전 의존 감독일수록 상위 선수에게 몰아줌
  const weights = domestic.map((d, i) => (i < rotationSize ? Math.pow(rotationSize - i + 1, steep) * (d.score / 75) : 0));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  let alloc = weights.map((w) => (w / wsum) * domesticBudget);
  // 1인 최대 34분 → 초과분은 나머지 로테이션에 재분배
  for (let iter = 0; iter < 4; iter++) {
    let over = 0;
    alloc = alloc.map((m) => { if (m > 34) { over += m - 34; return 34; } return m; });
    if (over <= 0.01) break;
    const room = alloc.map((m, i) => (i < rotationSize && m < 34 ? 34 - m : 0));
    const roomSum = room.reduce((a, b) => a + b, 0) || 1;
    alloc = alloc.map((m, i) => m + over * (room[i] / roomSum));
  }
  domestic.forEach((d, i) => minutes.set(d.p.name, Math.round(alloc[i] * 10) / 10));
  return minutes;
}

export interface OpponentThreat {
  name: string;
  ppg: number;
}

/** 경기별 AI 게임플랜: 상대 득점 1위가 압도적이면 감독 성향에 따라 더블팀 */
export function aiDoubleTeamTarget(coach: CoachProfile, threats: OpponentThreat[]): string | null {
  if (threats.length < 2) return null;
  const sorted = [...threats].sort((a, b) => b.ppg - a.ppg);
  const dominance = sorted[0].ppg - sorted[1].ppg;
  if (sorted[0].ppg < 15) return null;
  const prob = coach.doubleTeamTendency * Math.min(1, 0.4 + dominance / 10);
  return Math.random() < prob ? sorted[0].name : null;
}
