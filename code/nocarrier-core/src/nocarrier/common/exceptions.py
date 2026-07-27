"""Domain-level exceptions shared across the nocarrier package.

Every error raised by nocarrier code should subclass NoCarrierError so
callers (FastAPI exception handlers, scripts, tests) can catch the
whole family with one except clause, or narrow to a specific failure
mode when they need to.
"""

from __future__ import annotations


class NoCarrierError(Exception):
    """Base class for all nocarrier domain errors."""


class ConfigError(NoCarrierError):
    """Configuration is missing, malformed, or internally inconsistent."""


class DataNotFoundError(NoCarrierError):
    """An expected raw/processed data file is missing."""


class DataValidationError(NoCarrierError):
    """Loaded data failed a schema or sanity check."""


class ModelNotTrainedError(NoCarrierError):
    """predict()/score() was called before an artifact was trained and loaded."""


class ModelLoadError(NoCarrierError):
    """A trained artifact exists on disk but failed to load."""


class RouteNotFoundError(NoCarrierError):
    """No viable path exists between two stations under the requested
    accessibility constraints.
    """


class LLMBackendError(NoCarrierError):
    """The configured LLM backend failed to respond or returned an
    unusable result.
    """
