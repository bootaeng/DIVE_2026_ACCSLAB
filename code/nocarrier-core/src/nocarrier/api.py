"""The public interface of nocarrier-core: two functions.

    from nocarrier.api import load_resources, predict_congestion, get_accessibility_routes

    resources = load_resources()                       # call once, reuse
    congestion = predict_congestion(resources, 113)     # Component A/A'
    routes = get_accessibility_routes(resources, 113, 203)  # Component B/C/D

No FastAPI, no LLM, no HTTP — plain Python functions returning typed
Pydantic objects (contracts/predictions.py), so this can be called
directly from any Python process (a script, a notebook, or another
team's own agent/orchestration code) or wrapped in whatever HTTP/RPC
layer that codebase already uses.

See ../README.md for exactly what is and isn't included in this
package, and why.
"""

from __future__ import annotations

from datetime import datetime
from functools import lru_cache

from nocarrier.common.config import NoCarrierSettings, get_settings
from nocarrier.contracts.predictions import RouteOption, StationCongestion
from nocarrier.contracts.user import LuggageSize, MobilityProfile, UserInput
from nocarrier.pipeline.steps import (
    PipelineResources,
    forecast_congestion_step,
    load_pipeline_resources,
    route_step,
)

__all__ = ["load_resources", "predict_congestion", "get_accessibility_routes", "PipelineResources"]


@lru_cache
def load_resources(settings: NoCarrierSettings | None = None) -> PipelineResources:
    """Loads every trained artifact and processed dataset exactly once
    (cached — cheap to call this repeatedly from your own code; the
    real I/O only happens on the first call). Raises immediately if an
    artifact/dataset is missing, so a bad deployment fails loudly at
    startup rather than on the first real request.
    """
    return load_pipeline_resources(settings or get_settings())


def predict_congestion(
    resources: PipelineResources, station_id: int, timestamp: datetime | None = None
) -> StationCongestion:
    """Component A (LightGBM congestion forecast, trained on real 2025
    ridership — MAE 31.65, MAPE 18.16% on a chronological holdout) +
    Component A' (STL event-spike flag). `timestamp` defaults to now.
    """
    return forecast_congestion_step(resources, station_id, timestamp or datetime.now())


def get_accessibility_routes(
    resources: PipelineResources,
    origin_station: int,
    destination_station: int,
    *,
    mobility_profile: MobilityProfile | str = MobilityProfile.NONE,
    luggage_size: LuggageSize | str = LuggageSize.NONE,
    has_luggage: bool = False,
    k: int = 3,
) -> list[RouteOption]:
    """Components B (conflict score) + C (routing + LightGBM alt-route
    complexity classifier, 89.3% accuracy / macro F1 0.775 on real
    labeled data) + D (platform safety flags), combined into up to `k`
    ranked routes. Each RouteOption.accessibility_risk (0.0-1.0) is the
    single number worth reading if you only want one score per route —
    it's what dive-platform's merged gateway uses as its conflict score
    when this backend is reachable.

    `origin_station`/`destination_station` are 역번호 (station_id) —
    see data/processed/stations.csv for the id/name table. Raises
    `nocarrier.common.exceptions.RouteNotFoundError` if no path exists
    (e.g. same station twice, or an unknown id).
    """
    user = UserInput(
        origin_station=origin_station,
        destination_station=destination_station,
        mobility_profile=MobilityProfile(mobility_profile),
        has_luggage=has_luggage,
        luggage_size=LuggageSize(luggage_size),
    )
    origin_congestion = predict_congestion(resources, origin_station, user.request_time)
    destination_congestion = predict_congestion(resources, destination_station, user.request_time)
    return route_step(
        resources,
        user,
        origin_congestion=origin_congestion,
        destination_congestion=destination_congestion,
        k=k,
    )
