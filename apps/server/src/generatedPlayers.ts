/**
 * KBL Manager — 가상 선수 생성 (신인 드래프트 / 외국선수·아시아쿼터 시장)
 *
 * 시즌이 거듭돼도 리그가 유지되도록 매 비시즌 신인과 외국선수 후보를 만든다.
 * 외국선수는 실제 영입 방식처럼 "해외리그 기록 + 리그 강도"로 능력치를 산정한다
 * (KBL 경험 없는 외국선수 평가 방식과 동일 — leagueData.ts loadForeignEstimates 참고).
 */
import { Pool, PoolClient } from "pg";
import { computeRatings, AttributeRow } from "./ratings";

type Db = Pool | PoolClient;

const SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권", "황", "안", "송", "류", "홍"];
const GIVEN_A = ["민", "준", "서", "도", "지", "현", "우", "승", "태", "재", "건", "시", "하", "유", "성", "동", "진", "영", "규", "형"];
const GIVEN_B = ["호", "준", "우", "현", "민", "석", "훈", "빈", "원", "혁", "수", "찬", "윤", "진", "규", "율", "환", "결", "겸", "범"];
const FIRST_EN = ["마커스", "자이언", "타일러", "데릭", "조던", "앤서니", "브랜든", "케빈", "트레본", "이사이아", "말릭", "저스틴", "드숀", "카일", "테렌스", "제일런", "코리", "라몬트", "니콜라", "안드레"];
const LAST_EN = ["존슨", "윌리엄스", "브라운", "데이비스", "해리스", "로빈슨", "워커", "그린", "카터", "미첼", "베일리", "포스터", "헤이스", "브룩스", "그랜트", "왓킨스", "몽고메리", "블레이크", "프라이스", "콜먼"];
const FIRST_PH = ["후안", "마크", "제이슨", "칼로", "레이", "조쉬", "앤젤로", "크리스찬", "노엘", "케빈"];
const LAST_PH = ["산토스", "레예스", "가르시아", "크루즈", "바티스타", "멘도사", "파딜라", "토레스", "아키노", "비야누에바"];

const OVERSEAS_LEAGUES = [
  { name: "NBA G리그", strength: 0.85 },
  { name: "일본 B1리그", strength: 0.9 },
  { name: "중국 CBA", strength: 1.05 },
  { name: "호주 NBL", strength: 0.95 },
  { name: "스페인 ACB", strength: 1.1 },
  { name: "터키 BSL", strength: 1.05 },
  { name: "이스라엘 리그", strength: 0.9 },
  { name: "푸에르토리코 BSN", strength: 0.8 },
];

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
const clampAttr = (v: number) => Math.round(Math.max(45, Math.min(97, v)));

type Archetype = "G" | "F" | "C";

/** 포지션 아키타입과 수준(0~1)으로 능력치 벡터 생성 */
function attributesFor(arch: Archetype, level: number): AttributeRow {
  const base = 52 + level * 34;
  const n = () => rand(-6, 6);
  const g = arch === "G", c = arch === "C";
  return {
    finishing: clampAttr(base + (c ? 6 : g ? -4 : 2) + n()),
    dunking: clampAttr(base + (c ? 8 : g ? -10 : 0) + n()),
    mid_range_shooting: clampAttr(base + (c ? -6 : 2) + n()),
    three_point_shooting: clampAttr(base + (c ? -14 : g ? 5 : 0) + n()),
    free_throw_shooting: clampAttr(base + (c ? -8 : 3) + n()),
    ball_handling: clampAttr(base + (g ? 8 : c ? -14 : -2) + n()),
    passing: clampAttr(base + (g ? 7 : c ? -10 : -2) + n()),
    steal: clampAttr(base + (g ? 4 : c ? -6 : 0) + n()),
    shot_blocking: clampAttr(base + (c ? 10 : g ? -14 : 0) + n()),
    defensive_rebounding: clampAttr(base + (c ? 10 : g ? -12 : 2) + n()),
    offensive_rebounding: clampAttr(base + (c ? 10 : g ? -12 : 0) + n()),
    stamina: clampAttr(base + n()),
    strength: clampAttr(base + (c ? 9 : g ? -8 : 2) + n()),
    speed: clampAttr(base + (g ? 8 : c ? -10 : 0) + n()),
  };
}

/** 능력치로부터 시뮬레이션 확률 프로필 산출 (실측 기록이 없는 가상 선수용) */
export function simProfileFromAttrs(a: AttributeRow, positionGroup: string) {
  const r = computeRatings(a, positionGroup);
  const s = (v: number) => (v - 50) / 49;
  return {
    paint_accuracy: 0.47 + s(a.finishing) * 0.17,
    mid_accuracy: 0.32 + s(a.mid_range_shooting) * 0.14,
    three_accuracy: 0.24 + s(a.three_point_shooting) * 0.15,
    ft_accuracy: 0.6 + s(a.free_throw_shooting) * 0.28,
    usage_percentile: Math.max(1, Math.min(99, s(r.offense) * 110)),
    pts_percentile: Math.max(1, Math.min(99, s(r.offense) * 110)),
    base_attrs: { ...a, offense: r.offense },
  };
}

const POSITION_LABEL: Record<Archetype, string[]> = {
  G: ["포인트 가드", "슈팅 가드"],
  F: ["스몰 포워드", "파워 포워드"],
  C: ["센터"],
};

async function uniqueName(db: Db, make: () => string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const name = make();
    const r = await db.query(`SELECT 1 FROM players WHERE name=$1`, [name]);
    if (r.rows.length === 0) return name;
  }
  return `${make()}${Math.floor(Math.random() * 90 + 10)}`;
}

interface InsertOpts {
  name: string;
  nationality: string;
  arch: Archetype;
  age: number;
  attrs: AttributeRow;
  potential: number | null;
  heightCm: number;
  weightKg: number;
  isForeign: boolean;
  draftYear?: number;
  draftPick?: number;
  year: number;
  seasonId: number;
}

async function insertPlayer(db: Db, o: InsertOpts): Promise<number> {
  const birth = `${o.year - o.age}-0${1 + Math.floor(Math.random() * 9)}-15`;
  const res = await db.query(
    `INSERT INTO players (name, team_id, nationality, position, position_group, height_cm, weight_kg, birth_date,
                          is_foreign_import, draft_year, draft_overall_pick, draft_category, is_generated)
     VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE) RETURNING id`,
    [o.name, o.nationality, pick(POSITION_LABEL[o.arch]), o.arch, o.heightCm, o.weightKg, birth, o.isForeign,
      o.draftYear ?? null, o.draftPick ?? null, o.draftYear ? "picked" : "foreign_or_naturalized"]
  );
  const id = res.rows[0].id;
  const a = o.attrs;
  await db.query(
    `INSERT INTO player_attributes (player_id, season_id, finishing, dunking, mid_range_shooting, three_point_shooting,
       free_throw_shooting, ball_handling, passing, steal, shot_blocking, defensive_rebounding, offensive_rebounding,
       stamina, injury_proneness, strength, speed, potential, work_ethic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [id, o.seasonId, a.finishing, a.dunking, a.mid_range_shooting, a.three_point_shooting, a.free_throw_shooting,
      a.ball_handling, a.passing, a.steal, a.shot_blocking, a.defensive_rebounding, a.offensive_rebounding,
      a.stamina, Math.round(rand(50, 80)), a.strength, a.speed, o.potential, Math.round(rand(55, 92))]
  );
  const sp = simProfileFromAttrs(a, o.arch);
  await db.query(
    `INSERT INTO player_sim_profile (player_id, paint_accuracy, mid_accuracy, three_accuracy, ft_accuracy, usage_percentile, pts_percentile, base_attrs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, sp.paint_accuracy, sp.mid_accuracy, sp.three_accuracy, sp.ft_accuracy, sp.usage_percentile, sp.pts_percentile, JSON.stringify(sp.base_attrs)]
  );
  await db.query(`INSERT INTO player_condition (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  return id;
}

/** 신인 드래프트 후보 생성 (2라운드 × 10팀 = 20명 + 여유 4명) */
export async function generateDraftClass(db: Db, year: number, seasonId: number, count = 24): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const arch: Archetype = pick(["G", "G", "F", "F", "C"]);
    const level = Math.max(0, Math.min(0.75, rand(0.05, 0.45) + (i < 4 ? 0.2 : 0)));
    const potential = Math.round(Math.min(97, 60 + rand(0, 30) + (i < 4 ? 8 : 0)));
    const name = await uniqueName(db, () => pick(SURNAMES) + pick(GIVEN_A) + pick(GIVEN_B));
    ids.push(await insertPlayer(db, {
      name, nationality: "KOR", arch, age: Math.round(rand(20, 23)), attrs: attributesFor(arch, level), potential,
      heightCm: arch === "G" ? rand(178, 190) : arch === "F" ? rand(190, 199) : rand(198, 206),
      weightKg: arch === "G" ? rand(72, 85) : arch === "F" ? rand(85, 98) : rand(95, 110),
      isForeign: false, year, seasonId,
    }));
  }
  return ids;
}

export interface ForeignCandidate {
  id: number;
  league: string;
}

/** 외국선수 시장 후보 생성: 해외리그 기록(리그 강도 반영)으로 능력치 산정 */
export async function generateForeignPool(db: Db, year: number, seasonId: number, count = 14): Promise<{ id: number; league: string; askingUsd: number }[]> {
  const out: { id: number; league: string; askingUsd: number }[] = [];
  for (let i = 0; i < count; i++) {
    const arch: Archetype = pick(["G", "F", "F", "C", "C"]);
    const league = pick(OVERSEAS_LEAGUES);
    const rawLevel = rand(0.45, 0.95);
    const level = Math.min(1, rawLevel * league.strength);
    const name = await uniqueName(db, () => `${pick(FIRST_EN)} ${pick(LAST_EN)}`);
    const id = await insertPlayer(db, {
      name, nationality: "USA", arch, age: Math.round(rand(24, 32)), attrs: attributesFor(arch, level), potential: null,
      heightCm: arch === "G" ? rand(188, 196) : arch === "F" ? rand(198, 206) : rand(203, 213),
      weightKg: arch === "G" ? rand(84, 95) : arch === "F" ? rand(95, 108) : rand(105, 125),
      isForeign: true, year, seasonId,
    });
    const askingUsd = Math.round((250000 + level * 450000) / 10000) * 10000;
    await db.query(
      `INSERT INTO contracts (player_id, contract_type, salary_usd, fa_year, source, signed_year) VALUES ($1,'foreign',$2,$3,'market',$3)`,
      [id, Math.min(700000, askingUsd), year]
    );
    await db.query(
      `INSERT INTO transactions (season_year, team_id, player_id, kind, description) VALUES ($1,NULL,$2,'market',$3)`,
      [year, id, `외국선수 시장 등록 — ${league.name} 출신`]
    );
    out.push({ id, league: league.name, askingUsd });
  }
  // 아시아쿼터 후보
  for (let i = 0; i < 5; i++) {
    const arch: Archetype = pick(["G", "G", "F"]);
    const level = rand(0.3, 0.7);
    const name = await uniqueName(db, () => `${pick(FIRST_PH)} ${pick(LAST_PH)}`);
    const id = await insertPlayer(db, {
      name, nationality: "PHI", arch, age: Math.round(rand(22, 29)), attrs: attributesFor(arch, level), potential: Math.round(rand(55, 80)),
      heightCm: rand(178, 196), weightKg: rand(72, 92), isForeign: false, year, seasonId,
    });
    const askingUsd = Math.round((100000 + level * 120000) / 10000) * 10000;
    await db.query(
      `INSERT INTO contracts (player_id, contract_type, salary_usd, fa_year, source, signed_year) VALUES ($1,'asia',$2,$3,'market',$3)`,
      [id, Math.min(200000, askingUsd), year]
    );
    out.push({ id, league: "필리핀 PBA/MPBL", askingUsd });
  }
  return out;
}
