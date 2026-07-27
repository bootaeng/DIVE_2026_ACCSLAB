# -*- coding: utf-8 -*-
"""부산 여행 AI 어시스턴트 서비스 (RAG).

부산교통공사 × 짐캐리(캐리로그) 프로젝트용 관광 RAG HTTP 서비스.

처리 흐름
  관광 질문
    -> [내부 데이터] 질문에서 역명 감지 -> 백엔드 API(혼잡도·편의시설·락커·경로·운임 등)를
       근거 청크로 주입  (원본 파일에 없는 데이터를 프로젝트 보유 데이터로 대체)
    -> [웹 검색(선택)] LLM 검색질의 생성 -> Google 검색(Serper/CSE) -> 본문 수집
    -> NVIDIA Nemotron Embed 재랭킹 -> Llama 3.3 Nemotron 근거 인용 답변 생성

환경 변수
    NVIDIA_API_KEY          (필수) NVIDIA NIM API 키
    SERPER_API_KEY          (선택) 웹 검색 활성화
    GOOGLE_CUSTOM_SEARCH_API_KEY / GOOGLE_CUSTOM_SEARCH_CX (선택, Serper 대안)
    BACKEND_URL             (기본 http://localhost:3000) 내부 데이터 API
    PORT                    (기본 3200)
"""
from __future__ import annotations

import html
import json
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

from flask import Flask, jsonify, request

try:
    from dotenv import load_dotenv  # backend/.env 재사용
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

from openai import OpenAI

NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
ANSWER_MODEL = "openai/gpt-oss-120b"
# 답변 모델 폴백 순서 — NVIDIA 쪽 특정 모델이 DEGRADED/장애일 때 자동으로 다음 모델 사용
ANSWER_MODEL_FALLBACKS = [
    "openai/gpt-oss-120b",
    "meta/llama-3.3-70b-instruct",
    "nvidia/llama-3.3-nemotron-super-49b-v1.5",
]
EMBEDDING_MODEL = "nvidia/nv-embed-v1"
SERPER_URL = "https://google.serper.dev/search"
GOOGLE_CSE_URL = "https://www.googleapis.com/customsearch/v1"
NAVER_BLOG_URL = "https://openapi.naver.com/v1/search/blog.json"
NAVER_LOCAL_URL = "https://openapi.naver.com/v1/search/local.json"
BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:3000")

# 부산 컨텍스트 공식 도메인
OFFICIAL_DOMAINS = (
    "visitbusan.net", "busan.go.kr", "humetro.busan.kr", "bto.or.kr",
    "knto.or.kr", "korea.net", "gov.kr", "go.kr",
)
NOISE_TAGS = {"script", "style", "nav", "footer", "header", "aside", "form", "svg", "noscript"}
NOISE_HINTS = ("advert", "banner", "menu", "nav", "comment", "reply", "social", "cookie", "footer")
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str
    published_at: str | None
    official: bool


@dataclass
class Chunk:
    text: str
    url: str
    title: str
    official: bool
    published_at: str | None
    retrieved_at: str
    source_kind: str = "page"  # page | serp_snippet | internal_data
    embedding_score: float = 0.0
    freshness_score: float = 0.0
    final_score: float = 0.0


class TextExtractor(HTMLParser):
    """광고·메뉴·댓글을 제외한 HTML 본문을 수집한다. (원본 그대로)"""

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.ignored_depth = 0
        self.stack: list[bool] = []

    def handle_starttag(self, tag, attrs):
        attr_text = " ".join(value or "" for _, value in attrs).lower()
        ignored = self.ignored_depth > 0 or tag in NOISE_TAGS or any(h in attr_text for h in NOISE_HINTS)
        if tag not in VOID_TAGS:
            self.stack.append(ignored)
        if ignored and tag not in VOID_TAGS:
            self.ignored_depth += 1

    def handle_endtag(self, tag):
        ignored = self.stack.pop() if self.stack else False
        if ignored and self.ignored_depth:
            self.ignored_depth -= 1
        if tag in {"p", "div", "li", "section", "article", "br", "h1", "h2", "h3"} and not self.ignored_depth:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.ignored_depth:
            self.parts.append(data)

    def text(self) -> str:
        return re.sub(r"\s+", " ", html.unescape(" ".join(self.parts))).strip()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def request_json(url: str, *, method: str, headers: dict, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if method == "POST" and payload is not None else None
    if method == "GET" and payload:
        url = f"{url}?{urlencode(payload)}"
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:300]}") from exc
    except (URLError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"request failed: {exc}") from exc


def backend_get(path: str) -> Any:
    """프로젝트 Node 백엔드에서 내부 데이터 조회 (1회 재시도)."""
    for attempt in range(2):
        try:
            with urlopen(Request(f"{BACKEND_URL}{path}"), timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            if attempt == 0:
                continue
            print(f"[경고] 내부 데이터 조회 실패 {path}: {exc}")
    return None


def is_official_url(url: str) -> bool:
    host = urlparse(url).netloc.lower().split(":")[0]
    return any(host == d or host.endswith("." + d) for d in OFFICIAL_DOMAINS)


def canonical_url(url: str) -> str:
    p = urlparse(url)
    return urlunparse((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"), "", "", ""))


def _strip_naver_tags(value: str) -> str:
    return html.unescape(re.sub(r"</?b>", "", str(value or ""))).strip()


class GoogleSearchClient:
    """SERPER_API_KEY > Google Custom Search > 네이버 검색 API 순으로 사용. 모두 없으면 비활성."""

    def __init__(self) -> None:
        self.serper_key = os.environ.get("SERPER_API_KEY")
        self.google_key = os.environ.get("GOOGLE_CUSTOM_SEARCH_API_KEY")
        self.google_cx = os.environ.get("GOOGLE_CUSTOM_SEARCH_CX")
        self.naver_id = os.environ.get("NAVER_CLIENT_ID")
        self.naver_secret = os.environ.get("NAVER_CLIENT_SECRET")
        if self.serper_key:
            self.provider = "serper"
        elif self.google_key and self.google_cx:
            self.provider = "google_custom_search"
        elif self.naver_id and self.naver_secret:
            self.provider = "naver"
        else:
            self.provider = None  # 내부 데이터 전용 모드

    def _naver_headers(self) -> dict:
        return {"X-Naver-Client-Id": self.naver_id, "X-Naver-Client-Secret": self.naver_secret}

    def search(self, query: str) -> list[SearchResult]:
        if self.provider == "serper":
            resp = request_json(SERPER_URL, method="POST",
                                headers={"X-API-KEY": self.serper_key, "Content-Type": "application/json"},
                                payload={"q": query, "gl": "kr", "hl": "ko", "num": 8})
            items = resp.get("organic", [])
        elif self.provider == "google_custom_search":
            resp = request_json(GOOGLE_CSE_URL, method="GET", headers={},
                                payload={"key": self.google_key, "cx": self.google_cx, "q": query, "num": 8, "gl": "kr", "lr": "lang_ko"})
            if "error" in resp:
                raise RuntimeError(f"Google CSE error: {resp['error']}")
            items = resp.get("items", [])
        elif self.provider == "naver":
            # 네이버 블로그 검색 — 후기·여행 정보용 (title/description은 <b> 태그 포함)
            resp = request_json(NAVER_BLOG_URL, method="GET", headers=self._naver_headers(),
                                payload={"query": query, "display": 8, "sort": "sim"})
            items = [
                {"title": _strip_naver_tags(it.get("title")), "link": it.get("link"),
                 "snippet": _strip_naver_tags(it.get("description")), "date": it.get("postdate")}
                for it in resp.get("items", [])
            ]
        else:
            return []
        results = []
        for item in items if isinstance(items, list) else []:
            url = item.get("link")
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                continue
            published = item.get("date") or item.get("publishedDate")
            results.append(SearchResult(str(item.get("title", "")), url, str(item.get("snippet", "")),
                                        str(published) if published else None, is_official_url(url)))
        return results

    def naver_local_chunks(self, query: str, retrieved_at: str) -> list[Chunk]:
        """네이버 지역검색 — 실제 등록 업체(상호·카테고리·주소)를 하나의 근거 청크로 묶는다.
        맛집·카페 등 장소 추천 질문에서 존재하지 않는 가게를 지어내는 것을 막는 근거가 된다."""
        if not (self.naver_id and self.naver_secret):
            return []
        try:
            resp = request_json(NAVER_LOCAL_URL, method="GET", headers=self._naver_headers(),
                                payload={"query": query, "display": 5, "sort": "random"})
        except RuntimeError as exc:
            print(f"[경고] 네이버 지역검색 실패({query}): {exc}")
            return []
        places = []
        for it in resp.get("items", []):
            name = _strip_naver_tags(it.get("title"))
            if not name:
                continue
            addr = it.get("roadAddress") or it.get("address") or ""
            places.append(f"{name} (분류: {it.get('category', '미상')}, 주소: {addr})")
        if not places:
            return []
        return [Chunk(
            text=f"'{query}' 네이버 지역검색 등록 업체 {len(places)}곳: " + " / ".join(places),
            url=f"https://map.naver.com/p/search/{quote(query)}",
            title=f"네이버 지역검색: {query}",
            official=False, published_at=str(date.today()), retrieved_at=retrieved_at,
            source_kind="naver_local",
        )]


# ─────────────────────────────────────────────────────────────────
# 내부 데이터 근거 주입 — 원본 파일에 없던 부분
# 질문에서 역명을 감지해 프로젝트 보유 데이터를 근거 청크로 변환한다
# ─────────────────────────────────────────────────────────────────
_station_cache: dict[str, Any] = {}


def get_stations() -> list[dict]:
    # 빈 결과는 캐시하지 않는다 — 백엔드가 늦게 뜨거나 일시 실패해도 다음 요청에서 재시도
    if not _station_cache.get("stations"):
        data = backend_get("/api/stations")
        _station_cache["stations"] = (data or {}).get("stations", [])
    return _station_cache["stations"]


def detect_stations(question: str) -> list[dict]:
    """질문에 등장하는 역명을 긴 이름 우선으로 최대 2개 감지."""
    q = question.replace(" ", "")
    found, seen = [], set()
    for s in sorted(get_stations(), key=lambda x: -len(x["name"])):
        base = re.sub(r"\([^)]*\)", "", s["name"]).replace(" ", "")
        if len(base) < 2 or base in seen:
            continue
        if base in q:
            seen.add(base)
            found.append(s)
        if len(found) >= 2:
            break
    return found


def _peak_hours(bucket: dict) -> str:
    merged: dict[str, int] = {}
    for kind in ("승차", "하차"):
        for hour, val in (bucket.get(kind) or {}).items():
            merged[hour] = merged.get(hour, 0) + int(val or 0)
    top = sorted(merged.items(), key=lambda kv: -kv[1])[:3]
    return ", ".join(f"{h}({v:,}명)" for h, v in top)


def build_internal_chunks(question: str, retrieved_at: str) -> list[Chunk]:
    chunks: list[Chunk] = []

    def add(title: str, text: str, path: str) -> None:
        if text and len(text) > 20:
            chunks.append(Chunk(text=text[:1200], url=f"{BACKEND_URL}{path}", title=title,
                                official=True, published_at=str(date.today()), retrieved_at=retrieved_at,
                                source_kind="internal_data"))

    matched = detect_stations(question)

    for s in matched:
        name = re.sub(r"\([^)]*\)", "", s["name"]).strip()
        # ① 시간대별 혼잡도 (부산교통공사 승하차 데이터 2025+2026 집계)
        cong = backend_get(f"/api/congestion/{quote(name)}")
        if cong and cong.get("weekday"):
            add(f"{name}역 시간대별 혼잡도 (부산교통공사 승하차 데이터)",
                f"{name}역의 평일 혼잡 시간대 상위: {_peak_hours(cong['weekday'])}. "
                f"주말 혼잡 시간대 상위: {_peak_hours(cong.get('weekend') or {})}. "
                f"(2025년 연간 + 2026년 1~5월 실측 승하차 인원 평균)",
                f"/api/congestion/{name}")
        # ② 역사 편의시설 (엘리베이터·에스컬레이터·물품보관함·키오스크)
        lockers = s.get("lockers") or []
        locker_txt = ""
        if lockers:
            lk = lockers[0]
            locker_txt = (f" 물품보관함: {lk.get('상세위치', '')} 위치, "
                          f"소형 {lk.get('소형(개수)', 0)}·중형 {lk.get('중형(개수)', 0)}·대형 {lk.get('대형(개수)', 0)}·특대형 {lk.get('특대형(개수)', 0)}개, "
                          f"요금 {lk.get('이용요금', '')} (운영사 {lk.get('운영사', '')}).")
        # 시설 수 0은 '없음'이 아니라 데이터 미등록일 수 있다 — 장애인 편의시설
        # OpenAPI(③) 수치와 모순된 답변("엘리베이터는 없지만 외부 3대")을 막기 위해
        # 확인된(0이 아닌) 시설만 서술하고, 없으면 판단을 ③ 근거로 넘긴다.
        fac_parts = []
        if s.get("elevators"):
            fac_parts.append(f"엘리베이터 {len(s['elevators'])}대")
        if s.get("escalators"):
            fac_parts.append(f"에스컬레이터 {len(s['escalators'])}대")
        if s.get("kiosks"):
            fac_parts.append(f"교통약자 내비게이션 키오스크 {len(s['kiosks'])}대")
        fac_txt = ", ".join(fac_parts) if fac_parts else "승강설비는 이 데이터에 미등록(대수는 장애인 편의시설 근거를 따를 것)"
        add(f"{name}역 편의시설 정보 (부산교통공사 데이터)",
            f"{name}역({s.get('line', '')}) 시설 현황 — {fac_txt}."
            f"{locker_txt} 주소: {s.get('address', '')}. 환승: {s.get('transferLines') or '없음'}.",
            "/api/stations")
        # ③ 장애인 편의시설 (부산도시철도 OpenAPI)
        acc = backend_get(f"/api/accessibility/{quote(name)}")
        fac = (acc or {}).get("facilities")
        if fac:
            add(f"{name}역 장애인 편의시설 (부산도시철도 OpenAPI)",
                f"{name}역 장애인 편의시설 — 엘리베이터 내부 {fac['elevatorIn']}대/외부 {fac['elevatorOut']}대, "
                f"휠체어리프트 내부 {fac['wheelchairLiftIn']}/외부 {fac['wheelchairLiftOut']}, "
                f"에스컬레이터 {fac['escalator']}대, 점자유도로 {fac['blindRoad']}, 외부경사로 {fac['outerRamp']}, "
                f"장애인화장실 {fac['toilet']}개소({fac.get('toiletType', '')}).",
                f"/api/accessibility/{name}")
        # ④ 문화행사 (부산도시철도 OpenAPI)
        events = ((backend_get(f"/api/culture-events/{quote(name)}") or {}).get("events") or [])[:3]
        if events:
            ev_txt = " / ".join(f"{e['eventContent']} ({e['genre']}, {e['eventDate'][:21]}, {e['eventTime']})" for e in events)
            add(f"{name}역 문화행사 (부산도시철도 OpenAPI)", f"{name}역 등록 문화행사: {ev_txt}.", f"/api/culture-events/{name}")

    # ⑤ 두 역이 감지되면 경로·운임·짐 비교까지
    if len(matched) >= 2:
        route = backend_get(f"/api/route?start={matched[0]['id']}&end={matched[1]['id']}")
        if route and route.get("path"):
            fare, li = route.get("fare") or {}, route.get("luggageImpact") or {}
            n1 = re.sub(r"\([^)]*\)", "", matched[0]["name"])
            n2 = re.sub(r"\([^)]*\)", "", matched[1]["name"])
            transfers = sum(1 for n in route["path"] if n.get("edgeType") == "transfer")
            lug = ""
            if li:
                lug = (f" 대형 수하물 소지 시 이동 부하 지수 {li['withLuggage']['conflictScore']}, "
                       f"빈손(짐캐리 배송) 시 {li['handsFree']['conflictScore']}로 {li.get('scoreDropPct', 0)}% 감소.")
            add(f"{n1}→{n2} 도시철도 경로 (배리어프리 라우팅 엔진)",
                f"{n1}역에서 {n2}역까지 도시철도 경로: 총 {len(route['path'])}개 역 경유, 환승 {transfers}회, "
                f"이동거리 약 {fare.get('distance', '?')}km ({fare.get('zone', '?')}구간). "
                f"운임: 교통카드 어른 {fare.get('adult', 0):,}원·청소년 {fare.get('youth', 0):,}원, QR승차권 어른 {(fare.get('qr') or {}).get('adult', 0):,}원. "
                f"자원 충돌 점수 {route['conflict']['score']}/100 ({route['conflict']['level']}).{lug}",
                "/api/route")

    # ⑥ 짐 보관·배송 관련 질문이면 짐배송 흐름 통계 주입
    if re.search(r"짐|캐리어|수하물|보관|배송", question):
        flow = (backend_get("/api/luggage-flow") or {}).get("summary")
        if flow and flow.get("directions"):
            d0 = flow["directions"][0]
            hubs = ", ".join(f"{h['hub']} {round(h['hubShare'] * 100, 1)}%" for h in flow.get("delivery", []))
            add("부산 짐배송 이동 흐름 통계 (짐캐리 2025년 실데이터)",
                f"짐캐리 부산 짐배송 통계(2025년 연간): 거점→숙소 배송이 전체의 {round(d0['share'] * 100, 1)}% "
                f"(내국인 {round(d0['domestic'] * 100, 1)}%, 외국인 {round(d0['foreign'] * 100, 1)}%). "
                f"출발 거점 비중: {hubs}. 짐캐리 거점은 부산역·김해국제공항·부산항국제여객터미널이며, "
                f"당일 접수 시 숙소로 짐을 배송해 빈손 관광이 가능하다.",
                "/api/luggage-flow")

    return chunks


# ─────────────────────────────────────────────────────────────────
# RAG 파이프라인
# ─────────────────────────────────────────────────────────────────

def _chat(nvidia: OpenAI, messages: list[dict], *, temperature: float, max_tokens: int) -> str:
    """답변 모델 호출 — 첫 모델이 DEGRADED/오류면 폴백 목록의 다음 모델로 재시도.
    gpt-oss 계열은 reasoning_effort=low로 추론 토큰 낭비를 줄인다."""
    last_exc = None
    for model in ANSWER_MODEL_FALLBACKS:
        try:
            kwargs = dict(model=model, temperature=temperature, max_tokens=max_tokens, messages=messages)
            if "gpt-oss" in model:
                kwargs["extra_body"] = {"reasoning_effort": "low"}
            completion = nvidia.chat.completions.create(**kwargs)
            content = (completion.choices[0].message.content or "").strip()
            if content:
                return content
            last_exc = RuntimeError(f"{model}: 빈 응답")
        except Exception as exc:
            last_exc = exc
            print(f"[경고] 답변 모델 {model} 실패 → 다음 모델 시도: {str(exc)[:120]}", flush=True)
    raise last_exc or RuntimeError("모든 답변 모델 호출 실패")


def generate_queries(nvidia: OpenAI, question: str) -> list[str]:
    prompt = f"""다음 부산 여행/도시철도 질문에 답하기 위한 한국어 Google 검색 질의 2개를 JSON 배열로만 반환하세요.
공식 관광·지자체·부산교통공사 정보 확인용 질의를 적어도 하나 포함하세요.
질문: {question}"""
    raw = _chat(nvidia, [
        {"role": "system", "content": "You generate concise Korean web search queries."},
        {"role": "user", "content": prompt},
    ], temperature=0.15, max_tokens=200)
    match = re.search(r"\[[\s\S]*?\]", raw)
    try:
        generated = json.loads(match.group(0) if match else raw)
    except json.JSONDecodeError:
        generated = []
    queries = [q.strip() for q in generated if isinstance(q, str) and q.strip()]
    fallback = [f"부산 {question}", f"부산 {question} 공식"]
    return list(dict.fromkeys(queries + fallback))[:2]


def select_documents(results: Iterable[SearchResult], limit: int = 4) -> list[SearchResult]:
    unique: dict[str, SearchResult] = {}
    for r in results:
        key = canonical_url(r.url)
        if key and key not in unique:
            r.url = key
            unique[key] = r
    return sorted(unique.values(), key=lambda x: (not x.official, x.title == ""))[:limit]


def fetch_html(url: str) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; BusanTravelRAG/1.0)"})
    try:
        with urlopen(req, timeout=15) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except (HTTPError, URLError, ValueError) as exc:
        raise RuntimeError(f"본문 수집 실패 ({url}): {exc}") from exc


def split_chunks(text: str, minimum: int = 700, maximum: int = 1100) -> list[str]:
    sentences = re.split(r"(?<=[.!?。！？])\s+", text)
    chunks, current = [], ""
    for sentence in (s.strip() for s in sentences if s.strip()):
        if current and len(current) + len(sentence) + 1 > maximum:
            chunks.append(current)
            current = ""
        current = f"{current} {sentence}".strip()
        if len(current) >= minimum:
            chunks.append(current)
            current = ""
    if current:
        if chunks and len(current) < minimum:
            chunks[-1] = f"{chunks[-1]} {current}"
        else:
            chunks.append(current)
    return chunks


def collect_web_chunks(results: list[SearchResult], retrieved_at: str) -> list[Chunk]:
    chunks = []
    for r in results:
        try:
            parser = TextExtractor()
            parser.feed(fetch_html(r.url))
            for text in split_chunks(parser.text())[:4]:
                chunks.append(Chunk(text, r.url, r.title, r.official, r.published_at, retrieved_at))
        except RuntimeError:
            snippet = f"{r.title}. {r.snippet}".strip()
            if len(snippet) >= 40:
                chunks.append(Chunk(snippet, r.url, r.title, r.official, r.published_at, retrieved_at, "serp_snippet"))
    return chunks


def parse_date_value(value: str | None) -> date | None:
    if not value:
        return None
    m = re.search(r"(20\d{2})\D{0,4}(\d{1,2})?\D{0,4}(\d{1,2})?", value)
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2) or 1), int(m.group(3) or 1))
    except ValueError:
        return None


def freshness_score(value: str | None) -> float:
    ts = parse_date_value(value)
    if not ts:
        return 0.35
    return max(0.0, 1.0 - max(0, (date.today() - ts).days) / (365 * 3))


def cosine(a: list[float], b: list[float]) -> float:
    num = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return num / (na * nb) if na and nb else 0.0


def rank_chunks(nvidia: OpenAI, question: str, chunks: list[Chunk], top_k: int) -> list[Chunk]:
    if not chunks:
        return []
    if len(chunks) <= top_k:
        # 근거가 적으면 임베딩 재랭킹 생략 (내부 데이터 전용 모드 등)
        for c in chunks:
            c.freshness_score = freshness_score(c.published_at)
            c.final_score = 1.0 if c.source_kind == "internal_data" else 0.5
        return sorted(chunks, key=lambda c: -c.final_score)
    response = nvidia.embeddings.create(model=EMBEDDING_MODEL, input=[question] + [c.text for c in chunks])
    vectors = [item.embedding for item in response.data]
    for c, v in zip(chunks, vectors[1:]):
        c.embedding_score = cosine(vectors[0], v)
        c.freshness_score = freshness_score(c.published_at)
        c.final_score = 0.20 * float(c.official) + 0.15 * c.freshness_score + 0.65 * c.embedding_score
        if c.source_kind == "serp_snippet":
            c.final_score -= 0.20
        if c.source_kind == "internal_data":
            c.final_score += 0.15  # 프로젝트 보유 실데이터 우대
        if c.source_kind == "naver_local":
            c.final_score += 0.10  # 실제 등록 업체 정보 우대 (장소 실존 근거)
    return sorted(chunks, key=lambda c: -c.final_score)[:top_k]


def generate_answer(nvidia: OpenAI, question: str, evidence: list[Chunk]) -> str:
    context = "\n\n".join(
        f"[근거 {i}] 제목: {c.title}\nURL: {c.url}\n근거 종류: {c.source_kind}\n공식 출처: {'예' if c.official else '아니오'}\n날짜: {c.published_at or '미확인'}\n본문: {c.text}"
        for i, c in enumerate(evidence, 1)
    ) or "(제공된 근거 없음)"
    prompt = f"""부산 여행/도시철도 질문에 한국어로 친절하게 답하는 여행 컨시어지입니다. 아래 규칙을 따르세요.
- 먼저 질문의 핵심 의도(맛집 추천, 경로, 요금 등)에 바로 답하세요.
- 아래 근거에 답이 있으면 근거를 우선 사용하고, 각 핵심 주장 뒤에 [근거 번호]를 붙이세요.
- 근거에 없는 맛집·카페·관광지 등 일상적인 여행 질문은 당신이 아는 부산 여행 지식으로 추천해도 됩니다. 단 ① 실제로 널리 알려진 장소만 추천하고 실존이 불확실한 곳은 지어내지 마세요. ② 해당 부분 앞이나 뒤에 "※ 일반 여행 정보 — 방문 전 최신 영업 여부를 확인하세요"를 붙이세요. ③ 영업시간·가격은 단정하지 마세요.
- 도시철도 혼잡도·시설·보관함·운임·짐배송·노선(몇 호선)·환승·소요시간은 근거(internal_data = 부산교통공사·짐캐리 공식 실데이터)에 있는 내용만 사용하세요. 근거에 없으면 "도시철도로 이동 가능"처럼 노선 번호·시간을 빼고 서술하세요.
- 질문과 직접 관련 없는 근거는 나열하지 마세요. 질문에 실제로 도움이 되는 근거만 골라 간결히 안내하세요.
- 서로 다른 근거의 수치가 충돌하면(예: 엘리베이터 대수) 더 상세한 근거 하나만 따르고, "없지만 3대 있다"처럼 모순되게 서술하지 마세요.
- 근거 종류가 naver_local이면 네이버 지역검색에 등록된 실제 업체 목록(상호·분류·주소)입니다. 장소 추천 시 이 목록의 업체를 우선 추천하고 상호·주소를 그대로 인용하세요. 단 영업시간·가격·맛 평가는 단정하지 마세요.
- 근거 종류가 serp_snippet이면 검색 요약문이므로 확정 근거로 사용하지 마세요.
- 반드시 표준 한국어로만 작성하세요. 한자·일본어·중국어 문자를 섞지 마세요. 질문이 사투리여도 자연스러운 표준어로 답하면 됩니다.
- 무거운 짐이 있는 여행자라면 짐캐리 배송/역 물품보관함 활용을 자연스럽게 안내하세요.
- 답변 본문만 바로 출력하세요. 질문을 되풀이하거나 "질문:", "답변:" 같은 머리말을 붙이지 마세요.

질문: {question}

{context}"""
    return _chat(nvidia, [
        {"role": "system", "content": "You are a careful Busan travel concierge. Cite supplied evidence when available; for casual travel questions you may add well-known, clearly-labeled general knowledge."},
        {"role": "user", "content": prompt},
    ], temperature=0.25, max_tokens=1200) or "응답 생성에 실패했습니다."


# ─────────────────────────────────────────────────────────────────
# 페르소나 기반 여행 일정 생성 — sdbwork/JimCarry_Busan 모듈을 그대로 사용
# (persona.py: 짐 무게·짐 처리 상황·여행 스타일 → 컨시어지 페르소나 → 일자별 일정)
# + 이 프로젝트 보유 실데이터(락커 요금·혼잡 시간대·짐배송 흐름)를 컨텍스트로 주입
# ─────────────────────────────────────────────────────────────────
import sys as _sys

JIMCARRY_DIR = Path(__file__).resolve().parent.parent / "sdbwork" / "JimCarry_Busan"
_sys.path.insert(0, str(JIMCARRY_DIR))
from persona import (  # noqa: E402 — sdbwork 원본 모듈
    TravelerInput, build_persona, build_user_request,
    LUGGAGE_WEIGHT_OPTIONS, LUGGAGE_URGENCY_OPTIONS, TRAVEL_STYLE_OPTIONS,
)
from weather import get_busan_weather, format_for_persona  # noqa: E402 — 일자별 날씨 예보 (Open-Meteo)

PLAN_MODEL = "openai/gpt-oss-120b"  # JimCarry_Busan nvidia_client의 DEFAULT_MODEL
# 일정 생성용 — 리즈닝이 없는 순수 instruct 모델(추론이 max_tokens를 잡아먹어 표가 잘리는 문제 없음)
PLAN_MODEL_INSTRUCT = "meta/llama-3.3-70b-instruct"


# 주요 거점 간 도시철도 소요시간 참고표 — 경로 엔진(/api/route) 실측 기반, 1회 계산 후 캐시.
# LLM이 이동시간을 지어내지 않도록 근거 수치를 프롬프트에 제공한다.
_TRANSIT_HUBS = ["부산", "서면", "남포", "해운대", "광안", "센텀시티", "연산"]
_transit_table_cache: dict[str, str] = {}


def transit_time_table() -> str:
    if "text" in _transit_table_cache:
        return _transit_table_cache["text"]
    ids: dict[str, str] = {}
    for s in get_stations():
        base = re.sub(r"\([^)]*\)", "", s["name"]).strip()
        if base in _TRANSIT_HUBS and base not in ids and not s.get("supplementary"):
            ids[base] = s["id"]
    lines = []
    hubs = [h for h in _TRANSIT_HUBS if h in ids]
    for i, a in enumerate(hubs):
        for b in hubs[i + 1:]:
            route = backend_get(f"/api/route?start={ids[a]}&end={ids[b]}")
            path = (route or {}).get("path") or []
            if len(path) < 2:
                continue
            transfers = sum(1 for n in path if n.get("edgeType") == "transfer")
            ride_hops = max(1, len(path) - 1 - transfers)
            minutes = ride_hops * 2 + transfers * 4 + 4  # 역당 2분 + 환승 4분 + 대기 4분
            label_a = "부산역" if a == "부산" else f"{a}역"
            label_b = "부산역" if b == "부산" else f"{b}역"
            lines.append(f"{label_a}↔{label_b} 약 {minutes}분" + (f"(환승 {transfers}회)" if transfers else ""))
    text = " / ".join(lines)
    if text:
        _transit_table_cache["text"] = text
    return text


def build_plan_context(station: str) -> str:
    """일정 생성에 쓸 프로젝트 실데이터 컨텍스트 — persona.py의 '없는 시설을 지어내지 말라'
    원칙에 맞게, 확인된 보관함·혼잡도·짐캐리 거점 정보를 명시적으로 제공한다."""
    chunks = build_internal_chunks(f"{station}역에서 짐 보관하고 여행", now_iso())
    if not chunks:
        return ""
    lines = [f"- {c.title}: {c.text}" for c in chunks[:6]]
    return (
        "\n\n[확인된 실데이터 — 일정 속 짐 보관/배송 제안은 반드시 아래 정보를 근거로 사용하라]\n"
        + "\n".join(lines)
        + "\n(짐캐리 거점: 부산역·김해국제공항·부산항국제여객터미널. 위 데이터에 없는 보관함 위치·요금은 단정하지 말 것.)"
    )


app = Flask(__name__)


@app.post("/tour-plan")
def tour_plan():
    body = request.get_json(silent=True) or {}
    weight = body.get("weight") if body.get("weight") in LUGGAGE_WEIGHT_OPTIONS else "medium"
    urgency = body.get("urgency") if body.get("urgency") in LUGGAGE_URGENCY_OPTIONS else "now"
    styles = [s for s in (body.get("styles") or []) if s in TRAVEL_STYLE_OPTIONS]
    days = min(3, max(1, int(body.get("days") or 1)))
    station = re.sub(r"\([^)]*\)", "", str(body.get("station", "부산"))).strip() or "부산"
    HUB_LABELS = {"busan_station": "부산역", "gimhae_airport": "김해국제공항", "intl_terminal": "부산항국제여객터미널"}
    hub = HUB_LABELS.get(str(body.get("hub", "")))  # 도착 거점 (짐캐리 오피스) — 없으면 숙소 근처 역 기준
    end_hub = HUB_LABELS.get(str(body.get("endHub", "")))  # 여행 마침 거점 — 마지막 날 동선의 종착점
    companions = str(body.get("companions", "")).strip()
    note = str(body.get("note", "")).strip()
    travel_date = str(body.get("travelDate", "")).strip()
    if travel_date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", travel_date):
        travel_date = ""  # 형식이 틀리면 오늘부터로 처리
    existing_plan = str(body.get("plan", "")).strip()

    if not os.environ.get("NVIDIA_API_KEY"):
        return jsonify({"error": "NVIDIA_API_KEY가 설정되지 않았습니다. backend/.env에 추가 후 어시스턴트 서비스를 재시작하세요."}), 503

    # 당일치기(1일)는 숙소 개념이 없다 — 거점 기준으로 시작·종료
    day_trip = days == 1
    start_hub = hub or "부산역"
    # 도착 거점이 지정되면 여행 시작점 = 거점, 숙소 위치는 별도 안내
    if day_trip:
        start_area = f"{start_hub} (짐캐리 오피스)"
    else:
        start_area = f"{hub} (짐캐리 오피스)" if hub else f"{station}역"
    traveler = TravelerInput(
        luggage_weight=weight, luggage_urgency=urgency, travel_style=styles,
        travel_days=days, start_area=start_area, companions=companions,
        travel_date=travel_date, existing_plan=existing_plan,
    )
    if day_trip:
        day_note = (
            f"당일치기 여행이라 숙소가 없다. {start_hub}에 도착해 여정을 시작하고, "
            f"짐은 {start_hub}의 짐캐리 오피스·물품보관함에 맡기고 빈손으로 다녀라. "
            "숙소 체크인·체크아웃·숙소 배송은 절대 언급하지 말라."
        )
        if end_hub:
            day_note += (
                f" 일정 마지막은 {end_hub} 방향으로 마무리하고 그곳에서 부산을 떠난다."
                + (f" 짐을 맡긴 {start_hub}과 떠나는 {end_hub}이 다르므로, 짐을 찾아가는 동선을 일정 마지막에 포함하라." if end_hub != start_hub else f" 떠나기 전 {end_hub}에서 맡긴 짐을 수령하라.")
            )
        note = f"{note} {day_note}".strip() if note else day_note
    else:
        if hub:
            hub_note = (
                f"여행자는 {hub}에 도착해 여정을 시작하고, 숙소는 {station}역 인근이다. "
                f"도착 즉시 {hub} 짐캐리 오피스에서 짐을 '거점→숙소' 배송으로 보낸다(15시 이전 접수 → 숙소 프런트 16~19시 순차 도착). "
                f"이 배송 덕분에 여행 내내 짐을 들고 다니지 않으니, 물품보관함·무인보관함에 다시 맡기는 단계를 넣지 말라. "
                f"짐은 도착일 저녁 숙소에서 받고, 이후에는 숙소에 두면 된다."
            )
            note = f"{note} {hub_note}".strip() if note else hub_note
        if end_hub:
            end_note = (
                f"여행 마지막 날은 {end_hub}에서 부산을 떠난다. 마지막 날 일정은 숙소로 되돌아가지 말고 "
                f"{end_hub} 방향으로 자연스럽게 이동하며 마무리하고, 마지막 방문지는 {end_hub}에서 가까운 곳으로 골라라. "
                f"체크아웃(보통 11시)할 때 짐캐리 '숙소→거점' 배송을 접수하면(11시 이전 접수 → {end_hub} 매장 15시 도착) 짐이 {end_hub}에 먼저 가 있으므로, 마지막 날도 빈손으로 다니다가 떠나기 전 {end_hub}에서 수령한다. "
                f"이 경우에도 중간에 물품보관함에 다시 맡기는 단계는 넣지 말라. {end_hub} 도착·수령까지 여유 시간만 포함하라."
            )
            note = f"{note} {end_note}".strip() if note else end_note

    # 보관함 안내 — 당일치기(숙소 없음)에서만 짐캐리 무인보관함 이용. 1박 이상은 배송으로 처리되므로 보관함 언급 금지.
    if day_trip:
        locker_note = (
            "짐을 맡길 때는 짐캐리 무인보관함을 우선 안내하라. 짐캐리 무인보관함은 "
            "해운대(씨클라우드호텔 1층 로비), 원도심 남포·광복(롯데면세점 부산 8층 / KT&G 상상마당 부산 1층)에 있고 "
            "요금은 소형 2,000·중형 3,000·대형 4,000원(기본 4시간, 12시간마다 추가)이다. "
            "그날 동선이 이 지점 근처를 지나면 짐캐리 무인보관함을, 근처에 없으면 역 물품보관함(공사)을 안내하라."
        )
        note = f"{note} {locker_note}".strip() if note else locker_note

    # 여행 시작일 기준 부산 일자별 예보 (Open-Meteo, 키 불필요) — 실패해도 일정 생성은 계속
    weather_summary = ""
    try:
        weather_summary = format_for_persona(get_busan_weather(days=days, start_date=travel_date))
    except Exception as exc:
        print(f"[경고] 날씨 조회 실패: {exc}", flush=True)
    persona_prompt = build_persona(traveler, weather_summary=weather_summary)
    # 당일치기는 숙소 역 대신 도착 거점 인근 역의 실데이터(보관함·혼잡도)를 컨텍스트로 사용
    HUB_STATION = {"busan_station": "부산", "gimhae_airport": "공항", "intl_terminal": "중앙"}
    context_station = HUB_STATION.get(str(body.get("hub", "")), "부산") if day_trip else station
    data_context = build_plan_context(context_station)
    # 동선 최적화 — 하루 일정이 도시 반대편을 오가지 않도록 권역 클러스터를 명시한다
    route_guidance = (
        "\n\n[동선 최적화 지침 — 반드시 지켜라]\n"
        "- 하루 일정은 아래 권역 중 1~2개(서로 인접한 권역만)로 묶어라. 하루 안에 도시 반대편 권역을 오가는 왕복 동선을 만들지 말라.\n"
        "  · 원도심 권역: 남포동·자갈치·국제시장·보수동·부산역·초량 (1호선 라인)\n"
        "  · 서면 권역: 서면·전포 카페거리·부산시민공원\n"
        "  · 해운대 권역: 해운대해수욕장·동백섬·달맞이길·센텀시티·벡스코 (2호선 동쪽)\n"
        "  · 광안리 권역: 광안리해수욕장·민락수변공원·경성대 (2호선 중간)\n"
        "  · 영도 권역: 흰여울문화마을·태종대 (남포동에서 버스 연계)\n"
        "  · 기장 권역: 해동용궁사·오시리아 (해운대에서 동해선/버스 연계)\n"
        "- 방문 순서는 지리적으로 한 방향으로 이어지게 배치하고, 이미 지나온 방향으로 되돌아가지 말라. "
        "같은 도시철도 구간·같은 거리를 하루에 두 번 지나는 왕복 동선은 금지다(한붓그리기 원칙). "
        "일정 확정 전에 방문 순서를 스스로 검토해, 총 이동거리가 더 짧아지는 순서가 있으면 그 순서로 바꿔라.\n"
        "- 지하철 환승은 하루 2회 이하로 설계하고, 인접 권역 이동은 같은 호선으로 잇는 경로를 우선하라.\n"
        "- 첫 일정은 출발 거점(짐 처리 지점)에서 가까운 곳부터 시작하라. 마지막 날이 아닌 날의 마지막 일정은 숙소 방향으로 끝내고, "
        "여행 마지막 날은 숙소로 되돌아가지 말고 부산을 떠나는 거점(공항·역·터미널) 방향으로 동선을 마무리하라.\n"
        "- 각 이동 구간은 이전 장소에서 30분 이내(도시철도 기준)가 되도록 장소를 골라라. 30분을 넘는 이동은 하루 1회까지만 허용된다.\n"
        "- 하루 방문지는 최소 4곳, 최대 6곳으로 구성하라. (이 지침이 '하루 2~4개 핵심 일정' 원칙보다 우선한다) "
        "방문지는 서로 다른 '실제 관광 명소'여야 한다. 식당·카페·'숙소 복귀/휴식'·'자유시간'은 방문지 수에 포함되지 않는다 — "
        "식사는 명소 사이에 끼워 넣되, 산책·카페·식사·휴식만으로 하루를 채우는 것은 금지다.\n"
        "- 숙소 동네에서만 맴도는 일정은 금지다. 숙소 인근 명소는 하루 최대 1곳까지만 넣고, "
        "숙소가 주요 관광 권역 밖(예: 다대포·신평 등 외곽)이면 숙소는 아침 출발점·밤 복귀점일 뿐이다 — "
        "아침에 도시철도로 위 관광 권역으로 이동해 하루를 그 권역에서 보내라. 숙소↔관광 권역을 오가는 아침·저녁 이동은 30분 제한의 예외로 허용된다.\n"
        "- 날씨가 나빠도 일정 수를 줄이지 말라. 비 오는 날은 실내 명소(시장·전시·미술관·아쿠아리움·백화점)로 4곳 이상을 채워라.\n"
        "- [장소 중복 절대 금지] 여행 전체에서 같은 관광 명소를 두 번 방문하지 말라. 각 명소는 전 일정에서 딱 한 번만 등장한다. "
        "도착일과 마지막 날의 거점이 같은 권역(예: 둘 다 원도심)이어도, 두 날의 방문지가 겹치면 안 된다 — "
        "예를 들어 도착일에 자갈치시장·국제시장·용두산공원을 갔다면, 마지막 날에는 감천문화마을·부산근대역사관·40계단·영도 흰여울문화마을·보수동책방골목처럼 '가지 않은' 다른 명소로 채워라. "
        "원도심은 자갈치·국제시장·용두산공원(부산타워)·BIFF광장·부산근대역사관·40계단·보수동책방골목·감천문화마을·영도(흰여울·태종대) 등 명소가 많으니, 날마다 다른 조합을 써라. "
        "일정을 완성하기 전에 전체 방문지 목록을 스스로 점검해 중복이 있으면 다른 명소로 교체하라.\n"
    )
    transit_table = transit_time_table()
    if transit_table:
        route_guidance += (
            "\n[도시철도 구간 소요시간 참고표 — 부산교통공사 경로엔진 실측 기반]\n"
            f"{transit_table}\n"
            "- 일정에 적는 이동시간은 반드시 위 표를 기준으로 계산하라. 표에 없는 구간은 가장 가까운 거점 구간 시간에 나머지를 더해 추정하라.\n"
            "- 같은 권역 내 도보 이동은 1km당 약 15분으로 계산하고, 역→명소 도보 시간(보통 5~15분)도 이동시간에 포함하라.\n"
            "- 이동시간을 과소평가하지 말라. 근거 없이 '10분'처럼 임의의 시간을 지어내지 말라.\n"
        )
    # 사실 정확성·일관성 지침
    coherence_guidance = (
        "\n\n[사실 정확성·일관성 — 반드시 지켜라]\n"
        "- 실제로 존재하는 부산 도시철도 역명만 써라. '감천역'·'부산진역(2호선)'처럼 없는 역을 지어내지 말라. "
        "(감천문화마을은 토성역에서 마을버스, 부산시립미술관은 2호선 시립미술관역, 영화의전당은 2호선 센텀시티역 등 실제 접근역을 확인해 써라. 접근역이 불확실하면 '○○ 인근'으로 표기.)\n"
        "- 시간대와 활동이 논리적으로 맞아야 한다. 낮 시간(정오·오후)에 '야경 조망'처럼 시간과 모순되는 표현을 쓰지 말라. 야경·일몰은 저녁 이후 일정에만 넣어라.\n"
        "- 본문에 적는 방문 순서·장소는 아래 <STOPS> 목록과 정확히 일치해야 한다. 지도(STOPS)와 본문 동선이 어긋나면 안 된다.\n"
    )
    if not day_trip:
        coherence_guidance += (
            "- [짐 처리 절대 규칙] 이 일정은 짐캐리 배송(거점→숙소, 숙소→거점)만 사용한다. 큰 짐은 도착일 저녁부터 체크아웃까지 계속 숙소에 있고, "
            "관광 중에는 짐이 손에 없다. 따라서 어떤 날에도 물품보관함·무인보관함을 이용하는 단계를 넣지 말라. "
            "본문 어디에도 '무인보관함', '물품보관함', '짐 보관', '짐 회수' 같은 표현을 쓰지 말라(도착일 배송 접수와 마지막날 숙소→거점 배송 접수만 짐 관련 단계로 등장한다).\n"
        )
    # 응답 형식 — 일자별 마크다운 표
    format_guidance = (
        "\n\n[응답 형식 — 반드시 지켜라]\n"
        "- 먼저 이 일정의 핵심 전략을 2~3문장으로 요약하라.\n"
        "- 그다음 각 '일차'를 반드시 아래 마크다운 표 형식으로 작성하라(불릿 목록 금지):\n"
        "  ### N일차 (날짜·날씨 한 줄)\n"
        "  | 시간 | 장소·활동 | 이동(방법·소요) | 짐 팁 |\n"
        "  |---|---|---|---|\n"
        "  | 09:00 | 자갈치시장 | 부산역→자갈치역 2분+도보5분 | 짐캐리 배송으로 빈손 |\n"
        "- 표의 '장소·활동' 칸에 나오는 관광 명소는 <STOPS>와 정확히 같아야 한다.\n"
        "- 마지막에 '짐캐리 활용 요약'과 확인이 필요한 포인트를 2~4줄로 덧붙여라.\n"
    )
    # 지도 시각화용 방문지 목록 — 출력이 잘려도 안전하도록 본문 '앞'에 먼저 출력하게 한다
    stops_instruction = (
        "\n\n[추가 출력 — 지도 표시용, 반드시 응답의 '첫 줄'에]\n"
        "응답을 시작할 때 가장 먼저, 이 일정에서 방문할 장소 목록을 아래 형식의 한 블록으로 출력한 뒤 일정 본문을 작성하라.\n"
        "<STOPS>[{\"day\":1,\"order\":1,\"name\":\"장소명\",\"query\":\"카카오맵 검색용 키워드(부산 포함)\"}, ...]</STOPS>\n"
        "규칙: 실제 방문하는 '관광 명소'만(이동수단·식사·카페·숙소 복귀·휴식 제외), 하루 4~6개, query는 '부산 자갈치시장'처럼 지도 검색이 잘 되는 형태로. 목록 순서는 실제 방문 순서와 일치해야 한다. "
        "여행 전체에서 같은 name이 두 번 나오면 안 된다(모든 방문지는 유일). '용두산공원'과 '부산타워'처럼 같은 곳의 다른 이름도 중복으로 본다. 중복이 있으면 다른 명소로 교체한 뒤 출력하라. "
        "본문 표의 장소와 이 목록은 완전히 일치해야 한다."
    )
    user_request = build_user_request(traveler, extra_note=note) + data_context + route_guidance + coherence_guidance + format_guidance + stops_instruction

    nvidia = OpenAI(base_url=NVIDIA_BASE_URL, api_key=os.environ["NVIDIA_API_KEY"])

    max_out = min(8192, 3500 + days * 1500)

    def call(model: str, extra_user: str = "") -> str:
        kwargs = dict(
            model=model, temperature=0.6, top_p=1, max_tokens=max_out,
            messages=[{"role": "system", "content": persona_prompt},
                      {"role": "user", "content": user_request + extra_user}],
        )
        # gpt-oss는 reasoning_effort=low로 추론 토큰 낭비를 없애 빠르고 본문이 잘리지 않는다.
        if "gpt-oss" in model:
            kwargs["extra_body"] = {"reasoning_effort": "low"}
        completion = nvidia.chat.completions.create(**kwargs)
        return (completion.choices[0].message.content or "").strip()

    # 방문지 중복 감지용 — STOPS의 name을 정규화(괄호·공백 제거, 동의어 통합)
    _STOP_ALIAS = {"부산타워": "용두산공원", "용두산공원부산타워": "용두산공원"}
    def _stop_names(text: str) -> list[str]:
        m = re.search(r"<STOPS>\s*(\[[\s\S]*?\])\s*</STOPS>", text)
        if not m:
            return []
        try:
            arr = json.loads(m.group(1))
        except json.JSONDecodeError:
            return []
        out = []
        for s in arr:
            n = re.sub(r"\([^)]*\)", "", str((s or {}).get("name", ""))).replace(" ", "").strip()
            out.append(_STOP_ALIAS.get(n, n))
        return out
    def _dups(text: str) -> list[str]:
        seen, dup = set(), []
        for n in _stop_names(text):
            if n and n in seen and n not in dup:
                dup.append(n)
            seen.add(n)
        return dup

    # 일정 생성: gpt-oss(reasoning_effort=low) — 빠르고 표 본문이 잘리지 않는다.
    # 빈 응답 시 instruct 모델로 폴백(느리지만 확실).
    plan, model_used = "", PLAN_MODEL
    try:
        plan = call(PLAN_MODEL)
        if not plan:
            raise RuntimeError("빈 응답")
    except Exception as exc:
        print(f"[경고] {PLAN_MODEL} 실패, instruct 모델로 재시도: {exc}", flush=True)
        try:
            plan = call(PLAN_MODEL_INSTRUCT)
            model_used = PLAN_MODEL_INSTRUCT
        except Exception as exc2:
            return jsonify({"error": f"일정 생성 실패: {exc2}"}), 502

    # 중복 방문지가 있으면 1회 자동 재생성(프롬프트 규칙 위반 방어)
    dups = _dups(plan)
    if dups:
        print(f"[정보] 방문지 중복 감지 {dups} → 재생성", flush=True)
        fix = (
            f"\n\n[중요] 방금 만든 일정에서 다음 장소가 여행 중 두 번 이상 방문됐다: {', '.join(dups)}. "
            "중복된 장소를 '가지 않은 다른 부산 관광 명소'로 교체해, 전 일정에서 모든 방문지가 유일하도록 처음부터 다시 작성하라. "
            "표 형식과 <STOPS> 규칙을 그대로 지켜라."
        )
        try:
            retry = call(model_used, extra_user=fix)
            if retry and not _dups(retry):
                plan = retry
        except Exception as exc:
            print(f"[경고] 중복 재생성 실패(원본 유지): {exc}", flush=True)

    # <STOPS> 블록 추출 → 지도 마커용 배열 (파싱 실패 시 지도만 생략)
    stops = []
    stops_match = re.search(r"<STOPS>\s*(\[[\s\S]*?\])\s*</STOPS>", plan)
    if stops_match:
        try:
            parsed = json.loads(stops_match.group(1))
            stops = [
                {"day": int(s.get("day", 1)), "order": int(s.get("order", 0)),
                 "name": str(s.get("name", "")).strip(), "query": str(s.get("query", "")).strip()}
                for s in parsed if isinstance(s, dict) and s.get("name")
            ]
            stops.sort(key=lambda s: (s["day"], s["order"]))
        except (json.JSONDecodeError, ValueError):
            pass
        plan = (plan[:stops_match.start()] + plan[stops_match.end():]).strip()  # 본문에서 블록 제거 (위치 무관)

    return jsonify({
        "plan": plan,
        "stops": stops,
        "model": model_used,
        "weather": weather_summary,  # 일자별 예보 요약 (없으면 빈 문자열)
        "profile": {
            "weight": LUGGAGE_WEIGHT_OPTIONS[weight],
            "urgency": LUGGAGE_URGENCY_OPTIONS[urgency],
            "styles": [TRAVEL_STYLE_OPTIONS[s] for s in styles],
            "days": days, "station": station, "companions": companions,
            "travelDate": travel_date or "오늘부터",
            "hasPlan": bool(existing_plan),
            "hub": hub,
            "endHub": end_hub,
        },
        "internalContext": bool(data_context),
    })


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "llm": bool(os.environ.get("NVIDIA_API_KEY")),
        "webSearch": GoogleSearchClient().provider,
    })


@app.post("/ask")
def ask():
    body = request.get_json(silent=True) or {}
    question = str(body.get("question", "")).strip()
    if not question:
        return jsonify({"error": "question 필드가 필요합니다."}), 400
    if not os.environ.get("NVIDIA_API_KEY"):
        return jsonify({"error": "NVIDIA_API_KEY가 설정되지 않았습니다. backend/.env에 추가 후 어시스턴트 서비스를 재시작하세요."}), 503

    nvidia = OpenAI(base_url=NVIDIA_BASE_URL, api_key=os.environ["NVIDIA_API_KEY"])
    search = GoogleSearchClient()
    retrieved_at = now_iso()

    # ① 내부 데이터 근거 (프로젝트 보유 실데이터)
    chunks = build_internal_chunks(question, retrieved_at)

    # ② 웹 검색 근거 (검색 키가 있을 때만)
    queries: list[str] = []
    if search.provider:
        try:
            queries = generate_queries(nvidia, question)
            documents = select_documents(r for q in queries for r in search.search(q))
            chunks += collect_web_chunks(documents, retrieved_at)
            if search.provider == "naver":  # 장소 질문 대비 실제 등록 업체 근거 추가
                for q in queries:
                    chunks += search.naver_local_chunks(q, retrieved_at)
        except Exception as exc:  # 웹 검색 실패는 내부 데이터만으로 진행
            print(f"[경고] 웹 검색 실패: {exc}")

    # ③ 재랭킹 + 답변 생성
    try:
        evidence = rank_chunks(nvidia, question, chunks, top_k=6)
        answer = generate_answer(nvidia, question, evidence)
    except Exception as exc:
        return jsonify({"error": f"LLM 호출 실패: {exc}"}), 502

    sources = list({c.url: {
        "title": c.title, "url": c.url, "official": c.official,
        "sourceKind": c.source_kind, "publishedAt": c.published_at,
    } for c in evidence}.values())

    return jsonify({
        "question": question,
        "answer": answer,
        "sources": sources,
        "searchProvider": search.provider,
        "searchQueries": queries,
        "internalChunks": sum(1 for c in evidence if c.source_kind == "internal_data"),
        "webChunks": sum(1 for c in evidence if c.source_kind != "internal_data"),
        "retrievedAt": retrieved_at,
    })


if __name__ == "__main__":
    import sys
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(errors="replace")
        sys.stderr.reconfigure(errors="replace")
    port = int(os.environ.get("ASSISTANT_PORT", 3200))
    print(f"🤖 Busan Travel Assistant (RAG) on http://localhost:{port}")
    print(f"   LLM: {'OK' if os.environ.get('NVIDIA_API_KEY') else 'NVIDIA_API_KEY 미설정'}")
    print(f"   Web search: {GoogleSearchClient().provider or '비활성 (내부 데이터 전용)'}")
    app.run(host="127.0.0.1", port=port, threaded=True)
