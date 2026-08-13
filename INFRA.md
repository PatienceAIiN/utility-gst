# INFRA.md — GCP deployment and wiring

Server scope per §9: auth, device/licence check, update manifest, changelog, policy docs, AI proxy. **No file ever uploaded.** So this is a low-traffic, bursty, latency-tolerant API — which drives every choice below toward scale-to-zero rather than always-on.

Verified on this machine, 2026-08-14: `gcloud` 576.0.0, authenticated as `theharshkum@gmail.com`. Billing account **`patienceai` (01E300-1CFD42-ED42D7)** is open. `asia-south1` (Mumbai) is available for Cloud Run.

Nothing below has been provisioned — creating these resources is a spend decision and needs your go-ahead.

---

## 1. Topology

```
Desktop client (Windows, offline-first)
   │
   ├─ auth / licence / changelog / policy / AI proxy
   │     └── HTTPS ──► Cloud Run  (asia-south1, min-instances=0)
   │                      ├── Secret Manager   (GROQ_API_KEY, JWT key, DB URL)
   │                      ├── Neon Postgres    (Mumbai, existing account)
   │                      └── egress ──► api.groq.com   (Tier-3 proxy only)
   │
   └─ update feed + installer download
         └── HTTPS ──► Cloudflare R2  (NOT GCS — see I-05)
```

Deliberately **two clouds**, split on one axis: GCP runs the API, R2 serves the bytes. Reasoning in I-05.

---

## 2. Decisions

### I-01 · Dedicated GCP project `patience-utility`
Not folded into an existing project. Blast-radius isolation for client financial infrastructure, and a clean per-product billing line.
```bash
gcloud projects create patience-utility --name="Utility by Patience AI"
gcloud billing projects link patience-utility --billing-account=01E300-1CFD42-ED42D7
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com iamcredentials.googleapis.com --project=patience-utility
```
**Reverse if:** never — project sprawl is cheaper than a shared blast radius.

### I-02 · Cloud Run, `asia-south1`, min-instances = 0
The API is idle most of the day; §10's 14-day offline grace means the client tolerates cold starts by design. Cloud Run's free tier (2M requests, 180k vCPU-seconds, 360k GiB-seconds per month) covers this workload with room to spare — realistic cost is **₹0–200/month**.

Mumbai for latency to Indian users. Concurrency 80, 512 MiB, 1 vCPU, request timeout 60s (the AI-proxy path is the only slow one and Groq responds in ~1–2s).

**Cold start:** a Python container is roughly 1–3s cold. That lands on login and on update-check, never on a parse — parsing is entirely local. Acceptable.
**Reverse if:** login latency becomes a complaint. Fix is `min-instances=1` (~₹1,000/month, and it leaves the free tier), so only do it on evidence.

### I-03 · Neon Postgres, not Cloud SQL
Cloud SQL has no free tier and no scale-to-zero; the cheapest instance runs continuously at roughly ₹700–900/month for a database that will hold a few thousand user rows. Neon has a usable free tier, scales to zero, and **you already run it** (MrTourGuide) — one less system to learn.

Both Neon's Mumbai region and Cloud Run `asia-south1` are in Mumbai, so cross-cloud latency is single-digit milliseconds.

**Carry over from MrTourGuide:** Neon needs `search_path=public` set explicitly, and beware the shared `neon_auth` schema. Use a **separate Neon project**, not a new database inside the existing one, so this product's auth tables cannot collide with MrTourGuide's.
**Reverse if:** compliance requires data residency under a single provider contract, or connection-pool limits bite. Cloud SQL with a private IP is the migration target, and SQLAlchemy makes it a URL change.

### I-04 · Secrets in Secret Manager, injected as env vars
`GROQ_API_KEY`, `JWT_SIGNING_KEY`, `DATABASE_URL`. This is where D-12 lands: the Groq key lives here and **only** here.
```bash
printf '%s' "$GROQ_API_KEY" | gcloud secrets create groq-api-key --data-file=- --project=patience-utility
gcloud run deploy utility-api --set-secrets=GROQ_API_KEY=groq-api-key:latest ...
```
Free tier covers 6 active secret versions. The Cloud Run service account gets `roles/secretmanager.secretAccessor` and nothing else.
**Reverse if:** never.

### I-05 · Update feed and installers on Cloudflare R2, not GCS
This is the one place I'm deliberately stepping outside GCP, and it's a cost decision with a large multiplier.

Update distribution is pure egress. A ~120 MB installer × 2 channels, pushed to a few hundred devices a dozen times a year, is on the order of **hundreds of GB of egress per year**. GCS egress from Asia bills around ₹10–16/GB; **R2 egress is free.** At 700 GB/year that's roughly ₹7,000–11,000/year on GCS versus ₹0 on R2, and it grows linearly with every device and every release.

You already use R2 for PatienceAI APK distribution, so the bucket, token and workflow pattern exist.

Layout — each channel gets its own prefix, which is what §2 requires so a Win7 machine is never offered a `modern` build:
Using your existing `exchange` bucket under a `utility/` prefix (verified reachable; 447.9 MiB used of the 10 GiB free tier, so ~9.5 GiB headroom):
```
r2://exchange/utility/
  legacy/  latest.yml   Utility-Setup-x.y.z-legacy.exe   *.blockmap
  modern/  latest.yml   Utility-Setup-x.y.z.exe          *.blockmap
```
The prefix is not cosmetic — `exchange` already holds live production assets for other products, so it is the boundary the prune script enforces (I-12).
`.blockmap` files are what make electron-updater's differential download work — they must be published alongside the installer or every update becomes a full download.
**Reverse if:** the client mandates single-vendor infrastructure. Then GCS + Cloud CDN, and budget the egress explicitly.

### I-06 · GitHub Actions authenticates by Workload Identity Federation, no JSON key
A downloaded service-account key in GitHub secrets is a long-lived credential that can sign as the service account forever. WIF issues short-lived tokens against the repo's OIDC identity instead, scoped to one repository.
```bash
gcloud iam workload-identity-pools create github --location=global --project=patience-utility
# provider bound with attribute-condition on assertion.repository == "PatienceAIiN/<repo>"
```
The binding must be pinned to the exact repo. A provider left open to `assertion.repository_owner` alone lets *any* repo in the org mint tokens.
**Reverse if:** never.

### I-07 · Rate limiting in the application, not Cloud Armor
§9 requires OTP rate limiting and brute-force lockout with exponential backoff. The instinct is Cloud Armor, but Cloud Armor needs an external HTTPS load balancer in front of Cloud Run, and the LB itself costs roughly **₹1,500–2,000/month** — an order of magnitude more than the API it protects, and it defeats scale-to-zero.

So: enforce in FastAPI, with counters in Postgres keyed by email and by IP. Lockout state must be **durable**, not in-process, because Cloud Run scales horizontally and an in-memory counter is trivially bypassed by hitting a different instance. This is a correctness requirement, not an optimisation.
**Reverse if:** the API faces real volumetric abuse. Then front it with Cloudflare (already in the stack, and its rate limiting is far cheaper than Cloud Armor).

### I-08 · Custom domain via Cloudflare, target `api.patienceai.in`
DNS for `patienceai.in` is already at Cloudflare. Two routes: Cloud Run domain mapping, or Cloudflare proxying to the `run.app` URL. **Cloud Run domain mapping availability varies by region and needs verifying for `asia-south1`** before committing — if unavailable, proxy through Cloudflare, which also gives the I-07 fallback for free.

The client pins this hostname for update checks, so **it must be decided before the first signed release ships.** Changing the update-feed host after installers are in the field means those installers can no longer find updates.

### I-09 · Brevo for OTP mail — chosen, and the IP trap has to be engineered around
Decided: **Brevo**, via the **transactional HTTP API** (`POST https://api.brevo.com/v3/smtp/email`, `api-key` header), not SMTP relay. HTTP over 443 is friendlier to Cloud Run than SMTP ports and keeps one credential in Secret Manager.

I flagged Brevo because of the jobagent allowlist problem; you've picked it, so here is the actual mechanism and the mitigation rather than the objection again.

**Why this bites specifically on Cloud Run.** Brevo's IP security has a *learning phase*: while it's inactive Brevo auto-authorizes the IPs it sees calling the API, and once it stops seeing new ones it **activates blocking by itself**, after which requests from unlisted IPs are rejected immediately. The authorized list is shared across API and SMTP keys. Brevo's own docs are inconsistent on the window — one help article says 30 days, the developer docs give no timeline at all — so treat the exact number as unknown.

Cloud Run egresses from a large, rotating pool of Google IPs. So the failure looks like this: it works perfectly for weeks, Brevo silently decides it has learned the IP set, Cloud Run then rotates to an address outside that set, and **OTP delivery starts failing** — which means nobody can sign up or reset a password. It fails weeks after launch, from a config change nobody made, on the exact path with no fallback. That is the jobagent landmine, and it is a timing accident, not bad luck.

**Mitigation, in order:**

1. **Go into the Brevo dashboard and explicitly keep "Block unknown IP addresses" off**, treating the API key in Secret Manager as the security control. Whether this can be pinned off permanently is *not documented* — verify it in the account, and re-verify after the first month. Cheap, and probably sufficient.
2. **A delivery canary, and this one is not optional.** A scheduled job sends a real transactional email through Brevo daily and alerts on non-2xx. The failure mode is silent and delayed, so monitoring *is* the mitigation. Without it you find out from a user who can't log in.
3. **Only if Brevo forces blocking on:** pin a static egress IP — reserve an external address, Direct VPC egress from Cloud Run, Cloud NAT — and authorize that one IP. This costs roughly **₹2,800/month**, an order of magnitude more than the rest of the stack combined, so it is a deliberate escalation and not the default. At that price, relaying through one of the existing free-tier GCE VMs (which already has a stable IP) is worth comparing.

Also note Brevo's free tier is ~300 emails/day. Fine for OTP at early volume; worth a quota alert before it matters.

Groq needs none of this — it authenticates by key alone with no IP restriction — so the AI proxy path stays on shared egress.

### I-10 · Structured logging to Cloud Logging, no PII, no amounts
§12 forbids PII and amounts in logs. Cloud Logging's free tier is generous (50 GiB/month). Log `user_id`, `invoice_id`, `rule_code` — never a party name, GSTIN or rupee figure. A log-based alert on 5xx rate and on OTP-failure spikes.

---

## 3. Cost summary

| Component | Monthly (realistic) |
|---|---|
| Cloud Run (scale-to-zero) | ₹0–200 |
| Neon Postgres (free tier) | ₹0 |
| Secret Manager | ₹0 |
| Artifact Registry (<0.5 GB) | ₹0 |
| Cloudflare R2 (storage only, egress free) | ₹0–100 |
| Cloud Logging | ₹0 |
| **Total** | **≈ ₹0–300** |

Avoided by the choices above: Cloud SQL (~₹800), Cloud Armor + LB (~₹1,800), GCS egress (~₹600–900 amortised), VPC connector + NAT (~₹1,000). Roughly **₹4,000/month avoided** on a service that would otherwise cost more to host than to run.

The real spend in this project is not infrastructure — it is the **code-signing certificate** (DECISIONS.md R-03), which is annual, four-to-five figures in rupees, and the longest-lead item.

---

## 4. Wiring order (Phase 3, after approval)

1. Create project, link billing, enable APIs (I-01).
2. Create Neon project; store `DATABASE_URL` in Secret Manager.
3. Scaffold FastAPI with `/healthz` only; containerise; push to Artifact Registry.
4. Deploy to Cloud Run; confirm cold-start latency and health endpoint.
5. Set up WIF + the deploy workflow (I-06); confirm a push deploys with no stored key.
6. Map `api.patienceai.in` (I-08); verify TLS.
7. Then build the actual endpoints — auth first, AI proxy last (it depends on Phase 5).

R2 bucket and update feed are wired in Phase 4, not here.

### I-11 · In-app OTA: channel-aware, install-on-quit, retention-backed
Decided with R2 as the feed (I-05) and `electron-updater` on the client.

- **Channel-aware feeds.** `electron-builder.modern.yml` and `.legacy.yml` each carry their own `publish.url` under a separate R2 prefix, so a Win7 machine is never offered a `modern` build.
- **Background download, install on quit.** `autoDownload` on, `autoInstallOnAppQuit` on, and never `quitAndInstall()` mid-session. An in-flight import registers a quit-blocker, so an operator halfway through a 40-invoice batch cannot lose work to an update.
- **Differential download** via the `.blockmap` published next to each installer. Omit it and every update becomes a full download.
- **Staged rollout** through `stagingPercentage` in `latest.yml` — 10 → 50 → 100 by editing the manifest, not by rebuilding.
- **Signature verification** is `electron-updater`'s publisher-name check on the downloaded installer, which only means anything once the code-signing certificate exists (R-03). Until then the update path is functional but unverified — do not distribute on it.
- **Retention over deletion.** `scripts/r2_publish.py` keeps the 3 most recent releases per channel and never deletes what `latest.yml` resolves to. Delete-on-push would remove the only artifact auto-rollback can roll back to, and R2 storage is not the binding constraint (~0.7 GiB retained against a 10 GiB free tier). `KEEP_RELEASES=1` gives literal delete-on-push if wanted.

**Verified against the live bucket:** publishing 1.0.4 over an existing 1.0.0–1.0.3 kept 1.0.2/1.0.3/1.0.4, deleted 1.0.0/1.0.1, and touched nothing outside the `utility/` prefix. Test objects were removed afterwards; the bucket returned to its original 447.9 MiB.

### I-12 · The R2 credentials in use are account-wide and should be narrowed
The token supplied lists **8 buckets** (`barrister`, `exchange`, `identity`, `job`, `mrt`, `planner`, `sonex`, `startupintel-exports`). If it reaches CI, a compromise reaches every product's storage — and `exchange` holds live production assets (podcast audio, tickets, avatars) alongside our releases.

Two mitigations, both cheap: issue a **bucket-scoped R2 API token** for CI, and keep releases under the `utility/` prefix so the prune logic has a hard boundary to enforce (it refuses any key outside it). Both are in place in code; the scoped token is a dashboard action.
