"""Vectorized lag / rolling-window feature builders for bulk
training-set construction (Phase 3). Operates on the full long-format
ridership table at once via pandas groupby — much faster than calling
``FeatureStore.assemble()`` row by row, which is designed for
single-point online inference instead (see store.py).

``lag_{n}d`` and ``rolling_mean_{w}d`` are both defined relative to the
same (station_id, direction, hour_of_day) series, and both exclude the
target row's own day — consistent with ``FeatureStore``'s leakage-free
definitions.
"""

from __future__ import annotations

from collections.abc import Sequence

import pandas as pd

from nocarrier.common.exceptions import DataValidationError

_GROUP_COLS: list[str] = ["station_id", "direction", "hour_of_day"]


def _assert_contiguous_daily(df: pd.DataFrame) -> None:
    """Lag-by-row-shift is only valid if every (station, direction,
    hour) series has exactly one row per consecutive day with no gaps
    — true for the 2025 ridership data (verified: 365 days, no missing
    dates), but worth guarding against silently wrong lags on a future
    data refresh.
    """
    for _, group in df.groupby(_GROUP_COLS):
        dates = group["date"].sort_values()
        gaps = dates.diff().dropna()
        if len(gaps) and not (gaps == pd.Timedelta(days=1)).all():
            raise DataValidationError(
                "Non-contiguous daily series found in ridership_long — "
                "lag/rolling features assume one row per consecutive day. "
                "Re-check the source data before computing lag features."
            )


def add_lag_features(
    df: pd.DataFrame, lags_days: Sequence[int], *, validate: bool = True
) -> pd.DataFrame:
    """Adds ``lag_{n}d_count`` columns: the ``count`` value at the same
    (station_id, direction, hour_of_day) ``n`` days earlier.

    Named to match ``FeatureStore.FeatureRow``'s ``lag_1d_count`` /
    ``lag_7d_count`` fields exactly, so training-time (this module) and
    inference-time (store.py) features never drift apart under
    different names.
    """
    if validate:
        _assert_contiguous_daily(df)

    out = df.sort_values([*_GROUP_COLS, "date"]).reset_index(drop=True)
    grouped = out.groupby(_GROUP_COLS)["count"]
    for n in lags_days:
        out[f"lag_{n}d_count"] = grouped.shift(n)
    return out


def add_rolling_features(
    df: pd.DataFrame, windows_days: Sequence[int], *, validate: bool = True
) -> pd.DataFrame:
    """Adds ``rolling_mean_{w}d`` columns: the trailing ``w``-day mean
    of ``count`` at the same (station_id, direction, hour_of_day),
    computed up to but excluding the row's own day (no leakage).
    """
    if validate:
        _assert_contiguous_daily(df)

    out = df.sort_values([*_GROUP_COLS, "date"]).reset_index(drop=True)
    for w in windows_days:
        out[f"rolling_mean_{w}d"] = out.groupby(_GROUP_COLS)["count"].transform(
            lambda s, w=w: s.shift(1).rolling(w, min_periods=1).mean()
        )
    return out
