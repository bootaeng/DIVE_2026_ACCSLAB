# nocarrier-core

Two trained AI models — congestion forecasting and accessibility/route
scoring for the Busan subway — packaged as plain Python functions. No
server, no LLM, no frontend. Call them from your own code.

## Install

```bash
cd nocarrier-core
pip install -r requirements.txt
```

## Use

```python
from nocarrier.api import load_resources, predict_congestion, get_accessibility_routes

resources = load_resources()  # call once, reuse everywhere

congestion = predict_congestion(resources, station_id=113)
routes = get_accessibility_routes(resources, origin_station=113, destination_station=203)
```

## Functions

| Function | Input | Output |
|---|---|---|
| `predict_congestion(resources, station_id, timestamp=None)` | station ID (역번호), optional time | one `StationCongestion` |
| `get_accessibility_routes(resources, origin_station, destination_station, mobility_profile="none", luggage_size="none", k=3)` | origin/destination station IDs | list of up to `k` `RouteOption` |

Station IDs are 역번호 — full id/name table in `data/processed/stations.csv` (114 stations).

## Example output

```bash
PYTHONPATH=src python example.py
```

```
부산 (113): 551.7 predicted, level=low, event_spike=False

route-1: 48.5 min, accessibility_risk=0.076, step_free=True
  route: 초량 -> 부산진 -> 좌천 -> 범일 -> 범내골 -> 서면 -> 서면 -> 전포 -> ... -> 해운대
  warning: 서면역: 승강장-열차 간격이 넓어 승하차 시 주의가 필요합니다

route-2: 50.2 min, accessibility_risk=0.143, step_free=True
  ...

route-3: 68.2 min, accessibility_risk=0.164, step_free=True
  ...
```

`StationCongestion` fields: `station_id`, `station_name`, `predicted_volume`, `level` (`low|medium|high|severe`), `is_event_spike`, `reason`.

`RouteOption` fields: `id`, `eta_minutes`, `accessibility_risk` (0.0–1.0, lower = safer), `step_free`, `segments` (each with `station_id`/`station_name`), `warnings`.

## What's inside

| Component | What it is |
|---|---|
| A | Congestion forecast — trained LightGBM |
| A′ | Event-spike detection — STL decomposition |
| B | Conflict score — weighted formula (not trained) |
| C | Routing — graph search + trained LightGBM complexity classifier |
| D | Platform safety — lookup (not trained) |

Not included: LLM/chat layer, persona, facility recommender, FastAPI app, frontend. Add your own text-generation on top of these numbers if you need it — don't re-add an LLM here.

## The AI models — what, how, why

**Component A — congestion forecast.** A **LightGBM** regressor (gradient-boosted decision trees). Input: station, time of day, weekday/weekend, recent ridership history (lag/rolling features). Output: predicted boarding+alighting count for that station right now. Trained on real 2025 ridership data; tested on a holdout slice of time it never saw (MAE 31.65, meaning predictions are off by ~32 people on average). LightGBM was chosen over a deep model because the data is tabular and moderate-sized — gradient boosting is the standard strong baseline for that, trains fast, and is easy to inspect.

**Component A′ — event-spike detection.** Not a trained model — **STL decomposition** (a classical time-series statistics technique), which splits ridership into trend + seasonal pattern + leftover noise. If today's leftover is unusually large, that station gets flagged as having an event (concert, festival, etc.) driving extra traffic. Chosen because it needs no training data or labels — it just compares today to the station's own normal pattern.

**Component B — conflict score.** Not a model at all — a plain weighted formula: elevator demand + how full the station is + whether an alternate route exists if an elevator is broken. Deliberately transparent (not an ML black box) so it's easy to explain and defend why a station scored the way it did — useful when the answer affects someone with mobility needs.

**Component C — routing.** Two parts. (1) Graph search: the real Busan subway map as a graph, searched with **Yen's algorithm** (finds not just the best route but the next-best alternatives too, so there's always a backup option). (2) A **LightGBM classifier** trained on 932 real labeled elevator-outage cases, which predicts how hard a detour will be (easy/medium/hard) when a specific elevator is down — 89.3% accuracy on data it wasn't trained on.

**Component D — platform safety.** A lookup, not a model — flags stations with a wide gap between platform and train (real safety data), which matters most for wheelchairs and rolling luggage.

**Why LightGBM specifically, twice:** it's a strong default for structured/tabular data (rows of numbers and categories, not images or free text), needs relatively little data to train well, and produces a model file that's fast to load and run — a good fit for a hackathon timeline and for handing off as a single portable file, which is exactly what's sitting in `artifacts/` here.
