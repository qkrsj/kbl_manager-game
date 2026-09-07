/**
 * KBL Manager — 팀 로스터(SimPlayer[]) 빌드 공용 로직
 * players_enriched.json + roster.csv로부터 시뮬레이션 엔진이 쓸 SimPlayer[]를 구성한다.
 * seed.ts, advanceRound.ts 양쪽에서 동일 로직을 재사용하기 위해 분리.
 */
import * as fs from "fs";
import * as path from "path";
import { computeLeagueDerivedAttributes, PlayerInput, DerivedAttributes } from "../../../packages/attribute-pipeline/attributeConversion";
import { toLineupPlayer, RosterPlayer } from "../../../packages/simulation-engine/lineup";
import { computeSimulationInternals, SimStatLine } from "../../../packages/simulation-engine/simulationInternals";
import { SimPlayer, DisplayAttrs, SimulationInternals, TacticsOverride } from "../../../packages/simulation-engine/possession";

const DATA_DIR = path.join(__dirname, "../../../data/processed");

function parseCsv(content: string): { header: string[]; rows: string[][] } {
  const lines = content.trim().split("\n");
  const header = lines[0].split(",");
  const rows = lines.slice(1).map((l) => l.split(","));
  return { header, rows };
}

import { FOREIGN_LEAGUE_RECORDS, ForeignLeagueRecord } from "./foreignLeagueRecords";
import { FOREIGN_OPTION_MINUTES } from "./foreignImportMinutes";

/** 0~100 퍼센타일을 게임 스케일(50~99)로 변환 — attribute-pipeline과 동일 공식 */
function toAttributeScale(percentile0to100: number): number {
  const clamped = Math.max(0, Math.min(100, percentile0to100));
  return Math.round(50 + (clamped / 100) * 49);
}

function percentileOf(values: number[], target: number): number {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return 50;
  const below = clean.filter((v) => v < target).length;
  const equal = clean.filter((v) => v === target).length;
  return ((below + equal * 0.5) / clean.length) * 100;
}

export interface ForeignEstimate {
  name: string;
  attrs: DisplayAttrs;
  internals: SimulationInternals;
  speedTier: number; // DisplayAttrs엔 speed가 없어(엔진 미사용, 표시전용) 별도 보관
}

/**
 * KBL 실측기록이 없는 외국인선수를 실제 해외리그 기록(foreignLeagueRecords.ts) 기반으로 평가.
 * v0.2: 정성평가(상/중상/중) 방식 폐기 — 리그강도 배수로 KBL 환산 후, 실제 174명 KBL 선수의
 * PTS/REB/AST/BLK/STL/FG%/3P%/FT% 실측 분포와 직접 percentile 비교해서 산출.
 * (라운드파이프라인의 다른 선수들과 완전히 동일한 척도로 평가됨)
 */
export function loadForeignEstimates(
  kblStats: { PTS: number; REB: number; AST: number; BLK: number; STL: number; FGPct: number; ThreePct: number; FTPct: number }[]
): Map<string, ForeignEstimate> {
  const ptsArr = kblStats.map((s) => s.PTS);
  const rebArr = kblStats.map((s) => s.REB);
  const astArr = kblStats.map((s) => s.AST);
  const blkArr = kblStats.map((s) => s.BLK);
  const stlArr = kblStats.map((s) => s.STL);
  const fgArr = kblStats.map((s) => s.FGPct);
  const threeArr = kblStats.map((s) => s.ThreePct);
  const ftArr = kblStats.map((s) => s.FTPct);

  const leagueAvgFg = fgArr.reduce((a, b) => a + b, 0) / fgArr.length;
  const leagueAvgThree = threeArr.reduce((a, b) => a + b, 0) / threeArr.length;
  const leagueAvgFt = ftArr.reduce((a, b) => a + b, 0) / ftArr.length;

  const result = new Map<string, ForeignEstimate>();

  for (const r of FOREIGN_LEAGUE_RECORDS) {
    // 리그강도 배수로 KBL 환산 (볼륨스탯만 — 정확도%는 리그강도 영향 상대적으로 적어 원값 유지)
    const adjPpg = r.ppg * r.leagueStrength;
    const adjRpg = r.rpg * r.leagueStrength;
    const adjApg = r.apg * r.leagueStrength;
    const adjBpg = (r.bpg ?? 0.1) * r.leagueStrength; // 데이터 없으면 KBL 중앙값(0.1)로 중립 처리
    const adjSpg = (r.spg ?? 0.4) * r.leagueStrength; // 데이터 없으면 KBL 중앙값(0.4)로 중립 처리

    const ptsPct = percentileOf(ptsArr, adjPpg);
    const rebPct = percentileOf(rebArr, adjRpg);
    const astPct = percentileOf(astArr, adjApg);
    const blkPct = percentileOf(blkArr, adjBpg);
    const stlPct = percentileOf(stlArr, adjSpg);
    const fgPct = r.fgPct !== null ? percentileOf(fgArr, r.fgPct) : 50;
    const threePct = r.threePct !== null ? percentileOf(threeArr, r.threePct) : 50;
    const ftPctPercentile = r.ftPct !== null ? percentileOf(ftArr, r.ftPct) : 50;

    const finishing = toAttributeScale(ptsPct); // finishing = 볼륨 단독(기존 파이프라인과 동일 철학)
    const dunking = toAttributeScale((rebPct + fgPct) / 2); // 직접 데이터 없어 리바운드+FG% 로 운동능력 근사
    const midRangeShooting = toAttributeScale(fgPct * 0.7 + 50 * 0.3);
    const threePointShooting = toAttributeScale(threePct);
    const freeThrowShooting = toAttributeScale(ftPctPercentile);
    const ballHandling = toAttributeScale(astPct);
    const passing = toAttributeScale(astPct);
    const steal = toAttributeScale(stlPct);
    const shotBlocking = toAttributeScale(blkPct);
    const defensiveRebounding = toAttributeScale(rebPct);
    const offensiveRebounding = toAttributeScale(rebPct);
    const strength = toAttributeScale(rebPct);
    const stamina = toAttributeScale(50 + (r.gamesSample >= 30 ? 15 : 0)); // 표본 많으면 체력검증됐다고 가점

    const attrs: DisplayAttrs = {
      finishing, dunking, midRangeShooting, threePointShooting, freeThrowShooting,
      ballHandling, passing, steal, shotBlocking, defensiveRebounding, offensiveRebounding,
      strength, stamina,
    };

    const internals: SimulationInternals = {
      paintAccuracy: r.fgPct ?? leagueAvgFg,
      midAccuracy: r.fgPct ?? leagueAvgFg,
      threeAccuracy: r.threePct ?? leagueAvgThree,
      ftAccuracy: r.ftPct ?? leagueAvgFt,
      usagePercentile: ptsPct,
      ptsPercentile: ptsPct,
    };

    result.set(r.name, { name: r.name, attrs, internals, speedTier: 50 });
  }
  return result;
}

export interface LeagueData {
  raw: (PlayerInput & { nationality: string; birthDate?: string })[];
  derivedMap: Map<string, DerivedAttributes>;
  rosterCsv: { header: string[]; rows: string[][] };
  teamIdx: number;
  nameIdx: number;
  posIdx: number;
  teamNames: string[];
  buildTeamRoster: (teamName: string) => SimPlayer[];
}

export function loadLeagueData(): LeagueData {
  const raw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "players_enriched.json"), "utf-8")
  ) as (PlayerInput & { nationality: string; birthDate?: string })[];

  const rosterCsv = parseCsv(fs.readFileSync(path.join(DATA_DIR, "roster.csv"), "utf-8"));
  const teamIdx = rosterCsv.header.indexOf("team");
  const nameIdx = rosterCsv.header.indexOf("name");
  const posIdx = rosterCsv.header.indexOf("position");
  const natIdx = rosterCsv.header.indexOf("nationality");

  const derivedMap = computeLeagueDerivedAttributes(raw);
  const teamNames = Array.from(new Set(rosterCsv.rows.map((cols) => cols[teamIdx])));

  const internalsInput = raw
    .filter((p) => p.seasons.length > 0)
    .map((p) => {
      const s = p.seasons[p.seasons.length - 1];
      return {
        playerId: p.playerId,
        stat: {
          G: s.G, PTS: s.PTS, FGA: s.FGA, FTA: s.FTA, TO: s.TO, PP: s.PP, PPA: s.PPA,
          "2PM": s["2PM"], "2PA": s["2PA"], "3PM": s["3PM"], "3PA": s["3PA"], FTM: s.FTM,
        } as SimStatLine,
      };
    });
  const internalsMap = computeSimulationInternals(internalsInput);
  const kblStatsForForeignComparison = raw
    .filter((p) => p.seasons.length > 0)
    .map((p) => {
      const s = p.seasons[p.seasons.length - 1];
      return {
        PTS: s.PTS, REB: s.REB, AST: s.AST, BLK: s.BLK, STL: s.STL,
        FGPct: s["FG%"] / 100, ThreePct: s["3P%"] / 100, FTPct: s["FT%"] / 100,
      };
    });
  const foreignEstimates = loadForeignEstimates(kblStatsForForeignComparison);

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
      const estimate = foreignEstimates.get(lp.name);

      const attrs: DisplayAttrs = derived
        ? {
            finishing: derived.finishing, dunking: derived.dunking, midRangeShooting: derived.midRangeShooting,
            threePointShooting: derived.threePointShooting, freeThrowShooting: derived.freeThrowShooting,
            ballHandling: derived.ballHandling, passing: derived.passing, steal: derived.steal,
            shotBlocking: derived.shotBlocking, defensiveRebounding: derived.defensiveRebounding,
            offensiveRebounding: derived.offensiveRebounding, strength: derived.strength, stamina: derived.stamina,
          }
        : estimate
        ? estimate.attrs
        : {
            finishing: 50, dunking: 50, midRangeShooting: 50, threePointShooting: 50, freeThrowShooting: 50,
            ballHandling: 50, passing: 50, steal: 50, shotBlocking: 50, defensiveRebounding: 50,
            offensiveRebounding: 50, strength: 50, stamina: 50,
          };
      return {
        ...lp,
        attrs,
        internals: internals ?? estimate?.internals ?? { paintAccuracy: 0.5, midAccuracy: 0.42, threeAccuracy: 0.33, ftAccuracy: 0.7, usagePercentile: 50, ptsPercentile: 50 },
      };
    });
  }

  return { raw, derivedMap, rosterCsv, teamIdx, nameIdx, posIdx, teamNames, buildTeamRoster };
}

// ============================================================
// 유저 팀 전용 로스터/전술 오버라이드
// ⚠️ 이 함수는 franchise.user_team_id에 해당하는 팀에만 호출한다.
//    나머지 9팀은 buildTeamRoster()만 그대로 써서 기존 엔진 동작을 그대로 유지한다.
// ============================================================

export interface PlayerRosterSetting {
  name: string;
  role: "starter" | "bench" | "inactive";
  minutesTarget: number | null;
  offensePriority: 1 | 2 | 3 | null;
}

export interface TeamTacticsSetting {
  paceStyle: "fast" | "normal" | "slow";
  threePointReliance: "high" | "normal" | "low";
  defensiveStopperName: string | null;
  clutchCloserName: string | null;
}

const OFFENSE_PRIORITY_PERCENTILE: Record<1 | 2 | 3, number> = { 1: 97, 2: 88, 3: 78 };
const PACE_EXPONENT: Record<TeamTacticsSetting["paceStyle"], number | undefined> = {
  fast: 6, normal: undefined, slow: 12,
};
const THREE_RELIANCE_MULTIPLIER: Record<TeamTacticsSetting["threePointReliance"], number> = {
  high: 1.4, normal: 1.0, low: 0.7,
};

/**
 * 유저 팀 로스터에 로스터설정(선발/후보/출전시간/공격순위) + 팀전술을 반영.
 * role='inactive'인 선수는 그 시즌 엔트리에서 아예 제외(엔진이 절대 선택 안 함).
 */
export function applyUserOverrides(
  roster: SimPlayer[],
  playerSettings: PlayerRosterSetting[],
  tactics: TeamTacticsSetting
): SimPlayer[] {
  const settingsByName = new Map(playerSettings.map((s) => [s.name, s]));
  const paceExponent = PACE_EXPONENT[tactics.paceStyle];
  const threeMultiplier = THREE_RELIANCE_MULTIPLIER[tactics.threePointReliance];

  return roster
    .filter((p) => settingsByName.get(p.name)?.role !== "inactive")
    .map((p) => {
      const setting = settingsByName.get(p.name);

      const perGameMin = setting?.minutesTarget ?? p.perGameMin;

      const usagePercentile = setting?.offensePriority
        ? OFFENSE_PRIORITY_PERCENTILE[setting.offensePriority]
        : p.internals.usagePercentile;
      const ptsPercentile = setting?.offensePriority
        ? OFFENSE_PRIORITY_PERCENTILE[setting.offensePriority]
        : p.internals.ptsPercentile;

      const tacticsOverride: TacticsOverride = {
        shotProbExponent: paceExponent,
        threeWeightMultiplier: threeMultiplier,
        isDefensiveStopper: tactics.defensiveStopperName === p.name,
        isClutchCloser: tactics.clutchCloserName === p.name,
      };

      return {
        ...p,
        perGameMin,
        internals: { ...p.internals, usagePercentile, ptsPercentile },
        tactics: tacticsOverride,
      };
    });
}
