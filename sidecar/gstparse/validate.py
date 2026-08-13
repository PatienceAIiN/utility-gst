"""The blocking validation gate (brief §6).

One named function per rule so each gets one named test (brief §12). A blocking
finding disables export; the invoice goes to the Review Queue. Loud failure is
always preferable to a quiet mismatch (brief §1).
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Final

from .gst import is_valid_gstin, is_valid_hsn
from .models import Finding, Invoice
from .money import q2

LINE_TOLERANCE: Final = Decimal("0.05")
INVOICE_TOLERANCE: Final = Decimal("1.00")

# Date-effective slab table (DECISIONS.md R-07). A frozen literal would reject
# valid invoices the moment slabs are re-notified, and would also break
# re-parsing of historical invoices. Seeded with the classic set plus the
# demerit rate; confirm against the client's CA before shipping.
RATE_TABLE: Final[tuple[tuple[dt.date, dt.date, frozenset[Decimal]], ...]] = (
    (
        dt.date(2017, 7, 1),
        dt.date(9999, 12, 31),
        frozenset(Decimal(r) for r in ("0", "0.1", "0.25", "1", "1.5", "3", "5", "6",
                                       "7.5", "12", "18", "28", "40")),
    ),
)


def allowed_rates(on: dt.date | None) -> frozenset[Decimal]:
    target = on or dt.date.today()  # noqa: DTZ011 - slab lookup is calendar-date, not an instant
    for start, end, rates in RATE_TABLE:
        if start <= target <= end:
            return rates
    return RATE_TABLE[-1][2]


# --- §6.1 -----------------------------------------------------------------

def rule_qty_times_rate_equals_taxable(invoice: Invoice) -> list[Finding]:
    findings = []
    for item in invoice.line_items:
        expected = q2(item.qty * item.unit_rate)
        if abs(expected - item.taxable) > LINE_TOLERANCE:
            findings.append(Finding(
                "R1_TAXABLE_MISMATCH", "blocking",
                f"Quantity x rate is {expected}, but taxable value is {item.taxable}.",
                item.src_line))
    return findings


# --- §6.2 -----------------------------------------------------------------

def rule_components_sum_to_line_total(invoice: Invoice) -> list[Finding]:
    findings = []
    zero = Decimal("0.00")
    for item in invoice.line_items:
        total = item.taxable + (item.igst or zero) + (item.cgst or zero) + (item.sgst or zero)
        if abs(q2(total) - item.line_total) > LINE_TOLERANCE:
            findings.append(Finding(
                "R2_LINE_TOTAL_MISMATCH", "blocking",
                f"Taxable plus tax is {q2(total)}, but the line total is {item.line_total}.",
                item.src_line))
    return findings


# --- §6.3 -----------------------------------------------------------------

def rule_invoice_ties_out(invoice: Invoice) -> list[Finding]:
    if invoice.stated_grand_total is None:
        return [Finding("R3_NO_STATED_TOTAL", "warning",
                        "No grand total found on the invoice, so it cannot be tied out.")]
    delta = invoice.tie_out_delta or Decimal("0.00")
    if abs(delta) > INVOICE_TOLERANCE:
        return [Finding(
            "R3_TIE_OUT_FAILED", "blocking",
            f"Line totals plus round-off come to {invoice.computed_grand_total}, "
            f"but the invoice says {invoice.stated_grand_total} "
            f"(off by {delta}).")]
    if delta != 0:
        return [Finding(
            "R3_TIE_OUT_ROUNDING", "warning",
            f"Ties out to within {abs(delta)} of the invoice total. Within tolerance, "
            f"usually the vendor rounding each tax half up independently.")]
    return []


# --- §6.4 -----------------------------------------------------------------

def rule_igst_xor_cgst_sgst(invoice: Invoice) -> list[Finding]:
    findings: list[Finding] = []
    if invoice.supply_type is None:
        findings.append(Finding(
            "R4_SUPPLY_TYPE_UNKNOWN", "blocking",
            "Cannot tell whether this is an intra-state or inter-state supply: the buyer "
            "GSTIN is missing or invalid and no place of supply was found. Set the place "
            "of supply before importing."))
    for item in invoice.line_items:
        has_igst = item.igst is not None and item.igst != 0
        has_pair = (item.cgst is not None and item.cgst != 0) or (
            item.sgst is not None and item.sgst != 0)
        if has_igst and has_pair:
            findings.append(Finding(
                "R4_BOTH_TAX_TYPES", "blocking",
                "IGST and CGST/SGST are both populated. Only one may apply.",
                item.src_line))
    return findings


# --- §6.5 -----------------------------------------------------------------

def rule_gst_rate_is_known(invoice: Invoice) -> list[Finding]:
    permitted = allowed_rates(invoice.invoice_date)
    findings = []
    for item in invoice.line_items:
        if item.gst_rate not in permitted:
            findings.append(Finding(
                "R5_UNKNOWN_GST_RATE", "blocking",
                f"GST rate {item.gst_rate}% is not a recognised slab for this invoice date. "
                f"Add it under Masters if it is legitimate.",
                item.src_line))
    return findings


# --- §6.6 -----------------------------------------------------------------

def rule_gstin_and_hsn_wellformed(invoice: Invoice) -> list[Finding]:
    findings: list[Finding] = []
    if not is_valid_gstin(invoice.seller_gstin):
        findings.append(Finding(
            "R6_SELLER_GSTIN_INVALID", "blocking",
            f"Seller GSTIN {invoice.seller_gstin!r} is not a valid 15-character checksummed GSTIN."))
    # Buyer GSTIN is optional (B2C) but must be valid when present -- DECISIONS.md R-05.
    if invoice.buyer_gstin and not is_valid_gstin(invoice.buyer_gstin):
        findings.append(Finding(
            "R6_BUYER_GSTIN_INVALID", "blocking",
            f"Buyer GSTIN {invoice.buyer_gstin!r} fails the checksum."))
    for item in invoice.line_items:
        if not is_valid_hsn(item.hsn):
            findings.append(Finding(
                "R6_HSN_INVALID", "blocking",
                f"HSN {item.hsn!r} is not 4, 6 or 8 digits.", item.src_line))
    return findings


# --- unit master (brief §5: never invent a unit) --------------------------

def rule_unit_present(invoice: Invoice) -> list[Finding]:
    missing = [i.src_line for i in invoice.line_items if not i.unit]
    if missing:
        return [Finding(
            "R8_UNIT_UNKNOWN", "warning",
            f"No unit on {len(missing)} line(s); the invoice does not state one. "
            f"Resolve from the HSN/product master or leave blank -- never guessed.")]
    return []


ALL_RULES = (
    rule_qty_times_rate_equals_taxable,
    rule_components_sum_to_line_total,
    rule_invoice_ties_out,
    rule_igst_xor_cgst_sgst,
    rule_gst_rate_is_known,
    rule_gstin_and_hsn_wellformed,
    rule_unit_present,
)


def validate_invoice(invoice: Invoice) -> list[Finding]:
    """Run every rule. Idempotency (§6.7) is checked by the caller against the DB."""
    for rule in ALL_RULES:
        invoice.findings.extend(rule(invoice))
    return invoice.findings
