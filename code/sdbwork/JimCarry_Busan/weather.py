"""
짐캐리 (JimCarry) - 날씨 조회 모듈 (Open-Meteo API)

부산의 일자별 날씨 예보를 가져와, 페르소나에 넣을 텍스트로 정리한다.
Open-Meteo 는 API 키가 필요 없고, 표준 라이브러리(urllib)만으로 호출한다.

문서: https://open-meteo.com/en/docs
"""

import datetime
import json
import urllib.error
import urllib.parse
import urllib.request

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

# 부산 중심 좌표
BUSAN_LAT = 35.1796
BUSAN_LON = 129.0756

# 무료 예보 제공 범위(대략 16일). 이 범위를 벗어나면 예보를 생략한다.
MAX_FORECAST_DAYS = 16

# WMO weather code → 한국어 설명
_WMO_CODE = {
    0: "맑음",
    1: "대체로 맑음", 2: "부분적으로 흐림", 3: "흐림",
    45: "안개", 48: "짙은 안개",
    51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비",
    56: "어는 이슬비", 57: "강한 어는 이슬비",
    61: "약한 비", 63: "비", 65: "강한 비",
    66: "어는 비", 67: "강한 어는 비",
    71: "약한 눈", 73: "눈", 75: "강한 눈", 77: "싸락눈",
    80: "약한 소나기", 81: "소나기", 82: "강한 소나기",
    85: "약한 눈 소나기", 86: "강한 눈 소나기",
    95: "뇌우", 96: "뇌우(약한 우박)", 99: "뇌우(강한 우박)",
}

_WEEKDAY_KR = ["월", "화", "수", "목", "금", "토", "일"]


def describe_code(code) -> str:
    try:
        return _WMO_CODE.get(int(code), "정보 없음")
    except (TypeError, ValueError):
        return "정보 없음"


def get_busan_weather(days: int = 1, start_date: str = "") -> list:
    """
    부산의 일자별 예보를 가져온다.

    Args:
        days       : 조회할 일수
        start_date : "YYYY-MM-DD" (비우면 오늘부터). 오늘 기준 16일 이내만 유효.

    Returns:
        [{"date","weekday","code","desc","tmax","tmin","precip"}...]
        조회 실패/범위 초과 시 빈 리스트.
    """
    days = max(1, min(days, MAX_FORECAST_DAYS))

    params = {
        "latitude": BUSAN_LAT,
        "longitude": BUSAN_LON,
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        "timezone": "Asia/Seoul",
    }

    # 시작일이 지정되면 start_date/end_date 로, 아니면 forecast_days 로 요청
    if start_date:
        try:
            start = datetime.date.fromisoformat(start_date)
            today = datetime.date.today()
            delta = (start - today).days
            if delta < 0 or delta + days > MAX_FORECAST_DAYS:
                # 예보 제공 범위를 벗어나면 예보 없이 진행
                return []
            end = start + datetime.timedelta(days=days - 1)
            params["start_date"] = start.isoformat()
            params["end_date"] = end.isoformat()
        except ValueError:
            params["forecast_days"] = days
    else:
        params["forecast_days"] = days

    url = f"{OPEN_METEO_URL}?{urllib.parse.urlencode(params)}"

    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
        print(f"  [날씨 조회 실패] {e} — 날씨 없이 진행합니다.")
        return []

    daily = data.get("daily", {})
    dates = daily.get("time", [])
    codes = daily.get("weather_code", [])
    tmax = daily.get("temperature_2m_max", [])
    tmin = daily.get("temperature_2m_min", [])
    precip = daily.get("precipitation_probability_max", [])

    result = []
    for i, date_str in enumerate(dates):
        try:
            wd = _WEEKDAY_KR[datetime.date.fromisoformat(date_str).weekday()]
        except ValueError:
            wd = ""
        result.append({
            "date": date_str,
            "weekday": wd,
            "code": codes[i] if i < len(codes) else None,
            "desc": describe_code(codes[i]) if i < len(codes) else "정보 없음",
            "tmax": tmax[i] if i < len(tmax) else None,
            "tmin": tmin[i] if i < len(tmin) else None,
            "precip": precip[i] if i < len(precip) else None,
        })
    return result


def format_for_persona(forecast: list) -> str:
    """
    예보 리스트를 페르소나에 넣을 여러 줄 텍스트로 변환한다.
    (예) "- 1일차 (07-23 수): 비, 24~29℃, 강수확률 80%"
    """
    if not forecast:
        return ""

    lines = []
    for idx, day in enumerate(forecast, start=1):
        date = day.get("date", "")
        md = date[5:] if len(date) >= 10 else date  # MM-DD
        wd = day.get("weekday", "")
        desc = day.get("desc", "정보 없음")
        tmin = day.get("tmin")
        tmax = day.get("tmax")
        precip = day.get("precip")

        temp = ""
        if tmin is not None and tmax is not None:
            temp = f", {round(tmin)}~{round(tmax)}℃"
        rain = f", 강수확률 {precip}%" if precip is not None else ""

        lines.append(f"- {idx}일차 ({md} {wd}): {desc}{temp}{rain}")

    return "\n".join(lines)
