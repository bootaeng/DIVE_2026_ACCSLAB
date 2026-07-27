"""No-Carrier AI Travel Assistant.

Predictive ML + persona-driven LLM service built for DIVE 2026
(Busan Transportation Corporation x Zimcarry).

This package is a standalone library: it has no knowledge that HTTP
exists. The FastAPI app in ``app/`` (added in Phase 8) is a thin
serving layer built on top of it — you can exercise everything here
from a script, notebook, or test without running a server.
"""

__version__ = "0.1.0"
