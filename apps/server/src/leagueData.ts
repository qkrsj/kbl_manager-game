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

/**
 * KBL 첫 시즌이라 실측 기록이 없는 외국인 선수용 정성평가(상/중상/중/하 등)를
 * 0~99 능력치로 변환. data/manual/foreign_player_attribute_estimates.csv 기반.
 * ⚠️ 실측 스탯 기반이 아닌 다른 리그 커리어 참고 정성평가라 정확도가 낮음 — 거친 근사치.
 */
const TIER_SCORE: Record<string, number> = {
  "최상": 92, "상": 78, "중상": 65, "중": 50, "낮음": 30, "low": 30,
};
function tierToScore(raw: string): number {
  const cleaned = raw.replace(/\(.*\)/g, "").trim(); // "중(자료부족)" 같은 괄호 설명 제거
  return TIER_SCORE[cleaned] ?? 50;
}

export interface ForeignEstimate {
  name: string;
  attrs: DisplayAttrs;
  internals: SimulationInternals;
  speedTier: number; // DisplayAttrs엔 speed가 없어(엔진 미사용, 표시전용) 별도 보관
}

export function loadForeignEstimates(): Map<string, ForeignEstimate> {
  const filePath = path.join(__dirname, "../../../data/manual/foreign_player_attribute_estimates.csv");
  if (!fs.existsSync(filePath)) return new Map();

  // note 컬럼에 콤마가 포함된 경우가 있어 단순 split이 아니라 따옴표 인식 파싱 필요
  const content = fs.readFileSync(filePath, "utf-8").trim();
  const lines = content.split("\n");
  const header = lines[0].split(",");
  const idx = (col: string) => header.indexOf(col);

  function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === "," && !inQuotes) { result.push(cur); cur = ""; }
      else cur += ch;
    }
    result.push(cur);
    return result;
  }

  const result = new Map<string, ForeignEstimate>();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = cols[idx("name")];
    const scoring = tierToScore(cols[idx("scoring")]);
    const rebounding = tierToScore(cols[idx("rebounding")]);
    const playmaking = tierToScore(cols[idx("playmaking")]);
    const threePoint = tierToScore(cols[idx("threePoint")]);
    const perimeterDefense = tierToScore(cols[idx("perimeterDefense")]);
    const finishingTier = tierToScore(cols[idx("finishing")]);
    const speed = tierToScore(cols[idx("speed")]);
    const postScoring = tierToScore(cols[idx("postScoring")]);
    const block = tierToScore(cols[idx("block")]);
    const steal = tierToScore(cols[idx("steal")]);

    // "scoring"(종합득점력)과 "finishing"(골밑마무리 정성평가)을 섞어서 볼륨형 finishing 근사
    const finishing = Math.round((scoring * 0.5 + finishingTier * 0.3 + postScoring * 0.2));

    const attrs: DisplayAttrs = {
      finishing,
      dunking: Math.round((speed + postScoring) / 2), // 직접 항목 없어 운동능력형 대리값
      midRangeShooting: Math.round((scoring + threePoint) / 2 * 0.7 + 50 * 0.3), // 직접 항목 없어 근사
      threePointShooting: threePoint,
      freeThrowShooting: 55, // 자료 없음 — 리그 평균보다 약간 위로 중립 처리
      ballHandling: playmaking,
      passing: playmaking,
      steal: Math.round((steal + perimeterDefense) / 2),
      shotBlocking: block,
      defensiveRebounding: rebounding,
      offensiveRebounding: rebounding,
      strength: Math.round((rebounding + postScoring) / 2),
      stamina: 60, // 자료 없음 — 외국인선수 평균적 체력으로 중립 처리
    };

    const internals: SimulationInternals = {
      paintAccuracy: 0.45 + (finishingTier - 50) / 200, // 등급 위아래로 완만하게 가감
      midAccuracy: 0.35 + (attrs.midRangeShooting - 50) / 250,
      threeAccuracy: 0.25 + (threePoint - 50) / 150,
      ftAccuracy: 0.72,
      usagePercentile: scoring,
      ptsPercentile: scoring,
    };

    result.set(name, { name, attrs, internals, speedTier: speed });
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
  const foreignEstimates = loadForeignEstimates();

  function buildTeamRoster(teamName: string): SimPlayer[] {
    const players: RosterPlayer[] = [];
    rosterCsv.rows.forEach((cols) => {
      if (cols[teamIdx] === teamName) {
        const name = cols[nameIdx];
        const player = raw.find((p) => p.name === name);
        const perGameMin = player && player.seasons.length > 0 ? player.seasons[player.seasons.length - 1].Min : 10;
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
