import { useEffect, useState } from "react";

interface RosterPlayer {
  id: number;
  name: string;
  position_group: "G" | "F" | "C";
  nationality: string;
  role: "starter" | "bench" | "inactive";
  minutes_target: string | null;
  offense_priority: number | null;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

export function RosterSettings() {
  const [players, setPlayers] = useState<RosterPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch(`${API_BASE}/api/franchise/roster`)
      .then((r) => r.json())
      .then((data) => setPlayers(data))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function updatePlayer(id: number, patch: Partial<RosterPlayer>) {
    setPlayers((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function cycleRole(p: RosterPlayer) {
    const next: RosterPlayer["role"] = p.role === "inactive" ? "starter" : p.role === "starter" ? "bench" : "inactive";
    updatePlayer(p.id, { role: next });
  }

  const starterCount = players.filter((p) => p.role === "starter").length;
  const benchCount = players.filter((p) => p.role === "bench").length;

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/franchise/roster`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          players: players.map((p) => ({
            playerId: p.id,
            role: p.role,
            minutesTarget: p.minutes_target ? Number(p.minutes_target) : null,
            offensePriority: p.offense_priority,
          })),
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

  if (loading) return <p>로스터 불러오는 중...</p>;

  const roleLabel = { starter: "선발", bench: "후보", inactive: "비활성" };
  const roleColor = { starter: "#dcfce7", bench: "#fef9c3", inactive: "#f3f4f6" };

  return (
    <div>
      <p>
        선발: <strong style={{ color: starterCount === 5 ? "green" : "red" }}>{starterCount}/5</strong>
        {"  "}후보: <strong style={{ color: benchCount === 7 ? "green" : "red" }}>{benchCount}/7</strong>
        {"  "}(선수 이름 옆 버튼을 눌러 선발→후보→비활성 순환)
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #333" }}>
            <th style={{ padding: "4px" }}>포지션</th>
            <th style={{ textAlign: "left", padding: "4px" }}>선수</th>
            <th style={{ padding: "4px" }}>국적</th>
            <th style={{ padding: "4px" }}>역할</th>
            <th style={{ padding: "4px" }}>출전시간(분)</th>
            <th style={{ padding: "4px" }}>공격순위</th>
          </tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid #eee", background: roleColor[p.role] }}>
              <td style={{ padding: "4px", textAlign: "center" }}>{p.position_group}</td>
              <td style={{ padding: "4px" }}>{p.name}</td>
              <td style={{ padding: "4px", textAlign: "center" }}>{p.nationality}</td>
              <td style={{ padding: "4px", textAlign: "center" }}>
                <button onClick={() => cycleRole(p)} style={{ cursor: "pointer" }}>
                  {roleLabel[p.role]}
                </button>
              </td>
              <td style={{ padding: "4px", textAlign: "center" }}>
                <input
                  type="number"
                  min={0}
                  max={40}
                  value={p.minutes_target ?? ""}
                  onChange={(e) => updatePlayer(p.id, { minutes_target: e.target.value })}
                  style={{ width: "50px" }}
                  disabled={p.role === "inactive"}
                />
              </td>
              <td style={{ padding: "4px", textAlign: "center" }}>
                <select
                  value={p.offense_priority ?? ""}
                  onChange={(e) => updatePlayer(p.id, { offense_priority: e.target.value ? Number(e.target.value) : null })}
                  disabled={p.role === "inactive"}
                >
                  <option value="">-</option>
                  <option value="1">1순위</option>
                  <option value="2">2순위</option>
                  <option value="3">3순위</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={handleSave} disabled={saving} style={{ marginTop: "12px", padding: "8px 16px" }}>
        {saving ? "저장 중..." : "로스터 저장"}
      </button>
      {message && <span style={{ marginLeft: "12px" }}>{message}</span>}
    </div>
  );
}
