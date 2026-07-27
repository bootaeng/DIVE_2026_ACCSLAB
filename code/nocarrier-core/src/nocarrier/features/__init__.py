"""Feature engineering: turns Phase 1's processed tables into the
typed feature rows every predictive model (Phase 3+) consumes.

This is the single seam between raw processed data and models/ — a
model should never reach into data/processed/ directly; it asks the
FeatureStore for a row, or (for bulk training-set construction) calls
lags.py's vectorized builders directly.

Modules:
    calendar  — weekday/weekend/holiday features (South Korea, 2025-2026)
    weather   — pluggable weather provider (stub + a real 기상청 client)
    events    — pluggable event-calendar provider for 벡스코/사직구장 (Insight B)
    lags      — vectorized lag/rolling-window builders for bulk training data
    store     — FeatureStore: single-point-in-time feature assembly for inference
"""
