"""Typed, validated configuration loading.

Two layers are merged into one object:

* ``config/config.yaml`` — static project config (paths, feature flags)
* environment variables, via ``.env`` — secrets and per-deploy overrides
  (see ``.env.example`` for the full list)

``NoCarrierSettings`` is validated by pydantic-settings, so every other
module gets one typed object instead of scattered ``os.getenv()`` calls.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Paths(BaseSettings):
    data_dir: Path = Path("data")
    raw_dir: Path = Path("data/raw")
    interim_dir: Path = Path("data/interim")
    processed_dir: Path = Path("data/processed")
    external_dir: Path = Path("data/external")
    artifacts_dir: Path = Path("artifacts")


class FeatureFlags(BaseSettings):
    use_tft_showcase: bool = False
    use_external_weather: bool = False
    use_external_events: bool = False


class FeaturesConfig(BaseSettings):
    rolling_windows_days: list[int] = [7, 28]


class NoCarrierSettings(BaseSettings):
    """Process-wide settings, loaded from env vars prefixed ``NOCARRIER_``
    (see ``.env.example``) plus the static ``config.yaml`` file.
    """

    model_config = SettingsConfigDict(
        env_prefix="NOCARRIER_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Literal["development", "staging", "production"] = "development"
    log_level: str = "INFO"

    paths: Paths = Field(default_factory=Paths)
    feature_flags: FeatureFlags = Field(default_factory=FeatureFlags)
    features: FeaturesConfig = Field(default_factory=FeaturesConfig)


def load_yaml(path: str | Path) -> dict[str, Any]:
    """Generic YAML loader for the other config/*.yaml files
    (models.yaml, personas.yaml, llm.yaml) that aren't part of
    NoCarrierSettings itself. Returns {} if the file doesn't exist.
    """
    p = Path(path)
    if not p.exists():
        return {}
    with p.open(encoding="utf-8") as f:
        return dict(yaml.safe_load(f) or {})


def _load_yaml_overrides(config_path: Path) -> dict[str, Any]:
    return load_yaml(config_path)


@lru_cache
def get_settings(config_path: str = "config/config.yaml") -> NoCarrierSettings:
    """Return the process-wide settings singleton.

    Cached so ``config.yaml`` and ``.env`` are only read once per
    process; tests can call ``get_settings.cache_clear()`` to force a
    reload against a different config file.
    """
    overrides = _load_yaml_overrides(Path(config_path))

    settings = NoCarrierSettings()

    if "environment" in overrides:
        settings.environment = overrides["environment"]
    if "paths" in overrides:
        settings.paths = Paths(**overrides["paths"])
    if "feature_flags" in overrides:
        settings.feature_flags = FeatureFlags(**overrides["feature_flags"])
    if "features" in overrides:
        settings.features = FeaturesConfig(**overrides["features"])

    return settings
