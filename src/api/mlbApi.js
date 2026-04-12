const BASE_URL = "https://statsapi.mlb.com/api/v1/schedule";
const ESPN_LOGO_BASE_URL = "https://a.espncdn.com/i/teamlogos/mlb/500";
const PEOPLE_BASE_URL = "https://statsapi.mlb.com/api/v1/people";
const GAME_FEED_BASE_URL = "https://statsapi.mlb.com/api/v1.1/game";
const BACKEND_ODDS_API_BASE_URL = (
  import.meta.env.VITE_BACKEND_API_BASE_URL || "/backend-api"
).trim();
const configuredOddsCacheTtlMinutes = Number(import.meta.env.VITE_ODDS_CACHE_TTL_MINUTES);
const ODDS_CACHE_TTL_MS =
  Number.isFinite(configuredOddsCacheTtlMinutes) && configuredOddsCacheTtlMinutes > 0
    ? configuredOddsCacheTtlMinutes * 60 * 1000
    : 10 * 60 * 1000;
const pitcherSeasonStatsCache = new Map();
const pitcherGameLogsCache = new Map();
const gameFinalStatusCache = new Map();
const gameBoxscoreCache = new Map();
const teamStrikeoutsByGameCache = new Map();
const pitcherHandednessCache = new Map();
const lineupCache = new Map();
const playerHittingStatsCache = new Map();
const playerHittingStreakCache = new Map();
const pitcherStrikeoutLineCache = new Map();
let backendAccessToken = "";

const TEAM_ABBR_BY_ID = {
  108: "laa",
  109: "ari",
  110: "bal",
  111: "bos",
  112: "chc",
  113: "cin",
  114: "cle",
  115: "col",
  116: "det",
  117: "hou",
  118: "kc",
  119: "lad",
  120: "wsh",
  121: "nym",
  133: "oak",
  134: "pit",
  135: "sd",
  136: "sea",
  137: "sf",
  138: "stl",
  139: "tb",
  140: "tex",
  141: "tor",
  142: "min",
  143: "phi",
  144: "atl",
  145: "chw",
  146: "mia",
  147: "nyy",
  158: "mil"
};

export async function fetchMlbScheduleByDate(date) {
  const url = new URL(BASE_URL);
  url.searchParams.set("sportId", "1");
  url.searchParams.set("hydrate", "probablePitcher,linescore");
  url.searchParams.set("startDate", date);
  url.searchParams.set("endDate", date);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`MLB API error: ${response.status}`);
  }

  return response.json();
}

export function getPitcherImageUrl(playerId) {
  if (!playerId) {
    return null;
  }

  return `https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_auto:best/v1/people/${playerId}/headshot/67/current`;
}

export function getTeamAbbreviation(team) {
  const mappedAbbr = TEAM_ABBR_BY_ID[team?.id];
  if (mappedAbbr) {
    return mappedAbbr.toUpperCase();
  }

  if (!team?.name) {
    return "----";
  }

  const words = team.name.split(" ");
  const lastWord = words[words.length - 1];
  return lastWord.slice(0, 3).toUpperCase();
}

export function getTeamLogoUrl(team) {
  const abbr = TEAM_ABBR_BY_ID[team?.id];
  if (!abbr) {
    return null;
  }
  return `${ESPN_LOGO_BASE_URL}/${abbr}.png`;
}

function normalizeTeamName(name) {
  if (!name) {
    return "";
  }
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlayerName(name) {
  if (!name) {
    return "";
  }
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function selectBookmaker(bookmakers, preferredBookmakerKey) {
  if (!Array.isArray(bookmakers) || !bookmakers.length) {
    return null;
  }
  const preferred = bookmakers.find((bookmaker) => bookmaker?.key === preferredBookmakerKey);
  return preferred ?? bookmakers[0];
}

function extractPitcherStrikeoutLine(bookmaker, pitcherName) {
  if (!bookmaker || !pitcherName) {
    return null;
  }

  const normalizedPitcherName = normalizePlayerName(pitcherName);
  const markets = bookmaker?.markets ?? [];
  const strikeoutMarket = markets.find((market) => market?.key === "pitcher_strikeouts");
  if (!strikeoutMarket) {
    return null;
  }

  const outcomes = strikeoutMarket?.outcomes ?? [];
  const matchingOutcomes = outcomes.filter(
    (outcome) => normalizePlayerName(outcome?.description) === normalizedPitcherName
  );
  if (!matchingOutcomes.length) {
    return null;
  }

  const overOutcome = matchingOutcomes.find((outcome) => `${outcome?.name}`.toLowerCase() === "over");
  const underOutcome = matchingOutcomes.find((outcome) => `${outcome?.name}`.toLowerCase() === "under");
  const firstWithPoint = matchingOutcomes.find((outcome) => typeof outcome?.point === "number");
  const selected = overOutcome ?? firstWithPoint ?? matchingOutcomes[0];
  if (typeof selected?.point !== "number") {
    return null;
  }

  return {
    line: selected.point,
    overPrice: typeof overOutcome?.price === "number" ? overOutcome.price : null,
    underPrice: typeof underOutcome?.price === "number" ? underOutcome.price : null
  };
}

function findMatchingEvent(game, events) {
  const homeName = normalizeTeamName(game?.teams?.home?.team?.name);
  const awayName = normalizeTeamName(game?.teams?.away?.team?.name);
  const gameTime = new Date(game?.gameDate ?? game?.officialDate ?? "").getTime();

  return (
    events.find((event) => {
      const eventHome = normalizeTeamName(event?.home_team);
      const eventAway = normalizeTeamName(event?.away_team);
      if (eventHome !== homeName || eventAway !== awayName) {
        return false;
      }

      if (!gameTime || Number.isNaN(gameTime)) {
        return true;
      }
      const eventTime = new Date(event?.commence_time ?? "").getTime();
      if (!eventTime || Number.isNaN(eventTime)) {
        return true;
      }

      const hoursDiff = Math.abs(eventTime - gameTime) / (1000 * 60 * 60);
      return hoursDiff <= 18;
    }) ?? null
  );
}

function hasGameStarted(game) {
  const startTime = new Date(game?.gameDate ?? "").getTime();
  if (!startTime || Number.isNaN(startTime)) {
    return false;
  }
  return Date.now() >= startTime;
}

function buildBackendApiUrl(pathname) {
  const base = BACKEND_ODDS_API_BASE_URL.endsWith("/")
    ? BACKEND_ODDS_API_BASE_URL.slice(0, -1)
    : BACKEND_ODDS_API_BASE_URL;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;

  if (base.startsWith("/")) {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "http://localhost:5173";
    return new URL(`${base}${path}`, origin);
  }

  return new URL(`${base}${path}`);
}

export function setBackendAccessToken(token) {
  backendAccessToken = `${token || ""}`.trim();
}

function buildAuthenticatedHeaders() {
  if (!backendAccessToken) {
    throw new Error("Missing backend auth token.");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${backendAccessToken}`
  };
}

export async function loginToBackend({ username, password, rememberMe }) {
  const url = buildBackendApiUrl("/auth/login");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username,
      password,
      rememberMe
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.detail || `Backend auth error ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export async function fetchBackendSession() {
  const url = buildBackendApiUrl("/auth/me");
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: buildAuthenticatedHeaders()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.detail || `Backend auth check error ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export async function logoutFromBackend() {
  const url = buildBackendApiUrl("/auth/logout");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: buildAuthenticatedHeaders()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.detail || `Backend logout error ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export async function fetchRecommendationHistoryFromBackend() {
  const url = buildBackendApiUrl("/recommendations/history");
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: buildAuthenticatedHeaders()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.detail || `Backend recommendation history error ${response.status}`;
    throw new Error(message);
  }
  return Array.isArray(payload?.entries) ? payload.entries : [];
}

export async function upsertRecommendationHistoryToBackend(entries) {
  const url = buildBackendApiUrl("/recommendations/history/upsert");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: buildAuthenticatedHeaders(),
    body: JSON.stringify({
      entries: Array.isArray(entries) ? entries : []
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.detail || `Backend recommendation upsert error ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function fetchBackendOddsJson(pathname, payload) {
  const url = buildBackendApiUrl(pathname);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: buildAuthenticatedHeaders(),
    body: JSON.stringify(payload ?? {})
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    const detail = errorPayload?.detail || `Backend odds API error ${response.status}`;
    throw new Error(detail);
  }
  return response.json();
}

function getCachedOddsLines(cacheKey) {
  const cached = pitcherStrikeoutLineCache.get(cacheKey);
  if (cached === undefined) {
    return null;
  }

  const cacheAge = Date.now() - Number(cached.fetchedAt || 0);
  if (cacheAge <= ODDS_CACHE_TTL_MS) {
    return cached.linesByPitcherId ?? null;
  }

  pitcherStrikeoutLineCache.delete(cacheKey);
  return null;
}

function setCachedOddsLines(cacheKey, linesByPitcherId) {
  if (!Object.keys(linesByPitcherId || {}).length) {
    pitcherStrikeoutLineCache.delete(cacheKey);
    return;
  }

  pitcherStrikeoutLineCache.set(cacheKey, {
    linesByPitcherId,
    fetchedAt: Date.now()
  });
}

function invalidateOddsCacheForGame(gamePk) {
  if (!gamePk) {
    return;
  }

  const targetGamePk = String(gamePk);
  for (const cacheKey of pitcherStrikeoutLineCache.keys()) {
    const parts = cacheKey.split("-");
    const gamePkSegment = parts[parts.length - 1] || "";
    const gamePks = gamePkSegment.split(",").filter(Boolean);
    if (gamePks.includes(targetGamePk)) {
      pitcherStrikeoutLineCache.delete(cacheKey);
    }
  }
}

function normalizeBackendLinesMap(linesByPitcherId) {
  if (!linesByPitcherId || typeof linesByPitcherId !== "object") {
    return {};
  }

  return Object.entries(linesByPitcherId).reduce((acc, [pitcherId, node]) => {
    const normalizedPitcherId = Number(pitcherId);
    if (!normalizedPitcherId || !node) {
      return acc;
    }

    acc[normalizedPitcherId] = {
      line: typeof node?.line === "number" ? node.line : Number(node?.line),
      overPrice: node?.overPrice ?? null,
      underPrice: node?.underPrice ?? null,
      sportsbookKey: node?.sportsbookKey ?? "sportsbook",
      sportsbookTitle: node?.sportsbookTitle ?? node?.sportsbookKey ?? "Sportsbook",
      updatedAt: node?.updatedAt ?? Date.now()
    };
    return acc;
  }, {});
}

export async function fetchPitcherStrikeoutLinesByGames(
  games,
  { preferredBookmakerKey = "draftkings", regions = "us" } = {}
) {
  try {
    if (!Array.isArray(games) || !games.length) {
      return {};
    }

    const upcomingGames = games.filter((game) => !hasGameStarted(game));
    if (!upcomingGames.length) {
      return {};
    }

    const cacheKey = `${preferredBookmakerKey}-${regions}-${upcomingGames
      .map((game) => game?.gamePk)
      .filter(Boolean)
      .join(",")}`;
    const cached = getCachedOddsLines(cacheKey);
    if (cached) {
      return cached;
    }

    const payload = await fetchBackendOddsJson("/odds/lines/by-games", {
      games: upcomingGames,
      preferredBookmakerKey,
      regions,
      forceRefresh: false
    });
    const linesByPitcherId = normalizeBackendLinesMap(payload?.linesByPitcherId);

    setCachedOddsLines(cacheKey, linesByPitcherId);
    return linesByPitcherId;
  } catch (error) {
    return {};
  }
}

export async function fetchPitcherStrikeoutLinesForGame(
  game,
  { preferredBookmakerKey = "draftkings", regions = "us", forceRefresh = true } = {}
) {
  const debug = {
    endpoint: "",
    bookmakerKey: "",
    error: ""
  };

  try {
    if (!game) {
      debug.error = "Missing game";
      return { linesByPitcherId: {}, debug };
    }
    if (hasGameStarted(game)) {
      debug.error = "Juego iniciado";
      return { linesByPitcherId: {}, debug };
    }

    const cacheKey = `${preferredBookmakerKey}-${regions}-${game?.gamePk}`;
    if (!forceRefresh) {
      const cached = getCachedOddsLines(cacheKey);
      if (cached) {
        return { linesByPitcherId: cached, debug };
      }
    } else {
      invalidateOddsCacheForGame(game?.gamePk);
    }

    debug.endpoint = "/odds/lines/by-games";
    const payload = await fetchBackendOddsJson("/odds/lines/by-games", {
      games: [game],
      preferredBookmakerKey,
      regions,
      forceRefresh
    });
    const linesByPitcherId = normalizeBackendLinesMap(payload?.linesByPitcherId);

    if (Object.keys(linesByPitcherId).length) {
      const firstPitcher = Object.values(linesByPitcherId)[0];
      debug.bookmakerKey = firstPitcher?.sportsbookKey ?? "";
      setCachedOddsLines(cacheKey, linesByPitcherId);
    } else {
      debug.error = payload?.error || "No matching pitcher outcomes";
      pitcherStrikeoutLineCache.delete(cacheKey);
    }

    return { linesByPitcherId, debug };
  } catch (error) {
    debug.error = error instanceof Error ? error.message : "Unexpected error";
    return { linesByPitcherId: {}, debug };
  }
}

export async function fetchPitcherHandednessByIds(playerIds) {
  const uniqueIds = [...new Set(playerIds.filter(Boolean))];
  const results = await Promise.all(
    uniqueIds.map(async (pitcherId) => {
      const handedness = await fetchPitcherHandedness(pitcherId);
      return [pitcherId, handedness];
    })
  );

  return Object.fromEntries(results);
}

async function fetchPitcherSeasonStats(playerId, season) {
  if (!playerId) {
    return null;
  }

  const cacheKey = `${playerId}-${season}`;
  const cachedStats = pitcherSeasonStatsCache.get(cacheKey);
  if (cachedStats !== undefined) {
    return cachedStats;
  }

  const url = new URL(`${PEOPLE_BASE_URL}/${playerId}`);
  url.searchParams.set(
    "hydrate",
    `stats(group=[pitching],type=[season],season=${season},sportId=1)`
  );

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      pitcherSeasonStatsCache.set(cacheKey, null);
      return null;
    }

    const payload = await response.json();
    const stat = payload.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
    const normalizedStats = stat
      ? {
          era: stat.era ?? null,
          strikeoutsPer9Inn: stat.strikeoutsPer9Inn ?? null
        }
      : null;

    pitcherSeasonStatsCache.set(cacheKey, normalizedStats);
    return normalizedStats;
  } catch (error) {
    pitcherSeasonStatsCache.set(cacheKey, null);
    return null;
  }
}

export async function fetchPitcherEra(playerId, season) {
  const stats = await fetchPitcherSeasonStats(playerId, season);
  return stats?.era ?? null;
}

export async function fetchPitcherStrikeoutsPerGame(playerId, season) {
  const gameLogs = await fetchPitcherGameLogs(playerId, season);
  if (!gameLogs.length) {
    return null;
  }

  const totalStrikeouts = gameLogs.reduce((acc, log) => acc + (Number(log.strikeOuts) || 0), 0);
  return totalStrikeouts / gameLogs.length;
}

export async function fetchPitcherErasByIds(playerIds, season) {
  const uniqueIds = [...new Set(playerIds.filter(Boolean))];
  const results = await Promise.all(
    uniqueIds.map(async (pitcherId) => {
      const stats = await fetchPitcherSeasonStats(pitcherId, season);
      const era = stats?.era ?? null;
      return [pitcherId, era];
    })
  );

  return Object.fromEntries(results);
}

export async function fetchPitcherStrikeoutsPerGameByIds(playerIds, season) {
  const uniqueIds = [...new Set(playerIds.filter(Boolean))];
  const results = await Promise.all(
    uniqueIds.map(async (pitcherId) => {
      const strikeoutsPerGame = await fetchPitcherStrikeoutsPerGame(pitcherId, season);
      return [pitcherId, strikeoutsPerGame];
    })
  );

  return Object.fromEntries(results);
}

async function fetchIsGameFinal(gamePk) {
  if (!gamePk) {
    return false;
  }

  const cached = gameFinalStatusCache.get(gamePk);
  if (cached !== undefined) {
    return cached;
  }

  const statusUrl = `${GAME_FEED_BASE_URL}/${gamePk}/feed/live?fields=gameData,status,abstractGameState,codedGameState,detailedState,abstractGameCode`;

  try {
    const response = await fetch(statusUrl);
    if (!response.ok) {
      gameFinalStatusCache.set(gamePk, false);
      return false;
    }

    const payload = await response.json();
    const status = payload.gameData?.status;
    const isFinal =
      status?.abstractGameState === "Final" ||
      status?.codedGameState === "F" ||
      status?.detailedState === "Final";

    gameFinalStatusCache.set(gamePk, isFinal);
    return isFinal;
  } catch (error) {
    gameFinalStatusCache.set(gamePk, false);
    return false;
  }
}

export async function fetchPitcherGameLogs(playerId, season) {
  if (!playerId) {
    return [];
  }

  const cacheKey = `${playerId}-${season}`;
  const cached = pitcherGameLogsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const url = new URL(`${PEOPLE_BASE_URL}/${playerId}`);
  url.searchParams.set(
    "hydrate",
    `stats(group=[pitching],type=[gameLog],season=${season},sportId=1)`
  );

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      pitcherGameLogsCache.set(cacheKey, []);
      return [];
    }

    const payload = await response.json();
    const splits = payload.people?.[0]?.stats?.[0]?.splits ?? [];
    const normalizedLogs = (
      await Promise.all(
        splits.map(async (split) => {
          if (split?.gameType && split.gameType !== "R") {
            return null;
          }
          const gamePk = split?.game?.gamePk;
          const isGameFinal = await fetchIsGameFinal(gamePk);
          if (!isGameFinal) {
            return null;
          }

          return {
            gameDate: split?.date ?? "",
            gamePk: split?.game?.gamePk ?? null,
            opponentId: split?.opponent?.id ?? null,
            opponentName: split?.opponent?.name ?? "Rival no disponible",
            inningsPitched: split?.stat?.inningsPitched ?? "-",
            strikeOuts: split?.stat?.strikeOuts ?? "-"
          };
        })
      )
    )
      .filter(Boolean)
      .sort((a, b) => {
        const timeA = a.gameDate ? new Date(a.gameDate).getTime() : 0;
        const timeB = b.gameDate ? new Date(b.gameDate).getTime() : 0;
        return timeB - timeA;
      });

    pitcherGameLogsCache.set(cacheKey, normalizedLogs);
    return normalizedLogs;
  } catch (error) {
    pitcherGameLogsCache.set(cacheKey, []);
    return [];
  }
}

async function fetchGameBoxscore(gamePk) {
  if (!gamePk) {
    return null;
  }

  const cached = gameBoxscoreCache.get(gamePk);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const response = await fetch(`${GAME_FEED_BASE_URL}/${gamePk}/feed/live`);
    if (!response.ok) {
      gameBoxscoreCache.set(gamePk, null);
      return null;
    }
    const payload = await response.json();
    const boxscore = payload?.liveData?.boxscore ?? null;
    gameBoxscoreCache.set(gamePk, boxscore);
    return boxscore;
  } catch (error) {
    gameBoxscoreCache.set(gamePk, null);
    return null;
  }
}

function extractOpposingStarter(boxscore, sideKey) {
  const side = boxscore?.teams?.[sideKey];
  const pitcherIds = side?.pitchers ?? [];
  const players = side?.players ?? {};

  const pitchers = pitcherIds
    .map((pitcherId) => players[`ID${pitcherId}`])
    .filter(Boolean)
    .map((player) => ({
      id: player?.person?.id ?? null,
      name: player?.person?.fullName ?? "Pitcher no disponible",
      strikeOuts: player?.stats?.pitching?.strikeOuts ?? "-",
      inningsPitched: player?.stats?.pitching?.inningsPitched ?? "-",
      numberOfPitches: player?.stats?.pitching?.numberOfPitches ?? "-",
      gamesStarted: Number(player?.stats?.pitching?.gamesStarted ?? 0)
    }));

  if (!pitchers.length) {
    return {
      opposingStarterId: null,
      opposingStarter: "No disponible",
      opposingStarterStrikeOuts: "-",
      opposingStarterInningsPitched: "-",
      opposingStarterNumberOfPitches: "-"
    };
  }

  const starter = pitchers.find((pitcher) => pitcher.gamesStarted > 0) ?? pitchers[0];
  return {
    opposingStarterId: starter?.id ?? null,
    opposingStarter: starter?.name ?? "Pitcher no disponible",
    opposingStarterStrikeOuts: starter?.strikeOuts ?? "-",
    opposingStarterInningsPitched: starter?.inningsPitched ?? "-",
    opposingStarterNumberOfPitches: starter?.numberOfPitches ?? "-"
  };
}

async function fetchPitcherHandedness(playerId) {
  if (!playerId) {
    return "-";
  }

  const cached = pitcherHandednessCache.get(playerId);
  if (cached !== undefined) {
    return cached;
  }

  const url = `${PEOPLE_BASE_URL}/${playerId}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      pitcherHandednessCache.set(playerId, "-");
      return "-";
    }
    const payload = await response.json();
    const handCode = payload?.people?.[0]?.pitchHand?.code ?? "";
    const normalized =
      handCode === "R" ? "Derecho" : handCode === "L" ? "Zurdo" : handCode || "-";
    pitcherHandednessCache.set(playerId, normalized);
    return normalized;
  } catch (error) {
    pitcherHandednessCache.set(playerId, "-");
    return "-";
  }
}

export async function fetchTeamStrikeoutsByGame(teamId, season) {
  if (!teamId || !season) {
    return [];
  }

  const cacheKey = `${teamId}-${season}`;
  const cached = teamStrikeoutsByGameCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const startDate = `${season}-01-01`;
  const endDate = `${season}-12-31`;
  const scheduleUrl = new URL(BASE_URL);
  scheduleUrl.searchParams.set("sportId", "1");
  scheduleUrl.searchParams.set("teamId", String(teamId));
  scheduleUrl.searchParams.set("startDate", startDate);
  scheduleUrl.searchParams.set("endDate", endDate);

  try {
    const response = await fetch(scheduleUrl.toString());
    if (!response.ok) {
      teamStrikeoutsByGameCache.set(cacheKey, []);
      return [];
    }

    const payload = await response.json();
    const games = (payload?.dates ?? []).flatMap((dateNode) => dateNode?.games ?? []);

    const rows = (
      await Promise.all(
        games.map(async (game) => {
          const gamePk = game?.gamePk;
          const isRegularSeason = game?.gameType === "R";
          if (!isRegularSeason) {
            return null;
          }
          const isFinal = await fetchIsGameFinal(gamePk);
          if (!isFinal) {
            return null;
          }

          const isAway = game?.teams?.away?.team?.id === teamId;
          const teamNode = isAway ? game?.teams?.away?.team : game?.teams?.home?.team;
          const opponentNode = isAway ? game?.teams?.home?.team : game?.teams?.away?.team;
          const teamKey = isAway ? "away" : "home";
          const opponentKey = isAway ? "home" : "away";

          const boxscore = await fetchGameBoxscore(gamePk);
          if (!boxscore) {
            return null;
          }

          const starterInfo = extractOpposingStarter(boxscore, opponentKey);
          const opposingStarterHandedness = await fetchPitcherHandedness(
            starterInfo.opposingStarterId
          );

          return {
            gameDate: game?.officialDate ?? "",
            opponentName: opponentNode?.name ?? "Rival no disponible",
            teamName: teamNode?.name ?? "Equipo",
            opposingStarterId: starterInfo.opposingStarterId,
            opposingStarter: starterInfo.opposingStarter,
            opposingStarterStrikeOuts: starterInfo.opposingStarterStrikeOuts,
            opposingStarterInningsPitched: starterInfo.opposingStarterInningsPitched,
            opposingStarterNumberOfPitches: starterInfo.opposingStarterNumberOfPitches,
            opposingStarterHandedness
          };
        })
      )
    )
      .filter(Boolean)
      .sort((a, b) => {
        const timeA = a.gameDate ? new Date(a.gameDate).getTime() : 0;
        const timeB = b.gameDate ? new Date(b.gameDate).getTime() : 0;
        return timeB - timeA;
      });

    teamStrikeoutsByGameCache.set(cacheKey, rows);
    return rows;
  } catch (error) {
    teamStrikeoutsByGameCache.set(cacheKey, []);
    return [];
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getMean(values) {
  if (!values.length) {
    return 0;
  }
  const total = values.reduce((acc, value) => acc + value, 0);
  return total / values.length;
}

function getMedian(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function getStdDev(values, precomputedMean = null) {
  if (values.length <= 1) {
    return 1;
  }
  const mean = precomputedMean ?? getMean(values);
  const variance =
    values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function parseInningsPitched(inningsValue) {
  if (inningsValue === undefined || inningsValue === null || inningsValue === "") {
    return 0;
  }
  const [wholePartRaw, decimalPartRaw = "0"] = `${inningsValue}`.split(".");
  const wholePart = Number(wholePartRaw);
  if (!Number.isFinite(wholePart)) {
    return 0;
  }
  const decimalPart = decimalPartRaw.trim();
  if (decimalPart === "1") {
    return wholePart + 1 / 3;
  }
  if (decimalPart === "2") {
    return wholePart + 2 / 3;
  }
  return wholePart;
}

function normalizeHandednessCode(handedness) {
  const normalized = `${handedness ?? ""}`.toLowerCase().trim();
  if (!normalized) {
    return "";
  }
  if (normalized === "r" || normalized.startsWith("der")) {
    return "R";
  }
  if (normalized === "l" || normalized.startsWith("zur")) {
    return "L";
  }
  return "";
}

function approximateErf(value) {
  const sign = value >= 0 ? 1 : -1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(x, mean, stdDev) {
  if (!Number.isFinite(stdDev) || stdDev <= 0) {
    return x < mean ? 0 : 1;
  }
  const z = (x - mean) / (stdDev * Math.sqrt(2));
  return 0.5 * (1 + approximateErf(z));
}

function americanOddsToImpliedProbability(odds) {
  const numericOdds = Number(odds);
  if (!Number.isFinite(numericOdds) || numericOdds === 0) {
    return null;
  }
  if (numericOdds > 0) {
    return 100 / (numericOdds + 100);
  }
  return Math.abs(numericOdds) / (Math.abs(numericOdds) + 100);
}

export async function evaluatePitcherStrikeoutValueByGames(
  games,
  linesByPitcherId,
  { season, pitcherHandednessById = {}, recentGamesWindow = 10 } = {}
) {
  if (!Array.isArray(games) || !games.length || !linesByPitcherId) {
    return {};
  }

  const seasonToUse =
    season || games?.[0]?.season || games?.[0]?.officialDate?.split("-")?.[0] || "";
  if (!seasonToUse) {
    return {};
  }

  const analysisTargets = [];
  for (const game of games) {
    if (!game || hasGameStarted(game)) {
      continue;
    }

    const awayPitcherId = game?.teams?.away?.probablePitcher?.id;
    const homePitcherId = game?.teams?.home?.probablePitcher?.id;
    const awayLine = linesByPitcherId?.[awayPitcherId];
    const homeLine = linesByPitcherId?.[homePitcherId];

    if (awayPitcherId && awayLine?.line !== undefined) {
      analysisTargets.push({
        pitcherId: awayPitcherId,
        opponentTeamId: game?.teams?.home?.team?.id
      });
    }
    if (homePitcherId && homeLine?.line !== undefined) {
      analysisTargets.push({
        pitcherId: homePitcherId,
        opponentTeamId: game?.teams?.away?.team?.id
      });
    }
  }

  if (!analysisTargets.length) {
    return {};
  }

  const uniquePitcherIds = [...new Set(analysisTargets.map((target) => target.pitcherId).filter(Boolean))];
  const uniqueOpponentIds = [
    ...new Set(analysisTargets.map((target) => target.opponentTeamId).filter(Boolean))
  ];

  const [pitcherLogsEntries, opponentTeamLogsEntries] = await Promise.all([
    Promise.all(
      uniquePitcherIds.map(async (pitcherId) => {
        const logs = await fetchPitcherGameLogs(pitcherId, seasonToUse);
        return [pitcherId, logs];
      })
    ),
    Promise.all(
      uniqueOpponentIds.map(async (teamId) => {
        const logs = await fetchTeamStrikeoutsByGame(teamId, seasonToUse);
        return [teamId, logs];
      })
    )
  ]);

  const pitcherLogsById = Object.fromEntries(pitcherLogsEntries);
  const opponentTeamLogsById = Object.fromEntries(opponentTeamLogsEntries);
  const evaluationByPitcherId = {};
  const leagueStarterKsBaseline = 6.5;

  for (const target of analysisTargets) {
    const { pitcherId, opponentTeamId } = target;
    const lineNode = linesByPitcherId?.[pitcherId];
    const offeredLine = Number(lineNode?.line);
    if (!Number.isFinite(offeredLine)) {
      evaluationByPitcherId[pitcherId] = {
        valueLabel: "Sin evaluar",
        unavailableReason: "Linea invalida o no disponible",
        statsSampleSize: 0,
        opponentSampleSize: 0
      };
      continue;
    }

    const pitcherLogs = (pitcherLogsById?.[pitcherId] ?? []).slice(0, recentGamesWindow);
    const strikeoutValues = pitcherLogs
      .map((log) => Number(log?.strikeOuts))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (strikeoutValues.length < 3) {
      evaluationByPitcherId[pitcherId] = {
        valueLabel: "Sin evaluar",
        unavailableReason: `Muestra insuficiente del pitcher (${strikeoutValues.length} juegos)`,
        statsSampleSize: strikeoutValues.length,
        opponentSampleSize: 0
      };
      continue;
    }

    const mean10 = getMean(strikeoutValues);
    const mean5 = getMean(strikeoutValues.slice(0, 5)) || mean10;
    const median10 = getMedian(strikeoutValues);
    const baseProjection = mean10 * 0.5 + median10 * 0.3 + mean5 * 0.2;

    const inningsValues = pitcherLogs
      .map((log) => parseInningsPitched(log?.inningsPitched))
      .filter((value) => Number.isFinite(value) && value > 0);
    const meanRecentInnings = inningsValues.length ? getMean(inningsValues) : 5.5;
    const workloadFactor = clamp(meanRecentInnings / 5.5, 0.85, 1.15);

    const opponentLogs = opponentTeamLogsById?.[opponentTeamId] ?? [];
    const pitcherHandCode = normalizeHandednessCode(pitcherHandednessById?.[pitcherId]);
    const opponentAllValues = opponentLogs
      .map((log) => Number(log?.opposingStarterStrikeOuts))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const opponentByHandValues = opponentLogs
      .filter((log) => normalizeHandednessCode(log?.opposingStarterHandedness) === pitcherHandCode)
      .map((log) => Number(log?.opposingStarterStrikeOuts))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const opponentReferenceValues =
      opponentByHandValues.length >= 5 ? opponentByHandValues : opponentAllValues;
    const opponentAvg = opponentReferenceValues.length
      ? getMean(opponentReferenceValues)
      : leagueStarterKsBaseline;
    const opponentFactor = clamp(opponentAvg / leagueStarterKsBaseline, 0.8, 1.2);

    const projectedStrikeouts = baseProjection * workloadFactor * opponentFactor;
    const stdDev = Math.max(getStdDev(strikeoutValues, mean10), 1);
    const probabilityOver = clamp(1 - normalCdf(offeredLine + 0.5, projectedStrikeouts, stdDev), 0, 1);
    const impliedOverProbability = americanOddsToImpliedProbability(lineNode?.overPrice);
    const edgeOver = impliedOverProbability === null ? null : probabilityOver - impliedOverProbability;
    const zScore = (projectedStrikeouts - offeredLine) / stdDev;

    let valueLabel = "Nula";
    if (edgeOver !== null) {
      if (edgeOver >= 0.04) {
        valueLabel = "Valor";
      } else if (edgeOver <= -0.03) {
        valueLabel = "Sobrevalorada";
      }
    } else if (zScore >= 0.35) {
      valueLabel = "Valor";
    } else if (zScore <= -0.35) {
      valueLabel = "Sobrevalorada";
    }

    evaluationByPitcherId[pitcherId] = {
      valueLabel,
      projectedStrikeouts,
      probabilityOver,
      impliedOverProbability,
      edgeOver,
      zScore,
      unavailableReason: "",
      offeredLine,
      baseProjection,
      workloadFactor,
      opponentFactor,
      statsSampleSize: strikeoutValues.length,
      opponentSampleSize: opponentReferenceValues.length
    };
  }

  return evaluationByPitcherId;
}

function normalizeLineupTeam(teamNode) {
  const battingOrder = teamNode?.battingOrder ?? [];
  const playersMap = teamNode?.players ?? {};

  return battingOrder.map((playerId, index) => {
    const player = playersMap[`ID${playerId}`];
    return {
      slot: index + 1,
      playerId,
      fullName: player?.person?.fullName ?? "Jugador no disponible",
      position: player?.position?.abbreviation ?? "-"
    };
  });
}

export async function fetchGameLineups(gamePk) {
  if (!gamePk) {
    return null;
  }

  const cached = lineupCache.get(gamePk);
  if (cached !== undefined) {
    return cached;
  }

  const url = `${GAME_FEED_BASE_URL}/${gamePk}/feed/live`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      lineupCache.set(gamePk, null);
      return null;
    }

    const payload = await response.json();
    const awayTeamNode = payload.liveData?.boxscore?.teams?.away;
    const homeTeamNode = payload.liveData?.boxscore?.teams?.home;

    const lineups = {
      away: normalizeLineupTeam(awayTeamNode),
      home: normalizeLineupTeam(homeTeamNode)
    };

    lineupCache.set(gamePk, lineups);
    return lineups;
  } catch (error) {
    lineupCache.set(gamePk, null);
    return null;
  }
}

export async function fetchPlayerHittingStats(playerId, season) {
  if (!playerId) {
    return null;
  }

  const cacheKey = `${playerId}-${season}`;
  const cached = playerHittingStatsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const url = new URL(`${PEOPLE_BASE_URL}/${playerId}`);
  url.searchParams.set(
    "hydrate",
    `stats(group=[hitting],type=[season],season=${season},sportId=1)`
  );

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      playerHittingStatsCache.set(cacheKey, null);
      return null;
    }

    const payload = await response.json();
    const stat = payload.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
    const normalized = stat
      ? {
          hits: stat.hits ?? 0,
          doubles: stat.doubles ?? 0,
          triples: stat.triples ?? 0
        }
      : null;

    playerHittingStatsCache.set(cacheKey, normalized);
    return normalized;
  } catch (error) {
    playerHittingStatsCache.set(cacheKey, null);
    return null;
  }
}

export async function fetchPlayersHittingStatsByIds(playerIds, season) {
  const uniqueIds = [...new Set(playerIds.filter(Boolean))];
  const results = await Promise.all(
    uniqueIds.map(async (playerId) => {
      const stats = await fetchPlayerHittingStats(playerId, season);
      return [playerId, stats];
    })
  );

  return Object.fromEntries(results);
}

function asNumber(value) {
  if (value === undefined || value === null) {
    return 0;
  }
  const numeric = Number(value);
  return Number.isNaN(numeric) ? 0 : numeric;
}

function calculateCurrentStreak(gameLogs, predicate) {
  let streak = 0;
  for (const gameLog of gameLogs) {
    if (predicate(gameLog)) {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}

export async function fetchPlayerHittingStreak(playerId, season) {
  if (!playerId) {
    return null;
  }

  const cacheKey = `${playerId}-${season}`;
  const cached = playerHittingStreakCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const url = new URL(`${PEOPLE_BASE_URL}/${playerId}`);
  url.searchParams.set(
    "hydrate",
    `stats(group=[hitting],type=[gameLog],season=${season},sportId=1)`
  );

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      playerHittingStreakCache.set(cacheKey, null);
      return null;
    }

    const payload = await response.json();
    const splits = payload.people?.[0]?.stats?.[0]?.splits ?? [];
    const sortedLogs = [...splits].sort((a, b) => {
      const dateA = a?.date ? new Date(a.date).getTime() : 0;
      const dateB = b?.date ? new Date(b.date).getTime() : 0;
      return dateB - dateA;
    });

    const normalizedLogs = sortedLogs.map((split) => {
      const stat = split?.stat ?? {};
      const hits = asNumber(stat.hits);
      const doubles = asNumber(stat.doubles);
      const triples = asNumber(stat.triples);
      const homeRuns = asNumber(stat.homeRuns);
      const singles = Math.max(hits - doubles - triples - homeRuns, 0);
      const xbh = doubles + triples + homeRuns;
      return { hits, singles, xbh };
    });

    const streaks = {
      hitStreak: calculateCurrentStreak(normalizedLogs, (log) => log.hits > 0),
      singleStreak: calculateCurrentStreak(normalizedLogs, (log) => log.singles > 0),
      xbhStreak: calculateCurrentStreak(normalizedLogs, (log) => log.xbh > 0)
    };

    playerHittingStreakCache.set(cacheKey, streaks);
    return streaks;
  } catch (error) {
    playerHittingStreakCache.set(cacheKey, null);
    return null;
  }
}

export async function fetchPlayersHittingStreaksByIds(playerIds, season) {
  const uniqueIds = [...new Set(playerIds.filter(Boolean))];
  const results = await Promise.all(
    uniqueIds.map(async (playerId) => {
      const streaks = await fetchPlayerHittingStreak(playerId, season);
      return [playerId, streaks];
    })
  );

  return Object.fromEntries(results);
}
