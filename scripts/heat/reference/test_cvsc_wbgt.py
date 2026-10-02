"""python -m unittest test_cvsc_wbgt.py  (no network needed)

Fixture = NWS MTR hourly forecast for Castro Valley, 2026-10-03, issued
2026-10-02 01:31 PDT, re-encoded as api.weather.gov gridpoint JSON
(degC, km/h, mixed 1 h / 3 h validTime blocks) to exercise unit and
duration handling.
"""
import json
import math
import os
import tempfile
import unittest

import cvsc_wbgt as m

# local hours 00..23 on 2026-10-03
T_F = [66, 66, 65, 65, 64, 64, 64, 64, 65, 70, 75, 80, 85, 88, 90, 92, 92, 90, 86, 81, 75, 72, 71, 70]
TD_F = [54, 54, 53, 52, 52, 51, 51, 51, 51, 54, 55, 55, 57, 56, 56, 54, 54, 54, 55, 54, 53, 52, 52, 52]
W_MPH = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 3, 3, 6, 6, 6, 5, 5, 5, 0, 0, 0, 0]
SKY = [25, 31, 24, 16, 42, 40, 36, 15, 7, 8, 12, 7, 7, 7, 11, 11, 11, 19, 19, 19, 5, 5, 5, 15]


def _layer(vals, uom, conv):
    # Oct 3 00:00 PDT = 07:00 UTC. First three hours as one PT3H block.
    out = [{"validTime": "2026-10-03T07:00:00+00:00/PT3H", "value": conv(vals[0])}]
    for h in range(3, 24):
        out.append({"validTime": f"2026-10-{3 + (7 + h) // 24:02d}T{(7 + h) % 24:02d}:00:00+00:00/PT1H",
                    "value": conv(vals[h])})
    return {"uom": uom, "values": out}


def fixture():
    c = lambda f: (f - 32) * 5 / 9
    grid = {"properties": {
        "elevation": {"unitCode": "wmoUnit:m", "value": 121.0},
        "temperature": _layer(T_F, "wmoUnit:degC", c),
        "dewpoint": _layer(TD_F, "wmoUnit:degC", c),
        "windSpeed": _layer(W_MPH, "wmoUnit:km_h-1", lambda v: v / 0.621371),
        "skyCover": _layer(SKY, "wmoUnit:percent", lambda v: v),
    }}
    return grid


class Reproduce(unittest.TestCase):
    def setUp(self):
        self.canyon = m.SITES[0]
        self.vannoy = m.SITES[1]

    def run_site(self, site, hours):
        return {r["hour"]: r for r in m.compute_site(site, fixture(), m.date(2026, 10, 3), hours, 1)}

    def test_matches_earlier_analysis(self):
        c = self.run_site(self.canyon, [8, 11, 13, 14])
        g = self.run_site(self.vannoy, [8, 11, 14])
        self.assertAlmostEqual(c["14:00"]["wbgt_F"], 80.9, delta=0.6)
        self.assertAlmostEqual(c["11:00"]["wbgt_F"], 77.3, delta=0.6)
        self.assertAlmostEqual(g["14:00"]["wbgt_F"], 80.0, delta=0.6)
        self.assertAlmostEqual(g["08:00"]["wbgt_F"], 62.0, delta=0.6)
        self.assertAlmostEqual(c["13:00"]["black_at_air_F"], 94.5, delta=1.0)
        self.assertEqual(c["08:00"]["band"], "Green")

    def test_missing_forecast_hour_is_explicit(self):
        with self.assertRaisesRegex(ValueError, "does not cover"):
            m.compute_site(self.canyon, fixture(), m.date(2026, 10, 5), [14], 1)

    def test_cli_offline_and_csv(self):
        with tempfile.TemporaryDirectory() as d:
            fx, out = os.path.join(d, "fx.json"), os.path.join(d, "o.csv")
            with open(fx, "w") as fh:
                json.dump({s.key: fixture() for s in m.SITES}, fh)
            self.assertEqual(m.main(["--date", "2026-10-03", "--hours", "8,14",
                                     "--offline", fx, "--csv", out]), 0)
            with open(out) as fh:
                self.assertEqual(sum(1 for _ in fh), 1 + 4 * 2)


class Parsing(unittest.TestCase):
    def test_durations(self):
        self.assertEqual(m.parse_duration_hours("PT1H"), 1)
        self.assertEqual(m.parse_duration_hours("PT3H"), 3)
        self.assertEqual(m.parse_duration_hours("P1D"), 24)
        self.assertEqual(m.parse_duration_hours("P1DT6H"), 30)
        for bad in ("PT30M", "P", "1H", ""):
            with self.assertRaises(ValueError):
                m.parse_duration_hours(bad)

    def test_unknown_unit_rejected(self):
        with self.assertRaisesRegex(ValueError, "unexpected unit"):
            m.expand({"uom": "wmoUnit:K", "values": []}, "temperature")

    def test_null_values_skipped_but_empty_layer_rejected(self):
        layer = {"uom": "wmoUnit:degF", "values": [{"validTime": "2026-10-03T07:00:00+00:00/PT1H", "value": None}]}
        with self.assertRaisesRegex(ValueError, "no values"):
            m.expand(layer, "temperature")


class Physics(unittest.TestCase):
    def test_sun_on_horizon_dead_calm_stays_finite(self):
        w = m.field_wbgt("turf", 60.0, 50.0, 0.0, 5.0, math.radians(89.9), 7, 1000.0)
        self.assertTrue(math.isfinite(w) and w < 70.0)

    def test_dewpoint_above_air_rejected(self):
        with self.assertRaises(ValueError):
            m.field_wbgt("grass", 70.0, 75.0, 3.0, 500.0, math.radians(50), 11, 1000.0)

    def test_turf_not_cooler_than_grass_midday(self):
        args = (90.0, 56.0, 6.0, 709.0, math.radians(44.4), 14, 1000.0)
        self.assertGreater(m.field_wbgt("turf", *args), m.field_wbgt("grass", *args))

    def test_band_edges(self):
        self.assertEqual(m.band(76.1, 1), "Green")
        self.assertEqual(m.band(76.2, 1), "Yellow")
        self.assertEqual(m.band(86.2, 1), "Red")
        self.assertEqual(m.band(86.3, 1), "Black")


if __name__ == "__main__":
    unittest.main()
