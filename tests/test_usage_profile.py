import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from build_usage_profile import normalize, slot_index


class UsageProfileTest(unittest.TestCase):
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
