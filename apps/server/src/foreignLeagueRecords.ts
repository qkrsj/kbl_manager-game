/**
 * KBL Manager — KBL 실측기록 없는 외국인선수 해외리그 실제 기록
 * (리그 강도 배수를 곱해 KBL 기준으로 환산한 뒤, 실제 174명 KBL 선수 분포와
 *  percentile로 직접 비교한다 — 정성평가(상/중상/중) 방식에서 실측 데이터 기반으로 전환)
 *
 * 리그강도 배수 기준 (v0, 대략적 통념 기반 — 정교한 검증된 계수는 아님):
 *   NBA = 1.00 (할인 없음)
 *   중국 CBA = 1.05 (KBL과 비슷하거나 약간 위로 평가)
 *   일본 B1리그 = 0.90
 *   푸에르토리코 BSN = 0.80
 *   불가리아 NBL = 0.75
 *   대만 P리그(PLG) = 0.65
 *   필리핀 MPBL = 0.55
 */

export interface ForeignLeagueRecord {
  name: string;
  league: string;
  leagueStrength: number;
  gamesSample: number;
  ppg: number;
  rpg: number;
  apg: number;
  fgPct: number | null;     // 0~1
  threePct: number | null;  // 0~1
  ftPct: number | null;     // 0~1
  bpg: number | null;
  spg: number | null;
}

export const FOREIGN_LEAGUE_RECORDS: ForeignLeagueRecord[] = [
  {
    name: "아치 굿윈", league: "대만 P리그(PLG) 플레이오프 2025-26", leagueStrength: 0.65,
    gamesSample: 4, ppg: 30.3, rpg: 5.3, apg: 4.0, fgPct: null, threePct: 0.359, ftPct: null, bpg: null, spg: null,
  },
  {
    name: "다리우스 베즐리", league: "NBA 커리어 통산", leagueStrength: 1.00,
    gamesSample: 237, ppg: 8.9, rpg: 5.2, apg: 1.2, fgPct: 0.42, threePct: 0.29, ftPct: 0.70, bpg: 1.0, spg: 0.8,
  },
  {
    name: "존 무니", league: "일본 B1리그(치바) 2024-25", leagueStrength: 0.90,
    gamesSample: 48, ppg: 11.7, rpg: 10.4, apg: 1.5, fgPct: 0.55, threePct: null, ftPct: null, bpg: null, spg: null,
  },
  {
    name: "트레이 포터", league: "불가리아 NBL 2020-21", leagueStrength: 0.75,
    gamesSample: 24, ppg: 10.7, rpg: 7.5, apg: 0.5, fgPct: null, threePct: null, ftPct: null, bpg: 1.3, spg: null,
  },
  {
    name: "스카티 제임스", league: "중국 CBA 2024-25", leagueStrength: 1.05,
    gamesSample: 30, ppg: 25.0, rpg: 14.0, apg: 3.0, fgPct: 0.56, threePct: null, ftPct: null, bpg: null, spg: null,
  },
  {
    name: "제리 아바디아노", league: "필리핀 MPBL 2025", leagueStrength: 0.55,
    gamesSample: 14, ppg: 9.6, rpg: 2.6, apg: 1.9, fgPct: null, threePct: null, ftPct: null, bpg: null, spg: null,
  },
  {
    name: "루이스 킹", league: "푸에르토리코 BSN 2024", leagueStrength: 0.80,
    gamesSample: 41, ppg: 18.5, rpg: 6.0, apg: 2.0, fgPct: null, threePct: null, ftPct: null, bpg: null, spg: null,
  },
];
