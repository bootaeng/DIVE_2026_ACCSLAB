"""Minimal usage example. Run from this directory:

    pip install -r requirements.txt
    PYTHONPATH=src python example.py
"""

from nocarrier.api import get_accessibility_routes, load_resources, predict_congestion

resources = load_resources()  # loads once; reuse this object for every call

# Component A/A' — congestion forecast for one station, right now
congestion = predict_congestion(resources, station_id=113)
print(f"{congestion.station_name} ({congestion.station_id}): "
      f"{congestion.predicted_volume:.1f} predicted, level={congestion.level}, "
      f"event_spike={congestion.is_event_spike}")

# Components B/C/D — up to 3 ranked accessibility-aware routes
routes = get_accessibility_routes(resources, origin_station=113, destination_station=203)
for r in routes:
    stops = " -> ".join(s.station_name or str(s.station_id) for s in r.segments)
    print(f"\n{r.id}: {r.eta_minutes} min, accessibility_risk={r.accessibility_risk:.3f}, "
          f"step_free={r.step_free}")
    print(f"  route: {stops}")
    for w in r.warnings:
        print(f"  warning: {w.message}")
