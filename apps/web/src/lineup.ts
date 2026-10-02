/** 코트 포지션 칸 (1=PG … 5=C) 과 선수 포지션의 궁합 */
export const SLOT_LABELS = ["PG", "SG", "SF", "PF", "C"] as const;
export const SLOT_NAMES = ["포인트 가드", "슈팅 가드", "스몰 포워드", "파워 포워드", "센터"] as const;

/** "포인트 가드/슈팅 가드" 같은 포지션 문자열 → 맞는 칸 번호들 (1~5) */
export function slotsOf(position: string): number[] {
  const out = new Set<number>();
  for (const part of position.split("/").map((s) => s.trim())) {
    if (part === "포인트 가드") out.add(1);
    else if (part === "슈팅 가드") out.add(2);
    else if (part === "스몰 포워드") out.add(3);
    else if (part === "파워 포워드") out.add(4);
    else if (part === "센터") out.add(5);
    else if (part === "가드") { out.add(1); out.add(2); }
    else if (part === "포워드") { out.add(3); out.add(4); }
  }
  return out.size ? [...out] : [3];
}

/** 0 = 제 포지션, 1 = 인접 포지션(무난), 2 이상 = 어색함 */
export function slotFit(position: string, slot: number): number {
  return Math.min(...slotsOf(position).map((s) => Math.abs(s - slot)));
}

/** 포지션 약칭 (PG/SG 등) */
export function positionShort(position: string): string {
  return slotsOf(position).sort().map((s) => SLOT_LABELS[s - 1]).join("/");
}

/**
 * 선수들을 5칸에 가장 자연스럽게 배치 (5! = 120가지 중 어색함 합이 가장 작은 것).
 * fixed: 이미 칸이 정해진 선수 (key → slot). 반환: 칸 순서대로 key (빈 칸은 null)
 */
export function assignSlots<K>(players: { key: K; position: string }[], fixed: Map<K, number> = new Map()): (K | null)[] {
  const result: (K | null)[] = [null, null, null, null, null];
  const free: { key: K; position: string }[] = [];
  for (const p of players) {
    const s = fixed.get(p.key);
    if (s && s >= 1 && s <= 5 && result[s - 1] === null) result[s - 1] = p.key;
    else free.push(p);
  }
  const open = result.map((v, i) => (v === null ? i + 1 : 0)).filter((s) => s > 0);
  let best: number[] = [];
  let bestCost = Infinity;
  const n = Math.min(free.length, open.length);
  const pick = (i: number, used: number[], cost: number) => {
    if (cost >= bestCost) return;
    if (i === n) { bestCost = cost; best = [...used]; return; }
    for (const s of open) {
      if (used.includes(s)) continue;
      used.push(s);
      pick(i + 1, used, cost + slotFit(free[i].position, s) ** 2);
      used.pop();
    }
  };
  pick(0, [], 0);
  best.forEach((s, i) => { result[s - 1] = free[i].key; });
  return result;
}
