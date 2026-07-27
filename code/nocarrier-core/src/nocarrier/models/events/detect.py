"""Component A': event-spike detector.

Flags anomalously high- or low-ridership days per station using STL
seasonal decomposition + residual z-score on daily totals — see
AI_Pipeline_Strategy.md §2 Component A'. This operationalizes Insight B
(tourism-driven vs. event-driven demand duality) *without* needing a
labeled event dataset: it finds statistical outliers directly in the
ridership series. Cross-referencing against a real event calendar
(``features/events.py``) is left to the caller — this module only says
"something unusual happened here," not why.

No training/persistence step: this recomputes from ``ridership_long``
each time it's called (a few seconds for all 114 stations), so it's run
as a preprocessing step inside Component A's ``build_training_frame``
rather than saved as its own artifact.
"""

from __future__ import annotations

import pandas as pd
import structlog
from statsmodels.tsa.seasonal import STL

log = structlog.get_logger(__name__)

DEFAULT_Z_THRESHOLD = 2.5
DEFAULT_PERIOD_DAYS = 7  # weekly seasonality — the only periodicity ~365 daily points can support

_RESULT_COLUMNS: tuple[str, ...] = (
    "station_id",
    "date",
    "total",
    "trend",
    "seasonal",
    "resid",
    "resid_zscore",
    "is_event_spike",
)


def build_daily_totals(ridership_long: pd.DataFrame) -> pd.DataFrame:
    """Aggregate hourly, per-direction counts into one daily total per
    station (both directions combined) — the series
    ``detect_event_spikes`` operates on.
    """
    return (
        ridership_long.groupby(["station_id", "date"], as_index=False)["count"]
        .sum()
        .rename(columns={"count": "total"})
    )


def detect_event_spikes(
    daily_totals: pd.DataFrame,
    *,
    z_threshold: float = DEFAULT_Z_THRESHOLD,
    period: int = DEFAULT_PERIOD_DAYS,
) -> pd.DataFrame:
    """``daily_totals`` must have columns station_id, date, total (one
    row per station-date — see ``build_daily_totals``). Returns one row
    per station-date with the STL decomposition components plus
    ``is_event_spike``.
    """
    results: list[pd.DataFrame] = []

    for station_id, group in daily_totals.groupby("station_id"):
        series = group.sort_values("date").set_index("date")["total"]
        if len(series) < period * 2:
            log.warning("stl_series_too_short", station_id=station_id, length=len(series))
            continue

        stl_result = STL(series, period=period, robust=True).fit()
        resid = stl_result.resid
        std = resid.std()
        z = (resid - resid.mean()) / std if std > 0 else resid * 0.0

        results.append(
            pd.DataFrame(
                {
                    "station_id": station_id,
                    "date": series.index,
                    "total": series.to_numpy(),
                    "trend": stl_result.trend.to_numpy(),
                    "seasonal": stl_result.seasonal.to_numpy(),
                    "resid": resid.to_numpy(),
                    "resid_zscore": z.to_numpy(),
                    "is_event_spike": (z.abs() > z_threshold).to_numpy(),
                }
            )
        )

    if not results:
        return pd.DataFrame(columns=list(_RESULT_COLUMNS))
    return pd.concat(results, ignore_index=True)
