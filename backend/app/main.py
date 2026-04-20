import base64
import hashlib
import hmac
import os
import secrets
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import jwt
import pymysql
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pymysql.cursors import DictCursor
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

BASE_DIR = Path(__file__).resolve().parents[1]
# Keep local development convenience, but never override runtime env vars
# injected by the platform (e.g. Railway production variables).
load_dotenv(BASE_DIR / ".env", override=False)

ODDS_API_BASE_URL = (os.getenv("THE_ODDS_API_BASE_URL") or "https://api.the-odds-api.com/v4").rstrip("/")
ODDS_API_KEY = (os.getenv("THE_ODDS_API_KEY") or "").strip()
ODDS_CACHE_TTL_MINUTES = int(os.getenv("ODDS_CACHE_TTL_MINUTES") or "10")
HTTP_TIMEOUT_SECONDS = float(os.getenv("ODDS_HTTP_TIMEOUT_SECONDS") or "12")
APP_AUTH_USERNAME = (os.getenv("APP_AUTH_USERNAME") or "admin").strip()
APP_AUTH_PASSWORD_HASH = (os.getenv("APP_AUTH_PASSWORD_HASH") or "").strip()
APP_AUTH_PASSWORD = os.getenv("APP_AUTH_PASSWORD") or "mlb2026"
APP_JWT_SECRET = (os.getenv("APP_JWT_SECRET") or "change-me-in-production").strip()
APP_JWT_ALGORITHM = "HS256"
APP_JWT_EXPIRES_HOURS = int(os.getenv("APP_JWT_EXPIRES_HOURS") or "12")
APP_JWT_REMEMBER_DAYS = int(os.getenv("APP_JWT_REMEMBER_DAYS") or "30")


class OddsByGamesRequest(BaseModel):
    games: list[dict[str, Any]] = Field(default_factory=list)
    preferredBookmakerKey: str = "draftkings"
    regions: str = "us"
    forceRefresh: bool = False


class LoginRequest(BaseModel):
    username: str = ""
    password: str = ""
    rememberMe: bool = True


class CreateUserRequest(BaseModel):
    username: str = ""
    password: str = ""
    role: str = "viewer"
    active: bool = True


class RecommendationHistoryUpsertRequest(BaseModel):
    entries: list[dict[str, Any]] = Field(default_factory=list)


app = FastAPI(title="Gleam MLB Odds Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
bearer_scheme = HTTPBearer(auto_error=False)
game_totals_cache: dict[str, dict[str, Any]] = {}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def b64url_encode(raw_bytes: bytes) -> str:
    return base64.urlsafe_b64encode(raw_bytes).decode("utf-8").rstrip("=")


def b64url_decode(raw_text: str) -> bytes:
    padding = "=" * (-len(raw_text) % 4)
    return base64.urlsafe_b64decode(raw_text + padding)


def hash_password_pbkdf2(password: str, *, salt: bytes | None = None, iterations: int = 210_000) -> str:
    resolved_salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), resolved_salt, iterations)
    return f"pbkdf2_sha256${iterations}${b64url_encode(resolved_salt)}${b64url_encode(digest)}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        scheme, raw_iterations, raw_salt, raw_digest = password_hash.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        iterations = int(raw_iterations)
        salt = b64url_decode(raw_salt)
        expected = b64url_decode(raw_digest)
        calculated = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(expected, calculated)
    except Exception:
        return False


def resolve_password_hash() -> str:
    if APP_AUTH_PASSWORD_HASH:
        return APP_AUTH_PASSWORD_HASH
    return hash_password_pbkdf2(APP_AUTH_PASSWORD)


RESOLVED_AUTH_PASSWORD_HASH = resolve_password_hash()


def issue_access_token(username: str, remember_me: bool) -> tuple[str, datetime]:
    now = utc_now()
    expiration = now + (
        timedelta(days=APP_JWT_REMEMBER_DAYS)
        if remember_me
        else timedelta(hours=APP_JWT_EXPIRES_HOURS)
    )
    jti = uuid.uuid4().hex
    payload = {
        "sub": username,
        "iat": int(now.timestamp()),
        "exp": int(expiration.timestamp()),
        "jti": jti,
    }
    token = jwt.encode(payload, APP_JWT_SECRET, algorithm=APP_JWT_ALGORITHM)
    return token, expiration


def decode_bearer_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> tuple[str, dict[str, Any]]:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Missing bearer token.")
    token = credentials.credentials or ""
    try:
        payload = jwt.decode(token, APP_JWT_SECRET, algorithms=[APP_JWT_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token.") from exc

    username = str(payload.get("sub") or "").strip().lower()
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token subject.")
    return token, payload


def is_token_revoked(conn: pymysql.connections.Connection, token_jti: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 AS hit FROM revoked_access_tokens WHERE token_jti = %s LIMIT 1",
            (token_jti,),
        )
        row = cur.fetchone()
    return bool(row)


def revoke_token(conn: pymysql.connections.Connection, token_jti: str, expires_at_utc: datetime) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO revoked_access_tokens (token_jti, expires_at)
            VALUES (%s, %s)
            ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at)
            """,
            (token_jti, expires_at_utc.replace(tzinfo=None)),
        )


def prune_expired_revoked_tokens(conn: pymysql.connections.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM revoked_access_tokens WHERE expires_at <= %s",
            (utc_now().replace(tzinfo=None),),
        )


def require_authenticated_user(
    decoded: tuple[str, dict[str, Any]] = Depends(decode_bearer_token),
) -> dict[str, Any]:
    _token, payload = decoded
    token_jti = str(payload.get("jti") or "").strip()
    username = str(payload.get("sub") or "").strip().lower()
    if not token_jti:
        raise HTTPException(status_code=401, detail="Token missing jti.")
    if not username:
        raise HTTPException(status_code=401, detail="Token missing subject.")

    try:
        with db_conn() as conn:
            prune_expired_revoked_tokens(conn)
            if is_token_revoked(conn, token_jti):
                raise HTTPException(status_code=401, detail="Token already revoked.")
            user = load_user_record(conn, username)
            if not user or not bool(user.get("is_active")):
                raise HTTPException(status_code=401, detail="User disabled or not found.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected auth backend error: {exc}") from exc
    payload["sub"] = username
    payload["role"] = normalize_user_role(user.get("role"))
    return payload


def mysql_connection_kwargs() -> dict[str, Any]:
    host = os.getenv("MYSQLHOST")
    port = int(os.getenv("MYSQLPORT") or "3306")
    user = os.getenv("MYSQLUSER")
    password = os.getenv("MYSQLPASSWORD")
    database = os.getenv("MYSQLDATABASE")

    if not host or not user or not database:
        raise RuntimeError("Missing MySQL env vars. Expected MYSQLHOST, MYSQLUSER, MYSQLDATABASE.")

    return {
        "host": host,
        "port": port,
        "user": user,
        "password": password or "",
        "database": database,
        "cursorclass": DictCursor,
        "autocommit": False,
        "charset": "utf8mb4",
    }


@contextmanager
def db_conn():
    connection = pymysql.connect(**mysql_connection_kwargs())
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def normalize_team_name(name: str | None) -> str:
    if not name:
        return ""
    cleaned = "".join(ch for ch in name.lower() if ch.isalnum() or ch.isspace())
    return " ".join(cleaned.split())


def normalize_player_name(name: str | None) -> str:
    return normalize_team_name(name)


def has_game_started(game: dict[str, Any]) -> bool:
    game_date = game.get("gameDate") or ""
    try:
        game_dt = datetime.fromisoformat(game_date.replace("Z", "+00:00"))
    except ValueError:
        return False
    return utc_now() >= game_dt.astimezone(timezone.utc)


def parse_decimal(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_unix_ms(value: datetime | None) -> int:
    if not value:
        return int(utc_now().timestamp() * 1000)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


def from_unix_ms(value: Any) -> datetime | None:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return None
    if numeric <= 0:
        return None
    return datetime.fromtimestamp(numeric / 1000, tz=timezone.utc)


def normalize_recommendation_status(status: Any) -> str:
    normalized = str(status or "").strip().lower()
    if normalized in {"success", "failed", "pending"}:
        return normalized
    return "pending"


def normalize_recommendation_side(side: Any) -> str:
    normalized = str(side or "").strip().lower()
    if normalized == "over":
        return "Over"
    if normalized == "under":
        return "Under"
    if normalized in {"hit", "hits"}:
        return "Hit"
    if normalized in {"embasarse", "onbase"}:
        return "Embasarse"
    return "Nula"


def normalize_history_game_date(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        return datetime.fromisoformat(raw[:10]).date().isoformat()
    except ValueError:
        return ""


def normalize_pick_domain(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"strikeouts", "hits", "onbase", "game_total", "team_total"}:
        return normalized
    return "strikeouts"


def normalize_user_role(role: Any) -> str:
    normalized = str(role or "").strip().lower()
    if normalized in {"admin", "viewer"}:
        return normalized
    return "viewer"


def load_user_record(conn: pymysql.connections.Connection, username: str) -> dict[str, Any] | None:
    username_normalized = str(username or "").strip().lower()
    if not username_normalized:
        return None
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT username, password_hash, role, is_active, created_at, updated_at, last_login_at
            FROM users
            WHERE username = %s
            LIMIT 1
            """,
            (username_normalized,),
        )
        row = cur.fetchone()
    return row if row else None


def upsert_user_record(
    conn: pymysql.connections.Connection,
    *,
    username: str,
    password_hash: str,
    role: str,
    is_active: bool,
) -> None:
    username_normalized = str(username or "").strip().lower()
    if not username_normalized:
        raise ValueError("Invalid username.")
    role_normalized = normalize_user_role(role)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              password_hash = VALUES(password_hash),
              role = VALUES(role),
              is_active = VALUES(is_active),
              updated_at = VALUES(updated_at)
            """,
            (
                username_normalized,
                password_hash,
                role_normalized,
                1 if is_active else 0,
                utc_now().replace(tzinfo=None),
                utc_now().replace(tzinfo=None),
            ),
        )


def ensure_default_admin_user(conn: pymysql.connections.Connection) -> None:
    admin_username = str(APP_AUTH_USERNAME or "admin").strip().lower() or "admin"
    existing = load_user_record(conn, admin_username)
    if existing:
        return
    upsert_user_record(
        conn,
        username=admin_username,
        password_hash=RESOLVED_AUTH_PASSWORD_HASH,
        role="admin",
        is_active=True,
    )


async def fetch_odds_json(path: str, params: dict[str, Any]) -> Any:
    if not ODDS_API_KEY:
        raise HTTPException(status_code=500, detail="Missing THE_ODDS_API_KEY in backend.")

    query = {"apiKey": ODDS_API_KEY, **params}
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        response = await client.get(f"{ODDS_API_BASE_URL}{path}", params=query)
        if response.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"The Odds API error {response.status_code}: {response.text[:180]}",
            )
        return response.json()


def log_odds_api_call(
    conn: pymysql.connections.Connection,
    *,
    token_fingerprint: str,
    requested_by: str,
    endpoint: str,
    status_code: int | None,
    requests_remaining: int | None,
    requests_used: int | None,
    requests_last: int | None,
    error_message: str = "",
) -> None:
    called_at = utc_now().replace(tzinfo=None)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO odds_api_call_log (
              token_fingerprint, requested_by, endpoint, status_code, requests_remaining, requests_used, requests_last, error_message, created_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                token_fingerprint[:80],
                (requested_by or "")[:64],
                endpoint[:120],
                status_code,
                requests_remaining,
                requests_used,
                requests_last,
                (error_message or "")[:255] or None,
                called_at,
            ),
        )
    upsert_odds_token_usage(
        conn,
        token_fingerprint=token_fingerprint,
        status_code=status_code,
        requests_remaining=requests_remaining,
        requests_used=requests_used,
        requests_last=requests_last,
        error_message=error_message,
        called_at=called_at,
    )


def build_odds_token_fingerprint() -> tuple[str, str]:
    if not ODDS_API_KEY:
        return "", ""
    digest = hashlib.sha256(ODDS_API_KEY.encode("utf-8")).hexdigest()
    fingerprint = digest[:40]
    token_label = f"tk_{digest[:6]}...{digest[-4:]}"
    return fingerprint, token_label


def upsert_odds_token_usage(
    conn: pymysql.connections.Connection,
    *,
    token_fingerprint: str,
    status_code: int | None,
    requests_remaining: int | None,
    requests_used: int | None,
    requests_last: int | None,
    error_message: str = "",
    called_at: datetime | None = None,
) -> None:
    if not token_fingerprint:
        return
    called_at_value = (called_at or utc_now()).replace(tzinfo=None)
    token_label = f"tk_{token_fingerprint[:6]}...{token_fingerprint[-4:]}"
    is_success = 1 if status_code is not None and 200 <= int(status_code) < 400 else 0
    is_failed = 1 if not is_success else 0
    exhausted_at_value = (
        called_at_value if requests_remaining is not None and int(requests_remaining) <= 0 else None
    )
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO odds_api_token_usage (
              token_fingerprint, token_label, total_calls, success_calls, failed_calls,
              last_requests_remaining, last_requests_used, last_requests_last,
              min_requests_remaining, max_requests_used, last_status_code, last_error_message,
              first_called_at, last_called_at, exhausted_at, updated_at
            )
            VALUES (%s, %s, 1, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              token_label = VALUES(token_label),
              total_calls = total_calls + 1,
              success_calls = success_calls + VALUES(success_calls),
              failed_calls = failed_calls + VALUES(failed_calls),
              last_requests_remaining = VALUES(last_requests_remaining),
              last_requests_used = VALUES(last_requests_used),
              last_requests_last = VALUES(last_requests_last),
              min_requests_remaining = CASE
                WHEN VALUES(min_requests_remaining) IS NULL THEN min_requests_remaining
                WHEN min_requests_remaining IS NULL THEN VALUES(min_requests_remaining)
                ELSE LEAST(min_requests_remaining, VALUES(min_requests_remaining))
              END,
              max_requests_used = CASE
                WHEN VALUES(max_requests_used) IS NULL THEN max_requests_used
                WHEN max_requests_used IS NULL THEN VALUES(max_requests_used)
                ELSE GREATEST(max_requests_used, VALUES(max_requests_used))
              END,
              last_status_code = VALUES(last_status_code),
              last_error_message = VALUES(last_error_message),
              last_called_at = VALUES(last_called_at),
              exhausted_at = COALESCE(VALUES(exhausted_at), exhausted_at),
              updated_at = VALUES(updated_at)
            """,
            (
                token_fingerprint[:80],
                token_label,
                is_success,
                is_failed,
                requests_remaining,
                requests_used,
                requests_last,
                requests_remaining,
                requests_used,
                status_code,
                (error_message or "")[:255] or None,
                called_at_value,
                called_at_value,
                exhausted_at_value,
                called_at_value,
            ),
        )


def parse_odds_header_int(headers: Any, key: str) -> int | None:
    try:
        raw_value = headers.get(key)
    except Exception:
        raw_value = None
    try:
        return int(str(raw_value).strip()) if raw_value is not None and str(raw_value).strip() else None
    except (TypeError, ValueError):
        return None


async def fetch_odds_json_with_usage_log(
    conn: pymysql.connections.Connection,
    *,
    requested_by: str,
    path: str,
    params: dict[str, Any],
) -> Any:
    if not ODDS_API_KEY:
        raise HTTPException(status_code=500, detail="Missing THE_ODDS_API_KEY in backend.")

    token_fingerprint, _token_label = build_odds_token_fingerprint()
    query = {"apiKey": ODDS_API_KEY, **params}
    endpoint = path if path.startswith("/") else f"/{path}"
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{ODDS_API_BASE_URL}{endpoint}", params=query)
        requests_remaining = parse_odds_header_int(response.headers, "x-requests-remaining")
        requests_used = parse_odds_header_int(response.headers, "x-requests-used")
        requests_last = parse_odds_header_int(response.headers, "x-requests-last")
        if response.status_code >= 400:
            log_odds_api_call(
                conn,
                token_fingerprint=token_fingerprint,
                requested_by=requested_by,
                endpoint=endpoint,
                status_code=response.status_code,
                requests_remaining=requests_remaining,
                requests_used=requests_used,
                requests_last=requests_last,
                error_message=f"{response.text[:180]}",
            )
            raise HTTPException(
                status_code=502,
                detail=f"The Odds API error {response.status_code}: {response.text[:180]}",
            )

        log_odds_api_call(
            conn,
            token_fingerprint=token_fingerprint,
            requested_by=requested_by,
            endpoint=endpoint,
            status_code=response.status_code,
            requests_remaining=requests_remaining,
            requests_used=requests_used,
            requests_last=requests_last,
        )
        return response.json()
    except HTTPException:
        raise
    except Exception as exc:
        log_odds_api_call(
            conn,
            token_fingerprint=token_fingerprint,
            requested_by=requested_by,
            endpoint=endpoint,
            status_code=None,
            requests_remaining=None,
            requests_used=None,
            requests_last=None,
            error_message=f"{exc}",
        )
        raise


def load_odds_usage_summary(conn: pymysql.connections.Connection) -> dict[str, Any]:
    token_fingerprint, token_label = build_odds_token_fingerprint()
    with conn.cursor() as cur:
        current_row = {}
        if token_fingerprint:
            cur.execute(
                """
                SELECT
                  token_fingerprint, token_label, total_calls, success_calls, failed_calls,
                  last_requests_remaining, last_requests_used, last_requests_last,
                  min_requests_remaining, max_requests_used, last_status_code, last_called_at, exhausted_at
                FROM odds_api_token_usage
                WHERE token_fingerprint = %s
                LIMIT 1
                """,
                (token_fingerprint,),
            )
            current_row = cur.fetchone() or {}

        cur.execute(
            """
            SELECT
              token_fingerprint, token_label, total_calls, success_calls, failed_calls,
              min_requests_remaining, max_requests_used, exhausted_at, last_called_at
            FROM odds_api_token_usage
            ORDER BY last_called_at DESC
            LIMIT 8
            """
        )
        token_history_rows = cur.fetchall() or []

        cur.execute("SELECT COUNT(*) AS total_calls_all_time FROM odds_api_call_log")
        all_time_row = cur.fetchone() or {}
        cur.execute(
            """
            SELECT endpoint, status_code, requests_remaining, requests_used, requests_last, created_at
            FROM odds_api_call_log
            ORDER BY id DESC
            LIMIT 1
            """
        )
        latest_row = cur.fetchone() or {}
        cur.execute(
            """
            SELECT
              COALESCE(NULLIF(requested_by, ''), '(sin usuario)') AS requested_by,
              COUNT(*) AS total_calls,
              MAX(created_at) AS last_call_at
            FROM odds_api_call_log
            GROUP BY COALESCE(NULLIF(requested_by, ''), '(sin usuario)')
            ORDER BY total_calls DESC, requested_by ASC
            LIMIT 12
            """
        )
        callers_rows = cur.fetchall() or []

    token_history = [
        {
            "tokenFingerprint": str(row.get("token_fingerprint") or ""),
            "tokenLabel": str(row.get("token_label") or ""),
            "totalCalls": int(row.get("total_calls") or 0),
            "successCalls": int(row.get("success_calls") or 0),
            "failedCalls": int(row.get("failed_calls") or 0),
            "minRequestsRemaining": (
                int(row.get("min_requests_remaining"))
                if row.get("min_requests_remaining") is not None
                else None
            ),
            "maxRequestsUsed": (
                int(row.get("max_requests_used")) if row.get("max_requests_used") is not None else None
            ),
            "exhaustedAt": to_unix_ms(row.get("exhausted_at")),
            "lastCalledAt": to_unix_ms(row.get("last_called_at")),
        }
        for row in token_history_rows
    ]
    calls_by_user = [
        {
            "username": str(row.get("requested_by") or "(sin usuario)"),
            "totalCalls": int(row.get("total_calls") or 0),
            "lastCallAt": to_unix_ms(row.get("last_call_at")),
        }
        for row in callers_rows
    ]

    return {
        "currentTokenFingerprint": token_fingerprint,
        "currentTokenLabel": (
            str(current_row.get("token_label") or token_label)
            if token_fingerprint
            else ""
        ),
        "currentTokenCalls": int(current_row.get("total_calls") or 0),
        "currentTokenSuccessCalls": int(current_row.get("success_calls") or 0),
        "currentTokenFailedCalls": int(current_row.get("failed_calls") or 0),
        "todayCalls": int(current_row.get("total_calls") or 0),
        "todaySuccessCalls": int(current_row.get("success_calls") or 0),
        "todayFailedCalls": int(current_row.get("failed_calls") or 0),
        "allTimeCalls": int(all_time_row.get("total_calls_all_time") or 0),
        "tokenHistory": token_history,
        "callsByUser": calls_by_user,
        "requestsRemaining": (
            int(current_row.get("last_requests_remaining"))
            if current_row.get("last_requests_remaining") is not None
            else None
        ),
        "requestsUsed": (
            int(current_row.get("last_requests_used"))
            if current_row.get("last_requests_used") is not None
            else None
        ),
        "requestsLast": (
            int(current_row.get("last_requests_last"))
            if current_row.get("last_requests_last") is not None
            else None
        ),
        "minRequestsRemaining": (
            int(current_row.get("min_requests_remaining"))
            if current_row.get("min_requests_remaining") is not None
            else None
        ),
        "maxRequestsUsed": (
            int(current_row.get("max_requests_used"))
            if current_row.get("max_requests_used") is not None
            else None
        ),
        "currentTokenExhaustedAt": (
            to_unix_ms(current_row.get("exhausted_at"))
            if current_row.get("exhausted_at") is not None
            else None
        ),
        "lastEndpoint": str(latest_row.get("endpoint") or ""),
        "lastStatusCode": (
            int(latest_row.get("status_code")) if latest_row.get("status_code") is not None else None
        ),
        "lastCallAt": to_unix_ms(latest_row.get("created_at")),
    }


def find_matching_event(game: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any] | None:
    home_name = normalize_team_name(
        ((game.get("teams") or {}).get("home") or {}).get("team", {}).get("name")
    )
    away_name = normalize_team_name(
        ((game.get("teams") or {}).get("away") or {}).get("team", {}).get("name")
    )
    game_date = game.get("gameDate") or game.get("officialDate") or ""
    game_time = None
    try:
        game_time = datetime.fromisoformat(str(game_date).replace("Z", "+00:00")).timestamp()
    except ValueError:
        game_time = None

    for event in events:
        event_home = normalize_team_name(event.get("home_team"))
        event_away = normalize_team_name(event.get("away_team"))
        if event_home != home_name or event_away != away_name:
            continue

        if game_time is None:
            return event

        event_time_raw = event.get("commence_time") or ""
        try:
            event_time = datetime.fromisoformat(str(event_time_raw).replace("Z", "+00:00")).timestamp()
        except ValueError:
            return event

        if abs(event_time - game_time) <= 18 * 3600:
            return event
    return None


def extract_pitcher_line(bookmaker: dict[str, Any], pitcher_name: str | None) -> dict[str, Any] | None:
    if not pitcher_name:
        return None
    pitcher_norm = normalize_player_name(pitcher_name)

    markets = bookmaker.get("markets") or []
    strikeout_market = next((m for m in markets if m.get("key") == "pitcher_strikeouts"), None)
    if not strikeout_market:
        return None

    outcomes = strikeout_market.get("outcomes") or []
    matching = [o for o in outcomes if normalize_player_name(o.get("description")) == pitcher_norm]
    if not matching:
        return None

    over_outcome = next((o for o in matching if str(o.get("name", "")).lower() == "over"), None)
    under_outcome = next((o for o in matching if str(o.get("name", "")).lower() == "under"), None)
    fallback = next((o for o in matching if isinstance(o.get("point"), (int, float))), matching[0])
    line = fallback.get("point")
    if not isinstance(line, (int, float)):
        return None

    return {
        "line": float(line),
        "over_price": over_outcome.get("price") if isinstance(over_outcome, dict) else None,
        "under_price": under_outcome.get("price") if isinstance(under_outcome, dict) else None,
    }


def extract_game_total_line(bookmaker: dict[str, Any]) -> dict[str, Any] | None:
    markets = bookmaker.get("markets") or []
    totals_market = next((m for m in markets if m.get("key") == "totals"), None)
    if not totals_market:
        return None
    outcomes = totals_market.get("outcomes") or []
    over_outcome = next((o for o in outcomes if str(o.get("name", "")).lower() == "over"), None)
    under_outcome = next((o for o in outcomes if str(o.get("name", "")).lower() == "under"), None)
    fallback = next((o for o in outcomes if isinstance(o.get("point"), (int, float))), None)
    selected = over_outcome or under_outcome or fallback
    line = selected.get("point") if isinstance(selected, dict) else None
    if not isinstance(line, (int, float)):
        return None
    return {
        "line": float(line),
        "over_price": over_outcome.get("price") if isinstance(over_outcome, dict) else None,
        "under_price": under_outcome.get("price") if isinstance(under_outcome, dict) else None,
    }


def get_cached_game_total(game_pk: int) -> dict[str, Any] | None:
    cache_key = str(game_pk)
    cached = game_totals_cache.get(cache_key)
    now = utc_now()
    if (
        cached
        and isinstance(cached.get("expiresAt"), datetime)
        and cached["expiresAt"] > now
    ):
        return cached.get("value")
    return None


def set_cached_game_total(game_pk: int, value: dict[str, Any], expires_at: datetime) -> None:
    game_totals_cache[str(game_pk)] = {"expiresAt": expires_at, "value": value}


def create_tables_if_needed() -> None:
    odds_sql = """
    CREATE TABLE IF NOT EXISTS pitcher_odds_lines (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      game_pk BIGINT NOT NULL,
      pitcher_id BIGINT NOT NULL,
      pitcher_name VARCHAR(128) NULL,
      sportsbook_key VARCHAR(64) NOT NULL,
      sportsbook_title VARCHAR(128) NULL,
      regions VARCHAR(32) NOT NULL,
      line_value DECIMAL(6,2) NOT NULL,
      over_price INT NULL,
      under_price INT NULL,
      event_id VARCHAR(64) NULL,
      updated_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL,
      source VARCHAR(24) NOT NULL DEFAULT 'auto',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_game_pitcher_book_regions (game_pk, pitcher_id, sportsbook_key, regions),
      KEY idx_game_regions_exp (game_pk, regions, expires_at),
      KEY idx_exp (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """
    revoked_tokens_sql = """
    CREATE TABLE IF NOT EXISTS revoked_access_tokens (
      token_jti VARCHAR(64) PRIMARY KEY,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_revoked_exp (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """
    recommendation_history_sql = """
    CREATE TABLE IF NOT EXISTS recommendation_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      entry_key VARCHAR(128) NOT NULL,
      pick_domain VARCHAR(24) NOT NULL DEFAULT 'strikeouts',
      game_pk BIGINT NOT NULL,
      game_date DATE NULL,
      event_label VARCHAR(64) NOT NULL,
      pitcher_id BIGINT NOT NULL,
      pitcher_name VARCHAR(128) NOT NULL,
      market_label VARCHAR(64) NULL,
      offered_line DECIMAL(6,2) NOT NULL,
      recommendation VARCHAR(12) NOT NULL,
      probability DECIMAL(6,4) NOT NULL DEFAULT 0,
      value_label VARCHAR(32) NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      actual_strikeouts DECIMAL(6,2) NULL,
      created_at DATETIME NOT NULL,
      resolved_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_username_entry (username, entry_key),
      KEY idx_username_created (username, created_at),
      KEY idx_username_status (username, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """
    users_sql = """
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(24) NOT NULL DEFAULT 'viewer',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      last_login_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE KEY uq_users_username (username),
      KEY idx_users_role_active (role, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """
    odds_call_log_sql = """
    CREATE TABLE IF NOT EXISTS odds_api_call_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      token_fingerprint VARCHAR(80) NOT NULL DEFAULT '',
      requested_by VARCHAR(64) NOT NULL DEFAULT '',
      endpoint VARCHAR(120) NOT NULL,
      status_code INT NULL,
      requests_remaining INT NULL,
      requests_used INT NULL,
      requests_last INT NULL,
      error_message VARCHAR(255) NULL,
      created_at DATETIME NOT NULL,
      KEY idx_token_fingerprint (token_fingerprint),
      KEY idx_created_at (created_at),
      KEY idx_status_code (status_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """
    odds_token_usage_sql = """
    CREATE TABLE IF NOT EXISTS odds_api_token_usage (
      token_fingerprint VARCHAR(80) PRIMARY KEY,
      token_label VARCHAR(24) NOT NULL,
      total_calls INT NOT NULL DEFAULT 0,
      success_calls INT NOT NULL DEFAULT 0,
      failed_calls INT NOT NULL DEFAULT 0,
      last_requests_remaining INT NULL,
      last_requests_used INT NULL,
      last_requests_last INT NULL,
      min_requests_remaining INT NULL,
      max_requests_used INT NULL,
      last_status_code INT NULL,
      last_error_message VARCHAR(255) NULL,
      first_called_at DATETIME NOT NULL,
      last_called_at DATETIME NOT NULL,
      exhausted_at DATETIME NULL,
      updated_at DATETIME NOT NULL,
      KEY idx_last_called_at (last_called_at),
      KEY idx_exhausted_at (exhausted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(odds_sql)
            cur.execute(revoked_tokens_sql)
            cur.execute(recommendation_history_sql)
            cur.execute(users_sql)
            cur.execute(odds_call_log_sql)
            cur.execute(odds_token_usage_sql)
            cur.execute("SHOW COLUMNS FROM odds_api_call_log LIKE %s", ("token_fingerprint",))
            if not cur.fetchone():
                cur.execute(
                    """
                    ALTER TABLE odds_api_call_log
                    ADD COLUMN token_fingerprint VARCHAR(80) NOT NULL DEFAULT ''
                    """
                )
                cur.execute(
                    "ALTER TABLE odds_api_call_log ADD KEY idx_token_fingerprint (token_fingerprint)"
                )
            cur.execute("SHOW COLUMNS FROM odds_api_call_log LIKE %s", ("requested_by",))
            if not cur.fetchone():
                cur.execute(
                    """
                    ALTER TABLE odds_api_call_log
                    ADD COLUMN requested_by VARCHAR(64) NOT NULL DEFAULT ''
                    """
                )
            cur.execute("SHOW COLUMNS FROM users LIKE %s", ("role",))
            if not cur.fetchone():
                cur.execute("ALTER TABLE users ADD COLUMN role VARCHAR(24) NOT NULL DEFAULT 'viewer'")
            cur.execute("SHOW COLUMNS FROM users LIKE %s", ("is_active",))
            if not cur.fetchone():
                cur.execute("ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1")
            cur.execute("SHOW COLUMNS FROM users LIKE %s", ("last_login_at",))
            if not cur.fetchone():
                cur.execute("ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL")
            ensure_default_admin_user(conn)
            cur.execute("SHOW COLUMNS FROM recommendation_history LIKE %s", ("pick_domain",))
            if not cur.fetchone():
                cur.execute(
                    """
                    ALTER TABLE recommendation_history
                    ADD COLUMN pick_domain VARCHAR(24) NOT NULL DEFAULT 'strikeouts'
                    """
                )
            cur.execute("SHOW COLUMNS FROM recommendation_history LIKE %s", ("market_label",))
            if not cur.fetchone():
                cur.execute(
                    """
                    ALTER TABLE recommendation_history
                    ADD COLUMN market_label VARCHAR(64) NULL
                    """
                )


def load_cached_game_lines(
    conn: pymysql.connections.Connection,
    game_pk: int,
    pitcher_ids: list[int],
    sportsbook_key: str,
    regions: str,
) -> dict[int, dict[str, Any]]:
    if not pitcher_ids:
        return {}
    placeholders = ",".join(["%s"] * len(pitcher_ids))
    sql = f"""
      SELECT pitcher_id, line_value, over_price, under_price, sportsbook_key, sportsbook_title, updated_at
      FROM pitcher_odds_lines
      WHERE game_pk = %s
        AND regions = %s
        AND sportsbook_key = %s
        AND pitcher_id IN ({placeholders})
        AND expires_at > %s
    """
    values = [game_pk, regions, sportsbook_key, *pitcher_ids, utc_now().replace(tzinfo=None)]
    with conn.cursor() as cur:
        cur.execute(sql, values)
        rows = cur.fetchall()

    result: dict[int, dict[str, Any]] = {}
    for row in rows:
        pitcher_id = int(row["pitcher_id"])
        result[pitcher_id] = {
            "line": parse_decimal(row.get("line_value")),
            "overPrice": row.get("over_price"),
            "underPrice": row.get("under_price"),
            "sportsbookKey": row.get("sportsbook_key"),
            "sportsbookTitle": row.get("sportsbook_title"),
            "updatedAt": to_unix_ms(row.get("updated_at")),
        }
    return result


def upsert_line_row(
    conn: pymysql.connections.Connection,
    *,
    game_pk: int,
    pitcher_id: int,
    pitcher_name: str | None,
    sportsbook_key: str,
    sportsbook_title: str | None,
    regions: str,
    line_value: float,
    over_price: int | None,
    under_price: int | None,
    event_id: str | None,
    source: str,
    updated_at: datetime,
    expires_at: datetime,
) -> None:
    sql = """
    INSERT INTO pitcher_odds_lines (
      game_pk, pitcher_id, pitcher_name, sportsbook_key, sportsbook_title,
      regions, line_value, over_price, under_price, event_id, source, updated_at, expires_at
    )
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON DUPLICATE KEY UPDATE
      pitcher_name = VALUES(pitcher_name),
      sportsbook_title = VALUES(sportsbook_title),
      line_value = VALUES(line_value),
      over_price = VALUES(over_price),
      under_price = VALUES(under_price),
      event_id = VALUES(event_id),
      source = VALUES(source),
      updated_at = VALUES(updated_at),
      expires_at = VALUES(expires_at)
    """
    with conn.cursor() as cur:
        cur.execute(
            sql,
            (
                game_pk,
                pitcher_id,
                pitcher_name,
                sportsbook_key,
                sportsbook_title,
                regions,
                line_value,
                over_price,
                under_price,
                event_id,
                source,
                updated_at.replace(tzinfo=None),
                expires_at.replace(tzinfo=None),
            ),
        )


def load_recommendation_history(
    conn: pymysql.connections.Connection, *, username: str
) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              entry_key,
              pick_domain,
              game_pk,
              game_date,
              event_label,
              pitcher_id,
              pitcher_name,
              market_label,
              offered_line,
              recommendation,
              probability,
              value_label,
              status,
              actual_strikeouts,
              created_at,
              resolved_at
            FROM recommendation_history
            WHERE username = %s
            ORDER BY created_at DESC
            """,
            (username,),
        )
        rows = cur.fetchall()

    entries: list[dict[str, Any]] = []
    for row in rows:
        game_date = row.get("game_date")
        entries.append(
            {
                "entryKey": row.get("entry_key") or "",
                "pickDomain": row.get("pick_domain") or "strikeouts",
                "gamePk": int(row.get("game_pk") or 0),
                "gameDate": game_date.isoformat() if game_date else "",
                "eventLabel": row.get("event_label") or "",
                "pitcherId": int(row.get("pitcher_id") or 0),
                "pitcherName": row.get("pitcher_name") or "",
                "marketLabel": row.get("market_label") or "",
                "offeredLine": parse_decimal(row.get("offered_line")),
                "recommendation": row.get("recommendation") or "Nula",
                "probability": parse_decimal(row.get("probability")) or 0,
                "valueLabel": row.get("value_label") or "",
                "status": row.get("status") or "pending",
                "actualStrikeouts": parse_decimal(row.get("actual_strikeouts")),
                "createdAt": to_unix_ms(row.get("created_at")),
                "resolvedAt": to_unix_ms(row.get("resolved_at")) if row.get("resolved_at") else None,
            }
        )
    return entries


def upsert_recommendation_history_entry(
    conn: pymysql.connections.Connection,
    *,
    username: str,
    entry: dict[str, Any],
) -> bool:
    entry_key = str(entry.get("entryKey") or "").strip()
    if not entry_key:
        return False

    game_pk = int(entry.get("gamePk") or 0)
    pitcher_id = int(entry.get("pitcherId") or 0)
    event_label = str(entry.get("eventLabel") or "").strip()
    pitcher_name = str(entry.get("pitcherName") or "").strip()
    offered_line = parse_decimal(entry.get("offeredLine"))
    if not game_pk or not pitcher_id or not event_label or not pitcher_name or offered_line is None:
        return False

    game_date = normalize_history_game_date(entry.get("gameDate"))
    pick_domain = normalize_pick_domain(entry.get("pickDomain"))
    market_label = str(entry.get("marketLabel") or "").strip()
    recommendation = normalize_recommendation_side(entry.get("recommendation"))
    probability = parse_decimal(entry.get("probability")) or 0
    value_label = str(entry.get("valueLabel") or "").strip()
    status = normalize_recommendation_status(entry.get("status"))
    actual_strikeouts = parse_decimal(entry.get("actualStrikeouts"))
    created_at = from_unix_ms(entry.get("createdAt")) or utc_now()
    resolved_at = from_unix_ms(entry.get("resolvedAt"))

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO recommendation_history (
              username, entry_key, pick_domain, game_pk, game_date, event_label, pitcher_id,
              pitcher_name, market_label, offered_line, recommendation, probability, value_label,
              status, actual_strikeouts, created_at, resolved_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              pick_domain = VALUES(pick_domain),
              game_pk = VALUES(game_pk),
              game_date = VALUES(game_date),
              event_label = VALUES(event_label),
              pitcher_id = VALUES(pitcher_id),
              pitcher_name = VALUES(pitcher_name),
              market_label = VALUES(market_label),
              offered_line = VALUES(offered_line),
              recommendation = VALUES(recommendation),
              probability = VALUES(probability),
              value_label = VALUES(value_label),
              status = VALUES(status),
              actual_strikeouts = VALUES(actual_strikeouts),
              created_at = VALUES(created_at),
              resolved_at = VALUES(resolved_at)
            """,
            (
                username,
                entry_key,
                pick_domain,
                game_pk,
                game_date or None,
                event_label,
                pitcher_id,
                pitcher_name,
                market_label or None,
                offered_line,
                recommendation,
                probability,
                value_label or None,
                status,
                actual_strikeouts,
                created_at.replace(tzinfo=None),
                resolved_at.replace(tzinfo=None) if resolved_at else None,
            ),
        )
    return True


async def resolve_lines_for_game(
    conn: pymysql.connections.Connection,
    requested_by: str,
    game: dict[str, Any],
    preferred_bookmaker_key: str,
    regions: str,
    force_refresh: bool,
    events_cache: list[dict[str, Any]] | None,
) -> tuple[dict[int, dict[str, Any]], dict[str, Any] | None, list[dict[str, Any]] | None]:
    game_pk = int(game.get("gamePk") or 0)
    if not game_pk:
        return {}, None, events_cache

    away_pitcher = ((game.get("teams") or {}).get("away") or {}).get("probablePitcher") or {}
    home_pitcher = ((game.get("teams") or {}).get("home") or {}).get("probablePitcher") or {}
    away_pitcher_id = int(away_pitcher.get("id") or 0)
    home_pitcher_id = int(home_pitcher.get("id") or 0)
    target_pitcher_ids = [pid for pid in [away_pitcher_id, home_pitcher_id] if pid]

    if not force_refresh:
        cached = load_cached_game_lines(conn, game_pk, target_pitcher_ids, preferred_bookmaker_key, regions)
        cached_total = get_cached_game_total(game_pk)
        if (
            len(cached) == len(target_pitcher_ids)
            and len(target_pitcher_ids) > 0
            and cached_total is not None
        ):
            return cached, cached_total, events_cache

    if events_cache is None:
        raw_events = await fetch_odds_json_with_usage_log(
            conn,
            requested_by=requested_by,
            path="/sports/baseball_mlb/events",
            params={},
        )
        events_cache = raw_events if isinstance(raw_events, list) else []

    event = find_matching_event(game, events_cache)
    if not event or not event.get("id"):
        return {}, None, events_cache

    odds_payload = await fetch_odds_json_with_usage_log(
        conn,
        requested_by=requested_by,
        path=f"/sports/baseball_mlb/events/{event['id']}/odds",
        params={
            "regions": regions,
            "markets": "pitcher_strikeouts,totals",
            "oddsFormat": "american",
        },
    )
    bookmakers = (odds_payload or {}).get("bookmakers") or ((odds_payload or {}).get("data") or {}).get(
        "bookmakers", []
    )
    if not bookmakers:
        return {}, None, events_cache

    bookmaker = next((b for b in bookmakers if b.get("key") == preferred_bookmaker_key), bookmakers[0])
    sportsbook_key = bookmaker.get("key") or preferred_bookmaker_key
    sportsbook_title = bookmaker.get("title") or sportsbook_key

    now = utc_now()
    expires_at = now + timedelta(minutes=ODDS_CACHE_TTL_MINUTES)
    source = "user_refresh" if force_refresh else "auto"
    extracted_total = extract_game_total_line(bookmaker)
    totals_node = None
    if extracted_total:
        totals_node = {
            "line": float(extracted_total["line"]),
            "overPrice": extracted_total.get("over_price"),
            "underPrice": extracted_total.get("under_price"),
            "sportsbookKey": sportsbook_key,
            "sportsbookTitle": sportsbook_title,
            "updatedAt": to_unix_ms(now),
        }
        set_cached_game_total(game_pk, totals_node, expires_at)

    lines_by_pitcher_id: dict[int, dict[str, Any]] = {}
    for pitcher in [away_pitcher, home_pitcher]:
        pitcher_id = int(pitcher.get("id") or 0)
        if not pitcher_id:
            continue
        extracted = extract_pitcher_line(bookmaker, pitcher.get("fullName"))
        if not extracted:
            continue

        upsert_line_row(
            conn,
            game_pk=game_pk,
            pitcher_id=pitcher_id,
            pitcher_name=pitcher.get("fullName"),
            sportsbook_key=sportsbook_key,
            sportsbook_title=sportsbook_title,
            regions=regions,
            line_value=float(extracted["line"]),
            over_price=extracted.get("over_price"),
            under_price=extracted.get("under_price"),
            event_id=str(event.get("id") or ""),
            source=source,
            updated_at=now,
            expires_at=expires_at,
        )
        lines_by_pitcher_id[pitcher_id] = {
            "line": float(extracted["line"]),
            "overPrice": extracted.get("over_price"),
            "underPrice": extracted.get("under_price"),
            "sportsbookKey": sportsbook_key,
            "sportsbookTitle": sportsbook_title,
            "updatedAt": to_unix_ms(now),
        }

    return lines_by_pitcher_id, totals_node, events_cache


@app.on_event("startup")
def on_startup() -> None:
    create_tables_if_needed()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/auth/login")
def auth_login(req: LoginRequest) -> dict[str, Any]:
    input_username = req.username.strip().lower()
    if not input_username:
        raise HTTPException(status_code=401, detail="Invalid credentials.")
    try:
        with db_conn() as conn:
            user = load_user_record(conn, input_username)
            if not user or not bool(user.get("is_active")):
                raise HTTPException(status_code=401, detail="Invalid credentials.")
            if not verify_password(req.password, str(user.get("password_hash") or "")):
                raise HTTPException(status_code=401, detail="Invalid credentials.")
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE users SET last_login_at = %s, updated_at = %s WHERE username = %s",
                    (
                        utc_now().replace(tzinfo=None),
                        utc_now().replace(tzinfo=None),
                        input_username,
                    ),
                )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected auth backend error: {exc}") from exc

    access_token, expires_at = issue_access_token(input_username, bool(req.rememberMe))
    return {
        "accessToken": access_token,
        "tokenType": "Bearer",
        "expiresAt": to_unix_ms(expires_at),
        "username": input_username
    }


@app.get("/auth/me")
def auth_me(auth_payload: dict[str, Any] = Depends(require_authenticated_user)) -> dict[str, Any]:
    exp_seconds = int(auth_payload.get("exp") or 0)
    expires_at_ms = exp_seconds * 1000 if exp_seconds > 0 else 0
    return {
        "authenticated": True,
        "username": str(auth_payload.get("sub") or ""),
        "role": normalize_user_role(auth_payload.get("role")),
        "expiresAt": expires_at_ms,
    }


@app.post("/auth/users")
def auth_create_user(
    req: CreateUserRequest,
    auth_payload: dict[str, Any] = Depends(require_authenticated_user),
) -> dict[str, Any]:
    requester_role = normalize_user_role(auth_payload.get("role"))
    if requester_role != "admin":
        raise HTTPException(status_code=403, detail="Only admin can create users.")

    username = str(req.username or "").strip().lower()
    password = str(req.password or "")
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must have at least 3 characters.")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password must have at least 6 characters.")
    role = normalize_user_role(req.role)
    password_hash = hash_password_pbkdf2(password)
    try:
        with db_conn() as conn:
            upsert_user_record(
                conn,
                username=username,
                password_hash=password_hash,
                role=role,
                is_active=bool(req.active),
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected auth backend error: {exc}") from exc
    return {"ok": True, "username": username, "role": role, "active": bool(req.active)}


@app.post("/auth/logout")
def auth_logout(auth_payload: dict[str, Any] = Depends(require_authenticated_user)) -> dict[str, Any]:
    token_jti = str(auth_payload.get("jti") or "").strip()
    exp_seconds = int(auth_payload.get("exp") or 0)
    if not token_jti or exp_seconds <= 0:
        raise HTTPException(status_code=400, detail="Invalid token payload.")

    expires_at = datetime.fromtimestamp(exp_seconds, tz=timezone.utc)
    try:
        with db_conn() as conn:
            revoke_token(conn, token_jti, expires_at)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected auth backend error: {exc}") from exc

    return {"ok": True}


@app.get("/recommendations/history")
def recommendations_history(
    auth_payload: dict[str, Any] = Depends(require_authenticated_user),
) -> dict[str, Any]:
    username = str(auth_payload.get("sub") or APP_AUTH_USERNAME)
    try:
        with db_conn() as conn:
            entries = load_recommendation_history(conn, username=username)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected history backend error: {exc}") from exc

    return {"entries": entries}


@app.post("/recommendations/history/upsert")
def recommendations_history_upsert(
    req: RecommendationHistoryUpsertRequest,
    auth_payload: dict[str, Any] = Depends(require_authenticated_user),
) -> dict[str, Any]:
    username = str(auth_payload.get("sub") or APP_AUTH_USERNAME)
    upserted = 0
    try:
        with db_conn() as conn:
            for entry in req.entries:
                if upsert_recommendation_history_entry(conn, username=username, entry=entry):
                    upserted += 1
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected history backend error: {exc}") from exc

    return {"ok": True, "upserted": upserted}


@app.post("/recommendations/history/prune-samples")
def recommendations_history_prune_samples(
    auth_payload: dict[str, Any] = Depends(require_authenticated_user),
) -> dict[str, Any]:
    username = str(auth_payload.get("sub") or APP_AUTH_USERNAME)
    deleted = 0
    try:
        with db_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM recommendation_history
                    WHERE username = %s
                      AND (entry_key LIKE 'sample-%%' OR game_pk >= 900000)
                    """,
                    (username,),
                )
                deleted = int(cur.rowcount or 0)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected history backend error: {exc}") from exc

    return {"ok": True, "deleted": deleted}


@app.get("/odds/usage/summary")
def odds_usage_summary(
    _auth_payload: dict[str, Any] = Depends(require_authenticated_user),
) -> dict[str, Any]:
    try:
        with db_conn() as conn:
            summary = load_odds_usage_summary(conn)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected odds usage backend error: {exc}") from exc
    return summary


@app.post("/odds/lines/by-games")
async def odds_lines_by_games(
    req: OddsByGamesRequest,
    auth_payload: dict[str, Any] = Depends(require_authenticated_user),
) -> dict[str, Any]:
    if not req.games:
        try:
            with db_conn() as conn:
                usage_summary = load_odds_usage_summary(conn)
        except Exception:
            usage_summary = {}
        return {"linesByPitcherId": {}, "totalsByGamePk": {}, "usageSummary": usage_summary}

    lines_by_pitcher_id: dict[str, dict[str, Any]] = {}
    totals_by_game_pk: dict[str, dict[str, Any]] = {}
    events_cache: list[dict[str, Any]] | None = None
    requested_by = str(auth_payload.get("sub") or APP_AUTH_USERNAME)

    try:
        with db_conn() as conn:
            for game in req.games:
                if has_game_started(game):
                    continue
                try:
                    game_lines, totals_node, events_cache = await resolve_lines_for_game(
                        conn,
                        requested_by=requested_by,
                        game=game,
                        preferred_bookmaker_key=req.preferredBookmakerKey,
                        regions=req.regions,
                        force_refresh=req.forceRefresh,
                        events_cache=events_cache,
                    )
                    for pitcher_id, line in game_lines.items():
                        lines_by_pitcher_id[str(pitcher_id)] = line
                    game_pk = int(game.get("gamePk") or 0)
                    if game_pk and totals_node:
                        totals_by_game_pk[str(game_pk)] = totals_node
                except Exception:
                    continue
            usage_summary = load_odds_usage_summary(conn)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected backend error: {exc}") from exc

    return {
        "linesByPitcherId": lines_by_pitcher_id,
        "totalsByGamePk": totals_by_game_pk,
        "usageSummary": usage_summary,
    }
