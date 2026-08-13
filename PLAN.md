# PLAN.md

Offline-first invoice digitisation for Indian GST accounting.
Product name: **Utility by Patience AI**. Footer reads `a product of Patience AI · v{semver} (build {YYYY.MM.DD-n})`.
*(Spelling note: your message read "Utitliy" — I've used "Utility" throughout. Say if that was intentional; it's baked into the installer name, the Credential Manager entry and the update-feed path, so it's cheap to change now and annoying later.)*

Status: **awaiting approval. No Phase 0 code written.**
Infrastructure plan: see `INFRA.md`. Architectural decisions and risk flags: see `DECISIONS.md`.

---

## 0. Environment as measured on this machine

Verified on 2026-08-14, not assumed:

| Thing | Found | Consequence |
|---|---|---|
| OS | Fedora 44, x86_64 | matches brief |
| Node | v22.22.2 | fine for both channels |
| npm | 10.9.7 | no pnpm/yarn installed — plan uses npm |
| Python | **3.14.6** | **too new**; pin 3.12 in a venv (see D-04) |
| git | 2.55.0 | fine |
| Docker | 29.6.0 | used for pinned Python build env + local Postgres |
| Wine | not installed | Phase 0 smoke test needs it, or a real VM |
| Tesseract | not installed | needed for Phase 1 OCR tests |
| Ollama | not installed | — |
| RAM | **7.1 GB total, 2.6 GB free** | **cannot host a local vision model** (see D-11) |
| Disk | 372 GB free on /home | ample |

Groq key: validated (HTTP 200). Account exposes **text models only** — `openai/gpt-oss-120b`, `llama-3.3-70b-versatile`, `qwen/qwen3.6-27b`, `groq/compound`, plus Whisper. **No vision model is available.** This is load-bearing for Tier 3; see D-11.

---

## 1. Phase breakdown and gates

Each phase stops for review. Nothing in a later phase starts before its gate passes.

### Phase 0 — Scaffold + dual-channel build
- Monorepo, TS strict, lint/format/CI skeleton.
- Electron main + preload + renderer shell, security baseline switched on from commit one (`contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP).
- Two build targets from one renderer bundle: `legacy` (Electron 22.3.27) and `modern` (current LTS).
- GitHub Actions `windows-latest` job producing an unsigned NSIS `.exe` per channel.
- **Native-module spike (highest risk item in the phase):** prove the encrypted-SQLite native module rebuilds against *both* Electron ABIs. If this cannot be made to work, D-06 changes and we find out now, not in Phase 2.
- **Gate:** shell `.exe` launches on a Win7 SP1 VM *and* on Win11. Signing is deliberately **not** in this gate — see Risk R-03.

### Phase 1 — Parsing core (no UI)
Standalone Python CLI, OS-agnostic, fully tested on Fedora.
- File-type detection and normalisation; PDF text+geometry (pdfplumber); XLSX/CSV/DOCX readers; OCR path (OCRmyPDF + Tesseract eng+hin).
- Tier 1 profile engine, Tier 2 arithmetic inference, validation engine, Excel writer.
- Every §5 domain rule and every §6 validation rule gets its own named test. Golden-file fixtures compared cell by cell.
- **Gate:** 100% line-item accuracy on the supplied sample invoices; both §5 worked examples pass as golden tests; `mypy` clean.

### Phase 2 — Import → validate → review → export
- Sidecar spawned from Electron main, JSON-RPC over stdio, cancellable.
- Encrypted SQLite; soft delete + audit trail.
- Import screen (drag-drop, per-file progress, resumable), Review Queue (doc preview left, editable grid right, keyboard-first), Registers screen.
- Excel export incl. the two client-template defect fixes, plus `Invoice Summary` and `Import Log` sheets.
- **Gate:** a multi-file mixed-format import ties out to the rupee against hand-computed totals.

### Phase 3 — Auth and accounts
FastAPI + Postgres. OTP verification, Argon2id, rotating refresh tokens with reuse detection, lockout with backoff, device binding, 14-day offline grace. Tokens in Windows Credential Manager.
- **Gate:** full flow works; pulling the network keeps the app usable for 14 days; tokens verified present in Credential Manager and absent from disk/localStorage.

### Phase 4 — OTA, changelog, policy, footer build code
Channel-aware feeds, differential download, install-on-quit, staged rollout, signature verification, auto-rollback.
- **Gate:** update installs on quit without interrupting an in-flight import; a deliberately corrupted update is rejected; a deliberately broken build rolls back.

### Phase 5 — Tier 3 AI profile generation
Redaction layer, server proxy, manual column-mapper UI as the always-available fallback.
- **Gate:** an unseen vendor layout is mapped once, then every subsequent invoice from that vendor parses deterministically through Tier 1 with zero AI calls.

---

## 2. File tree

```
gst-register/
├── PLAN.md  DECISIONS.md  README.md  DEPLOYMENT.md  CHANGELOG.md
├── .env.example                     # .env is gitignored
├── package.json                     # npm workspaces
├── apps/
│   ├── desktop/                     # Electron
│   │   ├── src/main/                # main process (TS)
│   │   │   ├── index.ts
│   │   │   ├── ipc/                 # one file per channel group
│   │   │   ├── sidecar/             # spawn, JSON-RPC, lifecycle, crash restart
│   │   │   ├── db/                  # encrypted SQLite, migrations, repositories
│   │   │   ├── secrets/             # Credential Manager wrapper
│   │   │   ├── updater/             # channel-aware electron-updater
│   │   │   └── schema/              # zod schemas — the trust boundary
│   │   ├── src/preload/index.ts     # contextBridge surface, the ONLY bridge
│   │   ├── src/renderer/            # React + MUI. Zero electron imports (lint-enforced)
│   │   ├── electron-builder.legacy.yml
│   │   └── electron-builder.modern.yml
│   └── server/                      # FastAPI (Phase 3+)
│       ├── app/{auth,licence,updates,policy,ai_proxy}/
│       └── migrations/
├── packages/
│   ├── ipc-contract/                # zod schemas + inferred TS types, shared
│   └── ui/                          # MD3 theme, light + dark
├── sidecar/                         # Python — the parsing core (Phase 1)
│   ├── gstparse/
│   │   ├── cli.py  rpc.py
│   │   ├── detect.py                # file type / digital-vs-scanned
│   │   ├── readers/{pdf,xlsx,csv,docx,ocr}.py
│   │   ├── tier1_profile.py  tier2_infer.py  tier3_ai.py
│   │   ├── redact.py                # placeholder substitution + audit log
│   │   ├── money.py                 # Decimal helpers, ONE rounding convention
│   │   ├── gst.py                   # split, state logic, GSTIN checksum, HSN norm
│   │   ├── validate.py              # §6 rules, one function per rule
│   │   └── excel/writer.py
│   ├── tests/
│   │   ├── test_rules_*.py          # one file per §5 / §6 rule
│   │   └── golden/                  # fixture in → expected .xlsx out
│   └── pyproject.toml
├── profiles/                        # versioned vendor JSON, human-diffable
└── .github/workflows/{ci.yml,release.yml}
```

---

## 3. IPC contract

Renderer is untrusted. Every payload is zod-validated in main *before* it reaches any handler. The preload surface is the complete API; there is no escape hatch.

```ts
window.api = {
  files:    { pick(), hashPreview(paths) },
  import:   { start(paths) → jobId, cancel(jobId), onProgress(cb), onFileDone(cb) },
  invoices: { list(query), get(id), update(id, patch), softDelete(id, reason), restore(id) },
  lines:    { update(id, patch), softDelete(id, reason) },
  review:   { queue(), resolve(invoiceId), overrideRule(invoiceId, ruleCode, justification) },
  profiles: { list(), get(gstin), upsert(profile), testAgainst(profile, fileId), delete(gstin) },
  masters:  { units: CRUD, hsn: CRUD },
  export:   { preflight(invoiceIds) → BlockingFailure[], run(invoiceIds) → filePath },
  ai:       { consentStatus(), grantConsent(), revokeConsent(),
              proposeProfile(fileId) → { profile, redactionLog }, sentPayloadLog(id) },
  auth:     { login, logout, signup, verifyOtp, forgotPassword, profile, session },
  updates:  { status(), checkNow(), onAvailable(cb), onDownloaded(cb) },
  app:      { version(), buildCode(), channel(), policyDoc(kind), changelog() },
}
```

Conventions:
- Request/response only; no raw event emitters cross the bridge — subscriptions are wrapped and auto-disposed.
- Money crosses the boundary as **exact decimal strings**, never JS `number`. The renderer formats; it never computes a total.
- `export.run` re-runs the full validation gate in main. The renderer's disabled button is a UX nicety, not the enforcement point.
- Every mutating call writes an audit row before returning.

---

## 4. Database schema (SQLite, encrypted)

Money columns are `TEXT` holding exact decimal strings — SQLite has no decimal type and floats are banned (§13). Python reads them straight into `Decimal`. Quantities likewise (fractional per §5).

```
schema_migrations(version PK, applied_at)

source_files(id PK, sha256 UNIQUE, filename, ext, bytes, imported_at,
             parse_tier, ocr_used, status)

invoices(id PK, source_file_id FK, seller_gstin, buyer_gstin, buyer_name,
         invoice_no, invoice_date DATE, place_of_supply,
         supply_type CHECK(intra|inter), round_off TEXT, grand_total TEXT,
         computed_total TEXT, tie_out_delta TEXT,
         profile_id FK NULL, status CHECK(parsed|review|approved|exported),
         created_at, updated_at, deleted_at NULL,
         UNIQUE(seller_gstin, invoice_no) WHERE deleted_at IS NULL)

line_items(id PK, invoice_id FK, line_no, description, hsn TEXT, unit NULL,
           qty TEXT, unit_rate TEXT, gst_rate TEXT,
           taxable TEXT, igst_rate TEXT, igst TEXT,
           cgst_rate TEXT, cgst TEXT, sgst_rate TEXT, sgst TEXT,
           line_total TEXT, source_bbox JSON, deleted_at NULL)

vendor_profiles(id PK, seller_gstin, version, name, rules JSON,
                origin CHECK(manual|tier2|tier3), created_at, deleted_at NULL,
                UNIQUE(seller_gstin, version))

validation_findings(id PK, invoice_id FK, line_item_id FK NULL, rule_code,
                    severity CHECK(blocking|warning), message,
                    overridden_by NULL, override_reason NULL, override_at NULL)

unit_master(id PK, hsn NULL, product_key NULL, unit, updated_by, updated_at)

audit_log(id PK, entity, entity_id, action, actor_user_id,
          old_json, new_json, at)     -- append-only, never updated

exports(id PK, path, created_at, invoice_count, row_count, sha256)

ai_calls(id PK, source_file_id FK, provider, model, redacted_payload JSON,
         response JSON, tokens, at)   -- §4.3 auditability

users(id PK, server_user_id, email, name, org, gstin, role, last_sync_at)
device(id PK, device_fingerprint, licence_state, last_online_at, grace_until)
```

Notes:
- `hsn` is `TEXT` and stays text through DB → Python → Excel, so leading zeros survive (§5).
- Soft delete everywhere on financial records. No `DELETE` statement exists in the repository layer for `invoices` / `line_items`; it is a lint rule, not a convention.
- `audit_log` is append-only and holds no amounts in message text, only in `old_json`/`new_json` (structured logs stay PII-free per §12).

---

## 5. Test strategy

- One named test per §5 domain rule and per §6 validation rule. Test names read as the rule: `test_amount_column_is_gross_not_taxable`, `test_intra_state_never_populates_igst`, `test_zero_qty_line_is_skipped`, `test_hsn_leading_zero_preserved_as_text`.
- Both §5 worked examples are golden tests (`300×129` and `112.5×250`).
- Golden-file Excel comparison: cell by cell, including number formats and the total-row formula ranges (the two template defects in §7 get explicit regression tests).
- Property test: for random valid line items, `taxable + igst + cgst + sgst == line_total` at 2 dp, and `cgst + sgst == tax` exactly (this is where the paisa-split rule in R-06 gets enforced).
- Tier-2 inference tested against every supplied vendor layout; a layout that Tier 2 resolves must never call Tier 3.

---

## 6. Sample data — received and verified

### 6.1 Invoice: `Done Kesari Nanda SBA -60.pdf`

Genous IndiaAhar Pvt Ltd → Kesari Nandan Foods, invoice `SBA/26-27/60`, dated `1st July 2026`. One A4 page, digital text layer (it is a LibreOffice Calc export, not a scan), so Tier 1/2 apply directly and OCR is not exercised by this file.

**All 33 arithmetic checks pass. The invoice ties out to the rupee.** Verified with `Decimal`:

- Every §5 column-semantics claim is confirmed on real data: `Gst Value` is per-unit tax (`Rate × pct`), `Gst Amount` is the line total tax, and `Amount` is **gross** (taxable + tax). There is **no taxable column on the invoice at all** — `Taxable = QTY × Rate` is entirely ours to compute, exactly as §5 warns.
- Both §5 worked examples are literally lines 1 and 3 of this invoice.
- Taxable total `141,334.00` + tax `17,276.25` = `158,610.25`, matching the invoice's Amount total; round-off `−0.25` gives `158,610.00`, matching the printed Total.
- Intra-state confirmed: seller `27AAKCG6367M1ZV` and buyer `27ABDFK6885B1Z6` are both state 27 (Maharashtra), and the invoice carries CGST+SGST with no IGST.

**14 invoice lines → 11 register rows.** Lines 6, 12 and 13 have `QTY = 0` (`PAV BHAAJI MASALA`, `KESARIBHAT MIX`, `COFFEE BEANS STANDARD`) and are skipped per §5.

Every §5 hazard appears in this one file, which makes it an excellent Phase 1 fixture:

| §5 hazard | Where it shows up |
|---|---|
| `Amount` is gross, not taxable | every line |
| `Gst Value` is per-unit, not line total | every line |
| HSN lost leading zero | `9109100` (line 3) and `9011111` (line 14) |
| Same HSN written two ways in one document | `9109100` vs `09109100` — lines 3 and 5 |
| Short but valid HSN | `0901` (line 13) — 4 digits, genuinely correct |
| Fractional QTY | `112.5` (line 3) |
| Zero-QTY filler lines | lines 6, 12, 13 |
| `Unit` absent | no Unit column anywhere on the invoice |
| Free-text date | `1st July 2026` |
| Invoice-level round-off | `−0.25` |

Ground truth captured in `samples/expected/SBA-26-27-60.json` for the Phase 1 golden test.

### 6.2 Template: `Sales Register Format-Updated.xlsx`

Single sheet `Sales Data`, range `B1:Q33`. Layout matches §7 exactly — two-row merged header on rows 3–4, `B3:B4`…`J3:J4` and `Q3:Q4` as vertical merges, `K3:L3`/`M3:N3`/`O3:P3` as the IGST/CGST/SGST Rate+Amount pairs, data from B5.

**Both §7 defects confirmed in the actual file:**

1. Row formulas exist on `Q5:Q30` — so the data region is rows **5–30** — but the total row at 31 reads `=SUM(J5:J29)`. **Row 30 is silently excluded from every total.** Confirmed on all eight total cells (J31 through Q31).
2. The data block is a fixed 26 rows (5–30). This one invoice needs 11, so a second invoice of similar size overflows it.

Two further things the brief didn't mention, both found by reading the file:

3. **Data rows carry `General` number format.** Only the row-31 totals have the accounting format. Left alone, `Taxable`/`Amount` columns won't render at 2 dp, dates won't be dates, and **HSN will be coerced to a number, destroying the leading zeros** we just worked to preserve. The writer must set formats per column on every generated row: HSN as text, Date as `dd-mm-yyyy`, money as `#,##0.00`.
4. **There is no round-off row and no round-off column.** So `Sales Data` sums to `158,610.25` while the invoice says `158,610.00`. That gap is unclosable inside this sheet — which is precisely why §7's **`Invoice Summary`** sheet with a tie-out delta column is the actual reconciliation artifact. Worth confirming the client understands the register total will differ from the sum of invoice totals by the round-off amounts.

Column widths are set on only some columns (`D`, `L`–`Q` have none); the writer preserves what exists and sets sensible widths for the rest.

### 6.3 Still needed before the Phase 1 gate

The two files above are enough to **start** Phase 1 and to build Tier 1 for this vendor. They are not enough to finish it, because everything I now know about layout comes from a single vendor.

Still missing, in priority order:

1. **A scanned invoice.** The OCR path is currently entirely untested — this file is digital. Without one, OCR ships unverified, and §4's rule that OCR output always enters the review queue has nothing to prove itself against.
2. **An inter-state invoice with IGST.** Both GSTINs here are state 27, so the whole IGST branch — half of §5's state logic — has no test case. This is the gap I'd most want closed, because misclassifying IGST as CGST+SGST is the exact silent failure §1 forbids.
3. **A multi-page invoice**, for the page-break truncation risk (R-09).
4. **2–3 more vendors in any format**, so Tier 2's generic inference is developed against variety rather than tuned to Genous IndiaAhar's column order.

Redact party names freely — layout and arithmetic are what matter.

---

## 7. Open questions

| # | Question | Blocks |
|---|---|---|
| ~~Q1~~ | ~~Product name~~ — **answered: Utility by Patience AI** (spelling confirmation pending) | — |
| Q2 | Do real Win7 machines actually exist in this deployment, and how many? | Phase 0 scope (see R-01) |
| Q3 | Is there a Win7 SP1 VM I can test against, or do you run that gate? | Phase 0 gate |
| Q4 | Is this register **B2B only**, or can buyers be unregistered (no GSTIN)? | Phase 1 (see R-05) |
| Q5 | Code-signing certificate — do you already hold one, and of what type? | Phase 0/4 (see R-03) |
| Q6 | Is a cloud AI provider acceptable at all, given §2's "never leaves the machine by default"? | Phase 5 (see R-04) |
| Q7 | When our per-line tax split disagrees with a vendor's printed subtotal by a paisa (it already does on this invoice — see R-06), do we follow our arithmetic and warn, or mirror the vendor's figure? **My strong recommendation is follow our arithmetic**, because it is what ties the register to the invoice total. | Phase 1 |
| Q8 | Approval to provision the GCP project and Neon instance in `INFRA.md` (≈₹0–300/month)? | Phase 3 |
| Q9 | Which email provider for OTP delivery? Pick one that authenticates by API key and **does not allowlist IPs** — otherwise Cloud Run needs a VPC connector and NAT (see INFRA I-09; this is what bit jobagent with Brevo). | Phase 3 |
