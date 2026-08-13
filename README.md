# Utility by Patience AI

Offline-first invoice digitisation for Indian GST accounting. Drop in mixed-format invoices, get one consolidated GST Sales Register `.xlsx` that ties to the rupee.

**Nothing is uploaded.** Parsing, validation and export all happen on the machine. The server exists only for auth, updates and (opt-in) Tier-3 profile generation.

- `PLAN.md` — phases, file tree, IPC contract, DB schema
- `DECISIONS.md` — every architectural choice, its trade-off, and what would reverse it; plus where the brief is wrong or risky
- `INFRA.md` — GCP + R2 deployment
- `DEPLOYMENT.md` — Win7 prerequisites, signing, release process

## Status

| Phase | State |
|---|---|
| 1 · Parsing core | **Done.** 92 tests, `mypy --strict` clean, ties out on the real sample invoice |
| 2 · Import → validate → review → export | **Vertical slice working** (single-screen UI, real export) |
| 0 · Dual-channel packaging | Windows portable zip builds from Fedora; signed NSIS installer needs CI |
| 3–5 · Auth, OTA, Tier-3 AI | Designed, not built |

## Fedora dev setup

Requires Node 22+, `uv`, and Python 3.12 (uv installs it).

```bash
# Parsing core -- runs entirely on Linux, no Electron needed
cd sidecar
uv venv --python 3.12
uv pip install -e ".[dev]" types-openpyxl types-python-dateutil
.venv/bin/python -m pytest -q          # 92 tests
.venv/bin/python -m mypy gstparse      # strict
.venv/bin/python -m ruff check gstparse

# Parse an invoice to JSON
.venv/bin/python -m gstparse.cli parse /path/to/invoice.pdf

# Export a register (refuses if any blocking validation fails)
.venv/bin/python -m gstparse.cli export /path/to/invoice.pdf --out ./out
```

```bash
# Desktop app
cd apps/desktop
npm install
npm run typecheck
npm run dev            # spawns the sidecar from ../../sidecar/.venv
```

## Building for Windows from Fedora

PyInstaller cannot cross-compile, and the brief rightly forbids building the
sidecar under Wine. Two paths exist:

**Local (fast, unsigned, portable zip).** Assembles a Windows sidecar from the
official embeddable Python plus `win_amd64` wheels — no Wine, no Windows host:

```bash
./scripts/build-win-sidecar.sh                     # -> sidecar/dist/gstparse (66 MiB)
cd apps/desktop
npx electron-builder --win --config electron-builder.local.yml
# -> release/local/Utility-1.0.0-win-x64-portable.zip
```

NSIS and `rcedit` are the only steps that need Wine, so the local config emits a
zip and skips them.

**Release (signed NSIS installer).** `.github/workflows/release.yml` builds on
`windows-latest`: PyInstaller onedir sidecar, both channels, signing, then
publish to R2. This is the only path that produces the shipped `.exe`.

## Test fixtures

The golden test runs against a real client invoice, which is **not in version
control** — this repository is public and the file carries real GSTINs, party
names, bank details and amounts. Drop it at:

```
sidecar/tests/fixtures/sample_invoice.pdf
sidecar/tests/fixtures/client_template.xlsx
```

Without it: 61 tests pass, 31 skip. With it: 92 pass. Every rule test is
self-contained; only the end-to-end golden test needs the invoice.

## Architecture

```
Electron main (TS)            renderer (React + MUI)
├── zod-validated IPC   ◄────  pure IPC consumer, zero Electron API
├── Python sidecar (JSON-RPC over stdio)
│     ├── readers/      PDF geometry, (XLSX/CSV/DOCX/OCR to come)
│     ├── tier2_infer   arithmetic column-semantics inference
│     ├── gst.py        GSTIN, HSN, state logic, tax split
│     ├── validate.py   the blocking gate, one function per rule
│     └── excel/writer  Sales Data + Invoice Summary + Import Log
└── updater (channel-aware, R2 feed)
```

The renderer contains no Electron or Node API usage, which is what allows the
Win7 `legacy` channel to be deleted later without touching UI code.

## Money

`Decimal` end to end. No float touches money. Rounding is defined once, in
`sidecar/gstparse/money.py`: `ROUND_HALF_UP`, 2 dp, applied only at boundaries.

CGST/SGST split via `CGST = round(tax/2)`, `SGST = tax − CGST`, so the halves
always sum to the tax exactly. See `DECISIONS.md` R-06 — the sample invoice
itself gets this wrong by a paisa.
