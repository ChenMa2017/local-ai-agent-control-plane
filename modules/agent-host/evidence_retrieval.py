"""Compatibility shim for the internal intake package."""

import sys

from agent_host.intake import evidence_retrieval as _module

sys.modules[__name__] = _module
