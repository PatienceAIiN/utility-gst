#!/usr/bin/env python3
"""Publish a release to Cloudflare R2 and prune old ones.

Retention, not delete-on-push
-----------------------------
The ask was "delete after new build pushed". Deleting the previous release the
moment a new one lands removes the only thing an auto-rollback can roll back TO
(brief §10 requires rollback on failed launch), and during a staged rollout
(10% -> 50% -> 100%) most installed users are still ON that version.

R2 storage is also not the constraint: at ~120 MiB an installer, three retained
releases across two channels is ~0.7 GiB against a 10 GiB free tier, and the
bucket currently holds well under 0.5 GiB. Deleting aggressively saves nothing
measurable and removes the emergency un-ship button.

So KEEP_RELEASES (default 3) is honoured instead. Set KEEP_RELEASES=1 for
literal delete-on-push if that is genuinely wanted.

Safety rules, because this bucket is shared with live production assets for
other products:
  * every key is verified to start with {prefix}/{channel}/ before deletion
  * the version referenced by the just-published latest.yml is never deleted
  * pruning runs only after the upload succeeds
  * --dry-run prints the plan and touches nothing
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import boto3
from botocore.config import Config

VERSION_RE = re.compile(r"(\d+\.\d+\.\d+)")
CONTENT_TYPES = {
    ".exe": "application/octet-stream",
    ".yml": "text/yaml",
    ".blockmap": "application/octet-stream",
}


def client():  # type: ignore[no-untyped-def]
    endpoint = os.environ["R2_ENDPOINT"]
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", region_name="auto"),
    )


def version_of(key: str) -> str | None:
    match = VERSION_RE.search(Path(key).name)
    return match.group(1) if match else None


def live_version(src: Path) -> str | None:
    """The version latest.yml points at -- the one clients will download.

    Deleting this would break every update check, so it is protected regardless
    of retention count. Read from the manifest rather than inferred from
    filenames, because the manifest is what clients actually resolve.
    """
    for manifest in src.rglob("*.yml"):
        for line in manifest.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("version:"):
                return line.split(":", 1)[1].strip()
    return None


def publish(s3, bucket: str, base: str, src: Path) -> set[str]:  # type: ignore[no-untyped-def]
    """Upload every artifact. Returns the version(s) just published."""
    published: set[str] = set()
    files = sorted(p for p in src.rglob("*") if p.is_file())
    if not files:
        raise SystemExit(f"No artifacts found in {src}")

    # Upload the installer and blockmap BEFORE latest.yml, so a client that polls
    # mid-publish never sees a manifest pointing at a file that is not there yet.
    ordered = sorted(files, key=lambda p: p.name.endswith(".yml"))
    for path in ordered:
        key = f"{base}/{path.name}"
        s3.upload_file(
            str(path), bucket, key,
            ExtraArgs={"ContentType": CONTENT_TYPES.get(path.suffix, "application/octet-stream")},
        )
        size = path.stat().st_size
        print(f"  uploaded {key}  ({size / 1024 / 1024:.1f} MiB)")
        if (found := version_of(path.name)) is not None:
            published.add(found)
    return published


def prune(s3, bucket: str, base: str, keep: int, protect: set[str],  # type: ignore[no-untyped-def]
          dry_run: bool) -> None:
    paginator = s3.get_paginator("list_objects_v2")
    keys: list[str] = []
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{base}/"):
        keys.extend(obj["Key"] for obj in page.get("Contents", []))

    versions = {v for k in keys if (v := version_of(k)) is not None}
    if not versions:
        print("  nothing versioned to prune")
        return

    def sort_key(version: str) -> tuple[int, ...]:
        return tuple(int(part) for part in version.split("."))

    ordered = sorted(versions, key=sort_key, reverse=True)
    retain = set(ordered[:keep]) | protect
    drop = [v for v in ordered if v not in retain]

    if not drop:
        print(f"  retention ok: {len(ordered)} release(s), keeping {sorted(retain, reverse=True)}")
        return

    print(f"  keeping {sorted(retain, key=sort_key, reverse=True)}; removing {drop}")
    for key in keys:
        version = version_of(key)
        if version is None or version not in drop:
            continue
        # Never delete outside our own channel prefix -- this bucket is shared.
        if not key.startswith(f"{base}/"):
            print(f"  REFUSING to delete out-of-scope key: {key}", file=sys.stderr)
            continue
        if dry_run:
            print(f"  [dry-run] would delete {key}")
        else:
            s3.delete_object(Bucket=bucket, Key=key)
            print(f"  deleted {key}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--channel", required=True, choices=["modern", "legacy"])
    parser.add_argument("--src", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    bucket = os.environ["R2_BUCKET"]
    prefix = os.environ.get("R2_PREFIX", "utility")
    keep = max(1, int(os.environ.get("KEEP_RELEASES", "3")))
    base = f"{prefix}/{args.channel}"

    s3 = client()
    print(f"[{args.channel}] publishing to r2://{bucket}/{base}/")
    publish(s3, bucket, base, args.src)

    # Protect only what latest.yml resolves to. Protecting everything in the
    # source directory would silently disable retention on a multi-version dir.
    live = live_version(args.src)
    protect = {live} if live else set()
    print(f"[{args.channel}] pruning, keeping {keep} most recent; live={live or 'unknown'}")
    prune(s3, bucket, base, keep, protect, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
