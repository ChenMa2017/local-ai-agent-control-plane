"""Compatibility shim for the internal research package."""

import sys

from agent_host.research import project_research_sync as _module

sys.modules[__name__] = _module
