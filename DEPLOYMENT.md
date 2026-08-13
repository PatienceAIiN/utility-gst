# DEPLOYMENT.md

## 1. Windows 7 prerequisites (the "unknown publisher" trap)

Windows 7 SP1 cannot validate SHA-2 code signatures out of the box. Without the
servicing updates below, a correctly signed installer still shows **"unknown
publisher"**, and depending on policy may be blocked outright.

Required on the target machine before installing the `legacy` build:

1. **Windows 7 Service Pack 1** — nothing else applies without it.
2. **SHA-2 code signing support** (KB4474419) — the security update that adds
   SHA-2 signature validation. Modern certificates are SHA-2 only; SHA-1 signing
   is no longer accepted by any public CA.
3. **KB4490628** — servicing stack update, a prerequisite for the above.

The installer should detect and warn rather than fail silently. A machine
missing these is not broken — it just needs patching first.

Windows 7 reached end of life in January 2020, and Electron 22.3.27 (the last
Win7-capable release) has been out of support since 2023. The `legacy` channel
is therefore best-effort: see `DECISIONS.md` R-01, and confirm real Win7
machines exist before paying this cost across every phase.

## 2. Code signing

**This is the longest-lead item in the project and it is a procurement task, not
an engineering one.** Start it early.

Since June 2023 the CA/Browser Forum baseline requirements mandate that
code-signing private keys live on FIPS 140-2 Level 2 (or equivalent) hardware.
Practical consequences:

- You **cannot** put a `.pfx` in GitHub Actions secrets and sign from CI. That
  workflow is dead.
- Signing from CI requires a cloud-HSM signing service with an API.
- OV/EV certificate issuance involves identity vetting — days to weeks.

**Win7-specific caution:** some modern signing services chain to roots that are
not in the Windows 7 trust store, so a certificate that validates perfectly on
Windows 11 can still produce "unknown publisher" on Windows 7. **Verify the
chosen service against a real Win7 SP1 VM before purchasing**, not after.

`.github/workflows/release.yml` reads `CSC_LINK` / `CSC_KEY_PASSWORD`. While
those secrets are unset the workflow still runs and produces an **unsigned**
installer — useful for testing, not for distribution.

## 3. Update feed

Artifacts are published to Cloudflare R2 (`INFRA.md` I-05), one prefix per
channel, so a Win7 machine is never offered a `modern` build:

```
r2://exchange/utility/legacy/  latest.yml  Utility-Setup-x.y.z-legacy.exe  *.blockmap
r2://exchange/utility/modern/  latest.yml  Utility-Setup-x.y.z.exe         *.blockmap
```

`.blockmap` files must be published alongside the installer or differential
download silently degrades to a full download.

### Retention

`scripts/r2_publish.py` uploads then prunes, keeping `KEEP_RELEASES` (default
**3**) most recent releases per channel, and never deleting the version that
`latest.yml` resolves to.

This is deliberately *retention* rather than delete-on-push. Deleting the
previous release the moment a new one lands removes the only thing auto-rollback
can roll back to, and during a staged rollout most installed users are still on
it. R2 storage is not the constraint — three releases across two channels is
~0.7 GiB against a 10 GiB free tier. Set `KEEP_RELEASES=1` for literal
delete-on-push if that is genuinely wanted.

**Do not use an R2/S3 lifecycle rule for this.** Age-based expiry would delete
the *current* release during any quiet period longer than the rule's window,
breaking updates and fresh installs. Pruning must be count-based and must run
after a successful publish.

Safety: the bucket `exchange` is shared with live production assets for other
products. The prune script verifies every key starts with `utility/{channel}/`
before deleting, and refuses anything outside it. The credentials currently in
use are account-wide (they can see 8 buckets) — **issue a bucket-scoped R2 token
for CI** rather than reusing them.

## 4. Release process

```bash
# 1. Everything green locally
cd sidecar && .venv/bin/python -m pytest -q && .venv/bin/python -m mypy gstparse
cd ../apps/desktop && npm run typecheck

# 2. Version bump + changelog, then tag
npm version 1.0.1 --no-git-tag-version
git commit -am "release: v1.0.1" && git tag v1.0.1 && git push --tags
```

The tag triggers `release.yml`: Linux runs the parsing suite, `windows-latest`
builds both channels, then the publish job pushes to R2 and prunes.

Staged rollout is driven by `stagingPercentage` in `latest.yml` — raise 10 → 50
→ 100 across successive edits of the manifest, not by rebuilding.

## 5. Secrets

| Secret | Where it lives | Notes |
|---|---|---|
| `GROQ_API_KEY` | GCP Secret Manager | Server-side only. Never in `app.asar`. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | GitHub Actions secrets | Should be bucket-scoped, not account-wide |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | GitHub Actions secrets | Cloud-HSM signing service |
| `BREVO_API_KEY` | GCP Secret Manager | See `INFRA.md` I-09 for the IP-authorisation trap |

The keys shared during development (Groq, R2) were transmitted in plaintext and
**should be rotated** before production use.
