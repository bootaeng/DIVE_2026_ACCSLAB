"""Pydantic contracts — the typed language every component speaks.

Nothing outside this package should pass loose dicts between the data
layer, the ML components, the LLM layer, and the API. If a boundary
needs a new field, it gets added to a schema here first, and every
consumer picks it up through validation rather than guesswork.

Modules:
    user         — UserInput: everything describing the person asking for help
    predictions  — outputs of predictive Components A-F
    context      — ContextObject: the single payload handed to the LLM
    response     — AssistantResponse: what the pipeline hands back to callers
"""
