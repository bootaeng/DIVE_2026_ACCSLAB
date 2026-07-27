"""Component C: GBM classifier for 대체경로 복잡도등급 (alt-route
complexity grade), trained on the labeled ``elevator_alt_routes.csv``
(932 rows, every row already carries a real ``complexity_grade`` — see
``AI_Pipeline_Strategy.md`` §Component C: "the 대체경로 file already
ships 학습라벨").

The point of training a classifier on already-labeled data is to
GENERALIZE: when a *new* elevator goes down that isn't in this
dataset, predict its likely alt-route complexity from the same
structural features (station type, transfer status, platform shape,
floor levels) without needing a human to hand-label it.

Only structural features are used — never ``route_available``,
``complexity_score``, ``label``, or ``alt_route_type``, since those
are derivatives of the target itself (verified via crosstab during
development: ``route_available == "N"`` is a perfect predictor of the
"이동 불가" class, and ``label`` is a near-deterministic function of
``complexity_grade``) and would leak the answer rather than let the
model learn to generalize. ``station_id``/``station_name`` are also
excluded — memorizing specific stations wouldn't generalize to a
station's *next* elevator failure the way structural features do.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import lightgbm as lgb
import pandas as pd
import structlog
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import train_test_split

from nocarrier.common.config import NoCarrierSettings, get_settings, load_yaml
from nocarrier.common.exceptions import ModelNotTrainedError
from nocarrier.models.base import (
    next_version,
    read_metadata,
    read_registry,
    update_registry,
    write_metadata,
)

log = structlog.get_logger(__name__)

FEATURE_COLUMNS: tuple[str, ...] = (
    "line_no",
    "is_terminal",
    "is_transfer",
    "platform_type",
    "start_type",
    "end_type",
    "start_level",
    "end_level",
)
CATEGORICAL_COLUMNS: tuple[str, ...] = (
    "is_terminal",
    "is_transfer",
    "platform_type",
    "start_type",
    "end_type",
)
TARGET_COLUMN = "complexity_grade"

TEST_SIZE = 0.2
RANDOM_STATE = 42

_ENGINEERING_DEFAULTS: dict[str, Any] = {"verbosity": -1}


def load_classifier_params(models_config_path: str = "config/models.yaml") -> dict[str, Any]:
    config = load_yaml(models_config_path)
    configured = config.get("routing", {}).get("complexity_classifier", {})
    params: dict[str, Any] = dict(_ENGINEERING_DEFAULTS)
    if "n_estimators" in configured:
        params["n_estimators"] = configured["n_estimators"]
    if "max_depth" in configured:
        params["max_depth"] = configured["max_depth"]
    return params


def build_feature_frame(alt_routes: pd.DataFrame) -> pd.DataFrame:
    df = alt_routes[[*FEATURE_COLUMNS, TARGET_COLUMN]].copy()
    for col in CATEGORICAL_COLUMNS:
        df[col] = df[col].astype("category")
    df["line_no"] = df["line_no"].astype(int)
    df["start_level"] = df["start_level"].astype(int)
    df["end_level"] = df["end_level"].astype(int)
    return df


@dataclass(frozen=True)
class TrainResult:
    model: lgb.LGBMClassifier
    metrics: dict[str, float]
    n_train: int
    n_test: int
    classes: tuple[str, ...]


def train_complexity_classifier(
    alt_routes: pd.DataFrame, *, params: dict[str, Any] | None = None
) -> TrainResult:
    frame = build_feature_frame(alt_routes)
    x = frame[list(FEATURE_COLUMNS)]
    y = frame[TARGET_COLUMN]

    x_train, x_test, y_train, y_test = train_test_split(
        x, y, test_size=TEST_SIZE, random_state=RANDOM_STATE, stratify=y
    )

    model = lgb.LGBMClassifier(**(params or load_classifier_params()))
    model.fit(x_train, y_train, categorical_feature=list(CATEGORICAL_COLUMNS))

    y_pred = model.predict(x_test)
    metrics = {
        "accuracy": float(accuracy_score(y_test, y_pred)),
        "macro_f1": float(f1_score(y_test, y_pred, average="macro")),
    }
    log.info("complexity_classifier_trained", n_train=len(x_train), n_test=len(x_test), **metrics)

    return TrainResult(
        model=model,
        metrics=metrics,
        n_train=len(x_train),
        n_test=len(x_test),
        classes=tuple(str(c) for c in model.classes_),
    )


def save_complexity_classifier(
    result: TrainResult, settings: NoCarrierSettings | None = None
) -> Path:
    settings = settings or get_settings()
    component_dir = settings.paths.artifacts_dir / "routing"
    component_dir.mkdir(parents=True, exist_ok=True)

    version = next_version(component_dir, "complexity_classifier")
    model_path = component_dir / f"complexity_classifier_{version}.txt"
    metadata_path = component_dir / f"complexity_classifier_{version}_metadata.json"

    result.model.booster_.save_model(str(model_path))
    write_metadata(
        metadata_path,
        {
            "feature_columns": list(FEATURE_COLUMNS),
            "categorical_columns": list(CATEGORICAL_COLUMNS),
            "classes": list(result.classes),
            "metrics": result.metrics,
            "n_train": result.n_train,
            "n_test": result.n_test,
        },
    )

    registry_path = settings.paths.artifacts_dir / "registry.json"
    update_registry(registry_path, "complexity_classifier", model_path.name)

    log.info("complexity_classifier_saved", path=str(model_path))
    return model_path


def load_complexity_artifacts(
    settings: NoCarrierSettings | None = None,
) -> tuple[lgb.Booster, list[str]]:
    settings = settings or get_settings()
    component_dir = settings.paths.artifacts_dir / "routing"
    registry_path = settings.paths.artifacts_dir / "registry.json"

    filename = read_registry(registry_path, "complexity_classifier")
    if filename is None:
        raise ModelNotTrainedError(
            "No trained complexity classifier in artifacts/registry.json — run "
            "`uv run python scripts/train_complexity.py` first."
        )

    booster = lgb.Booster(model_file=str(component_dir / filename))
    metadata_path = component_dir / f"{Path(filename).stem}_metadata.json"
    metadata = read_metadata(metadata_path)
    classes: list[str] = list(metadata["classes"])
    return booster, classes


def predict_complexity_grade(
    booster: lgb.Booster,
    classes: list[str],
    *,
    line_no: int,
    is_terminal: str,
    is_transfer: str,
    platform_type: str,
    start_type: str,
    end_type: str,
    start_level: int,
    end_level: int,
) -> tuple[str, dict[str, float]]:
    """Predicts the complexity grade for a (possibly new, unlabeled)
    elevator failure described by its structural attributes. Returns
    ``(predicted_grade, {grade: probability, ...})``.
    """
    row = {
        "line_no": line_no,
        "is_terminal": is_terminal,
        "is_transfer": is_transfer,
        "platform_type": platform_type,
        "start_type": start_type,
        "end_type": end_type,
        "start_level": start_level,
        "end_level": end_level,
    }
    frame = pd.DataFrame([row])
    for col in CATEGORICAL_COLUMNS:
        frame[col] = frame[col].astype("category")
    frame["line_no"] = frame["line_no"].astype(int)
    frame["start_level"] = frame["start_level"].astype(int)
    frame["end_level"] = frame["end_level"].astype(int)
    frame = frame[list(FEATURE_COLUMNS)]

    proba = booster.predict(frame)[0]
    probabilities = {cls: float(p) for cls, p in zip(classes, proba, strict=True)}
    predicted = max(probabilities, key=lambda k: probabilities[k])
    return predicted, probabilities
