const BASE_URL = "https://statsapi.mlb.com/api/v1/schedule";
const ESPN_LOGO_BASE_URL = "https://a.espncdn.com/i/teamlogos/mlb/500";
const PEOPLE_BASE_URL = "https://statsapi.mlb.com/api/v1/people";
const GAME_FEED_BASE_URL = "https://statsapi.mlb.com/api/v1.1/game";
const pitcherEraCache = new Map();
const lineupCache = new Map();
const playerHittingStatsCache = new Map();
const playerHittingStreakCache = new Map();

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
  url.searchParams.set("hydrate", "probablePitcher");
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
    return "---";
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

export async function fetchPitcherEra(playerId, season) {
  if (!playerId) {
    return null;
  }

  const cacheKey = `${playerId}-${season}`;
  const cachedEra = pitcherEraCache.get(cacheKey);
  if (cachedEra !== undefined) {
    return cachedEra;
  }

  const url = new URL(`${PEOPLE_BASE_URL}/${playerId}`);
  url.searchParams.set(
    "hydrate",
    `stats(group=[pitching],type=[season],season=${season},sportId=1)`
  );

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      pitcherEraCache.set(cacheKey, null);
      return null;
    }

    const payload = await response.json();
    const eraValue = payload.people?.[0]?.stats?.[0]?.splits?.[0]?.stat?.era;
    const normalizedEra = eraValue ?? null;
    pitcherEraCache.set(cacheKey, normalizedEra);
    return normalizedEra;
  } catch (error) {
    pitcherEraCache.set(cacheKey, null);
    return null;
  }
}

export async function fetchPitcherErasByIds(playerIds, season) {
  const uniqueIds = [...new Set(playerIds.filter(Boolean))];
  const results = await Promise.all(
    uniqueIds.map(async (pitcherId) => {
      const era = await fetchPitcherEra(pitcherId, season);
      return [pitcherId, era];
    })
  );

  return Object.fromEntries(results);
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
