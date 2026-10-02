import { useEffect, useMemo, useState } from "react";
import { useApi, Loading, ErrorBox, Card, Modal, useApp } from "./common";
import { BoxScore } from "./BoxScore";
import { formatDate } from "../api";
import type { NewsDay, NewsRow } from "../api";
import { teamStyle } from "../teamColors";
import "./news.css";

const CAT: Record<string, { icon: string; label: string }> = {
  game: { icon: "🏀", label: "경기" },
  record: { icon: "🔥", label: "기록" },
  streak: { icon: "📈", label: "연승·연패" },
  injury: { icon: "🚑", label: "부상" },
  return: { icon: "💪", label: "복귀" },
  growth: { icon: "⬆️", label: "성장" },
  trade: { icon: "🔁", label: "트레이드" },
  trade_offer: { icon: "📨", label: "트레이드 제안" },
  season: { icon: "🏆", label: "시즌" },
};

function NewsItem({ n }: { n: NewsRow }) {
  const { go } = useApp();
  const c = CAT[n.category] ?? { icon: "•", label: n.category };
  const action = n.category === "trade_offer" ? () => go({ name: "trade" }) : null;
  return (
    <div className={`nw-item imp-${n.importance} ${n.mine ? "mine" : ""} ${action ? "clickable" : ""}`} onClick={action ?? undefined}>
      <span className="nw-icon" title={c.label}>{c.icon}</span>
      <div>
        <b>{n.headline}</b>
        {n.body && <p>{n.body}</p>}
        {action && <small className="nw-link">트레이드 메뉴에서 답하기 →</small>}
      </div>
    </div>
  );
}

/** 하루치 소식: 경기 결과 + 뉴스 (달력 옆 패널, 뉴스 메뉴에서 같이 씀) */
export function DayNews({ date, compact = false, filter = "all" }: { date: string; compact?: boolean; filter?: "all" | "mine" }) {
  const { userTeamId } = useApp();
  const { data, error } = useApi<NewsDay>(`/api/news?date=${date}`, [date]);
  const [box, setBox] = useState<number | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const played = data.games.filter((g) => g.homeScore !== null);
  const news = filter === "mine" ? data.news.filter((n) => n.mine) : data.news;
  const shown = compact ? news.slice(0, 6) : news;
  return (
    <div className="day-news">
      {played.length > 0 && (
        <div className="dn-games">
          {played.map((g) => {
            const mine = g.homeId === userTeamId || g.awayId === userTeamId;
            const homeWon = (g.homeScore ?? 0) > (g.awayScore ?? 0);
            const hs = teamStyle(g.home), as = teamStyle(g.away);
            return (
              <button key={g.id} className={`dn-game ${mine ? "mine" : ""}`} onClick={() => setBox(g.id)} title="박스스코어">
                <span className={`dn-team ${!homeWon ? "win" : ""}`}><i style={{ background: as.primary }} />{as.short}<b>{g.awayScore}</b></span>
                <span className={`dn-team ${homeWon ? "win" : ""}`}><i style={{ background: hs.primary }} />{hs.short}<b>{g.homeScore}</b></span>
                {(g.ot || g.playoffLabel) && <small>{[g.playoffLabel, g.ot ? "연장" : null].filter(Boolean).join(" · ")}</small>}
              </button>
            );
          })}
        </div>
      )}
      {played.length === 0 && data.games.length === 0 && <p className="muted small">이날은 경기가 없었습니다.</p>}
      <div className="dn-list">
        {shown.map((n) => <NewsItem key={n.id} n={n} />)}
        {news.length === 0 && <p className="muted small">{filter === "mine" ? "우리 팀 소식이 없습니다." : "특별한 소식이 없었습니다."}</p>}
        {compact && news.length > shown.length && <p className="muted small">외 {news.length - shown.length}건 — 뉴스 메뉴에서 모두 보기</p>}
      </div>
      {box && <Modal onClose={() => setBox(null)}><BoxScore gameId={box} /></Modal>}
    </div>
  );
}

/** 상단 [뉴스] 메뉴: 날짜별 리그 소식 */
export function NewsView({ initialDate }: { initialDate?: string }) {
  const { data: dates, error } = useApi<{ date: string; count: number; mine: number; top: number }[]>("/api/news/dates");
  const [date, setDate] = useState<string | null>(initialDate ?? null);
  const [filter, setFilter] = useState<"all" | "mine">("all");
  useEffect(() => { if (!date && dates?.length) setDate(dates[0].date); }, [dates, date]);
  const months = useMemo(() => {
    const m = new Map<string, NonNullable<typeof dates>>();
    (dates ?? []).forEach((d) => m.set(d.date.slice(0, 7), [...(m.get(d.date.slice(0, 7)) ?? []), d]));
    return [...m.entries()];
  }, [dates]);
  if (error) return <ErrorBox error={error} />;
  if (!dates) return <Loading />;
  if (dates.length === 0) return <Card title="뉴스"><p className="muted">아직 소식이 없습니다. 상단의 <b>다음 ▶</b>으로 날짜를 진행하면 그날의 경기 결과와 뉴스가 쌓입니다.</p></Card>;
  const idx = dates.findIndex((d) => d.date === date);
  return (
    <div className="news-page">
      <aside className="news-dates">
        {months.map(([month, list]) => (
          <div key={month}>
            <div className="nd-month">{month.replace("-", "년 ")}월</div>
            {list.map((d) => (
              <button key={d.date} className={`nd ${d.date === date ? "on" : ""}`} onClick={() => setDate(d.date)}>
                <span>{formatDate(d.date).slice(5)}</span>
                <span className="nd-badges">{d.mine > 0 && <i className="nd-mine" title="우리 팀 소식">우리 {d.mine}</i>}<em>{d.count}</em></span>
              </button>
            ))}
          </div>
        ))}
      </aside>
      <div className="col" style={{ gap: 12, minWidth: 0 }}>
        <div className="news-head">
          <button className="small" disabled={idx >= dates.length - 1} onClick={() => setDate(dates[idx + 1].date)}>‹ 이전</button>
          <h2>{date ? formatDate(date) : ""} 소식</h2>
          <button className="small" disabled={idx <= 0} onClick={() => setDate(dates[idx - 1].date)}>다음 ›</button>
          <span className="spacer" />
          <div className="seg-light">
            <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>전체</button>
            <button className={filter === "mine" ? "on" : ""} onClick={() => setFilter("mine")}>우리 팀</button>
          </div>
        </div>
        {date && <Card><DayNews date={date} filter={filter} /></Card>}
      </div>
    </div>
  );
}

/** 홈 화면용: 가장 최근 날짜의 주요 헤드라인 몇 개 */
export function LatestHeadlines({ limit = 4 }: { limit?: number }) {
  const { go } = useApp();
  const { data: dates } = useApi<{ date: string }[]>("/api/news/dates");
  const date = dates?.[0]?.date ?? null;
  const { data } = useApi<NewsDay>(date ? `/api/news?date=${date}` : null, [date]);
  if (!date || !data) return null;
  const top = [...data.news].sort((a, b) => Number(!!b.mine) - Number(!!a.mine) || b.importance - a.importance).slice(0, limit);
  if (top.length === 0) return null;
  return (
    <div className="latest-headlines">
      <div className="lh-head"><b>{formatDate(date)} 헤드라인</b><a onClick={() => go({ name: "news", date })}>뉴스 더 보기 →</a></div>
      {top.map((n) => <NewsItem key={n.id} n={n} />)}
    </div>
  );
}
