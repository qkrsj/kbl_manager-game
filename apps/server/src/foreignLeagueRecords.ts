/**
 * KBL Manager — 해외리그 실제 기록 (외국선수·아시아쿼터 평가용)
 *
 * 대상
 *   1) KBL 기록이 없는 선수 (KBL 첫 시즌)
 *   2) 마지막 KBL 시즌이 3년 이상 지난 선수 (예: 2023-24 이전) — KBL 기록 대신 최근 해외리그 기록으로 평가
 *
 * 시즌마다 리그·경기수·출전시간·경기당 기록을 적는다. 모르는 항목은 null로 두면
 * overseasEvaluation.ts가 (1) 같은 선수의 다른 시즌 기록 → (2) 같은 포지션 KBL 선수 중앙값 순서로 채운다.
 *
 * 리그 수준(LEAGUES.factor)은 "그 리그 경기당 기록이 KBL에서는 몇 배로 나오는가"이다 (KBL = 1.00).
 * 더 강한 리그(NBA, 유럽 상위, 일본 B1)는 1보다 크고, 약한 리그는 1보다 작다.
 * 공식 환산 계수가 있는 건 아니라서, 외국선수 이적 사례와 통념을 바탕으로 정한 값이다.
 */

export type LeagueKey =
  | "KBL" | "NBA" | "EUROLEAGUE" | "ACB" | "BSL" | "LBA" | "B1" | "NBL_AUS" | "GLEAGUE" | "EASL" | "ISRAEL"
  | "CBA" | "B2" | "BSN" | "LEBANON" | "TAIWAN" | "BULGARIA" | "PBA" | "MPBL" | "UAAP";

export const LEAGUES: Record<LeagueKey, { label: string; factor: number }> = {
  NBA:        { label: "NBA", factor: 1.6 },
  EUROLEAGUE: { label: "유로리그", factor: 1.45 },
  ACB:        { label: "스페인 ACB", factor: 1.3 },
  BSL:        { label: "튀르키예 BSL", factor: 1.2 },
  LBA:        { label: "이탈리아 LBA", factor: 1.15 },
  B1:         { label: "일본 B1리그", factor: 1.1 },
  NBL_AUS:    { label: "호주 NBL", factor: 1.05 },
  KBL:        { label: "KBL", factor: 1.0 },
  GLEAGUE:    { label: "NBA G리그", factor: 1.0 },
  EASL:       { label: "동아시아 슈퍼리그(EASL)", factor: 1.0 },
  ISRAEL:     { label: "이스라엘 리그", factor: 1.0 },
  CBA:        { label: "중국 CBA", factor: 0.9 },   // 외국선수 사용량이 매우 커서 기록이 부풀려짐
  B2:         { label: "일본 B2리그", factor: 0.85 },
  BSN:        { label: "푸에르토리코 BSN", factor: 0.85 },
  LEBANON:    { label: "레바논 리그/서아시아 리그(WASL)", factor: 0.8 },
  PBA:        { label: "필리핀 PBA", factor: 0.8 },
  TAIWAN:     { label: "대만 PLG/TPBL", factor: 0.75 },
  BULGARIA:   { label: "불가리아 NBL", factor: 0.65 },
  MPBL:       { label: "필리핀 MPBL", factor: 0.6 },
  UAAP:       { label: "필리핀 대학리그(UAAP)", factor: 0.5 },
};

export interface OverseasSeason {
  season: string;      // 표시용 (예: "2025-26", "2026")
  endYear: number;     // 시즌이 끝난 해 (2025-26 → 2026, 여름리그 2026 → 2026) — 최근도 가중치 기준
  league: LeagueKey;
  team: string;
  G: number | null;    // 출전 경기수 (모르면 null)
  MIN: number | null;  // 경기당 출전시간
  PTS: number;
  REB: number;
  AST: number | null;
  STL: number | null;
  BLK: number | null;
  TO: number | null;
  FG: number | null;   // 야투율 0~1
  TP: number | null;   // 3점 성공률 0~1
  FT: number | null;   // 자유투 성공률 0~1
}

export interface OverseasPlayerRecord {
  name: string;
  seasons: OverseasSeason[];
  note?: string;
}

const s = (x: Partial<OverseasSeason> & Pick<OverseasSeason, "season" | "endYear" | "league" | "team" | "PTS" | "REB">): OverseasSeason => ({
  G: null, MIN: null, AST: null, STL: null, BLK: null, TO: null, FG: null, TP: null, FT: null, ...x,
});

export const OVERSEAS_RECORDS: OverseasPlayerRecord[] = [
  // ---------------- KBL 첫 시즌 ----------------
  {
    name: "아치 굿윈",
    seasons: [
      s({ season: "2025-26", endYear: 2026, league: "TAIWAN", team: "타이베이 푸본", G: 33, PTS: 26.4, REB: 5.3, AST: 3.4, STL: 1.6 }),
      s({ season: "2025-26 PO", endYear: 2026, league: "TAIWAN", team: "타이베이 푸본", G: 4, PTS: 30.3, REB: 5.3, AST: 4.0, TP: 0.359 }),
    ],
    note: "EASL 2025-26 경기당 29.3점(득점 1위)은 리바운드·어시스트가 확인되지 않아 제외",
  },
  {
    name: "다리우스 베즐리",
    seasons: [
      s({ season: "2026", endYear: 2026, league: "BSN", team: "폰세", G: 11, PTS: 12.5, REB: 10.5, AST: 3.0 }),
      s({ season: "2025-26", endYear: 2026, league: "CBA", team: "닝보", G: 12, PTS: 4.9, REB: 3.8, AST: 1.2 }),
      s({ season: "2025", endYear: 2025, league: "BSN", team: "폰세", G: 9, PTS: 14.6, REB: 8.9, AST: 2.2 }),
      s({ season: "2024-25", endYear: 2025, league: "CBA", team: "광둥", G: 33, PTS: 12.7, REB: 7.5, AST: 3.0 }),
      s({ season: "2024-25", endYear: 2025, league: "GLEAGUE", team: "G리그", G: 11, MIN: 30.8, PTS: 18.5, REB: 9.6, AST: 1.9, STL: 1.5, BLK: 1.5 }),
    ],
  },
  {
    name: "존 무니",
    seasons: [
      s({ season: "2025-26", endYear: 2026, league: "B1", team: "지바 제츠", G: 28, MIN: 27.1, PTS: 14.3, REB: 11.3, AST: 3.3, FG: 0.592, TP: 0.333, FT: 0.835 }),
      s({ season: "2024-25", endYear: 2025, league: "B1", team: "지바 제츠", G: 48, PTS: 11.7, REB: 10.4, AST: 1.5, FG: 0.55 }),
    ],
  },
  {
    name: "트레이 포터",
    seasons: [
      s({ season: "2025-26", endYear: 2026, league: "B1", team: "알티리 지바", G: 58, MIN: 23.0, PTS: 11.7, REB: 7.9, AST: 1.4, BLK: 1.1, STL: 0.4, TO: 1.0, FG: 0.636, FT: 0.738 }),
    ],
    note: "불가리아 2020-21 기록은 3년 이상 지나 제외",
  },
  {
    name: "스카티 제임스",
    seasons: [
      s({ season: "2025-26", endYear: 2026, league: "CBA", team: "톈진", G: 42, MIN: 36, PTS: 21.2, REB: 12.0, AST: 3.7, FG: 0.509, TP: 0.413 }),
      s({ season: "2024-25", endYear: 2025, league: "CBA", team: "CBA", G: 30, PTS: 24.6, REB: 14.0, AST: 4.2, FG: 0.56 }),
      s({ season: "2023-24", endYear: 2024, league: "CBA", team: "CBA", PTS: 26.5, REB: 13.0 }),
    ],
  },
  {
    name: "루이스 킹",
    seasons: [
      s({ season: "2026", endYear: 2026, league: "BSN", team: "푸에르토리코", MIN: 31.2, PTS: 15.8, REB: 6.5, AST: 3.9 }),
      s({ season: "2024-25", endYear: 2025, league: "CBA", team: "CBA", G: 26, PTS: 19.3, REB: 5.8, AST: 2.0, FG: 0.482 }),
      s({ season: "2024", endYear: 2024, league: "BSN", team: "푸에르토리코", G: 41, PTS: 18.5, REB: 6.0, AST: 2.0 }),
    ],
  },
  {
    name: "제리 아바디아노",
    seasons: [
      s({ season: "2025", endYear: 2025, league: "MPBL", team: "산후안 나이츠", G: 14, PTS: 9.6, REB: 2.6, AST: 1.9 }),
    ],
    note: "UAAP 시즌88(UP)은 시즌 평균이 확인되지 않아 제외",
  },

  // ---------------- 마지막 KBL 시즌이 3년 이상 지난 선수 ----------------
  {
    name: "패리스 배스",
    seasons: [
      s({ season: "2025-26", endYear: 2026, league: "LEBANON", team: "사게세(WASL)", G: 5, MIN: 39.9, PTS: 24.8, REB: 10.4, AST: 4.0, FG: 0.551 }),
      s({ season: "2025", endYear: 2025, league: "BSN", team: "폰세", PTS: 12.9, REB: 6.2, AST: 2.6 }),
      s({ season: "2024-25", endYear: 2025, league: "CBA", team: "저장", G: 20, PTS: 17.2, REB: 8.3 }),
    ],
    note: "마지막 KBL 2023-24 (KT, 25.4점) → 해외 기록으로 평가",
  },
  {
    name: "케베 알루마",
    seasons: [
      s({ season: "2025-26", endYear: 2026, league: "B1", team: "류큐", G: 7, MIN: 20.1, PTS: 11.0, REB: 4.1 }),
      s({ season: "2024-25", endYear: 2025, league: "B1", team: "류큐", G: 55, PTS: 20.8, REB: 8.7, AST: 3.0, FG: 0.478, TP: 0.397, FT: 0.796 }),
    ],
    note: "마지막 KBL 2023-24 (현대모비스) → 해외 기록으로 평가",
  },
  {
    name: "라숀 토마스",
    seasons: [
      s({ season: "2025-26", endYear: 2026, league: "LBA", team: "사사리", G: 26, PTS: 10.0, REB: 6.0, AST: 1.8, FG: 0.464 }),
      s({ season: "2024-25", endYear: 2025, league: "LBA", team: "사사리", G: 8, PTS: 13.8, REB: 7.8 }),
      s({ season: "2024-25", endYear: 2025, league: "CBA", team: "푸젠", G: 10, PTS: 8.1, REB: 3.6 }),
    ],
    note: "마지막 KBL 2021-22 (현대모비스) → 해외 기록으로 평가",
  },
  {
    name: "크리스 맥컬러",
    seasons: [
      s({ season: "2026", endYear: 2026, league: "BSN", team: "바야몬", G: 16, MIN: 21.4, PTS: 11.7, REB: 5.2, AST: 1.3 }),
    ],
    note: "마지막 KBL 2020-21 (KGC) → 해외 기록으로 평가",
  },
];
