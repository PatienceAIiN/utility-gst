# DECISIONS.md

Every architectural choice, its trade-off, and **the condition under which we reverse it**.
Part B records where I think the brief is wrong or risky. Per §14.3 I am flagging these rather than silently complying.

---

# Part A — Decisions

### D-01 · Dual-channel Electron (22.3.27 `legacy` / current LTS `modern`)
As specified. One renderer bundle, two builder configs, separate update feeds.
**Trade-off:** every native module must build against two ABIs, and every renderer feature is capped by Chromium 108's capabilities. That tax is paid on all six phases, not just Phase 0.
**Reverse if:** Q2 comes back "no real Win7 machines" — then delete the legacy channel and take modern Chromium everywhere. The renderer's zero-Electron-API rule is precisely what makes this deletion a config change rather than a rewrite.

### D-02 · Renderer contains zero Electron API usage
Enforced mechanically, not by discipline: an ESLint `no-restricted-imports` rule bans `electron` and `node:*` from `src/renderer/**`, and CI fails on violation.
**Trade-off:** some ceremony for trivial calls.
**Reverse if:** never. This is the property that makes D-01 reversible.

### D-03 · Money is `Decimal` end to end; SQLite stores exact decimal strings
Python `decimal.Decimal` everywhere. SQLite has no decimal type, so money and quantity columns are `TEXT`. Money crosses IPC as strings. The renderer formats, never computes.
**Rounding convention, defined once in `money.py` and nowhere else:** `ROUND_HALF_UP`, 2 dp, applied only at defined boundaries (per-line tax, invoice totals) — never mid-calculation.
**Trade-off:** `TEXT` money columns can't be summed in SQL; aggregates happen in Python.
**Reverse if:** never for floats. If SQL-side aggregation becomes a performance problem, switch to integer paise — but note fractional unit rates may need more than 2 dp, so this needs a scale audit first.

### D-04 · Pin Python 3.12, not the system 3.14
This machine has 3.14.6. The parsing stack (pdfplumber, OCRmyPDF, openpyxl, PyInstaller) has the deepest wheel coverage and the fewest surprises on 3.12, and **the local version must match CI exactly** or Fedora-green/Windows-red becomes routine.
Local dev uses a 3.12 venv; the Windows CI job pins the same. A Docker image pins it for reproducibility.
**Trade-off:** one more toolchain step in README setup.
**Reverse if:** every dependency publishes 3.14 wheels and CI can pin 3.14 too.

### D-05 · Python sidecar as PyInstaller **onedir**, JSON-RPC over stdio
As specified. Onedir over onefile because onefile unpacks to `%TEMP%` on every launch — slow, and it trips corporate AV.
**Trade-off:** larger install footprint.
**Reverse if:** never; onefile is strictly worse here.

### D-06 · Encrypted SQLite via `better-sqlite3-multiple-ciphers`
Gives SQLCipher-compatible encryption without a separate SQLCipher build. Key held in Windows Credential Manager (D-07).
**Trade-off:** a native module — so it must rebuild against both Electron ABIs (D-01). This is the single most likely thing to break the dual-channel build, which is why it is a **Phase 0 spike, not a Phase 2 discovery.**
**Reverse if:** the Electron 22 rebuild proves unworkable. Fallback: keep the DB unencrypted but store it in the user profile with the *file* encrypted via Electron `safeStorage`/DPAPI, or move encryption into the Python sidecar (`sqlcipher3`) so the native dependency sits on the Python side where there is only one ABI to satisfy. I lean toward the sidecar fallback.

### D-07 · Secrets in Windows Credential Manager — but not via `keytar`
`keytar` is archived and unmaintained; shipping it in new financial software is not defensible. Use `@napi-rs/keyring` (maintained, prebuilt N-API binaries, so it sidesteps much of the D-06 ABI pain).
Note the platform limit: a Credential Manager blob caps at 2560 bytes. Tokens and a DB key fit comfortably; anything larger must not be pushed in there.
**Reverse if:** `@napi-rs/keyring` fails on Win7. Fallback is Electron `safeStorage` (DPAPI, bound to the Windows user account), which satisfies the intent of §9 — secrets never in plaintext on disk — even though it is not literally Credential Manager.

### D-08 · Validation gate enforced in main, not the renderer
The disabled export button is UX. The actual gate re-runs in the main process inside `export.run`, because §3 says treat the renderer as untrusted.
**Reverse if:** never.

### D-09 · Vendor profiles as versioned JSON files *and* DB rows
Files under `profiles/` are the human-readable, diffable, reviewable artifact (§4.1); the DB holds the active pointer. Profiles are append-only-versioned — editing a profile creates v(n+1), so a re-parse of a historical invoice reproduces the original result.
**Trade-off:** two places to keep in sync; the file is the source of truth.
**Reverse if:** operators never hand-edit profiles, in which case DB-only is simpler.

### D-10 · Tier 3 sends **redacted text + geometry**, never a page image
See R-04 — this is the biggest change I'm proposing to the brief, and it is forced by two independent facts.
The payload is: header strings, column x-positions, ruling-line geometry, and type-tagged placeholders (`<AMT_1>`, `<GSTIN_1>`, `<QTY_1>`), plus the *results* of Tier 2's arithmetic tests expressed as relationships, not values. The model returns mapping rules only. Every payload is logged verbatim to `ai_calls` for audit.
**Reverse if:** never — sending images would break the redaction promise (R-04).

### D-11 · Tier-3 provider is Groq, not local Ollama
The brief's default is a local vision model. Two measurements make that impossible here:
1. **This machine has 7.1 GB RAM with 2.6 GB free.** A 7B–11B vision model does not fit alongside Electron dev and the sidecar.
2. **The supplied Groq key exposes no vision model at all** — the account lists `gpt-oss-120b`, `llama-3.3-70b-versatile`, `qwen3.6-27b`, `groq/compound` and Whisper. All text.

Both point the same way, and D-10 means text is sufficient anyway. **I verified this end to end before writing this document:** given only redacted placeholders and Tier-2 arithmetic evidence, `gpt-oss-120b` correctly resolved the exact §5 column-semantics trap — `GstValue` → per-unit tax, `GstAmount` → line total, `Amount` → gross not taxable. 689 tokens, one call, once per vendor. Cost is effectively zero and no real value left the machine.

Use `json_schema` strict mode with an enum-constrained field list, so the model physically cannot return a field name we don't handle. Note `gpt-oss-120b` is a reasoning model: it needs a real `max_tokens` budget (~2000) or it spends the whole allowance on reasoning and returns empty — I hit exactly that on the first attempt.
**Trade-off:** a cloud dependency in a product whose §2 promise is local-only. Mitigated by D-10 redaction, opt-in consent, and the fact that Tier 3 runs once per vendor, never per invoice.
**Reverse if:** the operator machine gets ≥16 GB RAM and a local model matches quality on our fixtures — the provider is behind an interface for exactly this reason. Also reverse to local if Q6 comes back "no cloud, ever," in which case the manual column-mapper UI becomes the sole Tier-3 path.

### D-12 · The Groq key lives on the server, never in the client
Per §13. It sits in the FastAPI proxy's secret store; the client calls our endpoint, which enforces per-user quota and logs usage. For local Phase-1/5 development it is in a gitignored `.env`.
**Note:** the key was shared in plaintext chat, so it should be **rotated** before it is used for anything real. It is currently written to `/home/harsh/gst-register/.env`, which is gitignored.
**Reverse if:** never.

### D-13 · The manual column-mapper UI is built *before* it is needed
§8 lists it under Phase 5, but it is the deterministic fallback for every case Tier 3 fumbles, and it is the only path that works with zero network and zero AI consent.
**Reverse if:** never — but this is a scope note, not a disagreement: it stays in Phase 5, it just gets built first within that phase.

### D-14 · Install-on-quit only; no forced restart
As specified (§10). An in-flight import registers a quit-blocker so an update cannot land mid-job.
**Reverse if:** never.

### D-15 · Server on GCP Cloud Run; update artifacts on Cloudflare R2
Full reasoning, costs and wiring order in **`INFRA.md`**. Summary: Cloud Run in Mumbai scaling to zero (~₹0–300/month all-in), Neon Postgres rather than Cloud SQL, secrets in Secret Manager, keyless CI via Workload Identity Federation.

The one deliberate step outside GCP is update distribution — installers and `latest.yml` go to R2, because update traffic is pure egress and R2 charges nothing for it while GCS would cost thousands of rupees a year that scale with every device and release.
**Reverse if:** the client mandates single-vendor infrastructure; then GCS + Cloud CDN with egress budgeted explicitly.

---

# Part B — Where I think the brief is wrong or risky

Ordered by how much they cost if ignored.

### R-01 · The Win7 requirement may be costing more than it's worth — verify it before Phase 0 ends
Electron 22.3.27 has been out of support since 2023; it ships an unpatched Chromium 108, and Windows 7 itself has been end-of-life since January 2020. The legacy channel therefore carries a permanent, unfixable CVE surface in software that holds client financial data.

The actual risk is *contained* — no remote content is ever loaded, CSP is strict, the renderer is sandboxed — so I am not refusing to build it. But the dual-channel tax is paid on all six phases, and in my experience "we need Win7" often turns out to mean one machine in one office that could be replaced for less than the engineering cost.

**Ask:** how many Win7 machines, and can they be upgraded? If the answer is zero or "they could be," deleting the legacy channel is the single highest-leverage simplification available in this whole build. D-02 keeps that door open either way.

### R-02 · §4.3's redaction promise is **structurally impossible** with a vision model
This is the most important item in this document.

The brief says the AI default is a local *vision* model receiving the document, and separately that before any cloud call a redaction layer must replace all amounts, GSTINs, party names and bank details so that "only layout structure and header text leave the machine."

Those two requirements contradict each other. **You cannot redact an image.** If you send a page render, every rupee figure, every GSTIN and the party's name and address are sitting in the pixels regardless of what the redaction layer does to the text extraction. The redaction layer would be logging a reassuring audit trail of a promise it isn't keeping — which in accounting software is worse than not having it.

Redaction only means something if the payload is a **structural representation**: header strings, coordinates, ruling lines, and typed placeholders. That is D-10, and it happens to be strictly better anyway — cheaper, auditable, diffable, and it makes a text model sufficient (D-11), which resolves the RAM problem and the no-vision-model-on-this-key problem simultaneously.

I have already demonstrated it works on the hardest case in the brief. **Recommend adopting D-10 as the Tier-3 design.**

### R-03 · Code signing is a procurement blocker, and it is not a Phase 4 problem
§11 puts a signed `.exe` in the **Phase 0** gate. That gate cannot be met by engineering alone:

- Since June 2023, publicly-trusted code-signing private keys must live on FIPS-140-2-Level-2 hardware or an equivalent HSM. You can no longer drop a `.pfx` into GitHub Actions secrets. Signing from CI requires a cloud-HSM signing service with an API.
- Lead time on an OV/EV certificate is days to weeks (identity vetting), and it costs real money annually.
- **Win7-specific trap:** some modern signing services chain to roots that aren't in Win7's trust store, and SHA-2 signature and timestamp validation on Win7 needs the SP1 + SHA-2 servicing updates the brief already mentions in §2. A cert that signs perfectly for Win11 can still produce "unknown publisher" on Win7. Whichever service is chosen must be **verified against a real Win7 VM before purchase**, not after.

**Recommend:** drop signing from the Phase 0 gate — Phase 0 proves an *unsigned* shell launches on Win7 — and start certificate procurement now in parallel, since it is the longest-lead item in the project. Q5 answers this.

### R-04 · "Client financial data never leaves the machine by default" vs. a cloud AI provider
§2 states the promise; §4.3 permits a cloud fallback that is off by default. With D-10 redaction, what leaves is a layout skeleton with no values, so the promise survives — but this should be a deliberate, recorded decision, not a default that drifts in.

Two things to settle before Phase 5: the provider's **data-retention and training terms** need reading (free tiers are frequently where "we may use your data" lives), and cross-border transfer of even redacted business data should be a conscious call given India's DPDP Act. If the client's answer is "nothing goes to any third party," the manual column-mapper (D-13) covers Tier 3 completely, just with more operator time per new vendor. That is a legitimate configuration, and I'd rather offer it than assume.

### R-05 · The intra/inter-state rule breaks on B2C invoices — a real gap in §5
§5 derives supply type purely by comparing the first two digits of seller and buyer GSTIN. That works only when the buyer *has* a GSTIN.

An unregistered buyer (B2C) has none. Under the current rule the comparison has no left-hand side, and the code would either crash or — far worse — silently fall through to one branch and put the tax in the wrong columns. In a sales register, systematically misclassifying IGST as CGST+SGST is exactly the "quiet mismatch" §1 says must never happen.

**Recommend:** supply type resolves from **place of supply** (a real GST concept), with buyer GSTIN prefix as the primary signal when present, falling back to the buyer's state from the address, and **blocking to the Review Queue when neither is determinable**. Never guess. Also, §6.6's GSTIN check must be conditional — mandatory for seller, optional-but-validated-if-present for buyer. Q4 tells me whether B2C is even in scope, but I'd build the fallback regardless.

### R-06 · CGST/SGST cannot always split evenly — §5 and §6.2 collide on odd paisa
**Status: CONFIRMED on the real sample invoice. This is no longer hypothetical.**

§5 says same-state means `CGST = SGST = tax/2`. §6.2 requires `Taxable + IGST + CGST + SGST == line TOTAL`.

Take the brief's own second worked example — which turns out to be line 3 of the actual invoice. Tax is ₹1,406.25, so half is ₹703.125. Round both to 2 dp and you get 703.13 + 703.13 = ₹1,406.26, a paisa more than the tax. Rule 6.2 then fails on an invoice that is perfectly correct.

**The vendor made exactly this error, and it is printed on the invoice.** The 5% bucket's true tax is ₹3,139.95, but the invoice prints `CGST@2.5% 1569.98` and `SGST@2.5% 1569.98`, summing to ₹3,139.96. Across all four printed tax subtotals the vendor states ₹17,276.26 against a true tax of ₹17,276.25. Their own `Gst Amount` column total (₹17,276.25) contradicts their own tax subtotals by a paisa.

**Decision, as a single documented function in `money.py`:** `CGST = round_half_up(tax / 2, 2)`, then `SGST = tax - CGST`. The halves may differ by a paisa; the sum is exact by construction.

Applied per line and summed, this yields CGST ₹8,638.13 / SGST ₹8,638.12 = ₹17,276.25 exactly, and the register grand total lands on ₹158,610.00 — **the invoice's printed Total to the rupee.** The naive both-halves-rounded approach misses it.

Consequence to accept deliberately: our `SGST@2.5%` figure is ₹1,569.97 where the vendor printed ₹1,569.98. We are right and the vendor is a paisa off. This must surface as a **warning on the Invoice Summary tie-out column, not a blocking validation failure** — otherwise every invoice from this vendor lands in the Review Queue forever. Q7 in `PLAN.md` asks you to confirm this policy.

Related: the *rates* halving (18% → 9+9) is clean, but 0.25% → 0.125% each is not representable at 2 dp. Store rates at 3 dp, or store the combined rate and derive the halves for display only.

### R-07 · The hardcoded GST rate set in §6.5 will fail on real invoices
§6.5 pins `gst_rate ∈ {0, 0.25, 3, 5, 12, 18, 28}` as a validation rule. Two problems.

First, GST slabs change by government notification — the structure was materially reworked in the September 2025 rationalisation, which restructured the 12% and 28% slabs and introduced a higher demerit rate. Any invoice carrying a rate outside the frozen list would be rejected by our own validator as malformed when it is in fact valid. Second, the app must keep parsing **historical** invoices at rates that are no longer current, so the answer is not simply "update the list."

**Recommend:** replace the literal with a **date-effective rate table** — rates valid between dates, seeded with both the pre- and post-reform slabs, editable from the Masters screen, and validated against the *invoice date* rather than today. An unknown rate becomes a Review Queue warning, not a hard rejection.

I'd want you or the client's CA to confirm the exact current slab list before I seed that table — I don't want to hardcode my own recollection of tax law into accounting software.

### R-08 · Idempotency rule §6.7 has no legitimate-override path
Blocking on "SHA-256 seen before OR (seller GSTIN + invoice no) already imported" is right as a default. But vendors do reissue corrected invoices under the same number, and an operator who hits that wall has no way forward except editing the database.

**Recommend:** keep it blocking, add an explicit **supersede** action — requires a typed justification, writes an audit row, soft-deletes the prior invoice's rows and links old → new. The rule stays loud; it just stops being a dead end.

### R-09 · Multi-page invoices are the most likely silent-truncation bug
Not mentioned in the brief, and it is the failure mode I would bet on. Line items spanning a page break, with the table header repeated on page 2 and a "carried forward" subtotal in between, will happily produce a register that is short a few lines and looks entirely plausible.

Validation rule §6.3 (`Σ line totals + round-off == grand total`) is what catches this — which is a good argument for it being blocking, not a warning. Worth an explicit multi-page fixture in the Phase 1 golden tests, hence the request in PLAN.md §6.

### R-10 · Phase 0's gate depends on hardware I don't have
"Shell runs on Win7 VM" cannot be verified from this machine — no Windows box, no Win7 licence, and Wine is not installed (and Wine is not a valid proxy for a Win7 trust-store or SHA-2 question anyway). I can produce the artifact from CI; someone with a real Win7 SP1 VM has to run the gate. Q3.

### R-12 · §5's "normalise HSN to 8 digits" is wrong and would corrupt valid codes
The brief says store HSN as text and "normalise to 8 digits." Left-padding to 8 is correct for a 7-digit value but destructive for a genuinely short one, and the sample invoice contains both cases.

HSN is hierarchical and only ever **2, 4, 6 or 8** digits — always even. So:
- `9109100` (7 digits) is a corrupted 8-digit code; prepend a zero → `09109100`. ✓
- `9011111` (7 digits) → `09011111`. ✓
- `0901` (4 digits, line 13) is **already valid** — it is the real HSN heading for coffee. Padding it to `00000901` would invent a code that doesn't exist.

**Rule, and it's cleaner than the brief's:** if the digit count is **odd, prepend one zero; if even, leave it alone.** That derives from the structure of HSN rather than guessing a target width, and it handles every case in the sample correctly.

Confirmation that this matters: the same physical HSN appears **twice in one document, written two different ways** — `9109100` on line 3 and `09109100` on line 5. Any approach that doesn't normalise would produce two different HSN codes for the same product family in the register.

### R-13 · The register sheet has nowhere to put round-off, so it cannot tie to invoice totals
Not in the brief, found by reading the template. `Sales Data` has 13 logical columns and none of them is round-off, and §5 correctly forbids distributing round-off across lines.

So for this invoice the register sums to ₹158,610.25 while the invoice's Total says ₹158,610.00. That ₹0.25 has no home in this sheet, by construction. Anyone reconciling the register against a stack of invoices will find a discrepancy on nearly every invoice and won't know it's expected.

This is exactly what §7's **`Invoice Summary`** sheet exists for, and it upgrades that sheet from "nice extra" to **the primary reconciliation artifact** — it is the only place where round-off and the tie-out delta can live. Worth making sure the client's accountant knows to reconcile against `Invoice Summary` rather than the `Sales Data` total.

### R-14 · The template will destroy HSN leading zeros unless formats are set per row
Also found by reading the file rather than the brief. Data rows 5–30 carry `General` number format; only the row-31 totals have an explicit format.

`General` means Excel decides, and Excel's decision for `09109100` is to treat it as a number and drop the leading zero — undoing R-12's normalisation at the very last step, silently, after every validation has passed. §5 flags the leading-zero hazard on input but not on output, and output is where it actually bites.

The writer must set formats explicitly on every generated row: HSN as **text** (`@`), Date as `dd-mm-yyyy`, money as `#,##0.00`, QTY at enough precision for `112.5`. Golden tests assert the *number formats*, not just the values — a cell holding the right string with the wrong format is still a bug.

### R-11 · Minor, but worth stating
- **OCR + Devanagari digits:** the brief specifies `eng+hin`. Hindi-language invoices may render digits in Devanagari (०-९); those must be normalised to ASCII before any arithmetic, or amounts silently become non-numeric. Cheap to handle, easy to forget.
- **§5's two worked examples are literally lines 1 and 3 of the sample invoice** — `300 × 129 = 38,700`, 18% → `6,966`, gross `45,666`; and `112.5 × 250 = 28,125`, 5% → `1,406.25`, gross `29,531.25`. Verified against the source PDF, not just re-derived from the brief. Encoded as golden tests verbatim.
- **The sample invoice is a LibreOffice Calc export, not a scan.** Its PDF title metadata is a SHA-256-named `.xlsx`. Useful to know: it means the file has a clean text layer, so it exercises Tier 1/2 well and the OCR path **not at all**. Do not mistake "the sample parses perfectly" for "OCR works."
- **§7's column layout is self-consistent** — B→Q is 13 logical columns with IGST/CGST/SGST each split into Rate+Amount, and `Q = J+L+N+P` correctly sums Taxable + the three tax amounts. No issue; noting it because I checked.
