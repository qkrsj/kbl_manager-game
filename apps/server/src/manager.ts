/**
 * KBL Manager — 감독(사용자) 프로필
 *
 * 새 게임에서 사용자가 만든 프로필이 선택한 팀의 감독이 된다 (기존 실제 감독을 대체).
 *  - 플레이 스타일 → 시작 전술(템포·3점 의존도·수비·리바운드) + 감독 성향 표시
 *  - 성격        → 선수단 관리 보너스 (훈련·회복·부상·경험치)
 *  - 운영 방향   → 나이대별 훈련 성장 보너스, 로테이션 성향
 * 효과는 유저 팀 선수에게만 적용된다.
 */
import type { Pool, PoolClient } from "pg";
import type { DefenseScheme, PaceStyle, ThreeReliance } from "./coaches";

type Db = Pool | PoolClient;

export type PlayStyle = "run" | "three" | "defense" | "inside" | "balanced";
export type Personality = "motivator" | "players" | "tactician" | "disciplinarian";
export type Direction = "win_now" | "balanced" | "rebuild";

export interface ManagerProfile {
  name: string;
  age: number;
  playStyle: PlayStyle;
  personality: Personality;
  direction: Direction;
  hometown?: string;
  motto?: string;
}

export const PLAY_STYLES: Record<PlayStyle, {
  label: string; description: string; pace: PaceStyle; three: ThreeReliance; defense: DefenseScheme; rebound: boolean;
}> = {
  run:      { label: "속공·트랜지션", description: "빠른 템포와 전방 압박으로 쉬운 득점을 만든다", pace: "fast", three: "normal", defense: "press", rebound: false },
  three:    { label: "양궁 농구", description: "볼을 돌려 3점슛 기회를 최대한 많이 만든다", pace: "normal", three: "high", defense: "man", rebound: false },
  defense:  { label: "질식 수비", description: "느린 템포의 하프코트 농구, 맨투맨 수비와 리바운드", pace: "slow", three: "normal", defense: "man", rebound: true },
  inside:   { label: "골밑 장악", description: "빅맨 중심 포스트업과 지역방어, 리바운드 우선", pace: "slow", three: "low", defense: "zone", rebound: true },
  balanced: { label: "밸런스", description: "상대에 맞춰 공수 균형을 잡는 정석 농구", pace: "normal", three: "normal", defense: "man", rebound: false },
};

export const PERSONALITIES: Record<Personality, { label: string; description: string; effect: string }> = {
  motivator:      { label: "카리스마형 리더", description: "강한 장악력으로 선수단을 이끈다", effect: "경기 경험치 +15%" },
  players:        { label: "덕장 (선수 친화)", description: "선수와 소통하며 컨디션을 세심하게 관리한다", effect: "피로 회복 +20%" },
  tactician:      { label: "지장 (전술가)", description: "데이터와 전술 훈련을 중시한다", effect: "훈련 성장 +10%" },
  disciplinarian: { label: "원칙주의자", description: "엄격한 규율과 몸 관리를 강조한다", effect: "부상 위험 −25%" },
};

export const DIRECTIONS: Record<Direction, { label: string; description: string; effect: string; rotationDepth: number; youthPreference: number }> = {
  win_now:  { label: "윈나우", description: "지금 당장 우승을 노린다 — 베테랑·주전 중심", effect: "27세 이상 훈련 성장 +15%", rotationDepth: 0.3, youthPreference: 0.15 },
  balanced: { label: "균형", description: "성적과 육성을 함께 챙긴다", effect: "전원 훈련 성장 +5%", rotationDepth: 0.5, youthPreference: 0.45 },
  rebuild:  { label: "리빌딩", description: "유망주에게 기회를 주고 미래를 준비한다", effect: "24세 이하 훈련 성장 +25%", rotationDepth: 0.7, youthPreference: 0.85 },
};

export const DEFAULT_PROFILE: ManagerProfile = { name: "감독", age: 45, playStyle: "balanced", personality: "tactician", direction: "balanced" };

/** 입력 검증·정리 (잘못된 값은 기본값으로) */
export function normalizeProfile(input: unknown): ManagerProfile {
  const p = (input ?? {}) as Partial<ManagerProfile>;
  const name = String(p.name ?? "").trim().slice(0, 20) || DEFAULT_PROFILE.name;
  const age = Math.max(28, Math.min(80, Math.round(Number(p.age) || DEFAULT_PROFILE.age)));
  return {
    name, age,
    playStyle: p.playStyle && p.playStyle in PLAY_STYLES ? p.playStyle : DEFAULT_PROFILE.playStyle,
    personality: p.personality && p.personality in PERSONALITIES ? p.personality : DEFAULT_PROFILE.personality,
    direction: p.direction && p.direction in DIRECTIONS ? p.direction : DEFAULT_PROFILE.direction,
    hometown: p.hometown ? String(p.hometown).trim().slice(0, 20) : undefined,
    motto: p.motto ? String(p.motto).trim().slice(0, 60) : undefined,
  };
}

/** 새 기능용 컬럼 (구버전 DB에도 자동으로 추가) — 감독 프로필, 선수별 훈련 강도·휴식 */
export async function ensureManagerSchema(db: Db) {
  await db.query(`ALTER TABLE franchise ADD COLUMN IF NOT EXISTS manager_profile JSONB`);
  await db.query(`ALTER TABLE player_training_focus ALTER COLUMN focus DROP NOT NULL`);
  await db.query(`ALTER TABLE player_training_focus ADD COLUMN IF NOT EXISTS intensity TEXT`);
  await db.query(`ALTER TABLE player_training_focus ADD COLUMN IF NOT EXISTS mode TEXT`);
  // 선발 라인업의 코트 위치 (1=PG 2=SG 3=SF 4=PF 5=C)
  await db.query(`ALTER TABLE player_roster_settings ADD COLUMN IF NOT EXISTS lineup_slot SMALLINT`);
  for (const n of [1, 2, 3]) {
    await db.query(`ALTER TABLE team_tactics ADD COLUMN IF NOT EXISTS option${n}_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL`);
  }
}

export async function loadManagerProfile(db: Db): Promise<ManagerProfile | null> {
  const r = await db.query(`SELECT manager_profile FROM franchise LIMIT 1`).catch(() => ({ rows: [] as any[] }));
  return r.rows[0]?.manager_profile ? normalizeProfile(r.rows[0].manager_profile) : null;
}

/** 프로필을 저장하고, 유저 팀 감독(coaches)과 시작 전술(team_tactics)을 프로필에 맞춘다 */
export async function applyManagerProfile(db: Db, teamId: number, profile: ManagerProfile, opts: { resetTactics: boolean }) {
  await ensureManagerSchema(db);
  await db.query(`UPDATE franchise SET manager_profile=$1`, [JSON.stringify(profile)]);
  const st = PLAY_STYLES[profile.playStyle];
  const dir = DIRECTIONS[profile.direction];
  const per = PERSONALITIES[profile.personality];
  await db.query(
    `INSERT INTO coaches (team_id, name, style, description, pace_style, three_point_reliance, defense_scheme, rotation_depth, youth_preference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (team_id) DO UPDATE SET name=$2, style=$3, description=$4, pace_style=$5, three_point_reliance=$6,
       defense_scheme=$7, rotation_depth=$8, youth_preference=$9`,
    [teamId, profile.name, st.label, `${per.label} · ${dir.label} — ${profile.motto ?? st.description}`,
      st.pace, st.three, st.defense, dir.rotationDepth, dir.youthPreference]
  );
  if (opts.resetTactics) {
    await db.query(
      `INSERT INTO team_tactics (team_id, pace_style, three_point_reliance, defense_scheme, rebound_emphasis)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (team_id) DO UPDATE SET pace_style=$2, three_point_reliance=$3, defense_scheme=$4, rebound_emphasis=$5`,
      [teamId, st.pace, st.three, st.defense, st.rebound]
    );
  }
}

// ============================================================
// 게임 효과 (유저 팀 선수에게만)
// ============================================================

export function trainingGrowthMultiplier(profile: ManagerProfile | null, playerAge: number): number {
  if (!profile) return 1;
  let m = 1;
  if (profile.personality === "tactician") m *= 1.1;
  if (profile.direction === "rebuild" && playerAge <= 24) m *= 1.25;
  if (profile.direction === "win_now" && playerAge >= 27) m *= 1.15;
  if (profile.direction === "balanced") m *= 1.05;
  return m;
}

export function recoveryMultiplier(profile: ManagerProfile | null): number {
  return profile?.personality === "players" ? 1.2 : 1;
}

export function injuryMultiplier(profile: ManagerProfile | null): number {
  return profile?.personality === "disciplinarian" ? 0.75 : 1;
}

export function experienceMultiplier(profile: ManagerProfile | null): number {
  return profile?.personality === "motivator" ? 1.15 : 1;
}
