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
load_dotenv(BASE_DIR / ".env", override=True)

ODDS_API_BASE_URL = (os.getenv("THE_ODDS_API_BASE_URL") or "https://api.the-odds-api.com/v4").rstrip("/")
ODDS_API_KEY = (os.getenv("THE_ODDS_API_KEY") or "").strip()
ODDS_CACHE_TTL_MINUTES = int(os.getenv("ODDS_CACHE_TTL_MINUTES") or "10")
HTTP_TIMEOUT_SECONDS = float(os.getenv("ODDS_HTTP_TIMEOUT_SECONDS") or "12")
MLB_VENUE_BASE_URL = "https://statsapi.mlb.com/api/v1/venues"
OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
WEATHER_CACHE_TTL_SECONDS = int(os.getenv("WEATHER_CACHE_TTL_SECONDS") or "1800")
VENUE_CACHE_TTL_SECONDS = int(os.getenv("VENUE_CACHE_TTL_SECONDS") or "43200")
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


class RecommendationHistoryUpsertRequest(BaseModel):
    entries: list[dict[str, Any]] = Field(default_factory=list)


class WeatherByGamesRequest(BaseModel):
    games: list[dict[str, Any]] = Field(default_factory=list)
    forceRefresh: bool = False


app = FastAPI(title="Gleam MLB Odds Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
bearer_scheme = HTTPBearer(auto_error=False)
weather_by_game_cache: dict[str, dict[str, Any]] = {}
venue_context_cache: dict[int, dict[str, Any]] = {}


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

    username = payload.get("sub")
    if not username or username != APP_AUTH_USERNAME:
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
    if not token_jti:
        raise HTTPException(status_code=401, detail="Token missing jti.")

    try:
        with db_conn() as conn:
            prune_expired_revoked_tokens(conn)
            if is_token_revoked(conn, token_jti):
                raise HTTPException(status_code=401, detail="Token already revoked.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected auth backend error: {exc}") from exc
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


def extract_game_date(game: dict[str, Any]) -> str:
    raw = str(game.get("officialDate") or game.get("gameDate") or "").strip()
    return raw[:10] if raw else ""


def is_probably_indoor(roof_type: Any) -> bool:
    normalized = str(roof_type or "").strip().lower()
    if not normalized:
        return False
    return "dome" in normalized or "closed" in normalized


def parse_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if numeric == numeric else None


def parse_hourly_time_to_utc(value: str) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def build_weather_summary(node: dict[str, Any]) -> str:
    temp_c = parse_float(node.get("temperatureC"))
    wind_kph = parse_float(node.get("windSpeedKph"))
    precip = parse_float(node.get("precipitationProbability"))
    chunks: list[str] = []
    if temp_c is not None:
        chunks.append(f"{temp_c:.1f}C")
    if wind_kph is not None:
        chunks.append(f"Viento {wind_kph:.0f} km/h")
    if precip is not None:
        chunks.append(f"Lluvia {precip:.0f}%")
    return " | ".join(chunks)


async def fetch_venue_context(venue_id: int) -> dict[str, Any] | None:
    if not venue_id:
        return None
    cached = venue_context_cache.get(venue_id)
    now = utc_now()
    if cached and isinstance(cached.get("expiresAt"), datetime) and cached["expiresAt"] > now:
        return cached.get("value")

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        response = await client.get(f"{MLB_VENUE_BASE_URL}/{venue_id}")
        if response.status_code >= 400:
            return None
        payload = response.json()
    venue_node = (payload.get("venues") or [None])[0] or {}
    location = venue_node.get("location") or {}
    coords = location.get("defaultCoordinates") or {}
    context = {
        "venueId": venue_id,
        "venueName": venue_node.get("name") or "",
        "roofType": venue_node.get("roofType") or "",
        "latitude": parse_float(coords.get("latitude")),
        "longitude": parse_float(coords.get("longitude")),
    }
    venue_context_cache[venue_id] = {
        "expiresAt": now + timedelta(seconds=max(300, VENUE_CACHE_TTL_SECONDS)),
        "value": context,
    }
    return context


async def fetch_open_meteo_weather(latitude: float, longitude: float, game_time_iso: str) -> dict[str, Any] | None:
    if latitude is None or longitude is None or not game_time_iso:
        return None
    try:
        game_dt = datetime.fromisoformat(str(game_time_iso).replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None

    start_date = game_dt.date().isoformat()
    end_date = start_date
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": "temperature_2m,apparent_temperature,precipitation_probability,wind_speed_10m,wind_direction_10m,weather_code",
        "timezone": "UTC",
        "start_date": start_date,
        "end_date": end_date,
        "wind_speed_unit": "kmh",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        response = await client.get(OPEN_METEO_FORECAST_URL, params=params)
        if response.status_code >= 400:
            return None
        payload = response.json()

    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        return None
    nearest_index = -1
    nearest_diff = None
    for index, raw_time in enumerate(times):
        parsed_time = parse_hourly_time_to_utc(raw_time)
        if parsed_time is None:
            continue
        diff = abs((parsed_time - game_dt).total_seconds())
        if nearest_diff is None or diff < nearest_diff:
            nearest_diff = diff
            nearest_index = index
    if nearest_index < 0:
        return None

    def read_hourly(metric: str) -> Any:
        values = hourly.get(metric) or []
        if nearest_index >= len(values):
            return None
        return values[nearest_index]

    return {
        "temperatureC": parse_float(read_hourly("temperature_2m")),
        "apparentTemperatureC": parse_float(read_hourly("apparent_temperature")),
        "precipitationProbability": parse_float(read_hourly("precipitation_probability")),
        "windSpeedKph": parse_float(read_hourly("wind_speed_10m")),
        "windDirectionDeg": parse_float(read_hourly("wind_direction_10m")),
        "weatherCode": read_hourly("weather_code"),
        "sampledAtUtc": times[nearest_index],
    }


async def resolve_game_weather(game: dict[str, Any], force_refresh: bool) -> dict[str, Any] | None:
    game_pk = int(game.get("gamePk") or 0)
    if not game_pk:
        return None
    cache_key = str(game_pk)
    now = utc_now()
    cached = weather_by_game_cache.get(cache_key)
    if (
        not force_refresh
        and cached
        and isinstance(cached.get("expiresAt"), datetime)
        and cached["expiresAt"] > now
    ):
        return cached.get("value")

    venue_id = int(((game.get("venue") or {}).get("id")) or 0)
    venue = await fetch_venue_context(venue_id)
    lat = parse_float((venue or {}).get("latitude"))
    lon = parse_float((venue or {}).get("longitude"))
    roof_type = str((venue or {}).get("roofType") or "").strip()
    game_time_iso = str(game.get("gameDate") or "").strip()
    weather = await fetch_open_meteo_weather(lat, lon, game_time_iso)
    if not weather:
        return None

    result = {
        "temperatureC": weather.get("temperatureC"),
        "apparentTemperatureC": weather.get("apparentTemperatureC"),
        "precipitationProbability": weather.get("precipitationProbability"),
        "windSpeedKph": weather.get("windSpeedKph"),
        "windDirectionDeg": weather.get("windDirectionDeg"),
        "weatherCode": weather.get("weatherCode"),
        "sampledAtUtc": weather.get("sampledAtUtc"),
        "roofType": roof_type,
        "isIndoorLikely": is_probably_indoor(roof_type),
        "summary": build_weather_summary(weather),
        "source": "open-meteo",
        "updatedAt": to_unix_ms(now),
    }
    weather_by_game_cache[cache_key] = {
        "expiresAt": now + timedelta(seconds=max(120, WEATHER_CACHE_TTL_SECONDS)),
        "value": result,
    }
    return result


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
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(odds_sql)
            cur.execute(revoked_tokens_sql)
            cur.execute(recommendation_history_sql)
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
    game: dict[str, Any],
    preferred_bookmaker_key: str,
    regions: str,
    force_refresh: bool,
    events_cache: list[dict[str, Any]] | None,
) -> tuple[dict[int, dict[str, Any]], list[dict[str, Any]] | None]:
    game_pk = int(game.get("gamePk") or 0)
    if not game_pk:
        return {}, events_cache

    away_pitcher = ((game.get("teams") or {}).get("away") or {}).get("probablePitcher") or {}
    home_pitcher = ((game.get("teams") or {}).get("home") or {}).get("probablePitcher") or {}
    away_pitcher_id = int(away_pitcher.get("id") or 0)
    home_pitcher_id = int(home_pitcher.get("id") or 0)
    target_pitcher_ids = [pid for pid in [away_pitcher_id, home_pitcher_id] if pid]

    if not force_refresh:
        cached = load_cached_game_lines(conn, game_pk, target_pitcher_ids, preferred_bookmaker_key, regions)
        if len(cached) == len(target_pitcher_ids) and len(target_pitcher_ids) > 0:
            return cached, events_cache

    if events_cache is None:
        raw_events = await fetch_odds_json("/sports/baseball_mlb/events", {})
        events_cache = raw_events if isinstance(raw_events, list) else []

    event = find_matching_event(game, events_cache)
    if not event or not event.get("id"):
        return {}, events_cache

    odds_payload = await fetch_odds_json(
        f"/sports/baseball_mlb/events/{event['id']}/odds",
        {
            "regions": regions,
            "markets": "pitcher_strikeouts",
            "oddsFormat": "american",
        },
    )
    bookmakers = (odds_payload or {}).get("bookmakers") or ((odds_payload or {}).get("data") or {}).get(
        "bookmakers", []
    )
    if not bookmakers:
        return {}, events_cache

    bookmaker = next((b for b in bookmakers if b.get("key") == preferred_bookmaker_key), bookmakers[0])
    sportsbook_key = bookmaker.get("key") or preferred_bookmaker_key
    sportsbook_title = bookmaker.get("title") or sportsbook_key

    now = utc_now()
    expires_at = now + timedelta(minutes=ODDS_CACHE_TTL_MINUTES)
    source = "user_refresh" if force_refresh else "auto"

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

    return lines_by_pitcher_id, events_cache


@app.on_event("startup")
def on_startup() -> None:
    create_tables_if_needed()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/auth/login")
def auth_login(req: LoginRequest) -> dict[str, Any]:
    input_username = req.username.strip()
    if input_username != APP_AUTH_USERNAME:
        raise HTTPException(status_code=401, detail="Invalid credentials.")

    if not verify_password(req.password, RESOLVED_AUTH_PASSWORD_HASH):
        raise HTTPException(status_code=401, detail="Invalid credentials.")

    access_token, expires_at = issue_access_token(APP_AUTH_USERNAME, bool(req.rememberMe))
    return {
        "accessToken": access_token,
        "tokenType": "Bearer",
        "expiresAt": to_unix_ms(expires_at),
        "username": APP_AUTH_USERNAME
    }


@app.get("/auth/me")
def auth_me(auth_payload: dict[str, Any] = Depends(require_authenticated_user)) -> dict[str, Any]:
    exp_seconds = int(auth_payload.get("exp") or 0)
    expires_at_ms = exp_seconds * 1000 if exp_seconds > 0 else 0
    return {
        "authenticated": True,
        "username": str(auth_payload.get("sub") or ""),
        "expiresAt": expires_at_ms,
    }


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


@app.post("/weather/by-games")
async def weather_by_games(
    req: WeatherByGamesRequest,
    _auth_payload: dict[str, Any] = Depends(require_authenticated_user),
) -> dict[str, Any]:
    if not req.games:
        return {"weatherByGamePk": {}}

    weather_payload: dict[str, dict[str, Any]] = {}
    try:
        for game in req.games:
            if not isinstance(game, dict):
                continue
            game_pk = int(game.get("gamePk") or 0)
            if not game_pk:
                continue
            weather = await resolve_game_weather(game, req.forceRefresh)
            if weather:
                weather_payload[str(game_pk)] = weather
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected weather backend error: {exc}") from exc
    return {"weatherByGamePk": weather_payload}


@app.post("/odds/lines/by-games")
async def odds_lines_by_games(
    req: OddsByGamesRequest,
    _auth_payload: dict[str, Any] = Depends(require_authenticated_user),
) -> dict[str, Any]:
    if not req.games:
        return {"linesByPitcherId": {}}

    lines_by_pitcher_id: dict[str, dict[str, Any]] = {}
    events_cache: list[dict[str, Any]] | None = None

    try:
        with db_conn() as conn:
            for game in req.games:
                if has_game_started(game):
                    continue
                game_lines, events_cache = await resolve_lines_for_game(
                    conn,
                    game=game,
                    preferred_bookmaker_key=req.preferredBookmakerKey,
                    regions=req.regions,
                    force_refresh=req.forceRefresh,
                    events_cache=events_cache,
                )
                for pitcher_id, line in game_lines.items():
                    lines_by_pitcher_id[str(pitcher_id)] = line
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected backend error: {exc}") from exc

    return {"linesByPitcherId": lines_by_pitcher_id}
