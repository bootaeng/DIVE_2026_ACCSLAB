"""Build the base topological station graph.

Two edge types:

* **adjacent** — consecutive 역번호 within a line. Verified against the
  real station data before writing this: within each line, ascending
  station_id tracks smoothly changing coordinates, i.e. station numbers
  really do follow physical position along the line.
* **transfer** — stations that share a station_name across two lines.
  Verified against the real data: exactly six such pairs exist (서면,
  연산, 동래, 수영, 덕천, 미남), matching the transfer stations named in
  the team's planning report.

This is the *base* graph — physical topology only. Component C (Phase
4) builds a richer weighted graph on top of this one, layering in
elevator status, congestion, and conflict scores as dynamic edge costs.
"""

from __future__ import annotations

import networkx as nx
import pandas as pd
import structlog

from nocarrier.common.geo import Coordinate, haversine_km

log = structlog.get_logger(__name__)

# Placeholder proxy for inter-line transfer walking time. Refine with a
# real per-station-pair transfer-time dataset if one becomes available.
TRANSFER_WALK_MINUTES = 5.0


def build_station_graph(stations: pd.DataFrame) -> nx.Graph:
    """``stations`` must be the cleaned table: station_id (int),
    line_name, station_name, lat (float), lon (float).
    """
    graph: nx.Graph = nx.Graph()

    for row in stations.itertuples(index=False):
        graph.add_node(
            row.station_id,
            name=row.station_name,
            line=row.line_name,
            lat=row.lat,
            lon=row.lon,
        )

    _add_line_adjacency_edges(graph, stations)
    _add_transfer_edges(graph, stations)

    log.info(
        "station_graph_built",
        nodes=graph.number_of_nodes(),
        edges=graph.number_of_edges(),
    )
    return graph


def _add_line_adjacency_edges(graph: nx.Graph, stations: pd.DataFrame) -> None:
    for _line_name, group in stations.groupby("line_name"):
        ordered = group.sort_values("station_id")
        ids = ordered["station_id"].tolist()
        coords = [Coordinate(row.lat, row.lon) for row in ordered.itertuples(index=False)]
        for i in range(len(ids) - 1):
            dist_km = haversine_km(coords[i], coords[i + 1])
            graph.add_edge(ids[i], ids[i + 1], type="adjacent", distance_km=dist_km)


def _add_transfer_edges(graph: nx.Graph, stations: pd.DataFrame) -> None:
    for _station_name, group in stations.groupby("station_name"):
        if len(group) < 2:
            continue
        ids = group["station_id"].tolist()
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                graph.add_edge(ids[i], ids[j], type="transfer", walk_minutes=TRANSFER_WALK_MINUTES)


def save_graph(graph: nx.Graph, path: str) -> None:
    nx.write_graphml(graph, path)


def load_graph(path: str) -> nx.Graph:
    graph: nx.Graph = nx.read_graphml(path, node_type=int)
    return graph
