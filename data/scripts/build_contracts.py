"""
KBL Manager — 2026-27 시즌 선수 계약(보수/FA년도) 데이터 생성 스크립트

출력: data/processed/contracts_2026_27.csv

- source=reported : 2026-27 보수 협상 결과/FA 계약 보도로 확인된 값 (아래 REPORTED 표)
- source=estimated: 보도로 확인 불가능한 선수 → 아래 규칙으로 추정
    * 구단별 보도된 샐러리캡 소진율(TEAM_CAP_USAGE)에서 확인된 선수 보수를 뺀 잔여액을
      최근시즌 출전시간·득점·경력 기반 가치점수 비례로 배분 (최저 4,200만원, 구단 3위 보수 미만)
    * 2025 드래프트 신인은 지명순위별 신인 보수 테이블 적용
- fa_year: 계약이 끝나 FA가 되는 "비시즌 연도" (예: 2027 = 2026-27 시즌 종료 후 FA)
    * 보도된 계약기간이 있으면 그 값, 아니면 드래프트 1라운드 5시즌/2라운드 3시즌 규정으로 계산,
      이미 첫 FA를 지난 선수는 이름 기반 결정적 해시로 1~4년 잔여 추정
- 외국선수: 1년 계약(USD), 1옵션/2옵션 합계 100만 달러·1인 70만 달러 상한 준수
- 아시아쿼터: 1년 계약(USD)

실행: python3 data/scripts/build_contracts.py
"""
import csv
import hashlib
import json
import os

ROOT = os.path.join(os.path.dirname(__file__), "..")
CAP = 300000  # 만원 단위 (30억)
MIN_SALARY = 4200

# 만원 단위 보수 총액, fa_year(없으면 None → 추정)
REPORTED = {
    # 안양 정관장
    "변준형": (80000, 2029), "박지훈": (50000, None), "김종규": (40000, None),
    # 창원 LG
    "양홍석": (75000, None), "양준석": (40000, None), "유기상": (35000, None), "정인덕": (35000, None),
    # 울산 현대모비스
    "이승현": (65000, None), "서명진": (45000, None), "조한진": (30000, 2029), "정준원": (9000, 2027),
    # 수원 KT
    "김선형": (60000, 2028), "하윤기": (50000, None), "한희원": (27000, None), "서민수": (23000, 2029),
    # 서울 삼성 (이관희는 재정위원회 조정에서 선수 제시액 3억2천 결정)
    "이관희": (32000, 2027), "이대성": (30000, None), "한호빈": (25000, None), "이근휘": (23000, None),
    # 대구 한국가스공사
    "정성우": (40000, None), "박준영": (40000, 2029), "김국찬": (37000, None),
    # 원주 DB
    "강상재": (65000, None), "이정현": (40000, 2027), "정효근": (36000, 2028),
    # 고양 소노
    "이정현B": (72000, 2027), "최승욱": (42000, None), "이재도": (40000, None),
    # 서울 SK
    "안영준": (75000, None), "김낙현": (47000, 2030), "오재현": (29000, None),
    "오세근": (22000, 2027), "최원혁": (20000, 2029),
    # 부산 KCC (김동현은 조정 신청 후 구단안 7,500만원)
    "허훈": (80000, 2030), "허웅": (55000, None), "최준용": (45000, None), "김동현": (7500, None),
}

# 보도된 샐러리캡 소진율(%) — 일부 구단은 보도 미확인으로 추정치(est)
TEAM_CAP_USAGE = {
    "고양 소노 스카이거너스": 98.2,
    "창원 LG 세이커스": 90.4,
    "울산 현대모비스 피버스": 84.3,
    "서울 삼성 썬더스": 71.0,
    "대구 한국가스공사 페가수스": 75.0,
    "부산 KCC 이지스": 97.0,
    "원주 DB 프로미": 86.1,
    "서울 SK 나이츠": 88.0,       # est
    "안양 정관장 레드부스터스": 92.0,  # est
    "수원 KT 소닉붐": 90.0,       # est
}

FOREIGN_OPTION1 = {"헨리 엘런슨", "자밀 워니", "아셈 마레이", "숀 롱", "패리스 배스", "케베 알루마",
                   "스카티 제임스", "존 무니", "다리우스 베즐리", "케렘 칸터"}
FOREIGN_OVERRIDE = {"라건아"}


def h(name: str, mod: int) -> int:
    return int(hashlib.md5(name.encode("utf-8")).hexdigest(), 16) % mod


def main():
    players = {p["name"]: p for p in json.load(open(os.path.join(ROOT, "processed/players_enriched.json"), encoding="utf-8"))}
    roster = []
    seen = set()
    with open(os.path.join(ROOT, "processed/roster.csv"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["name"] in seen:
                continue
            seen.add(row["name"])
            roster.append(row)

    out = []
    by_team = {}
    for r in roster:
        by_team.setdefault(r["team"], []).append(r)

    for team, members in by_team.items():
        domestic_unknown = []
        known_total = 0
        known_values = []
        for r in members:
            name, nat = r["name"], r["nationality"]
            p = players.get(name)
            if name in FOREIGN_OVERRIDE or nat not in ("KOR", "PHI"):
                opt1 = name in FOREIGN_OPTION1
                usd = (60 + h(name, 11)) * 10000 if opt1 else (28 + h(name, 9)) * 10000
                out.append(dict(team=team, name=name, contract_type="foreign", salary_krw_10k="", salary_usd=usd,
                                fa_year=2027, source="estimated", note="1옵션" if opt1 else "2옵션"))
                continue
            if nat == "PHI":
                usd = (12 + h(name, 7)) * 10000
                out.append(dict(team=team, name=name, contract_type="asia", salary_krw_10k="", salary_usd=usd,
                                fa_year=2027 + h(name, 2), source="estimated", note="아시아쿼터"))
                continue
            if name in REPORTED:
                sal, fa = REPORTED[name]
                known_total += sal
                known_values.append(sal)
                out.append(dict(team=team, name=name, contract_type="domestic", salary_krw_10k=sal, salary_usd="",
                                fa_year=fa if fa else estimate_fa_year(name, p), source="reported",
                                note="" if fa else "fa_year 추정"))
            else:
                domestic_unknown.append(r)

        target = CAP * TEAM_CAP_USAGE[team] / 100
        third = sorted(known_values, reverse=True)[2] if len(known_values) >= 3 else 30000
        ceiling = min(third - 1000, 26000)

        rookies, others = [], []
        for r in domestic_unknown:
            p = players.get(r["name"])
            if p and (p.get("draftYear") == 2025 or (p["seasons"] and p["seasons"][0]["season"] == "2025-2026"
                                                     and len(p["seasons"]) == 1 and p.get("ageAtSeasonStart", 30) <= 24)):
                rookies.append(r)
            else:
                others.append(r)

        rookie_total = 0
        for r in rookies:
            p = players.get(r["name"])
            pick = p["draftInfo"].get("overallPick") if p and p["draftInfo"]["kind"] == "picked" else None
            sal = rookie_salary(pick)
            rookie_total += sal
            out.append(dict(team=team, name=r["name"], contract_type="domestic", salary_krw_10k=sal, salary_usd="",
                            fa_year=estimate_fa_year(r["name"], p), source="estimated", note="신인 보수 테이블"))

        remaining = max(0, target - known_total - rookie_total)
        scores = {r["name"]: value_score(players.get(r["name"])) for r in others}
        assigned = {n: MIN_SALARY for n in scores}
        pool = remaining - MIN_SALARY * len(scores)
        # 상한(ceiling)에 걸린 선수 몫은 나머지에게 재분배 (3회 반복이면 충분히 수렴)
        for _ in range(3):
            free = [n for n in scores if assigned[n] < ceiling]
            tot = sum(scores[n] for n in free) or 1
            leftover = 0
            for n in free:
                add = pool * scores[n] / tot
                new = assigned[n] + add
                if new > ceiling:
                    leftover += new - ceiling
                    new = ceiling
                assigned[n] = new
            pool = leftover
            if pool <= 1:
                break
        for r in others:
            p = players.get(r["name"])
            sal = int(round(assigned[r["name"]] / 100.0) * 100)
            sal = max(MIN_SALARY, sal)
            out.append(dict(team=team, name=r["name"], contract_type="domestic", salary_krw_10k=sal, salary_usd="",
                            fa_year=estimate_fa_year(r["name"], p), source="estimated", note="구단 소진율 기반 추정"))

    # 외국선수 2명 합계 100만 달러 상한: 2옵션 보수를 남은 한도 안으로 조정
    for team in by_team:
        fs = [x for x in out if x["team"] == team and x["contract_type"] == "foreign"]
        total = sum(x["salary_usd"] for x in fs)
        if total > 1000000:
            opt2 = min(fs, key=lambda x: x["salary_usd"])
            opt2["salary_usd"] -= total - 1000000

    out.sort(key=lambda x: (x["team"], x["contract_type"], -(int(x["salary_krw_10k"] or 0)), -(int(x["salary_usd"] or 0))))
    path = os.path.join(ROOT, "processed/contracts_2026_27.csv")
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["team", "name", "contract_type", "salary_krw_10k", "salary_usd", "fa_year", "source", "note"])
        w.writeheader()
        w.writerows(out)

    for team in by_team:
        tot = sum(int(x["salary_krw_10k"] or 0) for x in out if x["team"] == team)
        usd = sum(int(x["salary_usd"] or 0) for x in out if x["team"] == team and x["contract_type"] == "foreign")
        print(f"{team}: 국내 {tot/10000:.2f}억 ({tot/CAP*100:.1f}%), 외국 ${usd:,}")
    print(f"wrote {len(out)} rows -> {path}")


def rookie_salary(pick):
    if pick is None:
        return MIN_SALARY
    if pick <= 10:
        return 10000 - (pick - 1) * 400   # 1순위 1억 ~ 10순위 6,400만
    return max(MIN_SALARY, 5000 - (pick - 11) * 100)


def draft_year_of(p):
    if not p:
        return None
    dy = p.get("draftYear")
    if isinstance(dy, int):
        return dy
    if p["seasons"]:
        return int(p["seasons"][0]["season"][:4])
    return None


def estimate_fa_year(name, p):
    dy = draft_year_of(p)
    info = p["draftInfo"] if p else {"kind": "undrafted"}
    if info.get("kind") == "picked" and dy:
        first_fa = dy + (5 if info.get("overallPick", 99) <= 10 else 3)
        if first_fa >= 2027:
            return first_fa
    # 첫 FA 이후 계약 중 → 1~4년 잔여 (2027~2028에 가중)
    return [2027, 2027, 2028, 2028, 2029, 2030][h(name, 6)]


def value_score(p):
    if not p or not p["seasons"]:
        return 0.15
    s = p["seasons"][-1]
    recent = s["season"] >= "2024-2025"
    minutes = s.get("Min", 0) if recent else s.get("Min", 0) * 0.5
    pts = s.get("PTS", 0) if recent else s.get("PTS", 0) * 0.5
    exp = min(len(p["seasons"]), 10) / 10
    return max(0.15, (minutes / 30) ** 1.6 + (pts / 12) ** 1.4 + exp * 0.4)


if __name__ == "__main__":
    main()
