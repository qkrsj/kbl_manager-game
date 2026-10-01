/** KBL 10개 구단 색상·약칭 (팀 선택 카드·헤더 등 장식용) */
export interface TeamStyle { short: string; abbr: string; primary: string; secondary: string; city: string }

const TEAMS: Record<string, TeamStyle> = {
  "서울 SK 나이츠": { short: "SK", abbr: "SK", primary: "#e4002b", secondary: "#1a1a1a", city: "서울" },
  "창원 LG 세이커스": { short: "LG", abbr: "LG", primary: "#a50034", secondary: "#c9a227", city: "창원" },
  "원주 DB 프로미": { short: "DB", abbr: "DB", primary: "#00843d", secondary: "#0b3d2e", city: "원주" },
  "안양 정관장 레드부스터스": { short: "정관장", abbr: "KGC", primary: "#c8102e", secondary: "#2b1a1d", city: "안양" },
  "부산 KCC 이지스": { short: "KCC", abbr: "KCC", primary: "#1d3f94", secondary: "#e31837", city: "부산" },
  "수원 KT 소닉붐": { short: "KT", abbr: "KT", primary: "#e60012", secondary: "#111111", city: "수원" },
  "서울 삼성 썬더스": { short: "삼성", abbr: "SS", primary: "#1428a0", secondary: "#0a1650", city: "서울" },
  "울산 현대모비스 피버스": { short: "현대모비스", abbr: "HM", primary: "#002c5f", secondary: "#e4002b", city: "울산" },
  "고양 소노 스카이거너스": { short: "소노", abbr: "SONO", primary: "#3fa9dc", secondary: "#0a2240", city: "고양" },
  "대구 한국가스공사 페가수스": { short: "가스공사", abbr: "GAS", primary: "#0b3d91", secondary: "#00a3e0", city: "대구" },
};

export function teamStyle(name: string | null | undefined): TeamStyle {
  if (name && TEAMS[name]) return TEAMS[name];
  const short = (name ?? "").split(" ").slice(1, 2).join("") || name || "?";
  return { short, abbr: short.slice(0, 3), primary: "#2563eb", secondary: "#1e293b", city: (name ?? "").split(" ")[0] ?? "" };
}

/** 팀 로고 대신 쓰는 엠블럼 (원형 배지 + 약칭) */
export function teamNickname(name: string): string {
  const parts = name.split(" ");
  return parts.slice(2).join(" ") || parts[parts.length - 1];
}
