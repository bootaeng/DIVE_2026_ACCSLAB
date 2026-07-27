"""Shared plumbing used across every other package: config, logging,
geo helpers, constants, and the domain exception hierarchy.

Nothing in here depends on data/, models/, llm/, or app/ — common/ sits
at the bottom of the dependency graph.
"""
