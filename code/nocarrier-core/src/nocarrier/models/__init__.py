"""Predictive components (A-F from AI_Pipeline_Strategy.md §2).

Each component gets its own package with the same shape — a
``train.py`` that fits and saves a versioned artifact, and a
``predict.py`` (or ``score.py``/``recommend.py``) that loads the active
artifact and returns a typed result from ``nocarrier.contracts``. Not
enforced via a formal abstract base (see ``base.py``) — the
inputs/outputs differ too much per component for one interface to be
useful — but every component shares the artifact-registry convention
``base.py`` implements.
"""
