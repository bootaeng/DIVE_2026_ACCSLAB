"""Shared artifact-versioning conventions for predictive components.

Every component's ``train.py`` writes a versioned artifact file plus a
JSON metadata sidecar into ``artifacts/<component>/``, then records the
active filename in the shared ``artifacts/registry.json``. Every
component's ``predict.py`` reads the registry to find which artifact
is active, rather than hardcoding a filename — so re-training never
requires a code change, and multiple versions can coexist on disk for
comparison.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any


def next_version(component_dir: Path, prefix: str) -> str:
    """Returns "v1" if no artifacts with this prefix exist yet in
    ``component_dir``, else one past the highest existing version.

    Extension-agnostic (globs ``{prefix}_v*`` regardless of suffix) so
    it works for LightGBM's ``.txt`` artifacts (Components A, C) and
    joblib's ``.pkl`` artifacts (Component E) alike.
    """
    existing = sorted(component_dir.glob(f"{prefix}_v*"))
    versions = []
    for p in existing:
        if not p.is_file() or p.suffix == ".json":
            continue
        suffix = p.stem.rsplit("_v", 1)[-1]
        if suffix.isdigit():
            versions.append(int(suffix))
    return f"v{max(versions, default=0) + 1}"


def write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    payload = {**metadata, "saved_at": datetime.now().isoformat()}
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, default=str), encoding="utf-8"
    )


def read_metadata(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def update_registry(registry_path: Path, component: str, artifact_filename: str) -> None:
    registry: dict[str, Any] = {}
    if registry_path.exists():
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    registry[component] = artifact_filename
    registry_path.write_text(json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8")


def read_registry(registry_path: Path, component: str) -> str | None:
    if not registry_path.exists():
        return None
    registry: dict[str, Any] = json.loads(registry_path.read_text(encoding="utf-8"))
    value = registry.get(component)
    return value if isinstance(value, str) else None
