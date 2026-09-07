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
import { SimPlayer, DisplayAttrs, TacticsOverride } from "../../../packages/simulation-engine/possession";

const DATA_DIR = path.join(__dirname, "../../../data/processed");

function parseCsv(content: string): { header: string[]; rows: string[][] } {
  const lines = content.trim().split("\n");
  const header = lines[0].split(",");
  const rows = lines.slice(1).map((l) => l.split(","));
  return { header, rows };
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

  function buildTeamRoster(teamName: string): SimPlayer[] {
    const players: RosterPlayer[] = [];
    rosterCsv.rows.forEach((cols) => {
      if (cols[teamIdx] === teamName) {
        const name = cols[nameIdx];
        const player = raw.find((p) => p.name === name);
        const perGameMin = player && player.seasons.length > 0 ? player.seasons[player.seasons.length - 1].Min : 10;
        players.push({ name, position: cols[posIdx], nationality: player?.nationality ?? "KOR", perGameMin });
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
