"""Everything describing the person asking for help.

UserInput is the single entry point into the pipeline (see
pipeline/orchestrator.py, added in Phase 7) — every predictive
component and the LLM ultimately trace back to this object.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field, field_validator

from nocarrier.common.constants import SUPPORTED_LANGUAGES


class MobilityProfile(str, Enum):
    """Accessibility need driving routing constraints (Component C)."""

    NONE = "none"
    WHEELCHAIR = "wheelchair"
    STROLLER = "stroller"
    ELDERLY = "elderly"
    VISUAL_IMPAIRMENT = "visual_impairment"
    HEARING_IMPAIRMENT = "hearing_impairment"


class LuggageSize(str, Enum):
    NONE = "none"
    SMALL = "small"
    MEDIUM = "medium"
    LARGE = "large"
    EXTRA_LARGE = "extra_large"


class UserInput(BaseModel):
    """A single travel-assistance request."""

    origin_station: int = Field(..., description="역번호 of the starting station")
    destination_station: int = Field(..., description="역번호 of the destination station")

    origin_station_name: str | None = Field(
        default=None,
        description="역명, filled in by pipeline/orchestrator.py from "
        "resources.stations so the LLM can refer to the trip by station "
        "name instead of a bare 역번호 — optional/None for any caller "
        "that doesn't have the station table on hand (e.g. direct "
        "UserInput construction in tests).",
    )
    destination_station_name: str | None = Field(default=None, description="역명 — see origin_station_name")

    mobility_profile: MobilityProfile = MobilityProfile.NONE
    has_luggage: bool = False
    luggage_size: LuggageSize = LuggageSize.NONE

    free_hours: float | None = Field(
        default=None,
        ge=0,
        description="Hours the traveler has free before needing to be "
        "somewhere else — drives Module 3 local nudges.",
    )

    language: str = "ko"
    nationality_hint: str | None = Field(
        default=None,
        description='"domestic" | "foreign" | None if unknown; informs '
        "persona assignment (Component E) alongside inferred signals.",
    )

    request_time: datetime = Field(default_factory=datetime.now)

    @field_validator("language")
    @classmethod
    def _language_supported(cls, v: str) -> str:
        if v not in SUPPORTED_LANGUAGES:
            raise ValueError(f"Unsupported language '{v}'. Supported: {SUPPORTED_LANGUAGES}")
        return v
