"""Weather data for the feature store — used as a congestion covariate
(rain measurably raises indoor-station dwell time and elevator demand,
per AI_Pipeline_Strategy.md §3).

``KmaWeatherProvider`` implements a real client against 기상청's
단기예보 (short-term forecast) API, including the lat/lon -> grid
(nx, ny) conversion (Lambert Conformal Conic, standard KMA parameters —
verified against public KMA API documentation, not guessed; see
docs/FEATURES.md). It requires ``KMA_WEATHER_API_KEY`` and has not been
exercised against the live endpoint in this environment (no network
access to apihub.kma.go.kr here) — verify manually once a key is
available before relying on it in production.

``StubWeatherProvider`` is the default: a deterministic, clearly
"no data" stand-in (never fabricated weather) so the pipeline runs
end-to-end without a live key. Which one ``FeatureStore`` uses is
controlled by ``NoCarrierSettings.feature_flags.use_external_weather``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

import httpx
import structlog

log = structlog.get_logger(__name__)

# KMA LCC DFS grid parameters — verified against public KMA API
# documentation (apihub.kma.go.kr) during development.
_RE = 6371.00877  # Earth radius (km)
_GRID = 5.0  # grid spacing (km)
_SLAT1 = 30.0
_SLAT2 = 60.0
_OLON = 126.0
_OLAT = 38.0
_XO = 43
_YO = 136


def latlon_to_kma_grid(lat: float, lon: float) -> tuple[int, int]:
    """Convert (lat, lon) to the KMA short-term-forecast grid (nx, ny)."""
    degrad = math.pi / 180.0
    re = _RE / _GRID

    slat1 = _SLAT1 * degrad
    slat2 = _SLAT2 * degrad
    olon = _OLON * degrad
    olat = _OLAT * degrad

    sn = math.tan(math.pi * 0.25 + slat2 * 0.5) / math.tan(math.pi * 0.25 + slat1 * 0.5)
    sn = math.log(math.cos(slat1) / math.cos(slat2)) / math.log(sn)
    sf = math.tan(math.pi * 0.25 + slat1 * 0.5)
    sf = (sf**sn) * math.cos(slat1) / sn
    ro = math.tan(math.pi * 0.25 + olat * 0.5)
    ro = re * sf / (ro**sn)

    ra = math.tan(math.pi * 0.25 + lat * degrad * 0.5)
    ra = re * sf / (ra**sn)
    theta = lon * degrad - olon
    if theta > math.pi:
        theta -= 2.0 * math.pi
    if theta < -math.pi:
        theta += 2.0 * math.pi
    theta *= sn

    nx = int(ra * math.sin(theta) + _XO + 0.5)
    ny = int(ro - ra * math.cos(theta) + _YO + 0.5)
    return nx, ny


@dataclass(frozen=True)
class WeatherObservation:
    temperature_c: float | None
    precipitation_mm: float | None
    condition: str | None  # "clear" | "rain" | "rain_snow" | "snow" | "shower" | None
    source: str


class WeatherProvider(Protocol):
    def get_weather(self, lat: float, lon: float, timestamp: datetime) -> WeatherObservation: ...


class StubWeatherProvider:
    """Deterministic offline stand-in — NOT real weather. Always returns
    a "no data" observation so downstream code must treat weather as
    optional rather than silently trusting a fabricated forecast.
    """

    def get_weather(self, lat: float, lon: float, timestamp: datetime) -> WeatherObservation:
        return WeatherObservation(
            temperature_c=None, precipitation_mm=None, condition=None, source="stub"
        )


_FORECAST_SLOTS: tuple[str, ...] = ("0200", "0500", "0800", "1100", "1400", "1700", "2000", "2300")

_PTY_LABELS: dict[str, str] = {
    "0": "clear",
    "1": "rain",
    "2": "rain_snow",
    "3": "snow",
    "4": "shower",
}


def _nearest_forecast_slot(timestamp: datetime) -> str:
    hhmm = timestamp.strftime("%H%M")
    eligible = [s for s in _FORECAST_SLOTS if s <= hhmm]
    return eligible[-1] if eligible else _FORECAST_SLOTS[-1]


def _safe_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _parse_kma_response(payload: dict[str, object]) -> WeatherObservation:
    try:
        body = payload["response"]["body"]["items"]["item"]  # type: ignore[index]
    except (KeyError, TypeError):
        log.warning("kma_weather_unexpected_payload")
        return WeatherObservation(None, None, None, source="kma_error")

    values: dict[str, str] = {item["category"]: item["fcstValue"] for item in body}
    temperature = _safe_float(values.get("TMP"))
    raw_precip = values.get("PCP")
    precipitation = 0.0 if raw_precip in (None, "강수없음") else _safe_float(raw_precip)
    condition = _PTY_LABELS.get(values.get("PTY", ""))

    return WeatherObservation(
        temperature_c=temperature,
        precipitation_mm=precipitation,
        condition=condition,
        source="kma",
    )


class KmaWeatherProvider:
    """Real 기상청 단기예보 API client.

    Not exercised against the live endpoint in this environment —
    the grid-conversion math is unit-tested against a known reference
    point, but the HTTP call itself should be smoke-tested manually
    with a real ``KMA_WEATHER_API_KEY`` before production use.
    """

    _BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst"

    def __init__(self, api_key: str, client: httpx.Client | None = None) -> None:
        self._api_key = api_key
        self._client = client or httpx.Client(timeout=5.0)

    def get_weather(self, lat: float, lon: float, timestamp: datetime) -> WeatherObservation:
        nx, ny = latlon_to_kma_grid(lat, lon)
        base_date = timestamp.strftime("%Y%m%d")
        base_time = _nearest_forecast_slot(timestamp)

        try:
            response = self._client.get(
                self._BASE_URL,
                params={
                    "serviceKey": self._api_key,
                    "dataType": "JSON",
                    "base_date": base_date,
                    "base_time": base_time,
                    "nx": nx,
                    "ny": ny,
                    "numOfRows": 100,
                    "pageNo": 1,
                },
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            log.warning("kma_weather_request_failed", error=str(exc))
            return WeatherObservation(None, None, None, source="kma_error")

        result: WeatherObservation = _parse_kma_response(response.json())
        return result
