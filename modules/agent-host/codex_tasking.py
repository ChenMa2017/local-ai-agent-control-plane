"""Compatibility shim for the internal runtime package."""

import sys

from agent_host.runtime import codex_tasking as _module

sys.modules[__name__] = _module
