"""Project-wide constants.

Anything that is a fixed fact about the Busan subway network or the
service's defaults lives here. Tunable *behavior* (hyperparameters,
feature flags, cost weights) belongs in config/, not here — this file
should rarely change.
"""

from __future__ import annotations

from typing import Final

# --- Network -----------------------------------------------------------

STATION_COUNT: Final[int] = 114
LINE_NAMES: Final[tuple[str, ...]] = ("1호선", "2호선", "3호선", "4호선")

# --- Geo -----------------------------------------------------------------

EARTH_RADIUS_KM: Final[float] = 6371.0088

# --- Defaults --------------------------------------------------------------

DEFAULT_LANGUAGE: Final[str] = "ko"
SUPPORTED_LANGUAGES: Final[tuple[str, ...]] = ("ko", "en")

# --- Time buckets (matches the 시간대별 승하차 인원 CSV columns) -----------

HOURLY_COLUMNS: Final[tuple[str, ...]] = (
    "01시-02시",
    "02시-03시",
    "03시-04시",
    "04시-05시",
    "05시-06시",
    "06시-07시",
    "07시-08시",
    "08시-09시",
    "09시-10시",
    "10시-11시",
    "11시-12시",
    "12시-13시",
    "13시-14시",
    "14시-15시",
    "15시-16시",
    "16시-17시",
    "17시-18시",
    "18시-19시",
    "19시-20시",
    "20시-21시",
    "21시-22시",
    "22시-23시",
    "23시-24시",
    "24시-01시",
)
