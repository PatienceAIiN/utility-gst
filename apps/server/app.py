"""Utility account and sync API.

Deliberately small. Per the brief §9 the server exists only for auth, licence,
update manifests, policy documents and the AI proxy -- no invoice ever reaches
it, and no parsing happens here.

Backups arrive already encrypted by the client (AES-256-GCM under a key derived
from the user's password). This service stores opaque bytes; it cannot read
them, which is the whole point of doing the encryption client-side.

Runs alongside existing services on the shared VM: its own database, its own
port, its own systemd unit. It touches nothing else.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field

DATABASE_URL = os.environ["UTILITY_DATABASE_URL"]
BACKUP_DIR = Path(os.environ.get("UTILITY_BACKUP_DIR", "/var/lib/utility/backups"))
MAX_BACKUP_BYTES = 32 * 1024 * 1024
TOKEN_TTL = timedelta(days=14)  # matches the client's offline grace period

app = FastAPI(title="Utility API", docs_url=None, redoc_url=None, openapi_url=None)


def db() -> psycopg.Connection:
    return psycopg.connect(DATABASE_URL, autocommit=True)


def now() -> datetime:
    return datetime.now(timezone.utc)


# --- password hashing -------------------------------------------------------
# scrypt from hashlib, matching the desktop client's KDF family. No native
# dependency, no build step on a shared production VM.
SCRYPT = {"n": 1 << 15, "r": 8, "p": 1, "dklen": 32, "maxmem": 256 * 1024 * 1024}


def hash_password(password: str, salt: bytes | None = None) -> str:
    use = salt or secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=use, **SCRYPT)
    return f"scrypt${use.hex()}${key.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_hex, key_hex = stored.split("$")
        expected = bytes.fromhex(key_hex)
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), **SCRYPT)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


# --- rate limiting ----------------------------------------------------------
# Durable, in Postgres. An in-process counter would be useless the moment the
# service runs more than one worker.
def rate_limit(key: str, limit: int, window_seconds: int) -> None:
    cutoff = now() - timedelta(seconds=window_seconds)
    with db() as conn:
        conn.execute("DELETE FROM rate_hits WHERE at < %s", (cutoff,))
        count = conn.execute(
            "SELECT count(*) FROM rate_hits WHERE k = %s AND at >= %s", (key, cutoff)
        ).fetchone()[0]
        if count >= limit:
            raise HTTPException(429, "Too many requests. Try again shortly.")
        conn.execute("INSERT INTO rate_hits (k, at) VALUES (%s, %s)", (key, now()))


def client_ip(request: Request) -> str:
    # Behind nginx/Cloudflare, so trust the forwarded chain's first entry.
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "?")


# --- schema -----------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  name          text NOT NULL,
  org           text,
  gstin         text,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE TABLE IF NOT EXISTS tokens (
  token      text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS backups (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       text NOT NULL,
  bytes      integer NOT NULL,
  sha256     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backups_account_idx ON backups (account_id, at DESC);
CREATE TABLE IF NOT EXISTS feedback (
  id      bigserial PRIMARY KEY,
  kind    text NOT NULL,
  message text NOT NULL,
  email   text,
  version text,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rate_hits (k text NOT NULL, at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS rate_hits_idx ON rate_hits (k, at);
CREATE TABLE IF NOT EXISTS activity (
  id         bigserial PRIMARY KEY,
  account_id uuid,
  action     text NOT NULL,
  detail     text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_at_idx ON activity (at DESC);
"""


@app.on_event("startup")
def startup() -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.execute(SCHEMA)


def log(account_id: str | None, action: str, detail: str = "") -> None:
    """Activity log. No amounts, no party names, no GSTINs (brief §12)."""
    try:
        with db() as conn:
            conn.execute(
                "INSERT INTO activity (account_id, action, detail) VALUES (%s, %s, %s)",
                (account_id, action, detail[:300]),
            )
    except Exception:
        pass  # logging must never break a request


# --- auth -------------------------------------------------------------------
class SignUp(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=1024)
    name: str = Field(min_length=1, max_length=200)
    org: str | None = Field(default=None, max_length=200)
    gstin: str | None = Field(default=None, max_length=20)


class SignIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)


def issue_token(account_id: str) -> dict[str, str]:
    token = secrets.token_urlsafe(48)
    with db() as conn:
        conn.execute(
            "INSERT INTO tokens (token, account_id, expires_at) VALUES (%s, %s, %s)",
            (token, account_id, now() + TOKEN_TTL),
        )
    return {"token": token, "expires_at": (now() + TOKEN_TTL).isoformat()}


def current_account(authorization: Annotated[str | None, Header()] = None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sign in required.")
    token = authorization.split(" ", 1)[1].strip()
    with db() as conn:
        row = conn.execute(
            "SELECT account_id FROM tokens WHERE token = %s AND expires_at > %s", (token, now())
        ).fetchone()
    if not row:
        raise HTTPException(401, "Session expired. Sign in again.")
    return str(row[0])


@app.get("/healthz")
def healthz() -> dict[str, object]:
    with db() as conn:
        conn.execute("SELECT 1")
    return {"ok": True, "service": "utility-api", "time": now().isoformat()}


@app.post("/v1/auth/signup")
def signup(body: SignUp, request: Request) -> dict[str, object]:
    rate_limit(f"signup:{client_ip(request)}", limit=5, window_seconds=3600)
    with db() as conn:
        exists = conn.execute("SELECT 1 FROM accounts WHERE email = %s", (body.email.lower(),)).fetchone()
        if exists:
            raise HTTPException(409, "An account with that email already exists.")
        row = conn.execute(
            "INSERT INTO accounts (email, name, org, gstin, password_hash)"
            " VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (body.email.lower(), body.name, body.org, body.gstin, hash_password(body.password)),
        ).fetchone()
    account_id = str(row[0])
    log(account_id, "signup")
    return {"account": {"id": account_id, "email": body.email, "name": body.name}, **issue_token(account_id)}


@app.post("/v1/auth/login")
def login(body: SignIn, request: Request) -> dict[str, object]:
    ip = client_ip(request)
    rate_limit(f"login:{ip}", limit=20, window_seconds=900)
    rate_limit(f"login:{body.email.lower()}", limit=10, window_seconds=900)
    with db() as conn:
        row = conn.execute(
            "SELECT id, password_hash, name FROM accounts WHERE email = %s", (body.email.lower(),)
        ).fetchone()
    if not row or not verify_password(body.password, row[1]):
        raise HTTPException(401, "That email or password is not right.")
    account_id = str(row[0])
    with db() as conn:
        conn.execute("UPDATE accounts SET last_login_at = %s WHERE id = %s", (now(), account_id))
    log(account_id, "login")
    return {"account": {"id": account_id, "email": body.email, "name": row[2]}, **issue_token(account_id)}


# --- backups ----------------------------------------------------------------
@app.put("/v1/backups/{name}")
async def put_backup(
    name: str, request: Request, account_id: Annotated[str, Depends(current_account)]
) -> dict[str, object]:
    rate_limit(f"backup:{account_id}", limit=60, window_seconds=3600)
    blob = await request.body()
    if not blob:
        raise HTTPException(400, "Empty body.")
    if len(blob) > MAX_BACKUP_BYTES:
        raise HTTPException(413, "Backup too large.")
    if not blob.startswith(b"UTLY1"):
        # The client always encrypts before upload. Anything else is a bug or an
        # attempt to store arbitrary data here.
        raise HTTPException(400, "Not a Utility backup bundle.")

    safe = "".join(c for c in name if c.isalnum() or c in "-_.")[:120]
    directory = BACKUP_DIR / account_id
    directory.mkdir(parents=True, exist_ok=True)
    (directory / safe).write_bytes(blob)

    digest = hashlib.sha256(blob).hexdigest()
    with db() as conn:
        conn.execute(
            "INSERT INTO backups (account_id, name, bytes, sha256) VALUES (%s, %s, %s, %s)",
            (account_id, safe, len(blob), digest),
        )
    # Retention: keep the newest 10 per account (same reasoning as the release feed).
    kept = sorted(directory.glob("*.utlybak"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in kept[10:]:
        stale.unlink(missing_ok=True)

    log(account_id, "backup", f"{len(blob)}B")
    return {"ok": True, "bytes": len(blob), "sha256": digest}


@app.get("/v1/backups")
def list_backups(account_id: Annotated[str, Depends(current_account)]) -> dict[str, object]:
    with db() as conn:
        rows = conn.execute(
            "SELECT name, bytes, sha256, at FROM backups WHERE account_id = %s ORDER BY at DESC LIMIT 20",
            (account_id,),
        ).fetchall()
    return {
        "items": [
            {"name": r[0], "bytes": r[1], "sha256": r[2], "at": r[3].isoformat()} for r in rows
        ]
    }


@app.get("/v1/backups/{name}")
def get_backup(name: str, account_id: Annotated[str, Depends(current_account)]) -> Response:
    safe = "".join(c for c in name if c.isalnum() or c in "-_.")[:120]
    path = BACKUP_DIR / account_id / safe
    if not path.is_file():
        raise HTTPException(404, "No such backup.")
    log(account_id, "restore")
    return Response(path.read_bytes(), media_type="application/octet-stream")


# --- feedback ---------------------------------------------------------------
class Feedback(BaseModel):
    kind: str = Field(pattern="^(bug|idea|other)$")
    message: str = Field(min_length=1, max_length=5000)
    email: str | None = Field(default=None, max_length=320)
    version: str | None = Field(default=None, max_length=40)


@app.post("/v1/feedback")
def post_feedback(body: Feedback, request: Request) -> dict[str, bool]:
    rate_limit(f"feedback:{client_ip(request)}", limit=10, window_seconds=3600)
    with db() as conn:
        conn.execute(
            "INSERT INTO feedback (kind, message, email, version) VALUES (%s, %s, %s, %s)",
            (body.kind, body.message, body.email, body.version),
        )
    log(None, "feedback", body.kind)
    return {"ok": True}


@app.exception_handler(HTTPException)
def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


# --- transactional mail (Brevo) ---------------------------------------------
# Uses the Brevo HTTP API, not SMTP relay: HTTPS on 443 is friendlier to a
# locked-down VM and keeps a single credential.
#
# IMPORTANT operational note (INFRA.md I-09): Brevo learns the IPs that call it
# and can then start BLOCKING unknown ones by itself. This VM has a stable
# public IP, which is exactly why sending from here is safer than from a
# serverless runtime with rotating egress -- authorise 34.55.15.91 in Brevo once
# and it stays valid.
BREVO_API_KEY = os.environ.get("BREVO_API_KEY", "").strip()
BREVO_SENDER = os.environ.get("BREVO_SENDER", "support@patienceai.in")
ADMIN_EMAIL = os.environ.get("UTILITY_ADMIN_EMAIL", "").strip()


def send_mail(to: str, subject: str, html: str) -> tuple[bool, str]:
    """Best effort. A mail failure must never fail the request that triggered it."""
    if not BREVO_API_KEY:
        return False, "BREVO_API_KEY not configured"
    try:
        import urllib.request, json as _json

        payload = _json.dumps(
            {
                "sender": {"name": "Utility by Patience AI", "email": BREVO_SENDER},
                "to": [{"email": to}],
                "subject": subject,
                "htmlContent": html,
            }
        ).encode()
        request = urllib.request.Request(
            "https://api.brevo.com/v3/smtp/email",
            data=payload,
            headers={
                "api-key": BREVO_API_KEY,
                "content-type": "application/json",
                "accept": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=12) as response:
            return response.status in (200, 201, 202), f"HTTP {response.status}"
    except Exception as exc:
        return False, str(exc)[:200]


@app.get("/v1/mail/status")
def mail_status() -> dict[str, object]:
    """So misconfiguration is visible without sending a live message."""
    return {
        "configured": bool(BREVO_API_KEY),
        "sender": BREVO_SENDER,
        "admin_configured": bool(ADMIN_EMAIL),
    }


@app.post("/v1/mail/test")
def mail_test(authorization: Annotated[str | None, Header()] = None) -> dict[str, object]:
    """Delivery canary. Brevo's IP blocking activates silently and weeks late;
    this is what turns that into something you find out about deliberately."""
    if not ADMIN_EMAIL:
        raise HTTPException(400, "UTILITY_ADMIN_EMAIL not configured.")
    ok, detail = send_mail(
        ADMIN_EMAIL,
        "Utility API mail canary",
        "<p>Brevo delivery from the Utility API is working.</p>",
    )
    log(None, "mail_test", detail)
    return {"ok": ok, "detail": detail}
