import { useState } from "react";
import { useApi, Loading, ErrorBox, Card, Bar, TeamLink, useApp } from "./common";
import { api, krw, usd } from "../api";
import type { Payroll } from "../api";

export function SalaryCapView() {
  const { data, error } = useApi<{ rules: any; teams: (Payroll & { id: number; name: string })[] }>("/api/salary-cap");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const r = data.rules;
  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title="KBL 샐러리캡 규정 (2026-27)">
        <ul className="small">
          <li>국내선수 샐러리캡 <b>{krw(r.domesticCap)}</b> (보수 총액 = 연봉 + 인센티브), 최소 소진율 {r.minCapRatio * 100}%</li>
          <li>최저 보수 {krw(r.minSalary)}, 국내선수 등록 최대 {r.maxDomesticRoster}명</li>
          <li>외국선수 2명 연봉 합계 {usd(r.foreignTotalCapUsd)}, 1인 최대 $700,000 · 1·4쿼터 1명, 2·3쿼터 2명 출전</li>
          <li>아시아쿼터 1명 (국내선수 취급, 출전 제한 없음, 게임 내 연봉 상한 {usd(r.asiaCapUsd)})</li>
          <li>외부 FA 영입은 30억 이하만 가능, 기존 선수 재계약·연봉협상은 {krw(r.softCapLimit)}까지 허용(초과분 사치세)</li>
          <li>FA 보상(2026 개정): 직전 보수 30위 이내 → 보수 100% 또는 보상선수+25%, 31~40위 → 50%, 41위 이하 없음</li>
        </ul>
      </Card>
      <Card title="구단별 보수 현황">
        <table>
          <thead><tr><th>구단</th><th className="num">국내 보수 총액</th><th style={{ width: 200 }}>소진율</th><th className="num">국내</th><th className="num">외국 연봉</th><th className="num">아시아쿼터</th></tr></thead>
          <tbody>
            {[...data.teams].sort((a, b) => b.domesticTotal - a.domesticTotal).map((t) => {
              const pct = Math.round(t.usageRatio * 1000) / 10;
              return (
                <tr key={t.id}>
                  <td><TeamLink id={t.id} name={t.name} /></td><td className="num">{krw(t.domesticTotal)}</td>
                  <td><div className="row small" style={{ gap: 6 }}><div style={{ width: 120 }}><Bar value={pct} color={pct > 100 ? "red" : pct < 70 ? "orange" : "green"} /></div>{pct}%</div></td>
                  <td className="num">{t.domesticCount}명</td><td className="num">{usd(t.foreignTotalUsd)} ({t.foreignCount})</td><td className="num">{usd(t.asiaTotalUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small muted">2026-27 보수는 KBL 선수 등록 결과(보수 상위 선수·구단 소진율 보도)를 기준으로 하고, 보도되지 않은 선수는 구단 소진율과 기록으로 추정했습니다 (선수 페이지에 "보도 기준/추정치" 표시).</p>
      </Card>
    </div>
  );
}

export function NewGameView() {
  const { refresh, go } = useApp();
  const { data, error } = useApi<{ id: number; name: string; coach: string; style: string }[]>("/api/teams");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function start(teamId: number, name: string) {
    if (!confirm(`${name}(으)로 새 게임을 시작할까요? 현재 세이브는 초기화됩니다.`)) return;
    setBusy(true);
    try {
      await api("/api/new-game", { body: { teamId } });
      refresh();
      go({ name: "dashboard" });
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <Card title="새 게임 — 운영할 팀 선택 (2026-27 시즌)">
      <p className="muted small">선택한 팀의 전술·출전시간·훈련·계약을 직접 관리합니다. 나머지 9개 팀은 실제 감독 성향에 따라 AI가 운영합니다.</p>
      <ErrorBox error={err} />
      <div className="grid cols-3">
        {data.map((t) => (
          <div key={t.id} className="card tight">
            <b>{t.name}</b>
            <div className="small muted">{t.coach} 감독 · {t.style}</div>
            <button className="primary" style={{ marginTop: 8 }} disabled={busy} onClick={() => start(t.id, t.name)}>이 팀으로 시작</button>
          </div>
        ))}
      </div>
    </Card>
  );
}
