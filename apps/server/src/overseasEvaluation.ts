/**
 * KBL Manager — 해외리그 기록 → KBL 환산 시즌 기록
 *
 * KBL 기록이 없거나 마지막 KBL 시즌이 3년 이상 지난 외국선수·아시아쿼터는
 * foreignLeagueRecords.ts의 해외 기록을 KBL 기준 경기당 기록(SeasonStatLine)으로 바꿔서,
 * KBL 선수와 똑같은 능력치 파이프라인(attributeConversion)·수준 보정(ratingCalibration)에 넣는다.
 *
 *  1) 시즌별 환산: 경기당 득점·리바운드·어시스트·스틸·블록·턴오버 × 리그 수준(KBL = 1.00).
 *     성공률(야투·3점·자유투)은 리그 영향이 작다고 보고 그대로 둔다.
 *  2) 빈 항목 채우기: 같은 선수의 다른 시즌(환산 후, 36분당) → 없으면 같은 포지션(가드/포워드/센터)
 *     KBL 선수의 36분당 중앙값. 외국선수는 KBL 외국선수끼리, 아시아쿼터는 국내·아시아 선수 기준.
 *     슛 시도 구성(3점 시도 비율, 자유투 시도 비율, 공격 리바운드 비율, 덩크 등)도 포지션 중앙값을 쓴다.
 *     출전시간을 모르면 득점 ÷ 분당 득점(본인의 다른 시즌 → 포지션 중앙값)으로 추정 (18~34분), 경기수를 모르면 15경기.
 *  3) 최근 기록일수록 크게: 가중치 = 경기수 × 0.5^(2026 − 시즌 종료 연도).
 *     2025-26·2026 시즌 1.0, 2024-25·2025 시즌 0.5, 2023-24·2024 시즌 0.25, 그 이전은 반영 안 함.
 *     (기록이 오래된 시즌뿐인 선수는 그중 가장 최근 시즌을 1.0으로 맞춤)
 */
import type { PlayerInput, SeasonStatLine } from "../../../packages/attribute-pipeline/attributeConversion";
import { poolRecentSeasons } from "../../../packages/attribute-pipeline/attributeConversion";
import { LEAGUES, OVERSEAS_RECORDS, OverseasSeason } from "./foreignLeagueRecords";

/** 가장 최근 시즌의 종료 연도 (2025-26 시즌 / 2026 여름리그) */
export const LATEST_END_YEAR = 2026;
/** 한 해 지날 때마다 반영 비중을 절반으로 */
export const RECENCY_DECAY = 0.5;
/** 최근 3개 연도(2024~2026)까지만 반영 */
const WINDOW_YEARS = 3;
/** 마지막 KBL 시즌 종료 연도가 이 해 이하이면(= 2026-27 기준 3년 이상 지남) 해외 기록으로 평가 */
export const KBL_STALE_END_YEAR = 2024;
const DEFAULT_GAMES = 15;
const MIN_EST_FLOOR = 18;
const MIN_EST_CEIL = 34;

type Group = "foreign" | "local";
type PosGroup = "G" | "F" | "C";

interface Reference {
  per36: Record<"AST" | "STL" | "BLK" | "TO" | "PF" | "GD" | "DK" | "DKA", number>;
  fg: number; tp: number; ft: number;
  r3: number;        // 3PA / FGA
  rft: number;       // FTA / FGA
  orebShare: number; // OREB / REB
  paintShare: number; // PPA / 2PA
  paintVs2p: number;  // PP% / 2P%
  ptsPerMin: number;
}

export interface OverseasSeasonView {
  season: string; league: string; team: string; weight: number;
  games: number; minutes: number; pts: number; reb: number; ast: number; // KBL 환산 경기당
  filled: string[];
}

export interface OverseasEvaluation {
  name: string;
  line: SeasonStatLine;          // 최근도 가중 합산한 KBL 환산 기록
  seasons: OverseasSeasonView[];
  replacedKbl: string | null;    // KBL 기록 대신 해외 기록을 쓴 경우 마지막 KBL 시즌
  note?: string;
}

function median(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function posGroupOf(position: string | undefined): PosGroup {
  if (position?.includes("센터")) return "C";
  if (position?.includes("가드")) return "G";
  return "F";
}

function endYearOfKblSeason(label: string): number {
  return Number(label.split("-")[1] ?? label);
}

function buildReferences(
  raw: (PlayerInput & { nationality: string })[],
  roster: Map<string, { position: string; nationality: string }>
): Map<string, Reference> {
  const buckets = new Map<string, SeasonStatLine[]>();
  for (const p of raw) {
    const meta = roster.get(p.name);
    if (!meta || p.seasons.length === 0) continue;
    const pooled = poolRecentSeasons(p.seasons)!;
    if (pooled.Min < 12 || pooled.G < 10) continue;
    const group: Group = meta.nationality === "KOR" || meta.nationality === "PHI" ? "local" : "foreign";
    const key = `${group}:${posGroupOf(meta.position)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(pooled);
  }
  const out = new Map<string, Reference>();
  for (const [key, lines] of buckets) {
    const per36 = (k: keyof SeasonStatLine) => median(lines.map((l) => (Number(l[k]) / l.Min) * 36));
    const ratio = (num: (l: SeasonStatLine) => number, den: (l: SeasonStatLine) => number) =>
      median(lines.filter((l) => den(l) > 0).map((l) => num(l) / den(l)));
    out.set(key, {
      per36: { AST: per36("AST"), STL: per36("STL"), BLK: per36("BLK"), TO: per36("TO"), PF: per36("PF"), GD: per36("GD"), DK: per36("DK"), DKA: per36("DKA") },
      fg: median(lines.map((l) => l["FG%"] / 100)),
      tp: median(lines.filter((l) => l["3PA"] >= 0.5).map((l) => l["3P%"] / 100)) || 0.32,
      ft: median(lines.map((l) => l["FT%"] / 100)),
      r3: ratio((l) => l["3PA"], (l) => l.FGA),
      rft: ratio((l) => l.FTA, (l) => l.FGA),
      orebShare: ratio((l) => l.OREB, (l) => l.REB),
      paintShare: ratio((l) => l.PPA, (l) => l["2PA"]),
      paintVs2p: ratio((l) => l["PP%"], (l) => l["2P%"]),
      ptsPerMin: ratio((l) => l.PTS, (l) => l.Min),
    });
  }
  return out;
}

type Counting = "AST" | "STL" | "BLK" | "TO";
const COUNTING: Counting[] = ["AST", "STL", "BLK", "TO"];
const PCT: ("FG" | "TP" | "FT")[] = ["FG", "TP", "FT"];

export function buildOverseasEvaluations(
  raw: (PlayerInput & { nationality: string })[],
  roster: Map<string, { position: string; nationality: string }>
): Map<string, OverseasEvaluation> {
  const refs = buildReferences(raw, roster);
  const out = new Map<string, OverseasEvaluation>();

  for (const rec of OVERSEAS_RECORDS) {
    const meta = roster.get(rec.name);
    if (!meta) continue;
    const kbl = raw.find((p) => p.name === rec.name);
    const lastKbl = kbl && kbl.seasons.length ? kbl.seasons[kbl.seasons.length - 1].season : null;
    // 최근 3년 안에 KBL에서 뛴 선수는 KBL 기록 그대로 평가
    if (lastKbl && endYearOfKblSeason(lastKbl) > KBL_STALE_END_YEAR) continue;

    const group: Group = meta.nationality === "KOR" || meta.nationality === "PHI" ? "local" : "foreign";
    const ref = refs.get(`${group}:${posGroupOf(meta.position)}`) ?? refs.get(`${group}:F`)!;

    const seasons = rec.seasons.filter((x) => LATEST_END_YEAR - x.endYear < WINDOW_YEARS);
    if (!seasons.length) continue;
    const weightOf = (x: OverseasSeason) => Math.pow(RECENCY_DECAY, LATEST_END_YEAR - x.endYear);

    // 출전시간 빈칸: 득점 ÷ 분당 득점으로 추정 (분당 득점은 본인의 출전시간이 확인된 시즌 → 없으면 포지션 중앙값)
    const knownMin = seasons.filter((x) => x.MIN !== null);
    const ptsPerMin = knownMin.length
      ? knownMin.reduce((a, x) => a + x.PTS * LEAGUES[x.league].factor * weightOf(x), 0) / knownMin.reduce((a, x) => a + x.MIN! * weightOf(x), 0)
      : ref.ptsPerMin;
    const estimateMinutes = (kblPts: number) => Math.max(MIN_EST_FLOOR, Math.min(MIN_EST_CEIL, kblPts / ptsPerMin));

    // 1) 시즌별 KBL 환산 (아는 항목만)
    const conv = seasons.map((x) => {
      const f = LEAGUES[x.league].factor;
      const min = x.MIN ?? estimateMinutes(x.PTS * f);
      const filled: string[] = [];
      if (x.G === null) filled.push("경기수");
      if (x.MIN === null) filled.push("출전시간");
      const counting: Partial<Record<Counting, number>> = {};
      for (const k of COUNTING) if (x[k] !== null) counting[k] = (x[k] as number) * f;
      return { x, f, min, games: x.G ?? DEFAULT_GAMES, w: weightOf(x), pts: x.PTS * f, reb: x.REB * f, counting, filled };
    });

    // 2) 빈 항목: 같은 선수 다른 시즌(36분당, 최근도 가중) → 포지션 중앙값
    const ownPer36 = (k: Counting): number | null => {
      const have = conv.filter((c) => c.counting[k] !== undefined);
      if (!have.length) return null;
      const wsum = have.reduce((a, c) => a + c.w * c.games, 0);
      return have.reduce((a, c) => a + ((c.counting[k]! / c.min) * 36) * c.w * c.games, 0) / wsum;
    };
    const ownPct = (k: "FG" | "TP" | "FT"): number | null => {
      const have = conv.filter((c) => c.x[k] !== null);
      if (!have.length) return null;
      const wsum = have.reduce((a, c) => a + c.w * c.games, 0);
      return have.reduce((a, c) => a + (c.x[k] as number) * c.w * c.games, 0) / wsum;
    };
    const refPct = { FG: ref.fg, TP: ref.tp, FT: ref.ft };
    const LABEL: Record<string, string> = { AST: "어시스트", STL: "스틸", BLK: "블록", TO: "턴오버", FG: "야투율", TP: "3점%", FT: "자유투%" };

    const lines: SeasonStatLine[] = conv.map((c) => {
      const val: Record<Counting, number> = { AST: 0, STL: 0, BLK: 0, TO: 0 };
      for (const k of COUNTING) {
        if (c.counting[k] !== undefined) { val[k] = c.counting[k]!; continue; }
        const own = ownPer36(k);
        val[k] = ((own ?? ref.per36[k]) * c.min) / 36;
        c.filled.push(`${LABEL[k]}(${own !== null ? "본인 다른 시즌" : "포지션 평균"})`);
      }
      const pct: Record<"FG" | "TP" | "FT", number> = { FG: 0, TP: 0, FT: 0 };
      for (const k of PCT) {
        if (c.x[k] !== null) { pct[k] = c.x[k] as number; continue; }
        const own = ownPct(k);
        pct[k] = own ?? refPct[k];
        c.filled.push(`${LABEL[k]}(${own !== null ? "본인 다른 시즌" : "포지션 평균"})`);
      }
      // 슛 시도 구성은 포지션 중앙값: 득점 = FGA × (2·FG% + 3PA비율·3P% + FTA비율·FT%)
      const fga = c.pts / (2 * pct.FG + ref.r3 * pct.TP + ref.rft * pct.FT);
      const tpa = fga * ref.r3, tpm = tpa * pct.TP;
      const fgm = fga * pct.FG;
      const twoA = fga - tpa, twoM = Math.max(0, fgm - tpm);
      const fta = fga * ref.rft, ftm = fta * pct.FT;
      const ppa = twoA * ref.paintShare;
      const ppPct = Math.max(0.3, Math.min(0.8, (twoA > 0 ? twoM / twoA : 0.5) * ref.paintVs2p));
      const oreb = c.reb * ref.orebShare;
      const per36ref = (k: "PF" | "GD" | "DK" | "DKA") => (ref.per36[k] * c.min) / 36;
      return {
        season: `${c.x.endYear - 1}-${c.x.endYear}`, team: `${LEAGUES[c.x.league].label} ${c.x.team}`,
        G: c.games, W: 0, L: 0, Min: c.min, PTS: c.pts,
        "2PM": twoM, "2PA": twoA, "2P%": twoA > 0 ? (twoM / twoA) * 100 : 0,
        "3PM": tpm, "3PA": tpa, "3P%": pct.TP * 100,
        FGM: fgm, FGA: fga, "FG%": pct.FG * 100,
        FTM: ftm, FTA: fta, "FT%": pct.FT * 100,
        OREB: oreb, DREB: c.reb - oreb, REB: c.reb,
        AST: val.AST, STL: val.STL, BLK: val.BLK, TO: val.TO,
        GD: per36ref("GD"), DK: per36ref("DK"), DKA: per36ref("DKA"), PF: per36ref("PF"),
        PP: ppa * ppPct, PPA: ppa, "PP%": ppPct * 100,
        plusMinus: 0, DD2: 0, TD3: 0,
      } as SeasonStatLine;
    });

    // 3) 최근도 가중 합산 (가중치 = 경기수 × 0.5^(2026 − 종료 연도))
    const order = conv.map((c, i) => i).sort((a, b) => conv[a].x.endYear - conv[b].x.endYear);
    const chrono = order.map((i) => lines[i]);
    // 가장 최근 시즌의 가중치를 1로 맞춤 (KBL 3시즌 합산과 같은 기준 — 표본 크기 G가 "최근 시즌 경기수 + 이전 시즌 일부"가 되도록)
    const wMax = Math.max(...conv.map((c) => c.w));
    const weights = order.map((i) => conv[i].w / wMax).reverse(); // poolRecentSeasons는 최신 → 과거 순으로 가중치 적용
    const pooled = poolRecentSeasons(chrono, weights)!;
    pooled.season = "2025-2026";
    pooled.team = "해외리그 KBL 환산";

    out.set(rec.name, {
      name: rec.name,
      line: pooled,
      seasons: conv.map((c, i) => ({
        season: c.x.season, league: LEAGUES[c.x.league].label, team: c.x.team, weight: c.w,
        games: c.games, minutes: c.min, pts: c.pts, reb: c.reb, ast: lines[i].AST, filled: c.filled,
      })),
      replacedKbl: lastKbl,
      note: rec.note,
    });
  }
  return out;
}
