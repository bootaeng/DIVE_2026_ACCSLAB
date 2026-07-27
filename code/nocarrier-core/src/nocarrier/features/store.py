"""The feature store: assembles one complete, typed feature row for a
(station_id, timestamp, direction) triple from ridership history,
calendar, weather, and event-calendar signals.

This is the single seam between raw processed data (Phase 1) and every
predictive model (Phase 3+) — a model should never reach into
data/processed/ directly; it asks the FeatureStore for a row.

Lag/rolling definitions mirror lags.py exactly (same leakage-free
semantics) but are computed as single-point lookups here, since this
class is built for one-row-at-a-time online inference — the API will
call ``assemble()`` once per user request. Phase 3's bulk training-set
construction should call lags.py's vectorized functions directly on
the full ridership_long table instead; calling this class in a
training loop would be far slower.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime

import pandas as pd
import structlog

from nocarrier.common.config import NoCarrierSettings, get_settings
from nocarrier.common.exceptions import ConfigError, DataNotFoundError
from nocarrier.features.calendar import (
    CalendarFeatures,
    HolidayProvider,
    StaticHolidayProvider,
    compute_calendar_features,
)
from nocarrier.features.events import EventCalendarProvider, EventWindow, StubEventCalendarProvider
from nocarrier.features.weather import (
    KmaWeatherProvider,
    StubWeatherProvider,
    WeatherObservation,
    WeatherProvider,
)

log = structlog.get_logger(__name__)

DEFAULT_ROLLING_WINDOWS_DAYS: tuple[int, ...] = (7, 28)


@dataclass(frozen=True)
class FeatureRow:
    station_id: int
    direction: str
    timestamp: datetime

    hour_of_day: int
    calendar: CalendarFeatures

    lag_1d_count: float | None
    lag_7d_count: float | None
    rolling_mean_7d: float | None
    rolling_mean_28d: float | None

    weather: WeatherObservation
    active_events: list[EventWindow]

    @property
    def is_event_window(self) -> bool:
        return len(self.active_events) > 0

    def to_dict(self) -> dict[str, object]:
        """Flat representation suitable for feeding a model or writing
        to a row of a training DataFrame.
        """
        return {
            "station_id": self.station_id,
            "direction": self.direction,
            "timestamp": self.timestamp,
            "hour_of_day": self.hour_of_day,
            "weekday_index": self.calendar.weekday_index,
            "is_weekend": self.calendar.is_weekend,
            "is_holiday": self.calendar.is_holiday,
            "day_type": self.calendar.day_type,
            "lag_1d_count": self.lag_1d_count,
            "lag_7d_count": self.lag_7d_count,
            "rolling_mean_7d": self.rolling_mean_7d,
            "rolling_mean_28d": self.rolling_mean_28d,
            "temperature_c": self.weather.temperature_c,
            "precipitation_mm": self.weather.precipitation_mm,
            "weather_condition": self.weather.condition,
            "is_event_window": self.is_event_window,
        }


class FeatureStore:
    def __init__(
        self,
        ridership_long: pd.DataFrame,
        stations: pd.DataFrame,
        *,
        holiday_provider: HolidayProvider | None = None,
        weather_provider: WeatherProvider | None = None,
        event_provider: EventCalendarProvider | None = None,
        rolling_windows_days: tuple[int, ...] = DEFAULT_ROLLING_WINDOWS_DAYS,
    ) -> None:
        self._stations = stations.set_index("station_id")
        self._holiday_provider: HolidayProvider = holiday_provider or StaticHolidayProvider()
        self._weather_provider: WeatherProvider = weather_provider or StubWeatherProvider()
        self._event_provider: EventCalendarProvider = event_provider or StubEventCalendarProvider()
        self._rolling_windows_days = rolling_windows_days
        self._index = _build_series_index(ridership_long)

    @classmethod
    def from_processed(
        cls,
        settings: NoCarrierSettings | None = None,
        *,
        holiday_provider: HolidayProvider | None = None,
        weather_provider: WeatherProvider | None = None,
        event_provider: EventCalendarProvider | None = None,
        rolling_windows_days: tuple[int, ...] | None = None,
    ) -> FeatureStore:
        """Build a FeatureStore from ``data/processed/`` (Phase 1's
        output), wiring real vs. stub weather/event providers according
        to ``feature_flags.use_external_weather`` / ``use_external_events``
        unless the caller passes an explicit provider.
        """
        settings = settings or get_settings()
        processed_dir = settings.paths.processed_dir

        ridership_path = processed_dir / "ridership_long.parquet"
        stations_path = processed_dir / "stations.csv"
        if not ridership_path.exists() or not stations_path.exists():
            raise DataNotFoundError(
                f"Expected {ridership_path} and {stations_path} — run `make data` "
                "(Phase 1) before building the feature store."
            )

        ridership_long = pd.read_parquet(ridership_path)
        stations = pd.read_csv(stations_path)

        if weather_provider is None:
            weather_provider = _default_weather_provider(settings)
        if event_provider is None:
            event_provider = _default_event_provider(settings)
        resolved_windows = rolling_windows_days or tuple(settings.features.rolling_windows_days)

        return cls(
            ridership_long,
            stations,
            holiday_provider=holiday_provider,
            weather_provider=weather_provider,
            event_provider=event_provider,
            rolling_windows_days=resolved_windows,
        )

    def assemble(self, station_id: int, timestamp: datetime, direction: str = "승차") -> FeatureRow:
        hour_of_day = timestamp.hour
        calendar_features = compute_calendar_features(timestamp, self._holiday_provider)

        target_date = timestamp.date()
        lag_1d = self._lookup_count(
            station_id, direction, target_date - pd.Timedelta(days=1), hour_of_day
        )
        lag_7d = self._lookup_count(
            station_id, direction, target_date - pd.Timedelta(days=7), hour_of_day
        )
        rolling = {
            w: self._rolling_mean(station_id, direction, hour_of_day, target_date, w)
            for w in self._rolling_windows_days
        }

        lat, lon = self._station_coords(station_id)
        weather = self._weather_provider.get_weather(lat, lon, timestamp)
        events = self._event_provider.get_events(timestamp, timestamp)

        return FeatureRow(
            station_id=station_id,
            direction=direction,
            timestamp=timestamp,
            hour_of_day=hour_of_day,
            calendar=calendar_features,
            lag_1d_count=lag_1d,
            lag_7d_count=lag_7d,
            rolling_mean_7d=rolling.get(7),
            rolling_mean_28d=rolling.get(28),
            weather=weather,
            active_events=events,
        )

    def _station_coords(self, station_id: int) -> tuple[float, float]:
        if station_id not in self._stations.index:
            log.warning("station_not_found_for_weather", station_id=station_id)
            return 0.0, 0.0
        row = self._stations.loc[station_id]
        return float(row["lat"]), float(row["lon"])

    def _lookup_count(
        self, station_id: int, direction: str, target_date: object, hour_of_day: int
    ) -> float | None:
        pivot = self._index.get((station_id, direction))
        if pivot is None:
            return None
        ts = pd.Timestamp(target_date)
        if ts not in pivot.index or hour_of_day not in pivot.columns:
            return None
        val = pivot.loc[ts, hour_of_day]
        return None if pd.isna(val) else float(val)

    def _rolling_mean(
        self,
        station_id: int,
        direction: str,
        hour_of_day: int,
        end_date: object,
        window_days: int,
    ) -> float | None:
        pivot = self._index.get((station_id, direction))
        if pivot is None or hour_of_day not in pivot.columns:
            return None
        end_ts = pd.Timestamp(end_date)
        start_ts = end_ts - pd.Timedelta(days=window_days)
        mask = (pivot.index >= start_ts) & (pivot.index < end_ts)
        values = pivot.loc[mask, hour_of_day].dropna()
        return float(values.mean()) if len(values) else None


def _build_series_index(ridership_long: pd.DataFrame) -> dict[tuple[int, str], pd.DataFrame]:
    index: dict[tuple[int, str], pd.DataFrame] = {}
    for (station_id, direction), group in ridership_long.groupby(["station_id", "direction"]):
        pivot = group.pivot(index="date", columns="hour_of_day", values="count").sort_index()
        index[(station_id, direction)] = pivot
    return index


def _default_weather_provider(settings: NoCarrierSettings) -> WeatherProvider:
    if not settings.feature_flags.use_external_weather:
        return StubWeatherProvider()
    api_key = os.environ.get("KMA_WEATHER_API_KEY")
    if not api_key:
        raise ConfigError(
            "feature_flags.use_external_weather is enabled but KMA_WEATHER_API_KEY "
            "is not set (see .env.example)."
        )
    return KmaWeatherProvider(api_key=api_key)


def _default_event_provider(settings: NoCarrierSettings) -> EventCalendarProvider:
    if not settings.feature_flags.use_external_events:
        return StubEventCalendarProvider(csv_path=None)
    return StubEventCalendarProvider(csv_path=settings.paths.external_dir / "events.csv")
