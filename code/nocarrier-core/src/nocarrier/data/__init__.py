"""Data ingestion & preprocessing.

Turns the raw CSVs in ``data/raw/`` into the cleaned, joined,
English-column tables and the station graph that everything downstream
(``features/``, ``models/``) is built on. Orchestrated by
``scripts/build_data.py``; the individual modules here are pure,
reusable transforms with no CLI concerns of their own.

Modules:
    registry        — canonical raw filenames, encodings, column schemas
    loaders         — positional CSV parsing against the registry
    cleaning        — whitespace/numeric coercion + the station_id join
    ridership       — wide-to-long reshape of the hourly ridership file
    graph_builder   — the base station adjacency + transfer graph
    locker_mapping  — nearest-station lookup for off-network points of interest
"""
