"""One named test per §6 validation rule, plus Tier-2 inference."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal as D

import pytest

from gstparse.models import Finding, Invoice, LineItem
from gstparse.tier2_infer import infer_amount_semantics, match_headers
from gstparse.validate import (
    rule_components_sum_to_line_total,
    rule_gst_rate_is_known,
    rule_gstin_and_hsn_wellformed,
    rule_igst_xor_cgst_sgst,
    rule_invoice_ties_out,
    rule_qty_times_rate_equals_taxable,
)

SELLER = "27AAKCG6367M1ZV"
BUYER = "27ABDFK6885B1Z6"


def make_line(**overrides: object) -> LineItem:
    base: dict[str, object] = dict(
        src_line=1, description="X", hsn="21069099", qty=D("300"), unit=None,
        unit_rate=D("129"), gst_rate=D("18"), taxable=D("38700.00"),
        igst_rate=None, igst=None, cgst_rate=D("9"), cgst=D("3483.00"),
        sgst_rate=D("9"), sgst=D("3483.00"), line_total=D("45666.00"),
    )
    base.update(overrides)
    return LineItem(**base)  # type: ignore[arg-type]


def make_invoice(lines: list[LineItem] | None = None, **overrides: object) -> Invoice:
    base: dict[str, object] = dict(
        source_file="t.pdf", sha256="0" * 64, invoice_no="SBA/1",
        invoice_date=dt.date(2026, 7, 1), seller_name="S", seller_gstin=SELLER,
        buyer_name="B", buyer_gstin=BUYER, supply_type="intra",
        round_off=D("0.00"), stated_grand_total=D("45666.00"),
    )
    base.update(overrides)
    invoice = Invoice(**base)  # type: ignore[arg-type]
    invoice.line_items = lines if lines is not None else [make_line()]
    return invoice


# --- §6.1 -----------------------------------------------------------------

def test_rule1_passes_when_qty_times_rate_equals_taxable() -> None:
    assert rule_qty_times_rate_equals_taxable(make_invoice()) == []


def test_rule1_blocks_when_taxable_does_not_match_qty_times_rate() -> None:
    findings = rule_qty_times_rate_equals_taxable(
        make_invoice([make_line(taxable=D("38000.00"))]))
    assert [f.rule_code for f in findings] == ["R1_TAXABLE_MISMATCH"]
    assert findings[0].severity == "blocking"


def test_rule1_tolerates_five_paise() -> None:
    assert rule_qty_times_rate_equals_taxable(
        make_invoice([make_line(taxable=D("38700.04"))])) == []


# --- §6.2 -----------------------------------------------------------------

def test_rule2_passes_when_components_sum_to_line_total() -> None:
    assert rule_components_sum_to_line_total(make_invoice()) == []


def test_rule2_blocks_when_components_do_not_sum_to_line_total() -> None:
    findings = rule_components_sum_to_line_total(
        make_invoice([make_line(line_total=D("50000.00"))]))
    assert [f.rule_code for f in findings] == ["R2_LINE_TOTAL_MISMATCH"]


def test_rule2_holds_for_the_odd_paisa_split_that_broke_the_naive_version() -> None:
    """1406.25 tax: 703.13 + 703.12 keeps the line total exact."""
    line = make_line(qty=D("112.5"), unit_rate=D("250"), gst_rate=D("5"),
                     taxable=D("28125.00"), cgst=D("703.13"), sgst=D("703.12"),
                     line_total=D("29531.25"))
    assert rule_components_sum_to_line_total(make_invoice([line])) == []


# --- §6.3 -----------------------------------------------------------------

def test_rule3_passes_when_invoice_ties_out() -> None:
    assert rule_invoice_ties_out(make_invoice()) == []


def test_rule3_blocks_when_off_by_more_than_one_rupee() -> None:
    findings = rule_invoice_ties_out(make_invoice(stated_grand_total=D("45000.00")))
    assert [f.rule_code for f in findings] == ["R3_TIE_OUT_FAILED"]
    assert findings[0].severity == "blocking"


def test_rule3_warns_but_does_not_block_within_one_rupee() -> None:
    findings = rule_invoice_ties_out(make_invoice(stated_grand_total=D("45665.50")))
    assert [f.rule_code for f in findings] == ["R3_TIE_OUT_ROUNDING"]
    assert findings[0].severity == "warning"


def test_rule3_accounts_for_invoice_level_round_off() -> None:
    """Round-off is invoice-level, never distributed across lines."""
    invoice = make_invoice(round_off=D("-0.25"), stated_grand_total=D("45665.75"))
    assert rule_invoice_ties_out(invoice) == []


# --- §6.4 -----------------------------------------------------------------

def test_rule4_blocks_when_igst_and_cgst_sgst_are_both_populated() -> None:
    line = make_line(igst=D("6966.00"), igst_rate=D("18"))
    findings = rule_igst_xor_cgst_sgst(make_invoice([line]))
    assert "R4_BOTH_TAX_TYPES" in [f.rule_code for f in findings]


def test_rule4_allows_igst_alone_for_inter_state() -> None:
    line = make_line(igst=D("6966.00"), igst_rate=D("18"), cgst=None, sgst=None,
                     cgst_rate=None, sgst_rate=None)
    assert rule_igst_xor_cgst_sgst(make_invoice([line], supply_type="inter")) == []


def test_rule4_blocks_when_supply_type_is_undeterminable() -> None:
    """B2C with no place of supply must stop, not guess."""
    findings = rule_igst_xor_cgst_sgst(make_invoice(supply_type=None, buyer_gstin=None))
    assert "R4_SUPPLY_TYPE_UNKNOWN" in [f.rule_code for f in findings]


# --- §6.5 -----------------------------------------------------------------

def test_rule5_accepts_known_slabs() -> None:
    for rate in ("0", "0.25", "3", "5", "12", "18", "28"):
        line = make_line(gst_rate=D(rate))
        assert rule_gst_rate_is_known(make_invoice([line])) == []


def test_rule5_blocks_an_unrecognised_rate() -> None:
    findings = rule_gst_rate_is_known(make_invoice([make_line(gst_rate=D("17"))]))
    assert [f.rule_code for f in findings] == ["R5_UNKNOWN_GST_RATE"]


def test_rule5_is_date_effective_not_a_frozen_literal() -> None:
    """Slabs change by notification; the table is keyed by invoice date."""
    from gstparse.validate import allowed_rates
    assert D("18") in allowed_rates(dt.date(2026, 7, 1))
    assert D("40") in allowed_rates(dt.date(2026, 7, 1))


# --- §6.6 -----------------------------------------------------------------

def test_rule6_blocks_an_invalid_seller_gstin() -> None:
    findings = rule_gstin_and_hsn_wellformed(make_invoice(seller_gstin="27AAKCG6367M1ZX"))
    assert "R6_SELLER_GSTIN_INVALID" in [f.rule_code for f in findings]


def test_rule6_allows_a_missing_buyer_gstin_for_b2c() -> None:
    """An unregistered buyer has no GSTIN. That is legal, not a data error."""
    findings = rule_gstin_and_hsn_wellformed(make_invoice(buyer_gstin=None))
    assert not any(f.rule_code == "R6_BUYER_GSTIN_INVALID" for f in findings)


def test_rule6_blocks_a_present_but_invalid_buyer_gstin() -> None:
    findings = rule_gstin_and_hsn_wellformed(make_invoice(buyer_gstin="27ABDFK6885B1Z9"))
    assert "R6_BUYER_GSTIN_INVALID" in [f.rule_code for f in findings]


def test_rule6_blocks_a_malformed_hsn() -> None:
    findings = rule_gstin_and_hsn_wellformed(make_invoice([make_line(hsn="123")]))
    assert "R6_HSN_INVALID" in [f.rule_code for f in findings]


# --- export gate ----------------------------------------------------------

def test_export_is_blocked_while_any_blocking_finding_exists() -> None:
    invoice = make_invoice()
    assert not invoice.is_blocked
    invoice.findings.append(Finding("X", "warning", "just a warning"))
    assert not invoice.is_blocked
    invoice.findings.append(Finding("Y", "blocking", "real problem"))
    assert invoice.is_blocked


# --- Tier 2 ---------------------------------------------------------------

def test_header_synonyms_match_the_sample_invoice_columns() -> None:
    header = ["Sr. No.", "Description", "HSN CODE", "QTY", "Rate", "Gst Rate",
              "Gst Value", "Gst Amount", "Amount"]
    mapping = match_headers(header)
    assert mapping == {"sr_no": 0, "description": 1, "hsn": 2, "qty": 3, "unit_rate": 4,
                       "gst_rate": 5, "gst_value": 6, "gst_amount": 7, "amount": 8}


def test_gst_rate_header_is_not_swallowed_by_rate() -> None:
    """'Gst Rate' must not be matched by the shorter synonym 'Rate'."""
    mapping = match_headers(["Rate", "Gst Rate"])
    assert mapping["unit_rate"] == 0
    assert mapping["gst_rate"] == 1


def test_tier2_infers_amount_is_gross_from_arithmetic() -> None:
    colmap = {"qty": 0, "unit_rate": 1, "gst_rate": 2, "gst_value": 3,
              "gst_amount": 4, "amount": 5}
    rows = [["300", "129", "18%", "23.22", "6966.00", "45666"],
            ["150", "139", "18%", "25.02", "3753.00", "24603"],
            ["112.5", "250", "5%", "12.50", "1406.25", "29531.25"]]
    semantics = infer_amount_semantics(rows, colmap)
    assert semantics.amount_is_gross is True
    assert semantics.gst_value_is_per_unit is True
    assert semantics.sample_size == 3


def test_tier2_infers_amount_is_taxable_for_a_different_vendor() -> None:
    """Same header text, opposite meaning. Only arithmetic can tell them apart."""
    colmap = {"qty": 0, "unit_rate": 1, "gst_rate": 2, "amount": 3}
    rows = [["300", "129", "18%", "38700"], ["150", "139", "18%", "20850"]]
    semantics = infer_amount_semantics(rows, colmap)
    assert semantics.amount_is_gross is False


def test_tier2_returns_undetermined_rather_than_guessing() -> None:
    colmap = {"qty": 0, "unit_rate": 1, "gst_rate": 2, "amount": 3}
    rows = [["300", "129", "18%", "99999"]]
    semantics = infer_amount_semantics(rows, colmap)
    assert semantics.amount_is_gross is None
    assert not semantics.resolved


def test_tier2_ignores_zero_qty_rows_which_carry_no_signal() -> None:
    colmap = {"qty": 0, "unit_rate": 1, "gst_rate": 2, "amount": 3}
    rows = [["0", "555", "5%", "0"], ["300", "129", "18%", "45666"]]
    semantics = infer_amount_semantics(rows, colmap)
    assert semantics.sample_size == 1
    assert semantics.amount_is_gross is True


# --- self-healing: unreadable headers -------------------------------------

def test_misspelt_quantity_header_still_matches() -> None:
    """A real invoice shipped "Quantiy". An exact match dropped the column,
    which discarded the whole table and produced zero rows."""
    header = ["Sr. No.", "Description", "HSN CODE", "Quantiy", "Rate", "Gst Rate",
              "Gst Value", "Gst Amount", "Amount"]
    mapping = match_headers(header)
    assert mapping["qty"] == 3
    assert mapping["unit_rate"] == 4


@pytest.mark.parametrize(
    "typo,field",
    [
        ("Quantiy", "qty"), ("Quantty", "qty"), ("Qauntity", "qty"),
        ("Descripton", "description"), ("Descriptoin", "description"),
        ("Taxabel", "taxable"),
    ],
)
def test_common_header_typos_are_tolerated(typo: str, field: str) -> None:
    assert field in match_headers([typo, "Rate", "Amount"])


def test_short_headers_stay_strict() -> None:
    """"Rate" and "Date" differ by one character. Tolerating that would put a
    date into the unit-rate column, which is exactly the silent error the
    application exists to prevent."""
    mapping = match_headers(["Date"])
    assert "unit_rate" not in mapping


def test_unrelated_header_is_not_fuzzy_matched() -> None:
    mapping = match_headers(["Warehouse", "Dispatch"])
    assert mapping == {} or "qty" not in mapping


def test_columns_recovered_from_arithmetic_when_header_unreadable() -> None:
    """With no usable header text at all, the qty/rate/amount triple is found
    by testing qty x rate == amount across the rows."""
    from gstparse.readers.pdf import infer_columns_arithmetically

    rows = [
        ["DOSA MIX", "60", "129", "7740"],
        ["IDLY MIX", "42", "143", "6006"],
        ["UPMA MIX", "5", "199", "995"],
    ]
    found = infer_columns_arithmetically(rows, {})
    assert found["qty"] == 1
    assert found["unit_rate"] == 2
    assert found["amount"] == 3


def test_arithmetic_recovery_declines_when_nothing_agrees() -> None:
    """Random numbers must not produce a confident column map."""
    from gstparse.readers.pdf import infer_columns_arithmetically

    rows = [["A", "3", "7", "999"], ["B", "4", "11", "1234"], ["C", "9", "2", "77"]]
    found = infer_columns_arithmetically(rows, {})
    assert "qty" not in found


def test_missing_total_is_not_reported_when_nothing_parsed() -> None:
    """The absent total is a symptom. Reporting it alongside "no line items"
    points the operator at the wrong problem."""
    invoice = make_invoice([], stated_grand_total=None)
    invoice.line_items = []
    assert rule_invoice_ties_out(invoice) == []


def test_missing_total_reports_the_computed_figure_to_check() -> None:
    invoice = make_invoice(stated_grand_total=None)
    findings = rule_invoice_ties_out(invoice)
    assert findings[0].rule_code == "R3_NO_STATED_TOTAL"
    assert "45666.00" in findings[0].message


def test_net_amount_is_not_mistaken_for_gst_amount() -> None:
    """"net amount" and "gst amount" are two substitutions apart -- close enough
    for the length tolerance, and a swap would put tax in the value column."""
    mapping = match_headers(["Description", "Rate", "Gst Amount", "Net Amount"])
    assert mapping["gst_amount"] == 2
    assert mapping["amount"] == 3


def test_exact_header_match_outranks_a_fuzzy_one() -> None:
    """"Unit" is a UOM column, but is one character from quantity's "units"."""
    mapping = match_headers(["Qty", "Unit", "Rate"])
    assert mapping["qty"] == 0
    assert mapping["unit"] == 1


# --- self-healing: quantity printed rounded, billed fractional -------------

def test_quantity_recovered_when_printed_rounded_but_billed_fractional() -> None:
    """A sample invoice prints QTY 4 while every money column on the line is
    computed from 3.75, overstating the invoice by the difference."""
    from gstparse.parser import _recover_quantity

    assert _recover_quantity(
        printed=D("4"), rate=D("155"), gst_pct=D("18"),
        gst_value=D("27.90"), gst_amount=D("104.63"), amount=D("685.875"),
    ) == D("3.75")


def test_quantity_recovery_declines_when_the_printed_value_is_consistent() -> None:
    """The common case: nothing disagrees, so nothing is overridden."""
    from gstparse.parser import _recover_quantity

    assert _recover_quantity(
        printed=D("6"), rate=D("209"), gst_pct=D("18"),
        gst_value=D("37.62"), gst_amount=D("225.72"), amount=D("1479.72"),
    ) is None


def test_quantity_recovery_declines_when_the_amount_does_not_confirm_it() -> None:
    """The tax columns imply 3.75, but the Amount column agrees with neither
    quantity. Two figures must corroborate before the cell is overridden --
    otherwise the invoice must block, not be silently rewritten."""
    from gstparse.parser import _recover_quantity

    assert _recover_quantity(
        printed=D("4"), rate=D("155"), gst_pct=D("18"),
        gst_value=D("27.90"), gst_amount=D("104.63"), amount=D("9999.00"),
    ) is None


def test_quantity_recovery_needs_the_tax_columns() -> None:
    from gstparse.parser import _recover_quantity

    assert _recover_quantity(D("4"), D("155"), D("18"), None, None, D("685.875")) is None
    assert _recover_quantity(D("4"), D("155"), D("18"), D("0"), D("104.63"), D("685.875")) is None
