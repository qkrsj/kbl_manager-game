import { useState } from "react";
import { PlayerDetailView } from "./PlayerDetailView";

export function PlayerSearch({ initialName }: { initialName?: string }) {
  const [query, setQuery] = useState(initialName ?? "");
  const [searched, setSearched] = useState(initialName ?? "");

  return (
    <div>
      <div style={{ marginBottom: "16px" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setSearched(query)}
          placeholder="선수 이름 입력 후 Enter"
          style={{ padding: "8px", width: "250px" }}
        />
        <button onClick={() => setSearched(query)} style={{ marginLeft: "8px", padding: "8px 16px" }}>
          검색
        </button>
      </div>
      {searched && <PlayerDetailView playerName={searched} />}
    </div>
  );
}
