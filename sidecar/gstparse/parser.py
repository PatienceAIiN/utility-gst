"""Assemble a validated Invoice from a document. Tier 1 -> Tier 2 -> (Tier 3).

Taxable value is ALWAYS computed as QTY x Rate by us. It is not read from the
document, because on real invoices it frequently is not printed at all and the
column that looks like it ("Amount") is usually gross (brief §5).
"""

from __future__ import annotations

import hashlib
from decimal import Decimal
from pathlib import Path

from .gst import (
    compute_line_tax,
    normalise_hsn,
    resolve_supply_type,
    split_intra_state_tax,
    split_rate,
)
from .models import Finding, Invoice, LineItem
from .money import parse_money, parse_percent, q2
from .readers.pdf import PdfDocument
from .tier2_infer import infer_amount_semantics, match_headers


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_pdf(path: Path) -> Invoice:
    document = PdfDocument(path)
    colmap = match_headers(document.header_row)
    semantics = infer_amount_semantics(document.data_rows, colmap)

    gstins = document.gstins()
    seller_gstin = gstins[0] if gstins else None
    buyer_gstin = gstins[1] if len(gstins) > 1 else None

    invoice = Invoice(
        source_file=path.name,
        sha256=sha256_of(path),
        invoice_no=document.invoice_no(),
        invoice_date=document.invoice_date(),
        seller_name=document.seller_name(),
        seller_gstin=seller_gstin,
        buyer_name=document.buyer_name(),
        buyer_gstin=buyer_gstin,
        supply_type=resolve_supply_type(seller_gstin, buyer_gstin),
        round_off=document.round_off(),
        stated_grand_total=document.stated_grand_total(),
        parse_tier=2,
    )

    if not semantics.resolved and semantics.sample_size:
        invoice.findings.append(
            Finding(
                "TIER2_AMBIGUOUS",
                "blocking",
                "Could not resolve what the amount columns mean from the arithmetic. "
                "Map this vendor manually before importing.",
            )
        )

    def cell(row: list[str | None], name: str) -> str | None:
        index = colmap.get(name)
        if index is None or index >= len(row):
            return None
        return row[index]

    for offset, row in enumerate(document.data_rows, start=1):
        qty = parse_money(cell(row, "qty"))
        rate = parse_money(cell(row, "unit_rate"))
        gst_pct = parse_percent(cell(row, "gst_rate"))
        src_line = parse_money(cell(row, "sr_no"))
        line_no = int(src_line) if src_line is not None else offset

        if qty is None or rate is None:
            continue

        # Brief §5: vendors leave unordered SKUs in the table at QTY 0. They are
        # not register rows.
        if qty == 0:
            invoice.skipped_zero_qty.append(line_no)
            continue

        if gst_pct is None:
            invoice.findings.append(
                Finding("GST_RATE_MISSING", "blocking",
                        "No GST rate found on this line.", line_no)
            )
            gst_pct = Decimal(0)

        taxable = q2(qty * rate)
        tax = compute_line_tax(taxable, gst_pct)

        igst = cgst = sgst = None
        igst_rate = cgst_rate = sgst_rate = None
        if invoice.supply_type == "inter":
            igst, igst_rate = tax, gst_pct
        elif invoice.supply_type == "intra":
            cgst, sgst = split_intra_state_tax(tax)
            cgst_rate = sgst_rate = split_rate(gst_pct)

        invoice.line_items.append(
            LineItem(
                src_line=line_no,
                description=(cell(row, "description") or "").replace("\n", " ").strip(),
                hsn=normalise_hsn(cell(row, "hsn")),
                qty=qty,
                unit=(cell(row, "unit") or None),
                unit_rate=rate,
                gst_rate=gst_pct,
                taxable=taxable,
                igst_rate=igst_rate,
                igst=igst,
                cgst_rate=cgst_rate,
                cgst=cgst,
                sgst_rate=sgst_rate,
                sgst=sgst,
                line_total=q2(taxable + tax),
            )
        )

    from .validate import validate_invoice

    validate_invoice(invoice)
    return invoice
