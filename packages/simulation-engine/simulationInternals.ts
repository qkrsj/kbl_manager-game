/**
 * KBL Manager — 시뮬레이션 전용 내부값 계산
 * (화면 표시용 DerivedAttributes와 분리된, 엔진 전용 파생값)
 */

export interface SimStatLine {
  G: number;
  PTS: number;
  FGA: number;
  FTA: number;
  TO: number;
  PP: number;   // 경기당 페인트존 성공
  PPA: number;  // 경기당 페인트존 시도
  "2PM": number;
  "2PA": number;
  "3PM": number;
  "3PA": number;
  FTM: number;
}

function seasonTotal(perGameAvg: number, games: number): number {
  return perGameAvg * games;
}

function bayesianRate(success: number, attempts: number, k: number, leagueAvg: number): number {
  return (success + k * leagueAvg) / (attempts + k);
}

function percentile(values: number[], target: number): number {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return 50;
  const below = clean.filter((v) => v < target).length;
  const equal = clean.filter((v) => v === target).length;
  return ((below + equal * 0.5) / clean.length) * 100;
}

export interface SimulationInternalsResult {
  paintAccuracy: number;   // 실제 확률(0~1) — 페인트존
  midAccuracy: number;     // 실제 확률(0~1) — 미드레인지
  threeAccuracy: number;   // 실제 확률(0~1) — 3점
  ftAccuracy: number;      // 실제 확률(0~1) — 자유투
  usagePercentile: number;
  ptsPercentile: number;
}

/**
 * 리그 전체(최신시즌 기준) 선수 목록을 받아 각 선수의 시뮬레이션 전용 내부값을 계산.
 * ⚠️ 여기서 계산하는 정확도값(paintAccuracy 등)은 attribute-pipeline의 0~99 표시용
 *    능력치(threePointShooting 등)와는 다른, "실제 성공 확률(0~1)"이다.
 *    표시용 능력치는 볼륨까지 섞인 리그 내 상대 순위(퍼센타일)라서 시뮬레이션의
 *    확률로 그대로 쓰면 안 된다 (실측 검증 중 발견 — 포제션당 득점 1.76, 슛성공률
 *    72.8%로 비현실적으로 나왔던 원인).
 */
export function computeSimulationInternals(
  players: { playerId: string; stat: SimStatLine }[]
): Map<string, SimulationInternalsResult> {
  const ppSuccessTotal = players.reduce((a, p) => a + seasonTotal(p.stat.PP, p.stat.G), 0);
  const ppAttemptTotal = players.reduce((a, p) => a + seasonTotal(p.stat.PPA, p.stat.G), 0);
  const leagueAvgPPPct = ppAttemptTotal === 0 ? 0 : ppSuccessTotal / ppAttemptTotal;

  const midSuccessTotal = players.reduce((a, p) => a + seasonTotal(p.stat["2PM"] - p.stat.PP, p.stat.G), 0);
  const midAttemptTotal = players.reduce((a, p) => a + seasonTotal(p.stat["2PA"] - p.stat.PPA, p.stat.G), 0);
  const leagueAvgMidPct = midAttemptTotal === 0 ? 0 : midSuccessTotal / midAttemptTotal;

  const threeSuccessTotal = players.reduce((a, p) => a + seasonTotal(p.stat["3PM"], p.stat.G), 0);
  const threeAttemptTotal = players.reduce((a, p) => a + seasonTotal(p.stat["3PA"], p.stat.G), 0);
  const leagueAvgThreePct = threeAttemptTotal === 0 ? 0 : threeSuccessTotal / threeAttemptTotal;

  const ftSuccessTotal = players.reduce((a, p) => a + seasonTotal(p.stat.FTM, p.stat.G), 0);
  const ftAttemptTotal = players.reduce((a, p) => a + seasonTotal(p.stat.FTA, p.stat.G), 0);
  const leagueAvgFtPct = ftAttemptTotal === 0 ? 0 : ftSuccessTotal / ftAttemptTotal;

  const usageArr = players.map((p) => p.stat.FGA + 0.44 * p.stat.FTA + p.stat.TO);
  const ptsArr = players.map((p) => p.stat.PTS);

  const result = new Map<string, SimulationInternalsResult>();

  players.forEach((p, i) => {
    const paintAccuracy = bayesianRate(
      seasonTotal(p.stat.PP, p.stat.G), seasonTotal(p.stat.PPA, p.stat.G), 15, leagueAvgPPPct
    );
    const midAccuracy = bayesianRate(
      seasonTotal(p.stat["2PM"] - p.stat.PP, p.stat.G),
      seasonTotal(p.stat["2PA"] - p.stat.PPA, p.stat.G),
      20, leagueAvgMidPct
    );
    const threeAccuracy = bayesianRate(
      seasonTotal(p.stat["3PM"], p.stat.G), seasonTotal(p.stat["3PA"], p.stat.G), 20, leagueAvgThreePct
    );
    const ftAccuracy = bayesianRate(
      seasonTotal(p.stat.FTM, p.stat.G), seasonTotal(p.stat.FTA, p.stat.G), 15, leagueAvgFtPct
    );

    const usage = usageArr[i];
    const pts = ptsArr[i];

    result.set(p.playerId, {
      paintAccuracy,
      midAccuracy,
      threeAccuracy,
      ftAccuracy,
      usagePercentile: percentile(usageArr, usage),
      ptsPercentile: percentile(ptsArr, pts),
    });
  });

  return result;
}
