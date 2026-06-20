"""Compatibility shim for the internal reporting package."""

import sys

from agent_host.reporting import operator_summary as _module

sys.modules[__name__] = _module
