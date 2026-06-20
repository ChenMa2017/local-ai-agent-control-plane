"""Compatibility shim for the internal intake package."""

import sys

from agent_host.intake import intake_bridge_bindings as _module

sys.modules[__name__] = _module
