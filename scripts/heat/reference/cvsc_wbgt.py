#!/usr/bin/env python3
"""CVSC field WBGT forecaster.

Pulls the NWS gridpoint forecast (api.weather.gov) for each field, estimates
clear-sky solar radiation, and runs the Liljegren et al. (2008) WBGT model for
the field's surface (grass or synthetic turf). Prints WBGT, the US Soccer
Recognize to Recover alert band, and - for each hour - the regional air
temperature at which the field would reach Red and Black, holding the
forecast dewpoint and wind fixed.

Usage:
    pip install pvlib            # pulls numpy + pandas
    python cvsc_wbgt.py                          # tomorrow, 8 AM-5 PM, Category 1
    python cvsc_wbgt.py --date 2026-10-03 --hours 8,11,14
    python cvsc_wbgt.py --category 2 --csv out.csv
    python cvsc_wbgt.py --offline fixture.json   # run from saved gridpoint JSON

Limits (read before trusting a number):
  * NWS does not forecast solar radiation. GHI is clear-sky (pvlib Ineichen)
    reduced for forecast sky cover; smoke/haze is not modeled.
  * Liljegren assumes ground temp = air temp. Turf uses a no-evaporation surface
    energy balance plus field-measured offsets (air +1.5 F, dewpoint -1.8 F).
  * Below ~2 mph the model is very wind-sensitive. Sheltered fields can run
    several degrees above these numbers. An on-site WBGT meter overrides this.
  * The Liljegren port follows the published reference algorithm; it is not a
    line-by-line diff of the original C source.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pvlib

TZ = "America/Los_Angeles"
# api.weather.gov rejects requests without an identifying User-Agent.
USER_AGENT = "cvsc-wbgt/1.0 (Castro Valley Soccer Club field heat check)"


@dataclass(frozen=True)
class Site:
    key: str
    name: str
    lat: float
    lon: float
    surface: str  # "grass" | "turf"


SITES = [
    Site("canyon", "Canyon MS", 37.7046, -122.0524, "turf"),
    Site("vannoy", "Vannoy ES", 37.7069, -122.0587, "grass"),
    Site("independent", "Independent ES", 37.6990, -122.0509, "grass"),
    Site("fivecanyons", "Five Canyons Park", 37.6765, -122.0305, "grass"),
]

# US Soccer Recognize to Recover alert bands (WBGT, F): upper bound of each band.
# Category 2 poster lists Black as >89.8 in the table and >89.9 in the text;
# the stricter 89.8 is used here.
BANDS = {
    1: [("Green", 76.1), ("Yellow", 81.0), ("Orange", 84.1), ("Red", 86.2)],
    2: [("Green", 79.8), ("Yellow", 84.6), ("Orange", 87.7), ("Red", 89.8)],
    3: [("Green", 82.1), ("Yellow", 87.0), ("Orange", 90.0), ("Red", 92.0)],
}


def band(wbgt_f: float, category: int) -> str:
    for name, upper in BANDS[category]:
        if wbgt_f <= upper:
            return name
    return "Black"


# --------------------------------------------------------------------------
# Liljegren WBGT model
# --------------------------------------------------------------------------
STEFANB = 5.6696e-8
CP = 1003.5
M_AIR, M_H2O = 28.97, 18.015
R_AIR = 8314.34 / M_AIR
PR = CP / (CP + 1.25 * R_AIR)
RATIO = CP * M_AIR / M_H2O
EMIS_WICK, ALB_WICK, D_WICK, L_WICK = 0.95, 0.4, 0.007, 0.0254
EMIS_GLOBE, ALB_GLOBE, D_GLOBE = 0.95, 0.05, 0.0508
EMIS_SFC = 0.999
SOLAR_CONST = 1367.0
MIN_SPEED = 0.13
CZA_MIN = 0.00873
CONVERGENCE, MAX_ITER = 0.02, 500


def f_to_k(f): return (f - 32.0) * 5.0 / 9.0 + 273.15
def k_to_f(k): return (k - 273.15) * 9.0 / 5.0 + 32.0


def esat(tk):
    y = (tk - 273.15) / (tk - 32.18)
    return 1.004 * 6.1121 * math.exp(17.502 * y)


def viscosity(tk):
    omega = (tk / 97.0 - 2.9) / 0.4 * (-0.034) + 1.048
    return 2.6693e-6 * math.sqrt(M_AIR * tk) / (3.617 ** 2 * omega)


def thermal_cond(tk): return (CP + 1.25 * R_AIR) * viscosity(tk)


def diffusivity(tk, p):
    pcrit13 = (36.4 * 218.0) ** (1 / 3)
    tcrit512 = (132.0 * 647.3) ** (5 / 12)
    tcrit12 = math.sqrt(132.0 * 647.3)
    mmix = math.sqrt(1 / M_AIR + 1 / M_H2O)
    return 3.640e-4 * (tk / tcrit12) ** 2.334 * pcrit13 * tcrit512 * mmix / (p / 1013.25) * 1e-4


def emis_atm(tk, rh): return 0.575 * (rh * esat(tk)) ** 0.143
def h_evap(tk): return (313.15 - tk) / 30.0 * (-71100.0) + 2.4073e6


def h_sphere(tk, p, u):
    re_ = max(u, MIN_SPEED) * (p * 100 / (R_AIR * tk)) * D_GLOBE / viscosity(tk)
    return (2.0 + 0.6 * math.sqrt(re_) * PR ** 0.3333) * thermal_cond(tk) / D_GLOBE


def h_cylinder(tk, p, u):
    re_ = max(u, MIN_SPEED) * (p * 100 / (R_AIR * tk)) * D_WICK / viscosity(tk)
    return 0.281 * re_ ** 0.6 * PR ** 0.44 * thermal_cond(tk) / D_WICK


def normalize_solar(ghi, cza):
    """Cap GHI at 0.85 x top-of-atmosphere; direct-beam fraction from clearness."""
    if cza <= 0 or ghi <= 0:
        return ghi, 0.0
    if cza < CZA_MIN:
        return ghi, 0.0
    toa = SOLAR_CONST * cza
    s = min(ghi / toa, 0.85)
    return s * toa, max(min(math.exp(3 - 1.34 * s - 1.65 / s), 0.9), 0.0)


def clamp_zenith(zen, ghi):
    zen = max(zen, 1e-10)
    if ghi > 0 and zen > 1.57: zen = 1.57
    if ghi > 15 and zen > 1.54: zen = 1.54
    if ghi > 900 and zen > 1.52: zen = 1.52
    if ghi < 10 and zen >= 1.57: ghi = 0.0
    return zen, ghi


def wind_2m(u10, ghi):
    """Pasquill class from speed + insolation, urban power law 10 m -> 2 m."""
    if ghi > 0:
        j = 0 if ghi >= 925 else 1 if ghi >= 675 else 2 if ghi >= 175 else 3
        i = 4 if u10 >= 6 else 3 if u10 >= 5 else 2 if u10 >= 3 else 1 if u10 >= 2 else 0
        cls = [[1, 1, 2, 4], [1, 2, 3, 4], [2, 2, 3, 4], [3, 3, 4, 4], [3, 4, 4, 4]][i][j]
    else:
        cls = 5
    p = [0.15, 0.15, 0.20, 0.25, 0.30, 0.30][cls - 1]
    return max(u10 * 0.2 ** p, MIN_SPEED)


def _iterate(fn, start):
    prev = start
    for _ in range(MAX_ITER):
        new = fn(prev)
        if abs(new - prev) < CONVERGENCE:
            return new
        prev = 0.9 * prev + 0.1 * new
    raise RuntimeError("WBGT component did not converge")


def liljegren(ta, rh, p, u2, ghi, zen, tsfc, alb_sfc):
    """All temps K. Returns (Tnwb, Tg, WBGT) in K."""
    zen, ghi = clamp_zenith(zen, ghi)
    cza = math.cos(zen)
    ghi, fdir = normalize_solar(ghi, cza)
    ea = emis_atm(ta, rh)
    eair = rh * esat(ta)
    lw_env = 0.5 * (ea * ta ** 4 + EMIS_SFC * tsfc ** 4)

    def globe(tg):
        tref = 0.5 * (tg + ta)
        h = h_sphere(tref, p, u2)
        rad = 0.0
        if ghi > 0:
            rad = ghi / (2 * STEFANB * EMIS_GLOBE) * (1 - ALB_GLOBE) * (
                fdir * (1 / (2 * cza) - 1) + 1 + alb_sfc)
        val = lw_env - h / (STEFANB * EMIS_GLOBE) * (tg - ta) + rad
        if val <= 0:
            raise ValueError("globe temperature iteration went non-physical")
        return val ** 0.25

    def wick(tw):
        tref = 0.5 * (tw + ta)
        h = h_cylinder(tref, p, u2)
        fatm = STEFANB * EMIS_WICK * (lw_env - tw ** 4)
        if ghi > 0:
            fatm += (1 - ALB_WICK) * ghi * (
                (1 - fdir) * (1 + 0.25 * D_WICK / L_WICK)
                + fdir * (math.tan(zen) / math.pi + 0.25 * D_WICK / L_WICK) + alb_sfc)
        ew = esat(tw)
        sc = viscosity(tref) / ((p * 100 / (R_AIR * tref)) * diffusivity(tref, p))
        return ta - h_evap(tref) / RATIO * (ew - eair) / (p - ew) * (PR / sc) ** 0.56 + fatm / h

    tg = _iterate(globe, ta)
    tw = _iterate(wick, ta - 10)
    return tw, tg, 0.7 * tw + 0.2 * tg + 0.1 * ta


# --------------------------------------------------------------------------
# Surface models
# --------------------------------------------------------------------------
GRASS_ALBEDO = 0.23
TURF_ALBEDO = 0.10
TURF_AIR_OFFSET_F = 1.5    # air above turf vs regional (Grundstein & Cooper 2020: ~0.8 C)
TURF_DEW_OFFSET_F = -1.8   # drier air above turf (same study: ~1 C lower dewpoint)
# Share of absorbed sun going into infill/pad storage; morning turf lags the sun.
TURF_STORAGE = {6: 0.6, 7: 0.6, 8: 0.5, 9: 0.4, 10: 0.3, 11: 0.25}


def turf_surface_k(ta, rh, ghi, u2, hour):
    lw_down = emis_atm(ta, rh) * STEFANB * ta ** 4
    absorbed = (1 - TURF_ALBEDO) * ghi * (1 - TURF_STORAGE.get(hour, 0.10)) + 0.95 * lw_down
    h = 5.7 + 3.8 * u2
    lo, hi = ta - 20, ta + 80
    for _ in range(100):
        ts = 0.5 * (lo + hi)
        if 0.95 * STEFANB * ts ** 4 + h * (ts - ta) > absorbed:
            hi = ts
        else:
            lo = ts
    return ts


def rh_from(t_f, td_f):
    if td_f > t_f + 0.5:
        raise ValueError(f"dewpoint {td_f:.1f} F exceeds air temperature {t_f:.1f} F")
    return min(esat(f_to_k(td_f)) / esat(f_to_k(t_f)), 1.0)


def field_wbgt(surface, t_f, td_f, wind_mph, ghi, zen, hour, p_hpa):
    """WBGT (F) at 1.2-2 m over the given surface for regional forecast inputs."""
    if surface not in ("grass", "turf"):
        raise ValueError(f"unknown surface {surface!r}")
    if surface == "turf":
        t_f, td_f = t_f + TURF_AIR_OFFSET_F, td_f + TURF_DEW_OFFSET_F
    ta, rh = f_to_k(t_f), rh_from(t_f, td_f)
    zc, gc = clamp_zenith(zen, ghi)
    gc, _ = normalize_solar(gc, math.cos(zc))
    u2 = wind_2m(max(wind_mph, 0.0) * 0.44704, gc)
    if surface == "turf":
        tsfc, alb = turf_surface_k(ta, rh, gc, u2, hour), TURF_ALBEDO
    else:
        tsfc, alb = ta, GRASS_ALBEDO
    return k_to_f(liljegren(ta, rh, p_hpa, u2, ghi, zen, tsfc, alb)[2])


def air_trigger(surface, target_wbgt, td_f, wind_mph, ghi, zen, hour, p_hpa):
    """Regional air temp (F) at which field WBGT reaches target, dewpoint/wind fixed."""
    lo, hi = max(td_f + 1.0, 40.0), 125.0
    f = lambda t: field_wbgt(surface, t, td_f, wind_mph, ghi, zen, hour, p_hpa)
    if f(hi) < target_wbgt:
        return float("nan")
    if f(lo) >= target_wbgt:
        return lo
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        lo, hi = (lo, mid) if f(mid) >= target_wbgt else (mid, hi)
    return hi


# --------------------------------------------------------------------------
# NWS gridpoint data
# --------------------------------------------------------------------------
_DUR = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$")


def parse_duration_hours(d: str) -> int:
    m = _DUR.match(d)
    if not m or not any(m.groups()):
        raise ValueError(f"unsupported ISO-8601 duration {d!r}")
    days, hours, minutes = (int(x) if x else 0 for x in m.groups())
    if minutes:
        raise ValueError(f"sub-hour duration not supported: {d!r}")
    return days * 24 + hours


_CONVERT = {
    "wmoUnit:degC": lambda v: v * 9 / 5 + 32,
    "wmoUnit:degF": lambda v: v,
    "wmoUnit:km_h-1": lambda v: v * 0.621371,
    "wmoUnit:m_s-1": lambda v: v * 2.236936,
    "wmoUnit:percent": lambda v: v,
}


def expand(prop: dict, name: str) -> pd.Series:
    """Gridpoint layer -> hourly UTC series in F / mph / %."""
    uom = prop.get("uom")
    if uom not in _CONVERT:
        raise ValueError(f"{name}: unexpected unit {uom!r}")
    conv = _CONVERT[uom]
    out = {}
    for item in prop.get("values", []):
        start_s, _, dur = item["validTime"].partition("/")
        if item["value"] is None:
            continue
        start = pd.Timestamp(start_s).tz_convert("UTC")
        for k in range(parse_duration_hours(dur)):
            out[start + pd.Timedelta(hours=k)] = conv(item["value"])
    if not out:
        raise ValueError(f"{name}: no values in gridpoint data")
    return pd.Series(out).sort_index()


def _get_json(url: str, retries: int = 3) -> dict:
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                   "Accept": "application/geo+json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = e
            if e.code < 500:      # client errors won't fix themselves
                raise
        except urllib.error.URLError as e:
            last = e
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"NWS API failed after {retries} attempts: {url}: {last}")


def fetch_gridpoint(lat: float, lon: float) -> dict:
    pts = _get_json(f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}")
    url = pts["properties"].get("forecastGridData")
    if not url:
        raise RuntimeError(f"no forecastGridData for {lat},{lon}")
    return _get_json(url)


def station_pressure_hpa(elev_m: float) -> float:
    return 1013.25 * (1 - 2.25577e-5 * elev_m) ** 5.25588


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------
def compute_site(site: Site, grid: dict, day: date, hours: list[int], category: int) -> list[dict]:
    props = grid["properties"]
    elev = (props.get("elevation") or {}).get("value") or 0.0
    p_hpa = station_pressure_hpa(float(elev))
    temp = expand(props["temperature"], "temperature")
    dew = expand(props["dewpoint"], "dewpoint")
    wind = expand(props["windSpeed"], "windSpeed")
    sky = expand(props["skyCover"], "skyCover")
    nws_wbgt = None
    if props.get("wetBulbGlobeTemperature", {}).get("values"):
        nws_wbgt = expand(props["wetBulbGlobeTemperature"], "wetBulbGlobeTemperature")

    local = pd.DatetimeIndex([pd.Timestamp(f"{day} {h:02d}:00", tz=TZ) for h in hours])
    utc = local.tz_convert("UTC")
    missing = [str(t) for t in utc if t not in temp.index or t not in dew.index
               or t not in wind.index or t not in sky.index]
    if missing:
        raise ValueError(f"{site.name}: forecast does not cover {missing[0]} "
                         f"(gridpoint data runs {temp.index.min()} to {temp.index.max()})")

    loc = pvlib.location.Location(site.lat, site.lon, tz=TZ, altitude=elev)
    sp = loc.get_solarposition(local)
    cs = loc.get_clearsky(local, model="ineichen")
    red_lim = BANDS[category][2][1] + 0.1   # first value of Red
    black_lim = BANDS[category][3][1]

    rows = []
    for t_loc, t_utc, h in zip(local, utc, hours):
        n = sky[t_utc] / 100.0
        ghi = float(cs.loc[t_loc, "ghi"]) * (1 - 0.75 * n ** 3.4)
        zen = math.radians(float(sp.loc[t_loc, "apparent_zenith"]))
        T, Td, W = temp[t_utc], dew[t_utc], wind[t_utc]
        w = field_wbgt(site.surface, T, Td, W, ghi, zen, h, p_hpa)
        rows.append({
            "site": site.name, "surface": site.surface, "hour": f"{h:02d}:00",
            "air_F": round(T), "dewpt_F": round(Td), "wind_mph": round(W),
            "sky_pct": round(sky[t_utc]), "wbgt_F": round(w, 1), "band": band(w, category),
            "red_at_air_F": round(air_trigger(site.surface, red_lim, Td, W, ghi, zen, h, p_hpa), 1),
            "black_at_air_F": round(air_trigger(site.surface, black_lim, Td, W, ghi, zen, h, p_hpa), 1),
            "nws_wbgt_F": None if nws_wbgt is None or t_utc not in nws_wbgt.index
            else round(nws_wbgt[t_utc], 1),
        })
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--date", default=str(date.today() + timedelta(days=1)),
                    help="local date YYYY-MM-DD (default: tomorrow)")
    ap.add_argument("--hours", default="8,9,10,11,12,13,14,15,16,17",
                    help="comma-separated local hours, 0-23")
    ap.add_argument("--category", type=int, choices=(1, 2, 3), default=1)
    ap.add_argument("--sites", default=",".join(s.key for s in SITES))
    ap.add_argument("--offline", help="JSON file mapping site key -> saved gridpoint response")
    ap.add_argument("--csv", help="also write results to this CSV path")
    a = ap.parse_args(argv)

    day = date.fromisoformat(a.date)
    hours = [int(x) for x in a.hours.split(",") if x.strip()]
    if not hours or any(not 0 <= h <= 23 for h in hours):
        ap.error("--hours must be integers 0-23")
    by_key = {s.key: s for s in SITES}
    unknown = [k for k in a.sites.split(",") if k not in by_key]
    if unknown:
        ap.error(f"unknown site(s) {unknown}; choose from {list(by_key)}")
    offline = None
    if a.offline:
        with open(a.offline) as fh:
            offline = json.load(fh)

    rows = []
    for key in a.sites.split(","):
        site = by_key[key]
        grid = offline[key] if offline else fetch_gridpoint(site.lat, site.lon)
        rows += compute_site(site, grid, day, hours, a.category)

    df = pd.DataFrame(rows)
    if df["nws_wbgt_F"].isna().all():
        df = df.drop(columns="nws_wbgt_F")
    pd.set_option("display.width", 200)
    print(f"WBGT forecast for {day} | US Soccer Category {a.category} | "
          "triggers = regional air temp with forecast dewpoint/wind held")
    print(df.to_string(index=False))
    if a.csv:
        df.to_csv(a.csv, index=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
