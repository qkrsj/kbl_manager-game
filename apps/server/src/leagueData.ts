/**
 * KBL Manager — 팀 로스터(SimPlayer[]) 빌드 공용 로직
 * players_enriched.json + roster.csv로부터 시뮬레이션 엔진이 쓸 SimPlayer[]를 구성한다.
 * v1부터는 seed.ts(새 게임 생성) 시점에만 사용되고, 이후 시뮬레이션은 DB(rosterBuilder.ts)를 기준으로 한다.
 */
import * as fs from "fs";
import * as path from "path";
import { computeLeagueDerivedAttributes, PlayerInput, DerivedAttributes, poolRecentSeasons } from "../../../packages/attribute-pipeline/attributeConversion";
import { toLineupPlayer, RosterPlayer } from "../../../packages/simulation-engine/lineup";
import { computeSimulationInternals, SimStatLine } from "../../../packages/simulation-engine/simulationInternals";
import { SimPlayer, DisplayAttrs, SimulationInternals } from "../../../packages/simulation-engine/possession";

const DATA_DIR = path.join(__dirname, "../../../data/processed");
const MANUAL_DIR = path.join(__dirname, "../../../data/manual");
/** 2026-27 정규시즌 개막일 — 능력치 산정의 나이 기준 */
export const SEASON_START_DATE = "2026-10-03";

/** players_enriched.json에 생년월일이 없는 선수(KBL 첫 시즌 외국선수, 출전 기록 없는 신인)의 생년월일 */
export function readManualBirthDates(): Map<string, string> {
  const file = path.join(MANUAL_DIR, "birth_dates.csv");
  if (!fs.existsSync(file)) return new Map();
  const { header, rows } = parseCsv(fs.readFileSync(file, "utf-8"));
  const n = header.indexOf("name"), b = header.indexOf("birth_date");
  return new Map(rows.filter((r) => r[n] && r[b]).map((r) => [r[n], r[b]]));
}

export function ageOnDate(birthDate: string, onDate: string): number {
  const b = new Date(birthDate), d = new Date(onDate);
  let age = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) age--;
  return age;
}

function parseCsv(content: string): { header: string[]; rows: string[][] } {
  const lines = content.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const rows = lines.slice(1).map((l) => l.split(","));
  return { header, rows };
}

import { FOREIGN_OPTION_MINUTES } from "./foreignImportMinutes";
import { buildOverseasEvaluations, OverseasEvaluation } from "./overseasEvaluation";

export interface LeagueData {
  raw: (PlayerInput & { nationality: string; birthDate?: string })[];
  derivedMap: Map<string, DerivedAttributes>;
  rosterCsv: { header: string[]; rows: string[][] };
  teamIdx: number;
  nameIdx: number;
  posIdx: number;
  teamNames: string[];
  birthDates: Map<string, string>;
  /** 해외리그 기록으로 평가한 선수 (KBL 첫 시즌 / 마지막 KBL 시즌이 5년 이상 지난 선수) */
  overseas: Map<string, OverseasEvaluation>;
  buildTeamRoster: (teamName: string) => SimPlayer[];
}

export function loadLeagueData(): LeagueData {
  const raw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "players_enriched.json"), "utf-8")
  ) as (PlayerInput & { nationality: string; birthDate?: string })[];

  // 나이는 2026-27 개막일 기준으로 다시 계산 (players_enriched.json의 나이는 2025-26 시즌 기준이라 1살 적음)
  const birthDates = readManualBirthDates();
  for (const p of raw) {
    if (!p.birthDate && birthDates.has(p.name)) p.birthDate = birthDates.get(p.name);
    if (p.birthDate) p.ageAtSeasonStart = ageOnDate(p.birthDate, SEASON_START_DATE);
    if (p.birthDate) birthDates.set(p.name, p.birthDate);
  }

  const rosterCsv = parseCsv(fs.readFileSync(path.join(DATA_DIR, "roster.csv"), "utf-8"));
  const teamIdx = rosterCsv.header.indexOf("team");
  const nameIdx = rosterCsv.header.indexOf("name");
  const posIdx = rosterCsv.header.indexOf("position");
  const natIdx = rosterCsv.header.indexOf("nationality");
  const hIdx = rosterCsv.header.indexOf("height_cm");
  const wIdx = rosterCsv.header.indexOf("weight_kg");

  // 해외리그 기록 → KBL 환산 시즌 1줄로 바꿔서 KBL 선수와 같은 파이프라인에 넣는다.
  // (KBL 기록이 없는 선수는 새로 추가, 마지막 KBL 시즌이 5년 이상 지난 선수는 KBL 기록 대신 사용)
  const rosterInfo = new Map(rosterCsv.rows.map((c) => [c[nameIdx], { position: c[posIdx], nationality: c[natIdx] }]));
  const overseas = buildOverseasEvaluations(raw, rosterInfo);
  for (const [name, ev] of overseas) {
    const existing = raw.find((p) => p.name === name);
    if (existing) {
      existing.seasons = [ev.line];
    } else {
      const cols = rosterCsv.rows.find((c) => c[nameIdx] === name)!;
      const birthDate = birthDates.get(name);
      raw.push({
        playerId: name, name, ageAtSeasonStart: birthDate ? ageOnDate(birthDate, SEASON_START_DATE) : 27,
        draftInfo: { kind: "foreign_or_naturalized" }, birthDate,
        nationality: cols[natIdx], seasons: [ev.line],
        heightCm: Number(cols[hIdx]) || null, weightKg: Number(cols[wIdx]) || null,
      });
    }
  }

  const derivedMap = computeLeagueDerivedAttributes(raw);
  const teamNames = Array.from(new Set(rosterCsv.rows.map((cols) => cols[teamIdx])));

  const internalsInput = raw
    .filter((p) => p.seasons.length > 0)
    .map((p) => {
      const s = poolRecentSeasons(p.seasons)!; // 최근 3시즌 가중 합산
      return {
        playerId: p.playerId,
        stat: {
          G: s.G, PTS: s.PTS, FGA: s.FGA, FTA: s.FTA, TO: s.TO, PP: s.PP, PPA: s.PPA,
          "2PM": s["2PM"], "2PA": s["2PA"], "3PM": s["3PM"], "3PA": s["3PA"], FTM: s.FTM,
        } as SimStatLine,
      };
    });
  const internalsMap = computeSimulationInternals(internalsInput);

  function buildTeamRoster(teamName: string): SimPlayer[] {
    const players: RosterPlayer[] = [];
    rosterCsv.rows.forEach((cols) => {
      if (cols[teamIdx] === teamName) {
        const name = cols[nameIdx];
        const player = raw.find((p) => p.name === name);
        const rawPerGameMin = player && player.seasons.length > 0 ? player.seasons[player.seasons.length - 1].Min : 10;
        // ⚠️ 용병 1옵션/2옵션 출전시간은 리그 전체(10팀) 공통 지정 — 실측기록 유무와 무관하게
        // 적용됨. 특히 KBL 기록이 없는 신규 용병 7명은 이 매핑이 없으면 기본값 10분으로
        // 깔려서 로테이션에서 거의 안 뽑히는 문제가 있었음.
        const perGameMin = FOREIGN_OPTION_MINUTES[name] ?? rawPerGameMin;
        // ⚠️ player가 players_enriched.json에 없는 선수(KBL 첫 시즌 외국인 등)는
        // 이전엔 nationality가 "KOR"로 잘못 하드코딩되어 용병 쿼터 적용이 아예 안 되는
        // 버그가 있었음 (실측 검증 중 발견). roster.csv의 실제 국적을 항상 사용하도록 수정.
        players.push({ name, position: cols[posIdx], nationality: cols[natIdx], perGameMin });
      }
    });
    return players.map(toLineupPlayer).map((lp) => {
      const player = raw.find((p) => p.name === lp.name);
      const derived = player ? derivedMap.get(player.playerId) : undefined;
      const internals = player ? internalsMap.get(player.playerId) : undefined;

      const attrs: DisplayAttrs = derived
        ? {
            finishing: derived.finishing, dunking: derived.dunking, midRangeShooting: derived.midRangeShooting,
            threePointShooting: derived.threePointShooting, freeThrowShooting: derived.freeThrowShooting,
            ballHandling: derived.ballHandling, passing: derived.passing, steal: derived.steal,
            shotBlocking: derived.shotBlocking, defensiveRebounding: derived.defensiveRebounding,
            offensiveRebounding: derived.offensiveRebounding, strength: derived.strength, stamina: derived.stamina,
          }
        : {
            finishing: 50, dunking: 50, midRangeShooting: 50, threePointShooting: 50, freeThrowShooting: 50,
            ballHandling: 50, passing: 50, steal: 50, shotBlocking: 50, defensiveRebounding: 50,
            offensiveRebounding: 50, strength: 50, stamina: 50,
          };
      return {
        ...lp,
        attrs,
        internals: internals ?? { paintAccuracy: 0.5, midAccuracy: 0.42, threeAccuracy: 0.33, ftAccuracy: 0.7, usagePercentile: 50, ptsPercentile: 50 },
      };
    });
  }

  return { raw, derivedMap, rosterCsv, teamIdx, nameIdx, posIdx, teamNames, birthDates, overseas, buildTeamRoster };
}
