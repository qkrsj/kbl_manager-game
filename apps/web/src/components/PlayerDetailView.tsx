import { useEffect, useState } from "react";

interface PlayerDetail {
  name: string;
  position: string;
  position_group: string;
  nationality: string;
  team_name: string | null;
  height_cm: string | null;
  weight_kg: string | null;
  birth_date: string | null;
  draft_year: number | null;
  draft_overall_pick: number | null;
  draft_category: string | null;
  finishing: number | null;
  dunking: number | null;
  mid_range_shooting: number | null;
  three_point_shooting: number | null;
  free_throw_shooting: number | null;
  ball_handling: number | null;
  passing: number | null;
  steal: number | null;
  shot_blocking: number | null;
  defensive_rebounding: number | null;
  offensive_rebounding: number | null;
  stamina: number | null;
  injury_proneness: number | null;
  strength: number | null;
  speed: number | null;
  potential: number | null;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

const OFFENSE_KEYS = [
  ["finishing", "골밑득점(볼륨)"],
  ["dunking", "덩크"],
  ["mid_range_shooting", "미드레인지"],
  ["three_point_shooting", "3점슛"],
  ["free_throw_shooting", "자유투"],
  ["ball_handling", "볼핸들링"],
  ["passing", "패싱"],
] as const;

const DEFENSE_KEYS = [
  ["steal", "스틸"],
  ["shot_blocking", "블록"],
  ["defensive_rebounding", "수비리바운드"],
  ["offensive_rebounding", "공격리바운드"],
] as const;

const OTHER_KEYS = [
  ["stamina", "체력"],
  ["strength", "파워"],
  ["speed", "스피드"],
  ["injury_proneness", "부상위험도"],
  ["potential", "잠재력"],
] as const;

function draftLabel(p: PlayerDetail): string {
  if (p.draft_category === "regional_signee") return "연고선수 출신";
  if (p.draft_category === "foreign_or_naturalized") return "귀화/해외 출신 (드래프트 무관)";
  if (p.draft_category === "undrafted" || !p.draft_overall_pick) return "정보 없음";
  const pick = p.draft_overall_pick;
  const round = Math.ceil(pick / 10);
  const pickInRound = ((pick - 1) % 10) + 1;
  return `${p.draft_year ?? "?"}년 ${round}라운드 ${pickInRound}순위 (전체 ${pick}순위)`;
}

function StatBar({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  const pct = ((value - 50) / 49) * 100; // 50~99 스케일을 0~100%로
  return (
    <div style={{ marginBottom: "6px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
        <span>{label}</span>
        <span style={{ fontWeight: "bold" }}>{value}</span>
      </div>
      <div style={{ background: "#eee", borderRadius: "4px", height: "6px" }}>
        <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: "#2563eb", height: "100%", borderRadius: "4px" }} />
      </div>
    </div>
  );
}

export function PlayerDetailView({ playerName }: { playerName: string }) {
  const [player, setPlayer] = useState<PlayerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/players/${encodeURIComponent(playerName)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setPlayer(data);
      })
      .finally(() => setLoading(false));
  }, [playerName]);

  if (loading) return <p>불러오는 중...</p>;
  if (error || !player) return <p>선수를 찾을 수 없습니다: {playerName}</p>;

  const offenseVals = OFFENSE_KEYS.map(([k]) => player[k]).filter((v): v is number => v !== null);
  const defenseVals = DEFENSE_KEYS.map(([k]) => player[k]).filter((v): v is number => v !== null);
  const offenseTotal = offenseVals.length ? Math.round(offenseVals.reduce((a, b) => a + b, 0) / offenseVals.length) : null;
  const defenseTotal = defenseVals.length ? Math.round(defenseVals.reduce((a, b) => a + b, 0) / defenseVals.length) : null;
  const overall = offenseTotal !== null && defenseTotal !== null ? Math.round((offenseTotal + defenseTotal) / 2) : null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
        <div>
          <h2 style={{ margin: 0 }}>{player.name}</h2>
          <p style={{ color: "#666", margin: "4px 0" }}>
            {player.team_name} · {player.position} ({player.position_group}) · {player.nationality}
          </p>
          <p style={{ color: "#666", margin: "4px 0" }}>
            {player.height_cm ? `${player.height_cm}cm` : "신장 정보없음"} /{" "}
            {player.weight_kg ? `${player.weight_kg}kg` : "체중 정보없음"}
            {player.birth_date ? ` · ${player.birth_date}생` : ""}
          </p>
          <p style={{ color: "#666", margin: "4px 0" }}>드래프트: {draftLabel(player)}</p>
        </div>
        {overall !== null && (
          <div style={{ textAlign: "center", border: "2px solid #2563eb", borderRadius: "8px", padding: "12px 20px" }}>
            <div style={{ fontSize: "12px", color: "#888" }}>오버롤</div>
            <div style={{ fontSize: "36px", fontWeight: "bold", color: "#2563eb" }}>{overall}</div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: "12px", marginBottom: "20px" }}>
        <div style={{ flex: 1, background: "#f0f9ff", borderRadius: "8px", padding: "10px", textAlign: "center" }}>
          <div style={{ fontSize: "12px", color: "#888" }}>공격 종합</div>
          <div style={{ fontSize: "24px", fontWeight: "bold" }}>{offenseTotal ?? "-"}</div>
        </div>
        <div style={{ flex: 1, background: "#fef2f2", borderRadius: "8px", padding: "10px", textAlign: "center" }}>
          <div style={{ fontSize: "12px", color: "#888" }}>수비 종합</div>
          <div style={{ fontSize: "24px", fontWeight: "bold" }}>{defenseTotal ?? "-"}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "24px" }}>
        <div style={{ flex: 1 }}>
          <h4>공격 세부</h4>
          {OFFENSE_KEYS.map(([k, label]) => (
            <StatBar key={k} label={label} value={player[k]} />
          ))}
        </div>
        <div style={{ flex: 1 }}>
          <h4>수비 세부</h4>
          {DEFENSE_KEYS.map(([k, label]) => (
            <StatBar key={k} label={label} value={player[k]} />
          ))}
          <h4 style={{ marginTop: "16px" }}>기타</h4>
          {OTHER_KEYS.map(([k, label]) => (
            <StatBar key={k} label={label} value={player[k]} />
          ))}
        </div>
      </div>
    </div>
  );
}
