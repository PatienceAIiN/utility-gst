"""One named test per §5 domain rule. Test names read as the rule they defend."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal as D

import pytest

from gstparse.gst import (
    compute_line_tax,
    gstin_check_digit,
    is_valid_gstin,
    is_valid_hsn,
    normalise_hsn,
    resolve_supply_type,
    split_intra_state_tax,
    split_rate,
    state_code,
)
from gstparse.money import parse_money, parse_percent, q2

SELLER = "27AAKCG6367M1ZV"
BUYER = "27ABDFK6885B1Z6"


# --- §5 worked examples ---------------------------------------------------

def test_worked_example_dosa_mix_300_at_129_18pc() -> None:
    """300 x 129 = 38,700 taxable; 18% -> 6,966 tax; gross 45,666."""
    taxable = q2(D("300") * D("129"))
    tax = compute_line_tax(taxable, D("18"))
    assert taxable == D("38700.00")
    assert tax == D("6966.00")
    assert taxable + tax == D("45666.00")


def test_worked_example_sambar_112_5_at_250_5pc() -> None:
    """112.5 x 250 = 28,125 taxable; 5% -> 1,406.25 tax; gross 29,531.25."""
    taxable = q2(D("112.5") * D("250"))
    tax = compute_line_tax(taxable, D("5"))
    assert taxable == D("28125.00")
    assert tax == D("1406.25")
    assert taxable + tax == D("29531.25")


# --- §5 column semantics --------------------------------------------------

def test_taxable_is_computed_by_us_not_read_from_the_amount_column() -> None:
    """`Amount` on the sample invoice is gross. Treating it as taxable overstates by the tax."""
    qty, rate, gross_from_invoice = D("300"), D("129"), D("45666")
    taxable = q2(qty * rate)
    assert taxable == D("38700.00")
    assert taxable != gross_from_invoice
    assert gross_from_invoice - taxable == D("6966.00")


def test_gst_value_column_is_per_unit_not_line_total() -> None:
    """`Gst Value` 23.22 is per unit; x 300 units gives the 6,966 line total."""
    per_unit, qty = D("23.22"), D("300")
    assert q2(per_unit * qty) == D("6966.00")


# --- §5 quantity ----------------------------------------------------------

def test_quantity_may_be_fractional() -> None:
    assert parse_money("112.5") == D("112.5")
    assert q2(D("112.5") * D("250")) == D("28125.00")


def test_zero_quantity_line_produces_no_register_row() -> None:
    from pathlib import Path

    from gstparse.parser import parse_pdf

    fixture = Path(__file__).parent / "fixtures" / "sample_invoice.pdf"
    if not fixture.exists():
        pytest.skip("client invoice fixture not present -- see README 'Test fixtures'")
    invoice = parse_pdf(fixture)
    assert invoice.skipped_zero_qty == [6, 12, 13]
    assert all(item.qty != 0 for item in invoice.line_items)


# --- §5 HSN ---------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("9109100", "09109100"),   # 7 digits: leading zero was eaten
        ("9011111", "09011111"),
        ("09109100", "09109100"),  # already 8, unchanged
        ("21069099", "21069099"),
        ("0901", "0901"),          # genuinely 4 digits -- must NOT become 00000901
        ("901", "0901"),
    ],
)
def test_hsn_odd_length_gains_one_leading_zero_even_length_is_untouched(
    raw: str, expected: str
) -> None:
    assert normalise_hsn(raw) == expected


def test_hsn_four_digit_heading_is_not_padded_to_eight() -> None:
    """Padding 0901 to 00000901 would invent an HSN that does not exist."""
    assert normalise_hsn("0901") == "0901"
    assert is_valid_hsn("0901")


def test_same_hsn_written_two_ways_normalises_to_one_code() -> None:
    """The sample invoice contains both spellings of the same code."""
    assert normalise_hsn("9109100") == normalise_hsn("09109100")


def test_hsn_must_be_four_six_or_eight_digits() -> None:
    assert is_valid_hsn("0901") and is_valid_hsn("091091") and is_valid_hsn("09109100")
    assert not is_valid_hsn("09")        # chapter only, too coarse
    assert not is_valid_hsn("091091001")
    assert not is_valid_hsn("ABCD")


# --- §5 state logic -------------------------------------------------------

def test_same_state_gstins_are_intra_state() -> None:
    assert resolve_supply_type(SELLER, BUYER) == "intra"


def test_different_state_gstins_are_inter_state() -> None:
    assert resolve_supply_type(SELLER, "29AAKCG6367M1Z0"[:14] + "V") == "inter"


def test_intra_state_halves_the_rate() -> None:
    assert split_rate(D("18")) == D("9.000")
    assert split_rate(D("5")) == D("2.500")


def test_quarter_percent_rate_halves_below_two_decimals() -> None:
    """0.25% -> 0.125% each, which is why rates are stored at 3 dp."""
    assert split_rate(D("0.25")) == D("0.125")


def test_missing_buyer_gstin_returns_none_so_caller_routes_to_review() -> None:
    """B2C has no buyer GSTIN. Guessing would put tax in the wrong columns."""
    assert resolve_supply_type(SELLER, None) is None


def test_missing_buyer_gstin_falls_back_to_place_of_supply() -> None:
    assert resolve_supply_type(SELLER, None, "27") == "intra"
    assert resolve_supply_type(SELLER, None, "29") == "inter"


# --- §5 / R-06 the paisa split -------------------------------------------

def test_cgst_plus_sgst_always_equals_tax_exactly() -> None:
    """1406.25 / 2 = 703.125. Rounding both halves up gives 1406.26 and breaks §6.2."""
    cgst, sgst = split_intra_state_tax(D("1406.25"))
    assert cgst == D("703.13")
    assert sgst == D("703.12")
    assert cgst + sgst == D("1406.25")


def test_naive_independent_rounding_would_overstate_tax() -> None:
    """Documents the bug this rule exists to prevent -- and which the vendor shipped."""
    naive = q2(D("1406.25") / 2)
    assert naive * 2 == D("1406.26") != D("1406.25")


@pytest.mark.parametrize("tax", ["0.01", "0.03", "1406.25", "6966.00", "17276.25", "0.05"])
def test_split_is_exact_for_any_tax_value(tax: str) -> None:
    cgst, sgst = split_intra_state_tax(D(tax))
    assert cgst + sgst == D(tax)


# --- GSTIN ----------------------------------------------------------------

def test_real_gstins_pass_the_checksum() -> None:
    assert is_valid_gstin(SELLER)
    assert is_valid_gstin(BUYER)
    assert gstin_check_digit(SELLER[:14]) == "V"


def test_tampered_gstin_fails_the_checksum() -> None:
    assert not is_valid_gstin("27AAKCG6367M1ZX")


def test_gstin_state_code_is_the_first_two_digits() -> None:
    assert state_code(SELLER) == "27"
    assert state_code("99AAKCG6367M1ZV") == "99"
    assert state_code("00AAKCG6367M1ZV") is None


# --- money ----------------------------------------------------------------

def test_money_parsing_handles_indian_formatting() -> None:
    assert parse_money("1,58,610.25") == D("158610.25")
    assert parse_money("Rs 45,666") == D("45666")
    assert parse_money("(0.25)") == D("-0.25")
    assert parse_money("-0.25") == D("-0.25")
    assert parse_money("") is None
    assert parse_money("n/a") is None


def test_percent_parsing_strips_the_sign() -> None:
    assert parse_percent("18%") == D("18")
    assert parse_percent("5 %") == D("5")


def test_rounding_is_half_up_at_two_places() -> None:
    assert q2(D("0.125")) == D("0.13")
    assert q2(D("0.135")) == D("0.14")
    assert q2(D("2.675")) == D("2.68")  # a float would give 2.67 here
