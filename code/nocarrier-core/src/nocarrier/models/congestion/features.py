"""Feature schema for Component A — the single source of truth for
column names/order shared by ``train.py`` and ``predict.py`` so they
can never silently drift apart. ``predict.py`` builds its one-row
inference frame from a ``FeatureStore.FeatureRow`` using these exact
same column names.
"""

from __future__ import annotations

import pandas as pd

from nocarrier.features.calendar import (
    HolidayProvider,
    StaticHolidayProvider,
    compute_calendar_frame,
)
from nocarrier.features.lags import add_lag_features, add_rolling_features
from nocarrier.models.events.detect import build_daily_totals, detect_event_spikes

FEATURE_COLUMNS: tuple[str, ...] = (
    "station_id",
    "direction",
    "hour_of_day",
    "weekday_index",
    "is_weekend",
    "is_holiday",
    "is_event_spike",
    "lag_1d_count",
    "lag_7d_count",
    "rolling_mean_7d",
    "rolling_mean_28d",
)
CATEGORICAL_COLUMNS: tuple[str, ...] = ("station_id", "direction")
TARGET_COLUMN = "count"
LAG_DAYS: tuple[int, ...] = (1, 7)
DEFAULT_ROLLING_WINDOWS_DAYS: tuple[int, ...] = (7, 28)


def build_training_frame(
    ridership_long: pd.DataFrame,
    *,
    holiday_provider: HolidayProvider | None = None,
    rolling_windows_days: tuple[int, ...] = DEFAULT_ROLLING_WINDOWS_DAYS,
    z_threshold: float = 2.5,
) -> pd.DataFrame:
    """Turns raw ``ridership_long`` (Phase 1's output) into a frame with
    every column in ``FEATURE_COLUMNS`` plus ``TARGET_COLUMN`` and
    ``date`` (kept for the chronological train/valid split in train.py).
    """
    holiday_provider = holiday_provider or StaticHolidayProvider()

    df = add_lag_features(ridership_long, LAG_DAYS)
    df = add_rolling_features(df, rolling_windows_days, validate=False)  # already validated above

    daily_totals = build_daily_totals(ridership_long)
    spikes = detect_event_spikes(daily_totals, z_threshold=z_threshold)
    df = df.merge(
        spikes[["station_id", "date", "is_event_spike"]], on=["station_id", "date"], how="left"
    )
    df["is_event_spike"] = df["is_event_spike"].fillna(False).astype(bool)

    calendar_frame = compute_calendar_frame(pd.DatetimeIndex(df["date"].unique()), holiday_provider)
    df = df.merge(calendar_frame, on="date", how="left")
    df["is_weekend"] = df["is_weekend"].astype(bool)
    df["is_holiday"] = df["is_holiday"].astype(bool)

    df["station_id"] = df["station_id"].astype("category")
    df["direction"] = df["direction"].astype("category")

    return df


def to_model_matrix(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    x = df[list(FEATURE_COLUMNS)]
    y = df[TARGET_COLUMN]
    return x, y
