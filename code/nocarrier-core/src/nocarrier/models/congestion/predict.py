"""Component A inference: load the trained LightGBM artifact and
produce a ``CongestionForecast`` (nocarrier.contracts.predictions) for
a station over a requested set of timestamps, using the FeatureStore
for lag/calendar/weather context. Never re-implements feature logic —
builds its one-row frame from the exact ``FEATURE_COLUMNS`` features.py
defines for training.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from pathlib import Path

import lightgbm as lgb
import pandas as pd
import structlog

from nocarrier.common.config import NoCarrierSettings, get_settings
from nocarrier.common.exceptions import ModelNotTrainedError
from nocarrier.contracts.predictions import CongestionForecast, CongestionLevel, StationCongestion
from nocarrier.features.store import FeatureRow, FeatureStore
from nocarrier.models.base import read_metadata, read_registry
from nocarrier.models.congestion.features import CATEGORICAL_COLUMNS, FEATURE_COLUMNS

log = structlog.get_logger(__name__)


def load_congestion_artifacts(
    settings: NoCarrierSettings | None = None,
) -> tuple[lgb.Booster, pd.DataFrame]:
    """Returns (booster, baselines) for the currently active congestion
    artifact, per ``artifacts/registry.json``.
    """
    settings = settings or get_settings()
    component_dir = settings.paths.artifacts_dir / "congestion"
    registry_path = settings.paths.artifacts_dir / "registry.json"

    filename = read_registry(registry_path, "congestion")
    if filename is None:
        raise ModelNotTrainedError(
            "No trained congestion model in artifacts/registry.json — run "
            "`uv run python scripts/train_congestion.py` first."
        )

    booster = lgb.Booster(model_file=str(component_dir / filename))

    metadata_path = component_dir / f"{Path(filename).stem}_metadata.json"
    metadata = read_metadata(metadata_path)
    baselines = pd.read_csv(component_dir / metadata["baseline_filename"])

    return booster, baselines


def get_baseline(baselines: pd.DataFrame, station_id: int, direction: str) -> tuple[float, float]:
    match = baselines[
        (baselines["station_id"] == station_id) & (baselines["direction"] == direction)
    ]
    if match.empty:
        log.warning("no_baseline_for_station", station_id=station_id, direction=direction)
        return 0.0, 1.0
    row = match.iloc[0]
    std = float(row["std"]) if pd.notna(row["std"]) else 1.0
    return float(row["mean"]), std if std > 0 else 1.0


_FLOAT_COLUMNS: tuple[str, ...] = (
    "lag_1d_count",
    "lag_7d_count",
    "rolling_mean_7d",
    "rolling_mean_28d",
)
_BOOL_COLUMNS: tuple[str, ...] = ("is_weekend", "is_holiday", "is_event_spike")


def _feature_row_to_frame(row: FeatureRow) -> pd.DataFrame:
    data: dict[str, object] = {
        "station_id": row.station_id,
        "direction": row.direction,
        "hour_of_day": row.hour_of_day,
        "weekday_index": row.calendar.weekday_index,
        "is_weekend": row.calendar.is_weekend,
        "is_holiday": row.calendar.is_holiday,
        # The STL detector needs a historical window around a date and
        # isn't meaningful to recompute per single inference call; the
        # live event-calendar connector is the closest available signal
        # at prediction time, not a re-run of Component A'.
        "is_event_spike": row.is_event_window,
        "lag_1d_count": row.lag_1d_count,
        "lag_7d_count": row.lag_7d_count,
        "rolling_mean_7d": row.rolling_mean_7d,
        "rolling_mean_28d": row.rolling_mean_28d,
    }
    frame = pd.DataFrame([data])

    # A fresh single-row DataFrame infers `object` dtype for any column
    # holding a Python `None` (e.g. a station with no lag history yet),
    # which LightGBM's raw Booster.predict() rejects outright — coerce
    # every column to the same dtype family training used.
    for col in _FLOAT_COLUMNS:
        frame[col] = pd.to_numeric(frame[col], errors="coerce").astype(float)
    for col in _BOOL_COLUMNS:
        frame[col] = frame[col].astype(bool)
    frame["hour_of_day"] = frame["hour_of_day"].astype(int)
    frame["weekday_index"] = frame["weekday_index"].astype(int)
    for col in CATEGORICAL_COLUMNS:
        frame[col] = frame[col].astype("category")

    return frame[list(FEATURE_COLUMNS)]


def _level_from_zscore(predicted: float, mean: float, std: float) -> CongestionLevel:
    z = (predicted - mean) / std
    if z >= 2:
        return CongestionLevel.SEVERE
    if z >= 1:
        return CongestionLevel.HIGH
    if z >= 0:
        return CongestionLevel.MEDIUM
    return CongestionLevel.LOW


def _derive_reason(row: FeatureRow) -> str:
    reasons: list[str] = []
    if row.calendar.is_holiday:
        reasons.append("공휴일")
    elif row.calendar.is_weekend:
        reasons.append("주말")
    elif row.hour_of_day in (7, 8, 9, 18, 19):
        reasons.append("출퇴근시간")
    if row.weather.condition in ("rain", "rain_snow", "snow", "shower"):
        reasons.append("우천")
    if row.is_event_window:
        reasons.append("인근 이벤트")
    return "+".join(reasons) if reasons else "평시 패턴"


def predict_station_congestion(
    booster: lgb.Booster, feature_row: FeatureRow, baseline_mean: float, baseline_std: float
) -> StationCongestion:
    frame = _feature_row_to_frame(feature_row)
    predicted_volume = float(booster.predict(frame)[0])
    level = _level_from_zscore(predicted_volume, baseline_mean, baseline_std)

    return StationCongestion(
        station_id=feature_row.station_id,
        timestamp=feature_row.timestamp,
        predicted_volume=max(0.0, predicted_volume),
        level=level,
        is_event_spike=feature_row.is_event_window,
        reason=_derive_reason(feature_row),
    )


def forecast_station_congestion(
    feature_store: FeatureStore,
    booster: lgb.Booster,
    baselines: pd.DataFrame,
    station_id: int,
    timestamps: Sequence[datetime],
    direction: str = "승차",
) -> CongestionForecast:
    mean, std = get_baseline(baselines, station_id, direction)
    horizon = [
        predict_station_congestion(
            booster, feature_store.assemble(station_id, ts, direction), mean, std
        )
        for ts in timestamps
    ]
    return CongestionForecast(station_id=station_id, horizon=horizon)
