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
import uuid
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

-- Screen-lock state and admin-issued grants. The passcode itself never leaves
-- the machine -- only the fact that a lock is on, so support can act on it.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS locked        boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS locked_at     timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlock_grant  timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS restore_name  text;
"""


@app.on_event("startup")
def startup() -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.execute(SCHEMA)
        conn.execute(ADMIN_SCHEMA)


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


# --- screen lock and restore hand-off ----------------------------------------
#
# The passcode is hashed and stored on the machine and is never transmitted. The
# server only ever knows that a lock is switched on, which is what lets support
# clear one for a user who has forgotten it. An admin can therefore release a
# lock, but can never learn or set a passcode.
class LockState(BaseModel):
    locked: bool


@app.post("/v1/lock")
def report_lock(
    body: LockState, account_id: Annotated[str, Depends(current_account)]
) -> dict[str, bool]:
    with db() as conn:
        conn.execute(
            "UPDATE accounts SET locked = %s, locked_at = CASE WHEN %s THEN now() END,"
            " unlock_grant = NULL WHERE id = %s",
            (body.locked, body.locked, account_id),
        )
    log(account_id, "lock_on" if body.locked else "lock_off")
    return {"ok": True}


@app.get("/v1/lock")
def lock_status(account_id: Annotated[str, Depends(current_account)]) -> dict[str, object]:
    """Polled by the lock screen so an admin release can take effect."""
    with db() as conn:
        row = conn.execute(
            "SELECT locked, unlock_grant, restore_name FROM accounts WHERE id = %s",
            (account_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "No such account.")
    return {"locked": row[0], "unlockGranted": row[1] is not None, "restoreName": row[2]}


@app.post("/v1/lock/consume")
def consume_unlock(account_id: Annotated[str, Depends(current_account)]) -> dict[str, bool]:
    """The app confirms it has cleared the local passcode, so the grant is spent."""
    with db() as conn:
        row = conn.execute(
            "SELECT unlock_grant FROM accounts WHERE id = %s", (account_id,)
        ).fetchone()
        if not row or row[0] is None:
            raise HTTPException(409, "No unlock has been issued for this account.")
        conn.execute(
            "UPDATE accounts SET locked = false, locked_at = NULL, unlock_grant = NULL"
            " WHERE id = %s",
            (account_id,),
        )
    log(account_id, "lock_released_by_admin")
    return {"ok": True}


@app.post("/v1/restore/ack")
def ack_restore(account_id: Annotated[str, Depends(current_account)]) -> dict[str, bool]:
    with db() as conn:
        conn.execute("UPDATE accounts SET restore_name = NULL WHERE id = %s", (account_id,))
    log(account_id, "restore_applied")
    return {"ok": True}


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


# --- admin panel ------------------------------------------------------------
# Separate credential, separate session, separate surface from user accounts.
# The password is never stored: ADMIN_PASSWORD_HASH holds a scrypt digest, so a
# leak of the env file does not hand over the panel.
ADMIN_USER = os.environ.get("UTILITY_ADMIN_USER", "admin")
ADMIN_PASSWORD_HASH = os.environ.get("UTILITY_ADMIN_PASSWORD_HASH", "")
ADMIN_TTL = timedelta(hours=8)

ADMIN_SCHEMA = """
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      text PRIMARY KEY,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip         text
);
CREATE TABLE IF NOT EXISTS errors (
  id         bigserial PRIMARY KEY,
  account_id uuid,
  kind       text NOT NULL,
  message    text NOT NULL,
  version    text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS errors_at_idx ON errors (at DESC);
"""


def admin_guard(request: Request) -> None:
    token = request.cookies.get("utility_admin", "")
    if not token:
        raise HTTPException(401, "Sign in required.")
    with db() as conn:
        row = conn.execute(
            "SELECT 1 FROM admin_sessions WHERE token = %s AND expires_at > %s", (token, now())
        ).fetchone()
    if not row:
        raise HTTPException(401, "Session expired.")


class AdminLogin(BaseModel):
    username: str = Field(max_length=120)
    password: str = Field(max_length=1024)


@app.post("/v1/admin/login")
def admin_login(body: AdminLogin, request: Request, response: Response) -> dict[str, bool]:
    ip = client_ip(request)
    # Tight limit: this is the highest-value endpoint on the service.
    rate_limit(f"adminlogin:{ip}", limit=8, window_seconds=900)
    if not ADMIN_PASSWORD_HASH:
        raise HTTPException(503, "Admin access is not configured.")
    ok = body.username == ADMIN_USER and verify_password(body.password, ADMIN_PASSWORD_HASH)
    if not ok:
        log(None, "admin_login_failed", ip)
        raise HTTPException(401, "Incorrect username or password.")
    token = secrets.token_urlsafe(48)
    with db() as conn:
        conn.execute(
            "INSERT INTO admin_sessions (token, expires_at, ip) VALUES (%s, %s, %s)",
            (token, now() + ADMIN_TTL, ip),
        )
    response.set_cookie(
        "utility_admin", token,
        httponly=True, secure=True, samesite="strict",
        max_age=int(ADMIN_TTL.total_seconds()), path="/",
    )
    log(None, "admin_login", ip)
    return {"ok": True}


@app.post("/v1/admin/logout")
def admin_logout(request: Request, response: Response) -> dict[str, bool]:
    token = request.cookies.get("utility_admin", "")
    if token:
        with db() as conn:
            conn.execute("DELETE FROM admin_sessions WHERE token = %s", (token,))
    response.delete_cookie("utility_admin", path="/")
    return {"ok": True}


@app.get("/v1/admin/overview")
def admin_overview(request: Request) -> dict[str, object]:
    admin_guard(request)
    with db() as conn:
        counts = {
            name: conn.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
            for name in ("accounts", "backups", "feedback", "errors", "activity")
        }
        recent = conn.execute(
            "SELECT count(*) FROM activity WHERE at > %s", (now() - timedelta(days=1),)
        ).fetchone()[0]
        storage = conn.execute("SELECT coalesce(sum(bytes),0) FROM backups").fetchone()[0]
        failed = conn.execute(
            "SELECT count(*) FROM activity WHERE action = 'admin_login_failed' AND at > %s",
            (now() - timedelta(days=7),),
        ).fetchone()[0]
    return {
        "counts": counts,
        "activity24h": recent,
        "backupBytes": int(storage),
        "failedAdminLogins7d": failed,
        "mailConfigured": bool(BREVO_API_KEY),
    }


def account_id_or_404(user_id: str) -> str:
    """Reject a malformed account id before it reaches Postgres.

    The column is a uuid, so anything else makes the driver raise and the caller
    sees an opaque 500. A wrong id is a missing account, and should say so.
    """
    try:
        return str(uuid.UUID(user_id))
    except ValueError:
        raise HTTPException(404, "No such account.") from None


@app.get("/v1/admin/users")
def admin_users(request: Request, q: str = "", limit: int = 100) -> dict[str, object]:
    admin_guard(request)
    like = f"%{q.strip().lower()}%"
    with db() as conn:
        rows = conn.execute(
            "SELECT a.id, a.email, a.name, a.org, a.gstin, a.created_at, a.last_login_at,"
            " (SELECT count(*) FROM backups b WHERE b.account_id = a.id),"
            " (SELECT coalesce(sum(b.bytes),0) FROM backups b WHERE b.account_id = a.id),"
            " a.locked, a.locked_at, a.unlock_grant, a.restore_name"
            " FROM accounts a"
            " WHERE (%s = '' OR lower(a.email) LIKE %s OR lower(a.name) LIKE %s)"
            " ORDER BY a.created_at DESC LIMIT %s",
            (q.strip(), like, like, min(500, max(1, limit))),
        ).fetchall()
    return {
        "items": [
            {
                "id": str(r[0]), "email": r[1], "name": r[2], "org": r[3], "gstin": r[4],
                "createdAt": r[5].isoformat(), "lastLoginAt": r[6].isoformat() if r[6] else None,
                "backups": r[7], "backupBytes": int(r[8]),
                "locked": r[9], "lockedAt": r[10].isoformat() if r[10] else None,
                "unlockGranted": r[11] is not None, "restorePending": r[12],
            }
            for r in rows
        ]
    }


class AdminUserPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    org: str | None = Field(default=None, max_length=200)
    gstin: str | None = Field(default=None, max_length=20)


@app.patch("/v1/admin/users/{user_id}")
def admin_update_user(user_id: str, body: AdminUserPatch, request: Request) -> dict[str, bool]:
    admin_guard(request)
    user_id = account_id_or_404(user_id)
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        return {"ok": True}
    sets = ", ".join(f"{k} = %s" for k in fields)
    with db() as conn:
        conn.execute(f"UPDATE accounts SET {sets} WHERE id = %s", (*fields.values(), user_id))
    log(user_id, "admin_user_edit", ",".join(fields))
    return {"ok": True}


@app.delete("/v1/admin/users/{user_id}")
def admin_delete_user(user_id: str, request: Request) -> dict[str, bool]:
    admin_guard(request)
    user_id = account_id_or_404(user_id)
    # Deleting an account also removes its stored backups from disk. Leaving
    # encrypted blobs behind after a deletion request would defeat the point.
    directory = BACKUP_DIR / user_id
    if directory.is_dir():
        for item in directory.glob("*"):
            item.unlink(missing_ok=True)
        directory.rmdir()
    with db() as conn:
        conn.execute("DELETE FROM accounts WHERE id = %s", (user_id,))
    log(None, "admin_user_delete", user_id)
    return {"ok": True}


@app.post("/v1/admin/users/{user_id}/unlock")
def admin_unlock_user(user_id: str, request: Request) -> dict[str, bool]:
    """Release a screen lock the user set on their own machine.

    This does not reveal or change the passcode -- the server has never held it.
    It records permission for that account's app to clear its own lock the next
    time it can reach the network, and the app confirms once it has.
    """
    admin_guard(request)
    user_id = account_id_or_404(user_id)
    with db() as conn:
        row = conn.execute("SELECT locked FROM accounts WHERE id = %s", (user_id,)).fetchone()
        if not row:
            raise HTTPException(404, "No such account.")
        if not row[0]:
            raise HTTPException(409, "That account has no screen lock set.")
        conn.execute("UPDATE accounts SET unlock_grant = now() WHERE id = %s", (user_id,))
    log(user_id, "admin_unlock_issued")
    return {"ok": True}


@app.get("/v1/admin/users/{user_id}/backups")
def admin_user_backups(user_id: str, request: Request) -> dict[str, object]:
    admin_guard(request)
    user_id = account_id_or_404(user_id)
    with db() as conn:
        rows = conn.execute(
            "SELECT name, bytes, sha256, at FROM backups WHERE account_id = %s"
            " ORDER BY at DESC LIMIT 50",
            (user_id,),
        ).fetchall()
    on_disk = {p.name for p in (BACKUP_DIR / user_id).glob("*")} if (
        BACKUP_DIR / user_id).is_dir() else set()
    return {
        "items": [
            {"name": r[0], "bytes": r[1], "sha256": r[2], "at": r[3].isoformat(),
             "available": r[0] in on_disk}
            for r in rows
        ]
    }


@app.get("/v1/admin/users/{user_id}/backups/{name}")
def admin_download_backup(user_id: str, name: str, request: Request) -> Response:
    """Hand back the stored bundle exactly as the app uploaded it.

    It is encrypted with a key derived on the user's machine, so this is a
    sealed blob: it can be returned to its owner but not read here, and that is
    deliberate. Support can restore a customer, not read their books.
    """
    admin_guard(request)
    user_id = account_id_or_404(user_id)
    safe = "".join(c for c in name if c.isalnum() or c in "-_.")[:120]
    path = BACKUP_DIR / user_id / safe
    if not path.is_file():
        raise HTTPException(404, "That backup is no longer on disk.")
    log(user_id, "admin_backup_download", safe)
    return Response(
        path.read_bytes(),
        media_type="application/octet-stream",
        headers={"content-disposition": f'attachment; filename="{safe}"'},
    )


class AdminRestore(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@app.post("/v1/admin/users/{user_id}/restore")
def admin_apply_backup(user_id: str, body: AdminRestore, request: Request) -> dict[str, bool]:
    """Queue a backup for the account to restore.

    The server cannot decrypt the bundle, so it cannot perform the restore
    itself. It marks which one to apply; the app fetches and decrypts it with
    the user's own key on next sync, and acknowledges when done.
    """
    admin_guard(request)
    user_id = account_id_or_404(user_id)
    safe = "".join(c for c in body.name if c.isalnum() or c in "-_.")[:120]
    if not (BACKUP_DIR / user_id / safe).is_file():
        raise HTTPException(404, "That backup is no longer on disk.")
    with db() as conn:
        updated = conn.execute(
            "UPDATE accounts SET restore_name = %s WHERE id = %s", (safe, user_id)
        ).rowcount
    if not updated:
        raise HTTPException(404, "No such account.")
    log(user_id, "admin_restore_queued", safe)
    return {"ok": True}


@app.delete("/v1/admin/users/{user_id}/restore")
def admin_cancel_restore(user_id: str, request: Request) -> dict[str, bool]:
    admin_guard(request)
    user_id = account_id_or_404(user_id)
    with db() as conn:
        conn.execute("UPDATE accounts SET restore_name = NULL WHERE id = %s", (user_id,))
    log(user_id, "admin_restore_cancelled")
    return {"ok": True}


@app.get("/v1/admin/activity")
def admin_activity(request: Request, limit: int = 200, action: str = "") -> dict[str, object]:
    admin_guard(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT id, account_id, action, detail, at FROM activity"
            " WHERE (%s = '' OR action = %s) ORDER BY at DESC LIMIT %s",
            (action, action, min(1000, max(1, limit))),
        ).fetchall()
    return {
        "items": [
            {"id": r[0], "accountId": str(r[1]) if r[1] else None,
             "action": r[2], "detail": r[3], "at": r[4].isoformat()}
            for r in rows
        ]
    }


@app.get("/v1/admin/errors")
def admin_errors(request: Request, limit: int = 200) -> dict[str, object]:
    admin_guard(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT id, account_id, kind, message, version, at FROM errors ORDER BY at DESC LIMIT %s",
            (min(1000, max(1, limit)),),
        ).fetchall()
    return {
        "items": [
            {"id": r[0], "accountId": str(r[1]) if r[1] else None, "kind": r[2],
             "message": r[3], "version": r[4], "at": r[5].isoformat()}
            for r in rows
        ]
    }


@app.get("/v1/admin/feedback")
def admin_feedback(request: Request, limit: int = 200) -> dict[str, object]:
    admin_guard(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT id, kind, message, email, version, at FROM feedback ORDER BY at DESC LIMIT %s",
            (min(1000, max(1, limit)),),
        ).fetchall()
    return {
        "items": [
            {"id": r[0], "kind": r[1], "message": r[2], "email": r[3],
             "version": r[4], "at": r[5].isoformat()}
            for r in rows
        ]
    }


@app.get("/v1/admin/backups")
def admin_backups(request: Request, limit: int = 200) -> dict[str, object]:
    admin_guard(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT b.id, b.account_id, a.email, b.name, b.bytes, b.at"
            " FROM backups b LEFT JOIN accounts a ON a.id = b.account_id"
            " ORDER BY b.at DESC LIMIT %s",
            (min(1000, max(1, limit)),),
        ).fetchall()
    # Contents are never exposed: they are encrypted client-side and the server
    # cannot read them. Metadata only.
    return {
        "items": [
            {"id": r[0], "accountId": str(r[1]), "email": r[2], "name": r[3],
             "bytes": r[4], "at": r[5].isoformat()}
            for r in rows
        ]
    }


class ErrorReport(BaseModel):
    kind: str = Field(max_length=60)
    message: str = Field(max_length=4000)
    version: str | None = Field(default=None, max_length=40)


@app.post("/v1/errors")
def report_error(body: ErrorReport, request: Request) -> dict[str, bool]:
    """Crash and error reports from the app. Opt-in via the diagnostics consent."""
    rate_limit(f"errors:{client_ip(request)}", limit=40, window_seconds=3600)
    with db() as conn:
        conn.execute(
            "INSERT INTO errors (kind, message, version) VALUES (%s, %s, %s)",
            (body.kind, body.message, body.version),
        )
    return {"ok": True}


@app.get("/admin")
def admin_page() -> Response:
    page = Path(__file__).with_name("admin.html")
    if not page.is_file():
        raise HTTPException(404, "Admin panel not installed.")
    return Response(page.read_text(encoding="utf-8"), media_type="text/html")


# --- password reset by email OTP -------------------------------------------
OTP_TTL = timedelta(minutes=15)

OTP_SCHEMA = """
CREATE TABLE IF NOT EXISTS otps (
  email      text NOT NULL,
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false,
  attempts   int NOT NULL DEFAULT 0,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otps_email_idx ON otps (email, expires_at DESC);
"""


class OtpRequest(BaseModel):
    email: EmailStr


class OtpVerify(BaseModel):
    email: EmailStr
    code: str = Field(min_length=4, max_length=8)


@app.post("/v1/auth/otp/request")
def otp_request(body: OtpRequest, request: Request) -> dict[str, bool]:
    """Send a one-time code. Always reports success.

    Reporting whether an address exists would turn this into an account
    enumeration oracle, so the response is identical either way.
    """
    ip = client_ip(request)
    rate_limit(f"otp:{ip}", limit=6, window_seconds=3600)
    rate_limit(f"otp:{body.email.lower()}", limit=4, window_seconds=3600)

    code = f"{secrets.randbelow(1_000_000):06d}"
    with db() as conn:
        conn.execute(OTP_SCHEMA)
        conn.execute(
            "INSERT INTO otps (email, code_hash, expires_at) VALUES (%s, %s, %s)",
            (body.email.lower(), hashlib.sha256(code.encode()).hexdigest(), now() + OTP_TTL),
        )
    send_mail(
        body.email,
        "Your Utility verification code",
        f"<p>Your verification code is:</p>"
        f"<p style='font-size:26px;font-weight:700;letter-spacing:6px'>{code}</p>"
        f"<p>It expires in 15 minutes. If you did not ask for this, ignore this email "
        f"and your password will stay unchanged.</p>",
    )
    log(None, "otp_sent", ip)
    return {"ok": True}


@app.post("/v1/auth/otp/verify")
def otp_verify(body: OtpVerify, request: Request) -> dict[str, bool]:
    rate_limit(f"otpverify:{client_ip(request)}", limit=15, window_seconds=900)
    digest = hashlib.sha256(body.code.strip().encode()).hexdigest()
    with db() as conn:
        conn.execute(OTP_SCHEMA)
        row = conn.execute(
            "SELECT ctid, attempts FROM otps"
            " WHERE email = %s AND code_hash = %s AND used = false AND expires_at > %s"
            " ORDER BY at DESC LIMIT 1",
            (body.email.lower(), digest, now()),
        ).fetchone()
        if not row:
            # Count the failure against the newest live code so guessing is bounded.
            conn.execute(
                "UPDATE otps SET attempts = attempts + 1 WHERE ctid = ("
                "  SELECT ctid FROM otps WHERE email = %s AND used = false"
                "  AND expires_at > %s ORDER BY at DESC LIMIT 1)",
                (body.email.lower(), now()),
            )
            conn.execute(
                "UPDATE otps SET used = true WHERE email = %s AND attempts >= 5",
                (body.email.lower(),),
            )
            raise HTTPException(400, "That code is not right, or it has expired.")
        # Single use.
        conn.execute("UPDATE otps SET used = true WHERE ctid = %s", (row[0],))
    log(None, "otp_verified")
    return {"ok": True}
