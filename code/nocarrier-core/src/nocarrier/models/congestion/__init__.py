"""Component A — station congestion forecaster (LightGBM).

See AI_Pipeline_Strategy.md §2 Component A for why a single global GBM
beats per-station models or an LSTM on this data: 365 daily
observations per station-direction-hour series is plenty for trees,
thin for deep nets, and strong calendar seasonality + exogenous
covariates (holiday, weekend, event flag) are exactly what GBMs handle
well out of the box.
"""
