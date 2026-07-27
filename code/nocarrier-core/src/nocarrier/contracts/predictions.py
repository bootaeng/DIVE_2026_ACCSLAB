"""Outputs of the results-producing components: A/A' (congestion
forecast), B (conflict score), C (routing + alt-route complexity
classifier), D (platform safety flags).

Persona and facility-recommendation contracts, and anything LLM-related,
are deliberately not included here (see ../../../README.md) — this
package only produces structured results, not natural-language guidance.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field

# --- Component A / A' — congestion forecast + event-spike detection --------


class CongestionLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    SEVERE = "severe"


class StationCongestion(BaseModel):
    station_id: int
    station_name: str | None = Field(
        default=None,
        description="역명, filled in by pipeline/steps.py from resources.stations "
        "so the LLM can refer to the station by name instead of a bare "
        "역번호 — optional/None for any caller that doesn't have the "
        "station table on hand (e.g. direct unit construction in tests).",
    )
    timestamp: datetime
    predicted_volume: float = Field(..., description="Forecast boarding+alighting count")
    level: CongestionLevel
    is_event_spike: bool = Field(
        default=False, description="Flagged by the STL / S-H-ESD event detector"
    )
    reason: str | None = Field(
        default=None,
        description="Human-readable driver, e.g. '출근시간+우천' — surfaced to "
        "the LLM via ContextObject.congestion.",
    )


class CongestionForecast(BaseModel):
    station_id: int
    generated_at: datetime = Field(default_factory=datetime.now)
    horizon: list[StationCongestion] = Field(default_factory=list)


# --- Component B — elevator resource-conflict score -------------------------


class ConflictScore(BaseModel):
    station_id: int
    timestamp: datetime
    score: float = Field(..., ge=0.0, le=1.0)
    level: CongestionLevel
    contributing_factors: list[str] = Field(default_factory=list)


# --- Component D — platform safety flags -------------------------------------


class PlatformSafetyFlag(BaseModel):
    station_id: int
    platform_gap: str = Field(..., description="좁음 | 보통, from 승강장 간격 데이터")
    is_curved: bool
    risk_note: str | None = None


# --- Component C — barrier-free routing --------------------------------------


class RouteSegmentType(str, Enum):
    WALK = "walk"
    STAIRS = "stairs"
    ESCALATOR = "escalator"
    ELEVATOR = "elevator"
    TRAIN = "train"


class RouteSegment(BaseModel):
    type: RouteSegmentType
    station_id: int
    station_name: str | None = Field(
        default=None,
        description="역명 — see StationCongestion.station_name for why this "
        "exists (LLM-facing readability; optional for callers without the "
        "station table).",
    )
    detail: str | None = None
    step_free: bool = True


class RouteWarning(BaseModel):
    message: str
    severity: CongestionLevel = CongestionLevel.LOW


class RouteOption(BaseModel):
    id: str
    eta_minutes: float
    step_free: bool
    accessibility_risk: float = Field(..., ge=0.0, le=1.0)
    segments: list[RouteSegment] = Field(default_factory=list)
    warnings: list[RouteWarning] = Field(default_factory=list)
