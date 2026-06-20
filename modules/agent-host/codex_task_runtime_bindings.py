"""Compatibility shim for the internal runtime package."""

import sys

from agent_host.runtime import codex_task_runtime_bindings as _module

sys.modules[__name__] = _module
