"""Compatibility shim for the internal reporting package."""

import sys

from agent_host.reporting import post_run_artifacts as _module

sys.modules[__name__] = _module
