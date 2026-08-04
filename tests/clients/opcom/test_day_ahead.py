import datetime as dt
from pathlib import Path

import pandas as pd

from clients.opcom.endpoints.day_ahead import _day_bounds_utc, parse_response

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def test_day_bounds_utc_normal_day_is_24_hours():
    start, end = _day_bounds_utc(dt.date(2024, 6, 15))
    assert start == dt.datetime(2024, 6, 14, 22, 0, tzinfo=dt.timezone.utc)
    assert end == dt.datetime(2024, 6, 15, 22, 0, tzinfo=dt.timezone.utc)


def test_day_bounds_utc_spring_forward_is_23_hours():
    # last Sunday of March: clocks go forward, CET -> CEST
    start, end = _day_bounds_utc(dt.date(2024, 3, 31))
    assert (end - start) == dt.timedelta(hours=23)


def test_day_bounds_utc_fall_back_is_25_hours():
    # last Sunday of October: clocks go back, CEST -> CET
    start, end = _day_bounds_utc(dt.date(2024, 10, 27))
    assert (end - start) == dt.timedelta(hours=25)


def test_parse_response_normal_day():
    # real OPCOM response, captured via a live read-only GET for 2024-06-15
    raw = (FIXTURES_DIR / "2024-06-15_normal.xml").read_bytes()
    forecasttime = pd.Timestamp("2024-06-14T12:00:00Z")

    df = parse_response(raw, dt.date(2024, 6, 15), forecasttime)

    assert len(df) == 24  # hourly resolution in June 2024, pre-Oct 2025 15-min switch
    assert df["resolution"].eq(60).all()
    assert df["bidding_zone"].eq("RO").all()
    assert df["market"].eq("SDAC").all()
    assert df["source"].eq("OPCOM").all()
    assert df["currency"].eq("EUR").all()
    assert (df["forecasttime"] == forecasttime).all()

    assert df.iloc[0]["valuetime"] == pd.Timestamp("2024-06-14T22:00:00Z")
    assert df.iloc[0]["price"] == 58.35
    assert df.iloc[-1]["valuetime"] == pd.Timestamp("2024-06-15T21:00:00Z")
    assert df.iloc[-1]["price"] == 93.21


def test_parse_response_no_published_report_returns_empty_df():
    # real OPCOM response for a delivery day beyond the published range - <resultset/> with no Detail
    raw = (FIXTURES_DIR / "2026-08-15_no_report.xml").read_bytes()
    df = parse_response(raw, dt.date(2026, 8, 15), pd.Timestamp.now(tz="UTC"))
    assert df.empty


def test_parse_response_handles_comma_formatted_price_above_999():
    # PriceRO is comma-thousands-formatted above 999 (see parse_response docstring) -
    # not present in the captured fixture day, so covered with a minimal inline sample instead
    raw = b'<?xml version="1.0" ?><resultset><Detail><Pos>1</Pos><PriceRO>1,234.56</PriceRO></Detail></resultset>'
    df = parse_response(raw, dt.date(2024, 6, 15), pd.Timestamp.now(tz="UTC"))
    assert df.iloc[0]["price"] == 1234.56
