import os
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pymysql
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pymysql.cursors import DictCursor

BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BASE_DIR / ".env", override=True)

ODDS_API_BASE_URL = (os.getenv("THE_ODDS_API_BASE_URL") or "https://api.the-odds-api.com/v4").rstrip("/")
ODDS_API_KEY = (os.getenv("THE_ODDS_API_KEY") or "").strip()
ODDS_CACHE_TTL_MINUTES = int(os.getenv("ODDS_CACHE_TTL_MINUTES") or "10")
HTTP_TIMEOUT_SECONDS = float(os.getenv("ODDS_HTTP_TIMEOUT_SECONDS") or "12")


class OddsByGamesRequest(BaseModel):
    games: list[dict[str, Any]] = Field(default_factory=list)
    preferredBookmakerKey: str = "draftkings"
    regions: str = "us"
    forceRefresh: bool = False


app = FastAPI(title="Gleam MLB Odds Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


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
    sql = """
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
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)


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


@app.post("/odds/lines/by-games")
async def odds_lines_by_games(req: OddsByGamesRequest) -> dict[str, Any]:
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
