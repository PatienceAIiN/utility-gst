"""Domain models. Money and quantity are Decimal everywhere -- never float."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from decimal import Decimal

from .gst import SupplyType
from .money import fmt


@dataclass(slots=True)
class LineItem:
    src_line: int
    description: str
    hsn: str | None
    qty: Decimal
    unit: str | None
    unit_rate: Decimal
    gst_rate: Decimal          # percent, e.g. Decimal("18")
    taxable: Decimal
    igst_rate: Decimal | None
    igst: Decimal | None
    cgst_rate: Decimal | None
    cgst: Decimal | None
    sgst_rate: Decimal | None
    sgst: Decimal | None
    line_total: Decimal

    def to_json(self) -> dict[str, object]:
        return {
            "src_line": self.src_line,
            "description": self.description,
            "hsn": self.hsn,
            "qty": str(self.qty),
            "unit": self.unit,
            "unit_rate": str(self.unit_rate),
            "gst_rate": str(self.gst_rate),
            "taxable": fmt(self.taxable),
            "igst_rate": None if self.igst_rate is None else str(self.igst_rate),
            "igst": fmt(self.igst) or None,
            "cgst_rate": None if self.cgst_rate is None else str(self.cgst_rate),
            "cgst": fmt(self.cgst) or None,
            "sgst_rate": None if self.sgst_rate is None else str(self.sgst_rate),
            "sgst": fmt(self.sgst) or None,
            "line_total": fmt(self.line_total),
        }


@dataclass(slots=True)
class Finding:
    """A validation result. `blocking` findings disable export (brief §6)."""

    rule_code: str
    severity: str  # "blocking" | "warning"
    message: str
    src_line: int | None = None

    def to_json(self) -> dict[str, object]:
        return {
            "rule_code": self.rule_code,
            "severity": self.severity,
            "message": self.message,
            "src_line": self.src_line,
        }


@dataclass(slots=True)
class Invoice:
    source_file: str
    sha256: str
    invoice_no: str | None
    invoice_date: dt.date | None
    seller_name: str | None
    seller_gstin: str | None
    buyer_name: str | None
    buyer_gstin: str | None
    supply_type: SupplyType | None
    round_off: Decimal
    stated_grand_total: Decimal | None
    line_items: list[LineItem] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    parse_tier: int = 0
    ocr_used: bool = False
    skipped_zero_qty: list[int] = field(default_factory=list)

    # --- computed totals ---
    @property
    def taxable_total(self) -> Decimal:
        return sum((li.taxable for li in self.line_items), Decimal("0.00"))

    @property
    def igst_total(self) -> Decimal:
        return sum((li.igst or Decimal("0.00") for li in self.line_items), Decimal("0.00"))

    @property
    def cgst_total(self) -> Decimal:
        return sum((li.cgst or Decimal("0.00") for li in self.line_items), Decimal("0.00"))

    @property
    def sgst_total(self) -> Decimal:
        return sum((li.sgst or Decimal("0.00") for li in self.line_items), Decimal("0.00"))

    @property
    def tax_total(self) -> Decimal:
        return self.igst_total + self.cgst_total + self.sgst_total

    @property
    def line_total_sum(self) -> Decimal:
        return sum((li.line_total for li in self.line_items), Decimal("0.00"))

    @property
    def computed_grand_total(self) -> Decimal:
        return self.line_total_sum + self.round_off

    @property
    def tie_out_delta(self) -> Decimal | None:
        """Computed grand total minus what the invoice claims. Should be 0.00."""
        if self.stated_grand_total is None:
            return None
        return self.computed_grand_total - self.stated_grand_total

    @property
    def is_blocked(self) -> bool:
        return any(f.severity == "blocking" for f in self.findings)

    def to_json(self) -> dict[str, object]:
        return {
            "source_file": self.source_file,
            "sha256": self.sha256,
            "invoice_no": self.invoice_no,
            "invoice_date": self.invoice_date.isoformat() if self.invoice_date else None,
            "seller_name": self.seller_name,
            "seller_gstin": self.seller_gstin,
            "buyer_name": self.buyer_name,
            "buyer_gstin": self.buyer_gstin,
            "supply_type": self.supply_type,
            "parse_tier": self.parse_tier,
            "ocr_used": self.ocr_used,
            "skipped_zero_qty": self.skipped_zero_qty,
            "round_off": fmt(self.round_off),
            "stated_grand_total": fmt(self.stated_grand_total) or None,
            "totals": {
                "taxable": fmt(self.taxable_total),
                "igst": fmt(self.igst_total),
                "cgst": fmt(self.cgst_total),
                "sgst": fmt(self.sgst_total),
                "tax_total": fmt(self.tax_total),
                "line_total_sum": fmt(self.line_total_sum),
                "computed_grand_total": fmt(self.computed_grand_total),
                "tie_out_delta": fmt(self.tie_out_delta) or None,
            },
            "line_items": [li.to_json() for li in self.line_items],
            "findings": [f.to_json() for f in self.findings],
            "is_blocked": self.is_blocked,
        }
