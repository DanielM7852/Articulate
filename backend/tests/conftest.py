"""Test-wide isolation.

Telemetry would mint an anonymous SpacetimeDB identity over the network at app startup. Tests opt in by passing
`telemetry_enabled=True` (with a mock transport); the environment default keeps every other app offline.
"""

import os

os.environ["TELEMETRY_ENABLED"] = "false"
