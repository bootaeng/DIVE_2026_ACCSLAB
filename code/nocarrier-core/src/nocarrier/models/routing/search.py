"""Component C: multi-criteria route search.

Runs ranked shortest-path search (``networkx.shortest_simple_paths``,
Yen's algorithm over Dijkstra) on the accessibility-and-risk-weighted
graph from ``graph.py`` and turns each path into a typed
``RouteOption``. The single scalar edge weight (``cost``) already
blends time, accessibility risk, and conflict risk per
``config/models.yaml``'s ``routing.cost_weights`` — that's the
"multi-criteria" part; the search itself is plain shortest-path,
matching ``AI_Pipeline_Strategy.md``'s recommendation against a GNN.

Warnings and the ``step_free`` flag are only evaluated at *actionable*
stations on the path — the origin, the destination, and both ends of
any transfer hop — not every station a train happens to stop at along
the way, since a traveler staying on board never needs that station's
elevator or platform gap.
"""

from __future__ import annotations

from itertools import islice

import networkx as nx
import structlog

from nocarrier.common.exceptions import RouteNotFoundError
from nocarrier.contracts.predictions import (
    ConflictScore,
    CongestionLevel,
    PlatformSafetyFlag,
    RouteOption,
    RouteSegment,
    RouteSegmentType,
    RouteWarning,
)
from nocarrier.contracts.user import LuggageSize, MobilityProfile
from nocarrier.models.routing.graph import build_weighted_graph, requires_step_free

log = structlog.get_logger(__name__)

DEFAULT_K_ROUTES = 3


def find_routes(
    base_graph: nx.Graph,
    origin_station: int,
    destination_station: int,
    *,
    elevator_availability: dict[int, bool],
    safety_flags: dict[int, PlatformSafetyFlag],
    mobility_profile: MobilityProfile = MobilityProfile.NONE,
    luggage_size: LuggageSize = LuggageSize.NONE,
    conflict_scores: dict[int, ConflictScore] | None = None,
    k: int = DEFAULT_K_ROUTES,
) -> list[RouteOption]:
    if origin_station not in base_graph or destination_station not in base_graph:
        raise RouteNotFoundError(f"Unknown station id(s): {origin_station}, {destination_station}")
    if origin_station == destination_station:
        raise RouteNotFoundError("Origin and destination are the same station")

    conflict_scores = conflict_scores or {}
    graph = build_weighted_graph(
        base_graph,
        elevator_availability=elevator_availability,
        safety_flags=safety_flags,
        mobility_profile=mobility_profile,
        luggage_size=luggage_size,
        conflict_scores=conflict_scores,
    )

    try:
        paths_iter = nx.shortest_simple_paths(
            graph, origin_station, destination_station, weight="cost"
        )
        paths = list(islice(paths_iter, k))
    except nx.NetworkXNoPath as exc:
        raise RouteNotFoundError(
            f"No path between {origin_station} and {destination_station}"
        ) from exc

    if not paths:
        raise RouteNotFoundError(f"No path between {origin_station} and {destination_station}")

    needs_step_free = requires_step_free(mobility_profile, luggage_size)
    return [
        _path_to_route_option(
            graph,
            path,
            rank=i,
            needs_step_free=needs_step_free,
            elevator_availability=elevator_availability,
            safety_flags=safety_flags,
            conflict_scores=conflict_scores,
        )
        for i, path in enumerate(paths)
    ]


def _station_label(graph: nx.Graph, station_id: int) -> str:
    name = graph.nodes[station_id].get("name")
    return str(name) if name else str(station_id)


def _actionable_stations(graph: nx.Graph, path: list[int]) -> set[int]:
    """Origin, destination, and both ends of any transfer hop — the
    stations where the traveler actually gets on/off/changes lines,
    as opposed to a station the train merely stops at en route.
    """
    actionable = {path[0], path[-1]}
    for i in range(len(path) - 1):
        u, v = path[i], path[i + 1]
        if graph[u][v].get("type") == "transfer":
            actionable.add(u)
            actionable.add(v)
    return actionable


def _build_segments(
    graph: nx.Graph, path: list[int], elevator_availability: dict[int, bool]
) -> tuple[list[RouteSegment], float]:
    segments: list[RouteSegment] = []
    eta_minutes = 0.0
    for i in range(len(path) - 1):
        u, v = path[i], path[i + 1]
        edge = graph[u][v]
        eta_minutes += float(edge["time_minutes"])

        if edge.get("type") == "adjacent":
            line = graph.nodes[v].get("line", "")
            segments.append(
                RouteSegment(
                    type=RouteSegmentType.TRAIN,
                    station_id=v,
                    detail=f"{line} 승차" if line else None,
                    step_free=True,
                )
            )
        else:
            has_elevator = elevator_availability.get(v, False)
            detail = "환승 이동" if has_elevator else "환승 이동 (운행 중인 엘리베이터 없음)"
            segments.append(
                RouteSegment(
                    type=RouteSegmentType.WALK,
                    station_id=v,
                    detail=detail,
                    step_free=has_elevator,
                )
            )
    return segments, eta_minutes


def _build_warnings(
    graph: nx.Graph,
    actionable: set[int],
    *,
    needs_step_free: bool,
    elevator_availability: dict[int, bool],
    safety_flags: dict[int, PlatformSafetyFlag],
    conflict_scores: dict[int, ConflictScore],
) -> list[RouteWarning]:
    warnings: list[RouteWarning] = []
    for station_id in actionable:
        label = _station_label(graph, station_id)

        if needs_step_free and not elevator_availability.get(station_id, False):
            warnings.append(
                RouteWarning(
                    message=f"{label}역에 운행 중인 엘리베이터가 없습니다",
                    severity=CongestionLevel.HIGH,
                )
            )

        flag = safety_flags.get(station_id)
        if flag is not None and flag.risk_note:
            warnings.append(
                RouteWarning(
                    message=f"{label}역: {flag.risk_note}", severity=CongestionLevel.MEDIUM
                )
            )

        cs = conflict_scores.get(station_id)
        if cs is not None and cs.level in (CongestionLevel.HIGH, CongestionLevel.SEVERE):
            warnings.append(
                RouteWarning(
                    message=f"{label}역 엘리베이터 혼잡 위험이 높습니다 ({cs.level.value})",
                    severity=cs.level,
                )
            )
    return warnings


def _path_to_route_option(
    graph: nx.Graph,
    path: list[int],
    *,
    rank: int,
    needs_step_free: bool,
    elevator_availability: dict[int, bool],
    safety_flags: dict[int, PlatformSafetyFlag],
    conflict_scores: dict[int, ConflictScore],
) -> RouteOption:
    segments, eta_minutes = _build_segments(graph, path, elevator_availability)
    actionable = _actionable_stations(graph, path)
    warnings = _build_warnings(
        graph,
        actionable,
        needs_step_free=needs_step_free,
        elevator_availability=elevator_availability,
        safety_flags=safety_flags,
        conflict_scores=conflict_scores,
    )

    risk_values = [graph[path[i]][path[i + 1]]["accessibility_risk"] for i in range(len(path) - 1)]
    accessibility_risk = sum(risk_values) / len(risk_values) if risk_values else 0.0

    all_step_free = not (
        needs_step_free and any(not elevator_availability.get(sid, False) for sid in actionable)
    )

    return RouteOption(
        id=f"route-{rank + 1}",
        eta_minutes=round(eta_minutes, 1),
        step_free=all_step_free,
        accessibility_risk=round(min(1.0, accessibility_risk), 3),
        segments=segments,
        warnings=warnings,
    )
