"""Calendar features: weekday, weekend flag, and South Korea public
holidays (including 대체공휴일 substitute holidays).

``KNOWN_HOLIDAYS`` covers 2025-2026 — the years the ridership data
(2025) and the hackathon (2026) span — sourced from
publicholidays.co.kr, fetched and cross-referenced during development
(see docs/FEATURES.md for the citation). Extend the set, or swap in a
real government 공휴일 API client behind the same ``HolidayProvider``
protocol, before relying on this for other years.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Protocol

import pandas as pd

_WEEKDAY_KO: tuple[str, ...] = ("월", "화", "수", "목", "금", "토", "일")

KNOWN_HOLIDAYS: frozenset[date] = frozenset(
    {
        # 2025 — source: publicholidays.co.kr/2025-dates
        date(2025, 1, 1),  # New Year's Day
        date(2025, 1, 28),
        date(2025, 1, 29),
        date(2025, 1, 30),  # Seollal
        date(2025, 3, 1),  # Independence Movement Day
        date(2025, 3, 3),  # substitute (대체공휴일)
        date(2025, 5, 5),  # Children's Day
        date(2025, 5, 8),  # Buddha's Birthday
        date(2025, 6, 6),  # Memorial Day
        date(2025, 8, 15),  # Liberation Day
        date(2025, 10, 3),  # National Foundation Day
        date(2025, 10, 5),
        date(2025, 10, 6),
        date(2025, 10, 7),  # Chuseok
        date(2025, 10, 9),  # Hangeul Day
        date(2025, 12, 25),  # Christmas
        # 2026 — source: publicholidays.co.kr/2026-dates
        date(2026, 1, 1),
        date(2026, 2, 16),
        date(2026, 2, 17),
        date(2026, 2, 18),  # Seollal
        date(2026, 3, 1),
        date(2026, 3, 2),  # substitute
        date(2026, 5, 5),
        date(2026, 5, 8),
        date(2026, 6, 6),
        date(2026, 8, 15),
        date(2026, 8, 17),  # substitute
        date(2026, 9, 24),
        date(2026, 9, 25),
        date(2026, 9, 26),
        date(2026, 9, 27),  # Chuseok
        date(2026, 10, 3),
        date(2026, 10, 5),  # substitute
        date(2026, 10, 9),
        date(2026, 12, 25),
    }
)


class HolidayProvider(Protocol):
    def is_holiday(self, d: date) -> bool: ...


class StaticHolidayProvider:
    """Looks up ``KNOWN_HOLIDAYS``. Covers 2025-2026 only."""

    def __init__(self, holidays: frozenset[date] = KNOWN_HOLIDAYS) -> None:
        self._holidays = holidays

    def is_holiday(self, d: date) -> bool:
        return d in self._holidays


@dataclass(frozen=True)
class CalendarFeatures:
    weekday_ko: str
    weekday_index: int  # 0=Mon .. 6=Sun
    is_weekend: bool
    is_holiday: bool
    day_type: str  # "평일" | "주말" | "공휴일"


def compute_calendar_features(
    timestamp: datetime, holiday_provider: HolidayProvider
) -> CalendarFeatures:
    d = timestamp.date()
    weekday_index = timestamp.weekday()
    is_weekend = weekday_index >= 5
    is_holiday = holiday_provider.is_holiday(d)
    day_type = "공휴일" if is_holiday else ("주말" if is_weekend else "평일")
    return CalendarFeatures(
        weekday_ko=_WEEKDAY_KO[weekday_index],
        weekday_index=weekday_index,
        is_weekend=is_weekend,
        is_holiday=is_holiday,
        day_type=day_type,
    )


def compute_calendar_frame(
    dates: pd.DatetimeIndex, holiday_provider: HolidayProvider
) -> pd.DataFrame:
    """Vectorized-batch version of ``compute_calendar_features`` for bulk
    training-set construction (Phase 3): computes calendar features once
    per unique date rather than once per row, then the caller merges the
    result onto a long-format table on ``date``.
    """
    records = []
    for d in dates:
        cf = compute_calendar_features(
            datetime.combine(d.date(), datetime.min.time()), holiday_provider
        )
        records.append(
            {
                "date": d,
                "weekday_index": cf.weekday_index,
                "is_weekend": cf.is_weekend,
                "is_holiday": cf.is_holiday,
                "day_type": cf.day_type,
            }
        )
    return pd.DataFrame(records)
