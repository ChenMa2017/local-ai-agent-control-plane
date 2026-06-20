"""Compatibility shim for the internal research package."""

import sys

from agent_host.research import research_store as _module

sys.modules[__name__] = _module
