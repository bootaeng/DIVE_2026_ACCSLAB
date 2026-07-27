"""Component D: platform safety flags.

A deterministic lookup over the 승강장 간격 및 곡선구간 데이터 (Phase 1's
``platform_gaps.csv``) — no model involved, per
``AI_Pipeline_Strategy.md`` §Component D: "Deterministic flag table".

Risk ordering for the platform-train gap: a WIDE gap (넓음) is the real
accessibility hazard (a wheelchair caster or cane tip can drop into
it), not a narrow one, so 넓음 ranks worse than 좁음 here — this
matches the real data shape too (좁음 dominates at 4,632/4,864 rows,
i.e. most platforms are already safe; 넓음 is the rare, flagged case
at 43 rows). Curved platforms (곡선 / 완화곡선) widen the effective gap
on the outer rail and add to the risk.

Every station has several rows in the source data (one per up/down
direction and platform position), so we report the worst-case gap and
whether ANY position at that station is curved — a route through the
station could use either.
"""

from __future__ import annotations

import pandas as pd
import structlog

from nocarrier.common.config import NoCarrierSettings, get_settings
from nocarrier.common.exceptions import DataNotFoundError
from nocarrier.contracts.predictions import PlatformSafetyFlag

log = structlog.get_logger(__name__)

_GAP_RISK_ORDER: dict[str, int] = {"좁음": 0, "보통": 1, "넓음": 2}
_GAP_RISK_RANK_TO_LABEL: dict[int, str] = {v: k for k, v in _GAP_RISK_ORDER.items()}
_CURVED_SHAPES: tuple[str, ...] = ("곡선", "(완화)곡선")


def build_platform_safety_table(platform_gaps: pd.DataFrame) -> pd.DataFrame:
    """One row per ``station_id``: the worst-case ``gap_size`` and
    whether any platform position at that station is on a curve.
    """
    df = platform_gaps.copy()
    df["_gap_rank"] = df["gap_size"].map(_GAP_RISK_ORDER).fillna(1).astype(int)
    df["_is_curved"] = df["platform_shape"].isin(_CURVED_SHAPES)

    worst_rank = df.groupby("station_id")["_gap_rank"].max()
    any_curved = df.groupby("station_id")["_is_curved"].any()

    return pd.DataFrame(
        {
            "station_id": worst_rank.index,
            "gap_size": worst_rank.map(_GAP_RISK_RANK_TO_LABEL).to_numpy(),
            "is_curved": any_curved.reindex(worst_rank.index).to_numpy(),
        }
    ).reset_index(drop=True)


def _risk_note(gap_size: str, is_curved: bool) -> str | None:
    parts: list[str] = []
    if gap_size == "넓음":
        parts.append("승강장-열차 간격이 넓어 승하차 시 주의가 필요합니다")
    if is_curved:
        parts.append("곡선 구간으로 간격이 더 벌어질 수 있습니다")
    return " · ".join(parts) if parts else None


def _row_to_flag(row: pd.Series) -> PlatformSafetyFlag:
    gap_size = str(row["gap_size"])
    is_curved = bool(row["is_curved"])
    return PlatformSafetyFlag(
        station_id=int(row["station_id"]),
        platform_gap=gap_size,
        is_curved=is_curved,
        risk_note=_risk_note(gap_size, is_curved),
    )


def build_safety_flags(platform_gaps: pd.DataFrame) -> dict[int, PlatformSafetyFlag]:
    """station_id -> PlatformSafetyFlag, for every station with gap data."""
    table = build_platform_safety_table(platform_gaps)
    return {int(row.station_id): _row_to_flag(row) for _, row in table.iterrows()}


def load_platform_gaps(settings: NoCarrierSettings | None = None) -> pd.DataFrame:
    settings = settings or get_settings()
    path = settings.paths.processed_dir / "platform_gaps.csv"
    if not path.exists():
        raise DataNotFoundError(f"Missing {path} — run `make data` (Phase 1) first.")
    return pd.read_csv(path)


def get_platform_safety_flag(
    flags: dict[int, PlatformSafetyFlag], station_id: int
) -> PlatformSafetyFlag:
    flag = flags.get(station_id)
    if flag is not None:
        return flag
    log.warning("no_platform_safety_data", station_id=station_id)
    return PlatformSafetyFlag(station_id=station_id, platform_gap="알 수 없음", is_curved=False)
