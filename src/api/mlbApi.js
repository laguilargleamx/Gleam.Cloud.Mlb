const BASE_URL = "https://statsapi.mlb.com/api/v1/schedule";
const ESPN_LOGO_BASE_URL = "https://a.espncdn.com/i/teamlogos/mlb/500";
const PEOPLE_BASE_URL = "https://statsapi.mlb.com/api/v1/people";
const GAME_FEED_BASE_URL = "https://statsapi.mlb.com/api/v1.1/game";
const configuredOddsBaseUrl = (import.meta.env.VITE_THE_ODDS_API_BASE_URL || "/odds-api/v4").trim();
const THE_ODDS_API_BASE_URL =
  configuredOddsBaseUrl.includes("api.the-odds-api.com") ? "/odds-api/v4" : configuredOddsBaseUrl;
const THE_ODDS_API_KEY = (import.meta.env.VITE_THE_ODDS_API_KEY || "").trim();
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
  const firstWithPoint = matchingOutcomes.find((outcome) => typeof outcome?.point === "number");
  const selected = overOutcome ?? firstWithPoint ?? matchingOutcomes[0];
  return typeof selected?.point === "number" ? selected.point : null;
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

async function fetchOddsServiceJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The Odds API error ${response.status}`);
  }
  return response.json();
}

function buildOddsApiUrl(pathname) {
  const base = THE_ODDS_API_BASE_URL.endsWith("/")
    ? THE_ODDS_API_BASE_URL.slice(0, -1)
    : THE_ODDS_API_BASE_URL;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;

  // Support relative dev proxy base like "/odds-api/v4".
  if (base.startsWith("/")) {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "http://localhost:5173";
    return new URL(`${base}${path}`, origin);
  }

  return new URL(`${base}${path}`);
}

export async function fetchPitcherStrikeoutLinesByGames(
  games,
  { preferredBookmakerKey = "draftkings", regions = "us" } = {}
) {
  try {
    if (!THE_ODDS_API_KEY) {
      return {};
    }

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
    const cached = pitcherStrikeoutLineCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const eventsUrl = buildOddsApiUrl("/sports/baseball_mlb/events");
    eventsUrl.searchParams.set("apiKey", THE_ODDS_API_KEY);
    const events = await fetchOddsServiceJson(eventsUrl.toString());

    const linesByPitcherId = {};
    await Promise.all(
      upcomingGames.map(async (game) => {
        const result = await fetchPitcherStrikeoutLinesForGame(game, {
          preferredBookmakerKey,
          regions,
          forceRefresh: false,
          events
        });
        Object.assign(linesByPitcherId, result.linesByPitcherId);
      })
    );

    if (Object.keys(linesByPitcherId).length) {
      pitcherStrikeoutLineCache.set(cacheKey, linesByPitcherId);
    } else {
      pitcherStrikeoutLineCache.delete(cacheKey);
    }
    return linesByPitcherId;
  } catch (error) {
    return {};
  }
}

export async function fetchPitcherStrikeoutLinesForGame(
  game,
  { preferredBookmakerKey = "draftkings", regions = "us", forceRefresh = true, events = null } = {}
) {
  const debug = {
    eventsUrl: "",
    oddsUrl: "",
    matchedEventId: "",
    bookmakerKey: "",
    error: ""
  };

  try {
    if (!THE_ODDS_API_KEY) {
      debug.error = "Missing API key";
      return { linesByPitcherId: {}, debug };
    }
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
      const cached = pitcherStrikeoutLineCache.get(cacheKey);
      if (cached !== undefined) {
        return { linesByPitcherId: cached, debug };
      }
    } else {
      pitcherStrikeoutLineCache.delete(cacheKey);
    }

    const eventsUrl = buildOddsApiUrl("/sports/baseball_mlb/events");
    eventsUrl.searchParams.set("apiKey", THE_ODDS_API_KEY);
    debug.eventsUrl = eventsUrl.toString();
    const allEvents = Array.isArray(events) ? events : await fetchOddsServiceJson(eventsUrl.toString());

    const event = findMatchingEvent(game, allEvents);
    if (!event?.id) {
      debug.error = "No matching event";
      return { linesByPitcherId: {}, debug };
    }
    debug.matchedEventId = event.id;

    const oddsUrl = buildOddsApiUrl(`/sports/baseball_mlb/events/${event.id}/odds`);
    oddsUrl.searchParams.set("apiKey", THE_ODDS_API_KEY);
    oddsUrl.searchParams.set("regions", regions);
    oddsUrl.searchParams.set("markets", "pitcher_strikeouts");
    oddsUrl.searchParams.set("oddsFormat", "american");
    debug.oddsUrl = oddsUrl.toString();

    const oddsPayload = await fetchOddsServiceJson(oddsUrl.toString());
    const bookmakers = oddsPayload?.bookmakers ?? oddsPayload?.data?.bookmakers ?? [];
    const bookmaker = selectBookmaker(bookmakers, preferredBookmakerKey);
    if (!bookmaker) {
      debug.error = "No bookmaker";
      return { linesByPitcherId: {}, debug };
    }
    debug.bookmakerKey = bookmaker?.key ?? "";

    const linesByPitcherId = {};
    const awayPitcher = game?.teams?.away?.probablePitcher;
    const homePitcher = game?.teams?.home?.probablePitcher;
    const awayLine = extractPitcherStrikeoutLine(bookmaker, awayPitcher?.fullName);
    const homeLine = extractPitcherStrikeoutLine(bookmaker, homePitcher?.fullName);

    if (awayPitcher?.id && awayLine !== null) {
      linesByPitcherId[awayPitcher.id] = {
        line: awayLine,
        sportsbookKey: bookmaker?.key ?? "sportsbook",
        sportsbookTitle: bookmaker?.title ?? bookmaker?.key ?? "Sportsbook"
      };
    }
    if (homePitcher?.id && homeLine !== null) {
      linesByPitcherId[homePitcher.id] = {
        line: homeLine,
        sportsbookKey: bookmaker?.key ?? "sportsbook",
        sportsbookTitle: bookmaker?.title ?? bookmaker?.key ?? "Sportsbook"
      };
    }

    if (Object.keys(linesByPitcherId).length) {
      pitcherStrikeoutLineCache.set(cacheKey, linesByPitcherId);
    } else {
      debug.error = "No matching pitcher outcomes";
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
