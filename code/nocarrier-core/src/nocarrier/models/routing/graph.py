"""Component C support: layers accessibility and risk costs onto the
Phase 1 base station graph (``data/graph_builder.py``) to produce the
weighted graph that ``search.py`` runs shortest-path search over.

The base graph is physical topology only — ``adjacent`` edges (real
haversine distance between consecutive stations on a line) and
``transfer`` edges (same station name across lines, fixed 5-minute
walk). This module never edits that file; it decorates a copy for
routing.

Scope note (documented, not silently assumed): the base graph models
stations as single nodes, not station-internal geometry (entrances,
concourse levels, in-station elevator banks). So "does this station
have an operational elevator" is a station-level signal here, not a
verified step-free path from platform to street — accurate enough to
steer the search and warn the traveler, but not a guarantee. The
labeled 대체경로 data (Component C's complexity classifier) is the
more precise signal for a specific elevator-failure detour.
"""

from __future__ import annotations

import networkx as nx
import pandas as pd
import structlog

from nocarrier.common.config import load_yaml
from nocarrier.contracts.predictions import ConflictScore, PlatformSafetyFlag
from nocarrier.contracts.user import LuggageSize, MobilityProfile

log = structlog.get_logger(__name__)

# Documented engineering estimate, not fabricated data: Busan Metro's
# published average operating speed including station dwell time is
# roughly 32-35 km/h. Combined with each edge's real haversine
# distance (verified in Phase 1's graph_builder.py, mean ~0.91 km
# between adjacent stations) this gives a defensible per-hop ride-time
# estimate. Refine with real scheduled run-time tables if the team
# obtains them — same spirit as graph_builder.py's TRANSFER_WALK_MINUTES.
TRAIN_SPEED_KMH = 32.0
STATION_DWELL_MINUTES = 0.5

# A maximally risky hop (accessibility_risk or conflict_risk == 1.0)
# costs as much extra, in minutes-equivalent, as this many minutes of
# unwanted detour/wait — keeps the weighted sum in one comparable unit.
RISK_PENALTY_SCALE_MINUTES = 20.0
CONFLICT_PENALTY_SCALE_MINUTES = 15.0

DEFAULT_COST_WEIGHTS: dict[str, float] = {
    "time": 0.5,
    "accessibility_risk": 0.35,
    "conflict_score": 0.15,
}

_GAP_RISK: dict[str, float] = {"좁음": 0.0, "보통": 0.5, "넓음": 1.0}


def load_cost_weights(models_config_path: str = "config/models.yaml") -> dict[str, float]:
    config = load_yaml(models_config_path)
    configured = config.get("routing", {}).get("cost_weights", {})
    return {**DEFAULT_COST_WEIGHTS, **configured}


def requires_step_free(mobility_profile: MobilityProfile, luggage_size: LuggageSize) -> bool:
    if mobility_profile in (
        MobilityProfile.WHEELCHAIR,
        MobilityProfile.STROLLER,
        MobilityProfile.ELDERLY,
    ):
        return True
    return luggage_size in (LuggageSize.LARGE, LuggageSize.EXTRA_LARGE)


def platform_risk(flag: PlatformSafetyFlag | None) -> float:
    if flag is None:
        return 0.0
    risk = _GAP_RISK.get(flag.platform_gap, 0.5)
    if flag.is_curved:
        risk = min(1.0, risk + 0.25)
    return risk


def build_elevator_availability(elevators: pd.DataFrame) -> dict[int, bool]:
    """``station_id -> has at least one operational (운행) elevator``,
    for every station present in ``elevators`` (113/114 in the real
    data — the one missing station has no elevator dataset row at
    all, so callers should ``.get(station_id, False)`` rather than
    assume every station is covered).
    """
    all_ids = {int(sid) for sid in elevators["station_id"].unique()}
    operational_ids = {
        int(sid) for sid in elevators.loc[elevators["status"] == "운행", "station_id"].unique()
    }
    return {sid: sid in operational_ids for sid in all_ids}


def build_weighted_graph(
    base_graph: nx.Graph,
    *,
    elevator_availability: dict[int, bool],
    safety_flags: dict[int, PlatformSafetyFlag],
    mobility_profile: MobilityProfile = MobilityProfile.NONE,
    luggage_size: LuggageSize = LuggageSize.NONE,
    conflict_scores: dict[int, ConflictScore] | None = None,
    cost_weights: dict[str, float] | None = None,
) -> nx.Graph:
    """Returns a new graph (``base_graph`` is untouched) with a scalar
    ``cost`` edge attribute combining ride/walk time, accessibility
    risk, and (if supplied) Component B conflict scores — the input
    ``search.py`` runs shortest-path search over.

    ``conflict_scores`` is optional: routing works from accessibility
    infrastructure data alone (Phase 4 depends on Phase 2, not Phase
    3, per the blueprint's phase-dependency graph); pass Component A/B
    outputs in when available to sharpen the ranking.
    """
    weights = cost_weights or load_cost_weights()
    needs_step_free = requires_step_free(mobility_profile, luggage_size)
    conflict_scores = conflict_scores or {}

    graph: nx.Graph = nx.Graph()
    graph.add_nodes_from(base_graph.nodes(data=True))

    for u, v, data in base_graph.edges(data=True):
        edge_type = data.get("type")
        if edge_type == "adjacent":
            time_minutes = data["distance_km"] / TRAIN_SPEED_KMH * 60 + STATION_DWELL_MINUTES
        else:  # transfer
            time_minutes = float(data.get("walk_minutes", 5.0))

        risk_sum = 0.0
        conflict_sum = 0.0
        for station_id in (u, v):
            risk_sum += platform_risk(safety_flags.get(station_id))
            if needs_step_free and not elevator_availability.get(station_id, False):
                risk_sum += 0.5
            cs = conflict_scores.get(station_id)
            if cs is not None:
                conflict_sum += cs.score

        accessibility_risk = min(1.0, risk_sum / 2)
        conflict_risk = min(1.0, conflict_sum / 2)

        cost = (
            weights["time"] * time_minutes
            + weights["accessibility_risk"] * accessibility_risk * RISK_PENALTY_SCALE_MINUTES
            + weights["conflict_score"] * conflict_risk * CONFLICT_PENALTY_SCALE_MINUTES
        )

        graph.add_edge(
            u,
            v,
            type=edge_type,
            time_minutes=time_minutes,
            accessibility_risk=accessibility_risk,
            conflict_risk=conflict_risk,
            cost=cost,
        )

    return graph
