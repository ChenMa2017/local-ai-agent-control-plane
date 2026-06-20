"""Compatibility shim for the internal intake package."""

import sys

from agent_host.intake import prepare_intent as _module

sys.modules[__name__] = _module
