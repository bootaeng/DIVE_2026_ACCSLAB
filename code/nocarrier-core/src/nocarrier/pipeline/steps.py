"""Individual, composable pipeline steps plus the load-once resource
bundle they run against — covers the results-producing components this
package ships: A/A' (congestion forecast), B (conflict score), C
(routing + alt-route complexity classifier), D (platform safety).
Persona/facility-recommendation and anything LLM-related are not
included — see ../../../README.md.

``load_pipeline_resources`` reads every trained artifact and processed
dataset exactly once. Every step function below is a thin, typed
wrapper around one real model/component call; ``api.py`` is the only
thing that composes them into a convenient public interface.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import lightgbm as lgb
import networkx as nx
import pandas as pd
import structlog

from nocarrier.common.config import NoCarrierSettings, get_settings
from nocarrier.contracts.predictions import (
    ConflictScore,
    CongestionLevel,
    PlatformSafetyFlag,
    RouteOption,
    StationCongestion,
)
from nocarrier.contracts.user import UserInput
from nocarrier.data.graph_builder import load_graph
from nocarrier.features.store import FeatureStore
from nocarrier.models.conflict.score import load_conflict_inputs, score_conflict
from nocarrier.models.congestion.predict import (
    get_baseline,
    load_congestion_artifacts,
    predict_station_congestion,
)
from nocarrier.models.routing.graph import build_elevator_availability
from nocarrier.models.routing.search import find_routes
from nocarrier.models.safety.flags import build_safety_flags, load_platform_gaps

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class PipelineResources:
    """Everything the A/A'/B/C/D steps need, loaded once. Construct via
    ``load_pipeline_resources`` — raises ``ModelNotTrainedError``/
    ``DataNotFoundError`` immediately if any trained artifact or
    processed dataset is missing, so a misconfigured deployment fails
    at startup rather than on the first real request.
    """

    station_graph: nx.Graph
    stations: pd.DataFrame
    feature_store: FeatureStore

    congestion_booster: lgb.Booster
    congestion_baselines: pd.DataFrame

    elevators: pd.DataFrame
    alt_routes: pd.DataFrame
    elevator_availability: dict[int, bool]
    safety_flags: dict[int, PlatformSafetyFlag]


def load_pipeline_resources(settings: NoCarrierSettings | None = None) -> PipelineResources:
    settings = settings or get_settings()
    processed = settings.paths.processed_dir

    station_graph = load_graph(str(processed / "station_graph.graphml"))
    stations = pd.read_csv(processed / "stations.csv")
    feature_store = FeatureStore.from_processed(settings)

    congestion_booster, congestion_baselines = load_congestion_artifacts(settings)
    elevators, alt_routes = load_conflict_inputs(settings)
    elevator_availability = build_elevator_availability(elevators)
    safety_flags = build_safety_flags(load_platform_gaps(settings))

    log.info("pipeline_resources_loaded", n_stations=len(stations))
    return PipelineResources(
        station_graph=station_graph,
        stations=stations,
        feature_store=feature_store,
        congestion_booster=congestion_booster,
        congestion_baselines=congestion_baselines,
        elevators=elevators,
        alt_routes=alt_routes,
        elevator_availability=elevator_availability,
        safety_flags=safety_flags,
    )


def station_name_lookup(stations: pd.DataFrame) -> dict[int, str]:
    """station_id -> 역명, from the same stations table every component
    already loads. Used to enrich results with human-readable names.
    """
    return dict(zip(stations["station_id"], stations["station_name"], strict=True))


def forecast_congestion_step(
    resources: PipelineResources, station_id: int, timestamp: datetime
) -> StationCongestion:
    """Component A (LightGBM, trained on real 2025 ridership — MAE 31.65,
    MAPE 18.16% on a chronological holdout) + Component A' (STL /
    S-H-ESD event-spike flag, folded into predict_station_congestion).
    """
    mean, std = get_baseline(resources.congestion_baselines, station_id, "승차")
    feature_row = resources.feature_store.assemble(station_id, timestamp, "승차")
    congestion = predict_station_congestion(resources.congestion_booster, feature_row, mean, std)
    name = station_name_lookup(resources.stations).get(station_id)
    return congestion.model_copy(update={"station_name": name})


def score_conflict_step(
    resources: PipelineResources, station_id: int, timestamp: datetime, level: CongestionLevel
) -> ConflictScore:
    """Component B — transparent weighted composite (elevator demand +
    capacity-inverse + alt-route-unavailable penalty; NOT a trained
    model — see config/models.yaml's conflict_score.weights and its
    comment on why luggage_load_estimate is weighted 0.0).
    """
    return score_conflict(station_id, timestamp, level, resources.elevators, resources.alt_routes)


def route_step(
    resources: PipelineResources,
    user: UserInput,
    *,
    origin_congestion: StationCongestion,
    destination_congestion: StationCongestion,
    k: int = 3,
) -> list[RouteOption]:
    """Component C — multi-criteria weighted graph search (Yen's
    algorithm over Dijkstra, networkx.shortest_simple_paths) over the
    real 114-station graph, folding in Component B's conflict score and
    Component D's platform-safety flags (via build_weighted_graph) plus
    the alt-route complexity classifier (via models/routing/complexity.py,
    invoked inside find_routes for any elevator-down segment on the path).
    Returns up to k ranked routes, each carrying `accessibility_risk`
    (0.0-1.0) — this is the number the merged dive-platform's Routing
    tab conflict score is built from.
    """
    conflict_scores = {
        user.origin_station: score_conflict_step(
            resources, user.origin_station, user.request_time, origin_congestion.level
        ),
        user.destination_station: score_conflict_step(
            resources, user.destination_station, user.request_time, destination_congestion.level
        ),
    }
    routes = find_routes(
        resources.station_graph,
        user.origin_station,
        user.destination_station,
        elevator_availability=resources.elevator_availability,
        safety_flags=resources.safety_flags,
        mobility_profile=user.mobility_profile,
        luggage_size=user.luggage_size,
        conflict_scores=conflict_scores,
        k=k,
    )
    names = station_name_lookup(resources.stations)
    return [
        route.model_copy(
            update={
                "segments": [
                    segment.model_copy(update={"station_name": names.get(segment.station_id)})
                    for segment in route.segments
                ]
            }
        )
        for route in routes
    ]
