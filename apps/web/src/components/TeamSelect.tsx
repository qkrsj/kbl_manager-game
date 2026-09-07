import { useEffect, useState } from "react";

interface Team {
  id: number;
  name: string;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

export function TeamSelect({ currentTeam, onSelected }: { currentTeam: string; onSelected: () => void }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/teams`)
      .then((r) => r.json())
      .then((data) => setTeams(data))
      .finally(() => setLoading(false));
  }, []);

  async function handleSelect(teamId: number) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/franchise/select-team`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "알 수 없는 오류");
        return;
      }
      onSelected();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p>팀 목록 불러오는 중...</p>;

  return (
    <div style={{ border: "1px solid #ccc", padding: "16px", borderRadius: "8px" }}>
      <p>
        현재 내 팀: <strong>{currentTeam}</strong>
      </p>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "8px" }}>
        {teams.map((t) => (
          <button
            key={t.id}
            onClick={() => handleSelect(t.id)}
            disabled={saving || t.name === currentTeam}
            style={{
              padding: "10px",
              fontWeight: t.name === currentTeam ? "bold" : "normal",
              backgroundColor: t.name === currentTeam ? "#e0f0ff" : "white",
              cursor: t.name === currentTeam ? "default" : "pointer",
            }}
          >
            {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}
