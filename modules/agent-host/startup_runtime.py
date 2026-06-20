"""Compatibility shim for the internal runtime package."""

import sys

from agent_host.runtime import startup_runtime as _module

sys.modules[__name__] = _module
