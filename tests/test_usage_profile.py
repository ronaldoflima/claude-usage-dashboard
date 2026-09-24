import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from build_usage_profile import account_reset, normalize, slot_index


class UsageProfileTest(unittest.TestCase):
    def test_account_reset_uses_account_window_in_requested_timezone(self):
        payload = {"ok": True, "limits": [
            {"kind": "weekly_scoped", "resets_at": "2026-09-26T22:00:00Z"},
            {"kind": "weekly_all", "resets_at": "2026-09-23T17:30:00Z"},
        ]}
        reset = account_reset(payload, "America/Sao_Paulo")
        self.assertEqual((reset.weekday(), reset.hour, reset.minute), (2, 14, 30))

    def test_missing_or_stale_reset_requires_manual_configuration(self):
        for payload in ({"ok": False}, {"ok": True, "limits": []},
                        {"ok": True, "stale": True, "limits": []}):
            with self.assertRaises(ValueError):
                account_reset(payload, "UTC")

    def test_reset_hour_is_first_slot(self):
        tz = ZoneInfo("America/Sao_Paulo")
        saturday_reset = datetime(2026, 9, 19, 19, 0, tzinfo=tz)
        monday_morning = datetime(2026, 9, 21, 9, 0, tzinfo=tz)
        self.assertEqual(slot_index(saturday_reset, 5, 19), 0)
        self.assertEqual(slot_index(monday_morning, 5, 19), 38)

    def test_normalized_profile_sums_to_one_and_smooths_zeros(self):
        values = [0.0] * 168
        values[38] = 100
        result = normalize(values)
        self.assertAlmostEqual(sum(result), 1.0)
        self.assertGreater(result[0], 0)
        self.assertGreater(result[38], result[0])


if __name__ == "__main__":
    unittest.main()
