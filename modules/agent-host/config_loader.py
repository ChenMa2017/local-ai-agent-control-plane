"""Compatibility shim for the internal bridge package."""

import sys

from agent_host.bridge import config_loader as _module

sys.modules[__name__] = _module
