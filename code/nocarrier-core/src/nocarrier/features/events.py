"""Event-calendar connector for 벡스코 and 사직구장 — the two venues the
team's planning report identifies as event-driven, rather than
tourism-driven, demand sources (Insight B: "관광 동선과 이벤트 동선의
이원화된 수요").

No verified, live event-calendar API is wired up. ``StubEventCalendarProvider``
reads an optional CSV at ``data/external/events.csv`` if a teammate has
populated one; otherwise it returns no events. It deliberately never
fabricates event dates — a hardcoded list of "real" 벡스코/사직구장 event
dates would be guessed data presented as fact, which is worse than
honestly having no feed yet.

Expected CSV columns: ``venue,start,end,impact_level`` where
``start``/``end`` are ISO-8601 datetimes and ``impact_level`` is one of
"low" | "medium" | "high".
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

import structlog

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class EventWindow:
    venue: str
    start: datetime
    end: datetime
    impact_level: str  # "low" | "medium" | "high"


class EventCalendarProvider(Protocol):
    def get_events(self, window_start: datetime, window_end: datetime) -> list[EventWindow]: ...


class StubEventCalendarProvider:
    """Reads ``data/external/events.csv`` if given a path and it
    exists; returns an empty list otherwise. Never fabricates events.
    """

    def __init__(self, csv_path: Path | None = None) -> None:
        self._csv_path = csv_path
        self._events: list[EventWindow] = self._load()

    def _load(self) -> list[EventWindow]:
        if self._csv_path is None or not self._csv_path.exists():
            return []
        events: list[EventWindow] = []
        with self._csv_path.open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                events.append(
                    EventWindow(
                        venue=row["venue"],
                        start=datetime.fromisoformat(row["start"]),
                        end=datetime.fromisoformat(row["end"]),
                        impact_level=row["impact_level"],
                    )
                )
        log.info("events_loaded", count=len(events), path=str(self._csv_path))
        return events

    def get_events(self, window_start: datetime, window_end: datetime) -> list[EventWindow]:
        return [e for e in self._events if e.start < window_end and e.end > window_start]
