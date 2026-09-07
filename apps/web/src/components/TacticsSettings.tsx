import { useEffect, useState } from "react";

interface RosterPlayer {
  id: number;
  name: string;
  position_group: string;
}

interface Tactics {
  pace_style: "fast" | "normal" | "slow";
  three_point_reliance: "high" | "normal" | "low";
  defensive_stopper_player_id: number | null;
  clutch_closer_player_id: number | null;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

export function TacticsSettings() {
  const [tactics, setTactics] = useState<Tactics | null>(null);
  const [players, setPlayers] = useState<RosterPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/franchise/tactics`).then((r) => r.json()),
      fetch(`${API_BASE}/api/franchise/roster`).then((r) => r.json()),
    ])
      .then(([t, p]) => {
        setTactics(t);
        setPlayers(p);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    if (!tactics) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/franchise/tactics`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paceStyle: tactics.pace_style,
          threePointReliance: tactics.three_point_reliance,
          defensiveStopperPlayerId: tactics.defensive_stopper_player_id,
          clutchCloserPlayerId: tactics.clutch_closer_player_id,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`저장 실패: ${data.error}`);
        return;
      }
      setMessage("저장 완료!");
    } catch (e) {
      setMessage(`오류: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !tactics) return <p>전술 정보 불러오는 중...</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "400px" }}>
      <label>
        페이스(템포):{" "}
        <select
          value={tactics.pace_style}
          onChange={(e) => setTactics({ ...tactics, pace_style: e.target.value as Tactics["pace_style"] })}
        >
          <option value="fast">빠름 (속공 위주)</option>
          <option value="normal">보통</option>
          <option value="slow">느림 (세트오펜스)</option>
        </select>
      </label>

      <label>
        3점 의존도:{" "}
        <select
          value={tactics.three_point_reliance}
          onChange={(e) => setTactics({ ...tactics, three_point_reliance: e.target.value as Tactics["three_point_reliance"] })}
        >
          <option value="high">높음</option>
          <option value="normal">보통</option>
          <option value="low">낮음</option>
        </select>
      </label>

      <label>
        수비 스토퍼 (상대 최고usage 선수 전담마크):{" "}
        <select
          value={tactics.defensive_stopper_player_id ?? ""}
          onChange={(e) =>
            setTactics({ ...tactics, defensive_stopper_player_id: e.target.value ? Number(e.target.value) : null })
          }
        >
          <option value="">지정 안 함</option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.position_group})
            </option>
          ))}
        </select>
      </label>

      <label>
        클러치 마무리 (4쿼터 usage/득점력 부스트):{" "}
        <select
          value={tactics.clutch_closer_player_id ?? ""}
          onChange={(e) => setTactics({ ...tactics, clutch_closer_player_id: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">지정 안 함</option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.position_group})
            </option>
          ))}
        </select>
      </label>

      <button onClick={handleSave} disabled={saving} style={{ padding: "8px 16px", width: "fit-content" }}>
        {saving ? "저장 중..." : "전술 저장"}
      </button>
      {message && <span>{message}</span>}
    </div>
  );
}
