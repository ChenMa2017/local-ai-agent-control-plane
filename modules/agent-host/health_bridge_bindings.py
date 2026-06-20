"""Compatibility shim for the internal bridge package."""

import sys

from agent_host.bridge import health_bridge_bindings as _module

sys.modules[__name__] = _module
