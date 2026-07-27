"""Component B: elevator resource-conflict index.

A transparent weighted composite, NOT a trained model — per
``AI_Pipeline_Strategy.md`` §Component B: "the honest, defensible
version for a hackathon is the engineered index".

    score = w_demand   * congestion_risk
          + w_luggage  * luggage_load_estimate   (0.0 by default)
          + w_capacity * elevator_redundancy_risk
          + w_altroute * alt_route_unavailable_risk

* ``congestion_risk`` — Component A's ``CongestionLevel``, mapped onto
  a 0-1 scale so every term shares the same units.
* ``luggage_load_estimate`` is wired through the formula but defaults
  to weight 0.0: no dataset ties actual 짐캐리 luggage volume to a
  station/hour today, so estimating it would be fabricated, not
  measured (see ``config/models.yaml``'s comment on this weight).
* ``elevator_redundancy_risk`` and ``alt_route_unavailable_risk`` are
  both computed from real Phase 1 data (``elevators.csv``,
  ``elevator_alt_routes.csv``).
"""

from __future__ import annotations

from datetime import datetime

import pandas as pd
import structlog

from nocarrier.common.config import NoCarrierSettings, get_settings, load_yaml
from nocarrier.common.exceptions import DataNotFoundError
from nocarrier.contracts.predictions import ConflictScore, CongestionLevel

log = structlog.get_logger(__name__)

_CONGESTION_RISK: dict[CongestionLevel, float] = {
    CongestionLevel.LOW: 0.0,
    CongestionLevel.MEDIUM: 0.33,
    CongestionLevel.HIGH: 0.66,
    CongestionLevel.SEVERE: 1.0,
}

DEFAULT_WEIGHTS: dict[str, float] = {
    "predicted_elevator_demand": 0.5,
    "luggage_load_estimate": 0.0,
    "capacity_inverse": 0.3,
    "alt_route_unavailable_penalty": 0.2,
}

# Station-level operational-elevator count considered "full redundancy"
# (no conflict risk from capacity alone). 113/114 stations have
# elevator data; the real per-station count ranges 1-10, median 4 —
# see docs/DATA_DICTIONARY.md.
FULL_REDUNDANCY_ELEVATOR_COUNT = 4

SEVERE_THRESHOLD = 0.75
HIGH_THRESHOLD = 0.5
MEDIUM_THRESHOLD = 0.25


def load_conflict_weights(models_config_path: str = "config/models.yaml") -> dict[str, float]:
    config = load_yaml(models_config_path)
    configured = config.get("conflict_score", {}).get("weights", {})
    return {**DEFAULT_WEIGHTS, **configured}


def elevator_redundancy_risk(elevators_at_station: pd.DataFrame) -> float:
    """0.0 = at least ``FULL_REDUNDANCY_ELEVATOR_COUNT`` operational
    elevators; 1.0 = none operational (or no elevator data at all).
    """
    if elevators_at_station.empty:
        return 1.0
    operational = int((elevators_at_station["status"] == "운행").sum())
    return max(0.0, 1.0 - operational / FULL_REDUNDANCY_ELEVATOR_COUNT)


def alt_route_risk(alt_routes_at_station: pd.DataFrame) -> float:
    """0.0 = simple labeled alternative exists; 1.0 = no alternative
    exists for at least one elevator at this station (경로복잡도등급
    == 이동 불가); 0.5 = no labeled coverage for this station at all
    (unknown, treated as moderate risk rather than assumed safe).
    """
    if alt_routes_at_station.empty:
        return 0.5
    if (alt_routes_at_station["route_available"] == "N").any():
        return 1.0
    max_complexity = alt_routes_at_station["complexity_score"].max()
    if pd.isna(max_complexity):
        return 0.5
    return float(max_complexity) / 10.0


def _level_from_score(score: float) -> CongestionLevel:
    if score >= SEVERE_THRESHOLD:
        return CongestionLevel.SEVERE
    if score >= HIGH_THRESHOLD:
        return CongestionLevel.HIGH
    if score >= MEDIUM_THRESHOLD:
        return CongestionLevel.MEDIUM
    return CongestionLevel.LOW


def _contributing_factors(
    congestion_level: CongestionLevel,
    demand_risk: float,
    elevators_at_station: pd.DataFrame,
    alt_routes_at_station: pd.DataFrame,
) -> list[str]:
    factors = [f"혼잡도 {congestion_level.value} (기여도 {demand_risk:.2f})"]

    n_total = len(elevators_at_station)
    n_operational = int((elevators_at_station["status"] == "운행").sum()) if n_total else 0
    factors.append(f"운행 중 엘리베이터 {n_operational}/{n_total}대")

    if alt_routes_at_station.empty:
        factors.append("대체경로 라벨 데이터 없음 (커버리지 불명)")
    elif (alt_routes_at_station["route_available"] == "N").any():
        factors.append("일부 방향 대체경로 없음 (이동 불가)")
    else:
        max_complexity = alt_routes_at_station["complexity_score"].max()
        if pd.notna(max_complexity):
            factors.append(f"대체경로 최대 복잡도 {max_complexity:.0f}/10")

    return factors


def score_conflict(
    station_id: int,
    timestamp: datetime,
    congestion_level: CongestionLevel,
    elevators: pd.DataFrame,
    alt_routes: pd.DataFrame,
    *,
    weights: dict[str, float] | None = None,
) -> ConflictScore:
    """``elevators``/``alt_routes`` are the full processed
    ``elevators.csv`` / ``elevator_alt_routes.csv`` tables — filtered
    internally to this station.
    """
    weights = weights or load_conflict_weights()

    at_station_elevators = elevators[elevators["station_id"] == station_id]
    at_station_alt = alt_routes[alt_routes["station_id"] == station_id]

    demand_risk = _CONGESTION_RISK[congestion_level]
    redundancy_risk = elevator_redundancy_risk(at_station_elevators)
    route_risk = alt_route_risk(at_station_alt)
    luggage_risk = 0.0  # see module docstring: no data to back this yet

    raw_score = (
        weights["predicted_elevator_demand"] * demand_risk
        + weights["luggage_load_estimate"] * luggage_risk
        + weights["capacity_inverse"] * redundancy_risk
        + weights["alt_route_unavailable_penalty"] * route_risk
    )
    score = max(0.0, min(1.0, raw_score))

    return ConflictScore(
        station_id=station_id,
        timestamp=timestamp,
        score=score,
        level=_level_from_score(score),
        contributing_factors=_contributing_factors(
            congestion_level, demand_risk, at_station_elevators, at_station_alt
        ),
    )


def load_conflict_inputs(
    settings: NoCarrierSettings | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    settings = settings or get_settings()
    processed = settings.paths.processed_dir
    elevators_path = processed / "elevators.csv"
    alt_routes_path = processed / "elevator_alt_routes.csv"
    if not elevators_path.exists() or not alt_routes_path.exists():
        raise DataNotFoundError(
            f"Missing elevators/alt-routes data in {processed} — run `make data` first."
        )
    return pd.read_csv(elevators_path), pd.read_csv(alt_routes_path)
