"""Geospatial helper functions.

Pure math, no I/O. Used by the facility recommender (Component F, Phase
5) and the offsite-locker-to-nearest-station mapping (Phase 1).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import NamedTuple, TypeVar

from nocarrier.common.constants import EARTH_RADIUS_KM

IdT = TypeVar("IdT")


class Coordinate(NamedTuple):
    """A latitude/longitude pair, in degrees."""

    lat: float
    lon: float


def haversine_km(a: Coordinate, b: Coordinate) -> float:
    """Great-circle distance between two coordinates, in kilometers."""
    lat1, lon1 = math.radians(a.lat), math.radians(a.lon)
    lat2, lon2 = math.radians(b.lat), math.radians(b.lon)

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def nearest(point: Coordinate, candidates: Sequence[tuple[IdT, Coordinate]]) -> tuple[IdT, float]:
    """Return ``(id, distance_km)`` of the closest candidate to ``point``.

    ``candidates`` is a sequence of ``(id, Coordinate)`` pairs, e.g. every
    station's (역번호, Coordinate) — generic over the id type so callers
    can pass ``int`` station ids or ``str`` facility ids without a cast.
    This is a linear scan — fine for the ~114-station network; swap in a
    BallTree if this ever needs to scale to a much larger set of points.
    """
    if not candidates:
        raise ValueError("candidates must be non-empty")

    best_id, best_coord = candidates[0]
    best_dist = haversine_km(point, best_coord)

    for cand_id, coord in candidates[1:]:
        dist = haversine_km(point, coord)
        if dist < best_dist:
            best_id, best_dist = cand_id, dist

    return best_id, best_dist
