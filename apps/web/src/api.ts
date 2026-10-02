/** KBL Manager — API 클라이언트 + 공용 타입/포맷터 */

export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data as T;
}

export interface Franchise {
  id: number;
  seasonId: number;
  seasonYear: number;
  seasonLabel: string;
  userTeamId: number;
  userTeamName: string;
  date: string;
  phase: "regular" | "playoffs" | "offseason";
  offseasonStage: string | null;
  faDay: number;
  championTeamId: number | null;
}

export interface Coach {
  name: string;
  style: string;
  description: string;
  paceStyle: string;
  threePointReliance: string;
  defenseScheme: string;
  rotationDepth: number;
}

export interface SeasonStats {
  g: number; min: string; pts: string; reb: string; ast: string; stl: string; blk: string; tov: string; tpm: string;
  fg_pct: string | null; tp_pct: string | null; ft_pct: string | null;
}

export interface RosterPlayer {
  id: number;
  name: string;
  position: string;
  positionGroup: "G" | "F" | "C";
  nationality: string;
  contractType: "domestic" | "foreign" | "asia";
  age: number;
  heightCm: number | null;
  overall: number;
  offense: number;
  defense: number;
  potential: number | null;
  fatigue: number;
  injuredUntil: string | null;
  role: string | null;
  minutesTarget: number | null;
  lineupSlot: number | null;
  offensePriority: number | null;
  salaryKrw: number | null;
  salaryUsd: number | null;
  faYear: number | null;
  contractSource: string | null;
  xp: number;
  xpLevel: number;
  personalFocus: string | null;
  stats: SeasonStats | null;
  suggestedMinutes: number;
}

export interface Payroll {
  domesticTotal: number;
  domesticCount: number;
  foreignTotalUsd: number;
  foreignCount: number;
  asiaTotalUsd: number;
  asiaCount: number;
  capRoom: number;
  usageRatio: number;
}

export interface Standing {
  rank: number;
  team_id: number;
  team_name: string;
  games_played: number;
  wins: number;
  losses: number;
  points_for: number;
  points_against: number;
  win_pct: number;
  games_behind: number;
  last5: string;
  streak: string;
}

export interface LeaderBoard {
  stat: string;
  label: string;
  minGames: number;
  rows: { player_id: number; name: string; team_name: string; games: number; value: string; min: string }[];
}

export interface TrainingPlan {
  mode: "rest" | "train";
  focus: string;
  intensity: "light" | "normal" | "intense";
}

export interface DevChange {
  playerId: number;
  name: string;
  attribute: string;
  label: string;
  delta: number;
  reason: string;
}

export interface DayResult {
  date: string;
  nextDate: string;
  phase: string;
  results: { gameId: number; home: string; away: string; homeScore: number; awayScore: number; ot: boolean }[];
  userTeamChanges: DevChange[];
  injuries: { name: string; days: number }[];
  events: string[];
  trainingPlan: TrainingPlan | null;
}

// ============================================================
// 포맷터 / 라벨
// ============================================================

export function krw(manwon: number | null | undefined): string {
  if (manwon === null || manwon === undefined) return "-";
  const v = Number(manwon);
  if (v >= 10000) {
    const eok = Math.floor(v / 10000);
    const rest = v % 10000;
    return rest === 0 ? `${eok}억` : `${eok}억 ${rest.toLocaleString()}만`;
  }
  return `${v.toLocaleString()}만`;
}

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return `$${Number(v).toLocaleString()}`;
}

export function salaryLabel(p: { contractType: string; salaryKrw: number | null; salaryUsd: number | null }): string {
  return p.contractType === "domestic" ? krw(p.salaryKrw) : usd(p.salaryUsd);
}

export const CONTRACT_TYPE_LABEL: Record<string, string> = { domestic: "국내", foreign: "외국", asia: "아시아쿼터" };
export const PACE_LABEL: Record<string, string> = { fast: "빠르게", normal: "보통", slow: "느리게" };
export const THREE_LABEL: Record<string, string> = { high: "많이", normal: "보통", low: "적게" };
export const DEFENSE_LABEL: Record<string, string> = { man: "맨투맨", zone: "지역방어", press: "압박 수비" };
export const INTENSITY_LABEL: Record<string, string> = { light: "가볍게", normal: "보통", intense: "강하게" };
export const REASON_LABEL: Record<string, string> = { training: "훈련", aging: "노화", experience: "경험치", offseason: "비시즌" };
export const PHASE_LABEL: Record<string, string> = { regular: "정규시즌", playoffs: "플레이오프", offseason: "비시즌" };
export const STAGE_LABEL: Record<string, string> = { resign: "연봉협상·재계약", fa: "FA 시장", ready: "새 시즌 준비" };

export function formatDate(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return `${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()} (${days[dt.getDay()]})`;
}

export function shortTeam(name: string): string {
  const parts = name.split(" ");
  return parts.length >= 2 ? parts.slice(0, 2).join(" ") : name;
}

export function ratingClass(v: number): string {
  if (v >= 85) return "rt-elite";
  if (v >= 78) return "rt-good";
  if (v >= 70) return "rt-avg";
  return "rt-low";
}
