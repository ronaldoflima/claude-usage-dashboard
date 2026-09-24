#!/usr/bin/env python3
"""Offline RPC fixture: fails if the dashboard tries to start any work."""
import json
import sys

assert sys.argv[1:] == ["app-server"]
request = json.loads(sys.stdin.readline())
assert request["method"] == "initialize"
print(json.dumps({"id": 1, "result": {}}), flush=True)
assert json.loads(sys.stdin.readline())["method"] == "initialized"
assert json.loads(sys.stdin.readline())["method"] == "account/rateLimits/read"
print(json.dumps({"id": 2, "result": {"rateLimits": {"limitId": "codex", "primary": {
    "usedPercent": 25, "windowDurationMins": 300, "resetsAt": 2_000_000_000}}}}), flush=True)
sys.stdin.read()
