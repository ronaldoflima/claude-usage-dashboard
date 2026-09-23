import json
import tempfile
import unittest
from pathlib import Path

from app import QuotaClient, UsageIndex


class UsageIndexTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / "projects" / "-tmp-demo"
        self.project.mkdir(parents=True)
        self.log = self.project / "session.jsonl"
        self.index = UsageIndex(self.root, self.root / "index.sqlite3")

    def tearDown(self):
        self.index.connection.close()
        self.temp.cleanup()

    def write(self, message_id="msg_1", output=30, timestamp="2026-09-22T10:00:00Z"):
        event = {
            "type": "assistant", "timestamp": timestamp, "sessionId": "session-1", "cwd": "/tmp/demo",
            "message": {"id": message_id, "model": "claude-opus-5", "usage": {
                "input_tokens": 10, "output_tokens": output, "cache_read_input_tokens": 100,
                "cache_creation_input_tokens": 20, "output_tokens_details": {"thinking_tokens": 5}
            }}
        }
        with self.log.open("a") as handle:
            handle.write(json.dumps(event) + "\n")

    def test_indexes_and_deduplicates_stream_events(self):
        self.write(output=20)
        self.write(output=30, timestamp="2026-09-22T10:00:01Z")
        self.index.refresh()
        result = self.index.dashboard(0, 2_000_000_000_000, 60_000)
        self.assertEqual(result["totals"]["messages"], 1)
        self.assertEqual(result["totals"]["output_tokens"], 30)
        self.assertEqual(result["totals"]["thinking_tokens"], 5)
        self.assertEqual(result["totals"]["fresh_tokens"], 60)
        self.assertEqual(result["totals"]["total_tokens"], 160)

    def test_incremental_refresh(self):
        self.write()
        first = self.index.refresh()
        second = self.index.refresh()
        self.write(message_id="msg_2", timestamp="2026-09-22T10:01:00Z")
        third = self.index.refresh()
        self.assertEqual(first["events"], 1)
        self.assertEqual(second["events"], 0)
        self.assertEqual(third["events"], 1)

    def test_normalizes_structured_limits(self):
        normalized = QuotaClient._normalize({"limits": [
            {"kind": "session", "percent": 42, "resets_at": "2026-09-22T15:00:00Z"},
            {"kind": "weekly_scoped", "percent": 18, "resets_at": "2026-09-26T22:00:00Z", "scope": {"model": {"display_name": "Opus"}}}
        ]})
        self.assertEqual(normalized["limits"][0]["label"], "Sessão")
        self.assertEqual(normalized["limits"][1]["label"], "Semanal · Opus")


if __name__ == "__main__":
    unittest.main()
