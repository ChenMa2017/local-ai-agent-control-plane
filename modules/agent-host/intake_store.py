"""Compatibility shim for the internal intake package."""

import sys

from agent_host.intake import intake_store as _module

sys.modules[__name__] = _module
