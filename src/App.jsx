import { useEffect, useMemo, useRef, useState } from "react";
import {
  evaluatePitcherStrikeoutValueByGames,
  fetchPitcherGameLogs,
  fetchPitcherStrikeoutLinesForGame,
  fetchPitcherStrikeoutLinesByGames,
  fetchPitcherHandednessByIds,
  fetchMlbScheduleByDate,
  fetchPitcherErasByIds,
  fetchPitcherStrikeoutsPerGameByIds,
  getTeamAbbreviation,
  fetchBackendSession,
  fetchRecommendationHistoryFromBackend,
  loginToBackend,
  logoutFromBackend,
  upsertRecommendationHistoryToBackend,
  setBackendAccessToken
} from "./api/mlbApi";
import DateFilter from "./components/DateFilter";
import GamesList from "./components/GamesList";

const APP_DATA_CACHE_PREFIX = "mlb-app-data-cache-v1";
const configuredAppDataCacheTtlMinutes = Number(import.meta.env.VITE_APP_DATA_CACHE_TTL_MINUTES);
const APP_DATA_CACHE_TTL_MS =
  Number.isFinite(configuredAppDataCacheTtlMinutes) && configuredAppDataCacheTtlMinutes > 0
    ? configuredAppDataCacheTtlMinutes * 60 * 1000
    : 30 * 60 * 1000;
const AUTH_STORAGE_KEY = "mlb-app-auth-v1";
const RECOMMENDATION_HISTORY_STORAGE_KEY = "mlb-recommendation-history-v1";

function readRecommendationHistory() {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(RECOMMENDATION_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeRecommendationHistory(entries) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(RECOMMENDATION_HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    // Ignore storage quota/privacy mode errors.
  }
}

function resolveRecommendationByValue(strikeoutValue) {
  const valueLabel = `${strikeoutValue?.valueLabel ?? "Nula"}`.toLowerCase();
  const probabilityOver = Number(strikeoutValue?.probabilityOver);
  const safeProbabilityOver = Number.isFinite(probabilityOver) ? probabilityOver : 0.5;

  if (valueLabel === "valor") {
    return { recommendation: "Over", probability: safeProbabilityOver };
  }
  if (valueLabel === "sobrevalorada") {
    return { recommendation: "Under", probability: 1 - safeProbabilityOver };
  }
  return { recommendation: "Nula", probability: safeProbabilityOver };
}

function upsertRecommendationHistoryEntries(currentEntries, games, linesByPitcherId, valueByPitcherId) {
  const byKey = new Map(
    (Array.isArray(currentEntries) ? currentEntries : []).map((entry) => [entry?.entryKey, entry])
  );

  for (const game of games ?? []) {
    if (!game) {
      continue;
    }
    const awayPitcher = game?.teams?.away?.probablePitcher;
    const homePitcher = game?.teams?.home?.probablePitcher;
    const awayTeam = game?.teams?.away?.team;
    const homeTeam = game?.teams?.home?.team;
    const eventLabel = `${getTeamAbbreviation(awayTeam)} vs ${getTeamAbbreviation(homeTeam)}`;
    const gameDate = game?.officialDate || `${game?.gameDate || ""}`.slice(0, 10);

    for (const pitcher of [awayPitcher, homePitcher]) {
      const pitcherId = Number(pitcher?.id);
      if (!pitcherId) {
        continue;
      }
      const lineNode = linesByPitcherId?.[pitcherId];
      const offeredLine = Number(lineNode?.line);
      const strikeoutValue = valueByPitcherId?.[pitcherId];
      if (!Number.isFinite(offeredLine) || strikeoutValue?.unavailableReason) {
        continue;
      }

      const recommendationInfo = resolveRecommendationByValue(strikeoutValue);
      if (recommendationInfo.recommendation === "Nula") {
        continue;
      }

      const entryKey = `${game?.gamePk}-${pitcherId}`;
      const previous = byKey.get(entryKey);
      const nextBase = {
        entryKey,
        gamePk: Number(game?.gamePk || 0),
        gameDate: gameDate || "",
        eventLabel,
        pitcherId,
        pitcherName: pitcher?.fullName || "Pitcher",
        offeredLine,
        recommendation: recommendationInfo.recommendation,
        probability: recommendationInfo.probability,
        valueLabel: strikeoutValue?.valueLabel || ""
      };

      if (!previous) {
        byKey.set(entryKey, {
          ...nextBase,
          status: "pending",
          actualStrikeouts: null,
          createdAt: Date.now(),
          resolvedAt: null
        });
        continue;
      }

      if (previous.status === "pending") {
        byKey.set(entryKey, {
          ...previous,
          ...nextBase
        });
      }
    }
  }

  return [...byKey.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

async function resolveRecommendationHistoryEntries(entries) {
  const pendingEntries = (entries ?? []).filter((entry) => entry?.status === "pending");
  if (!pendingEntries.length) {
    return entries ?? [];
  }

  const uniquePitcherSeasonKeys = [
    ...new Set(
      pendingEntries
        .map((entry) => {
          const season = `${entry?.gameDate || ""}`.slice(0, 4);
          const pitcherId = Number(entry?.pitcherId || 0);
          if (!pitcherId || !season) {
            return "";
          }
          return `${pitcherId}-${season}`;
        })
        .filter(Boolean)
    )
  ];

  const logsEntries = await Promise.all(
    uniquePitcherSeasonKeys.map(async (key) => {
      const [pitcherIdRaw, season] = key.split("-");
      const pitcherId = Number(pitcherIdRaw);
      const logs = await fetchPitcherGameLogs(pitcherId, season);
      return [key, logs];
    })
  );
  const logsByPitcherSeason = Object.fromEntries(logsEntries);
  const nowMs = Date.now();

  return (entries ?? []).map((entry) => {
    if (entry?.status !== "pending") {
      return entry;
    }
    const season = `${entry?.gameDate || ""}`.slice(0, 4);
    const pitcherId = Number(entry?.pitcherId || 0);
    if (!pitcherId || !season) {
      return entry;
    }
    const logs = logsByPitcherSeason?.[`${pitcherId}-${season}`] ?? [];
    const matchingGame = logs.find((log) => Number(log?.gamePk || 0) === Number(entry?.gamePk || 0));
    if (!matchingGame) {
      return entry;
    }

    const actualStrikeouts = Number(matchingGame?.strikeOuts);
    if (!Number.isFinite(actualStrikeouts)) {
      return entry;
    }
    const line = Number(entry?.offeredLine);
    if (!Number.isFinite(line)) {
      return entry;
    }

    const isSuccess =
      entry?.recommendation === "Over" ? actualStrikeouts > line : actualStrikeouts < line;
    return {
      ...entry,
      actualStrikeouts,
      status: isSuccess ? "success" : "failed",
      resolvedAt: nowMs
    };
  });
}

function buildHistorySignature(entries) {
  return (entries ?? [])
    .map(
      (entry) =>
        `${entry?.entryKey}|${entry?.status}|${entry?.offeredLine}|${entry?.recommendation}|${entry?.actualStrikeouts ?? ""}`
    )
    .join(";");
}

function normalizeHistoryEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      entryKey: `${entry?.entryKey || ""}`,
      gamePk: Number(entry?.gamePk || 0),
      gameDate: `${entry?.gameDate || ""}`,
      eventLabel: `${entry?.eventLabel || ""}`,
      pitcherId: Number(entry?.pitcherId || 0),
      pitcherName: `${entry?.pitcherName || ""}`,
      offeredLine: Number(entry?.offeredLine || 0),
      recommendation: `${entry?.recommendation || "Nula"}`,
      probability: Number(entry?.probability || 0),
      valueLabel: `${entry?.valueLabel || ""}`,
      status: `${entry?.status || "pending"}`,
      actualStrikeouts:
        entry?.actualStrikeouts === null || entry?.actualStrikeouts === undefined
          ? null
          : Number(entry.actualStrikeouts),
      createdAt: Number(entry?.createdAt || Date.now()),
      resolvedAt: entry?.resolvedAt ? Number(entry.resolvedAt) : null
    }))
    .filter((entry) => entry.entryKey && entry.pitcherId && entry.gamePk)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function formatHistoryDate(isoDate) {
  if (!isoDate) {
    return "-";
  }
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return date.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function getTodayIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(isoDate, daysToAdd) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + daysToAdd);
  const nextYear = date.getFullYear();
  const nextMonth = `${date.getMonth() + 1}`.padStart(2, "0");
  const nextDay = `${date.getDate()}`.padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function hasGameStarted(game) {
  const startTime = new Date(game?.gameDate ?? "").getTime();
  if (!startTime || Number.isNaN(startTime)) {
    return false;
  }
  return Date.now() >= startTime;
}

function isGameLive(game) {
  const detailedState = `${game?.status?.detailedState ?? ""}`.toLowerCase();
  const abstractState = `${game?.status?.abstractGameState ?? ""}`.toLowerCase();
  return (
    abstractState === "live" ||
    detailedState.includes("in progress") ||
    detailedState.includes("warmup")
  );
}

function getMatchTagLabel(game) {
  const awayTeam = game?.teams?.away?.team;
  const homeTeam = game?.teams?.home?.team;
  const away = getTeamAbbreviation(awayTeam);
  const home = getTeamAbbreviation(homeTeam);
  return `${away} vs ${home}`;
}

function getMatchPriority(game) {
  if (isGameLive(game)) {
    return 0;
  }
  if (!hasGameStarted(game)) {
    return 1;
  }
  return 2;
}

function readAuthSession() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const fromLocal = window.localStorage.getItem(AUTH_STORAGE_KEY);
    const fromSession = window.sessionStorage.getItem(AUTH_STORAGE_KEY);
    const raw = fromLocal || fromSession;
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    const expiresAt = Number(parsed?.expiresAt || 0);
    if (!parsed?.authenticated || !parsed?.accessToken || !expiresAt) {
      clearAuthSession();
      return null;
    }
    if (Date.now() >= expiresAt) {
      clearAuthSession();
      return null;
    }
    return parsed;
  } catch (error) {
    clearAuthSession();
    return null;
  }
}

function writeAuthSession(sessionData, remember) {
  if (typeof window === "undefined") {
    return;
  }
  const payload = JSON.stringify(sessionData);
  window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
  if (remember) {
    window.localStorage.setItem(AUTH_STORAGE_KEY, payload);
  } else {
    window.sessionStorage.setItem(AUTH_STORAGE_KEY, payload);
  }
}

function clearAuthSession() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
  window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

function LoginView({ onLogin, authError, loading }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [showPassword, setShowPassword] = useState(false);

  function handleSubmit(event) {
    event.preventDefault();
    onLogin({
      username,
      password,
      rememberMe
    });
  }

  return (
    <section className="auth-card">
      <img className="auth-logo" src="/logo.png" alt="Gleam MLB logo" />
      <form className="auth-form" onSubmit={handleSubmit}>
        <label>
          Usuario
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Contrasena
          <div className="password-input-wrap">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPassword((current) => !current)}
              aria-label={showPassword ? "Ocultar contrasena" : "Mostrar contrasena"}
            >
              {showPassword ? (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path
                    d="M2 12c2.6-4.4 6.1-6.6 10-6.6 4.1 0 7.6 2.2 10 6.6-2.4 4.4-5.9 6.6-10 6.6-3.9 0-7.4-2.2-10-6.6z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="3.3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                  <path
                    d="M4 4l16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path
                    d="M2 12c2.6-4.4 6.1-6.6 10-6.6 4.1 0 7.6 2.2 10 6.6-2.4 4.4-5.9 6.6-10 6.6-3.9 0-7.4-2.2-10-6.6z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="3.3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                </svg>
              )}
            </button>
          </div>
        </label>
        <label className="remember-row">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(event) => setRememberMe(event.target.checked)}
          />
          <span>Recordarme</span>
        </label>
        <button type="submit" disabled={loading}>
          {loading ? "Validando..." : "Entrar"}
        </button>
      </form>
      {authError ? <p className="error">{authError}</p> : null}
    </section>
  );
}

function getAppDataCacheKey(selectedDate) {
  return `${APP_DATA_CACHE_PREFIX}:${selectedDate}`;
}

function readAppDataCache(selectedDate) {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(getAppDataCacheKey(selectedDate));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    const cachedAt = Number(parsed?.cachedAt);
    if (!cachedAt || Number.isNaN(cachedAt)) {
      return null;
    }
    if (Date.now() - cachedAt > APP_DATA_CACHE_TTL_MS) {
      window.localStorage.removeItem(getAppDataCacheKey(selectedDate));
      return null;
    }
    return parsed?.payload ?? null;
  } catch (error) {
    return null;
  }
}

function writeAppDataCache(selectedDate, payload) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      getAppDataCacheKey(selectedDate),
      JSON.stringify({
        cachedAt: Date.now(),
        payload
      })
    );
  } catch (error) {
    // Ignore cache write failures (quota/privacy mode).
  }
}

export default function App() {
  const todayDate = useMemo(() => getTodayIsoDate(), []);
  const minSelectableDate = useMemo(() => addDays(todayDate, -3), [todayDate]);
  const maxSelectableDate = useMemo(() => addDays(todayDate, 14), [todayDate]);
  const [selectedDate, setSelectedDate] = useState(todayDate);
  const [games, setGames] = useState([]);
  const [pitcherErasById, setPitcherErasById] = useState({});
  const [pitcherStrikeoutsPerGameById, setPitcherStrikeoutsPerGameById] = useState({});
  const [pitcherStrikeoutLinesById, setPitcherStrikeoutLinesById] = useState({});
  const [pitcherStrikeoutValueById, setPitcherStrikeoutValueById] = useState({});
  const [pitcherHandednessById, setPitcherHandednessById] = useState({});
  const [oddsLoading, setOddsLoading] = useState(false);
  const [gamesViewMode, setGamesViewMode] = useState("all");
  const [selectedMatchFilter, setSelectedMatchFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [refreshSeed, setRefreshSeed] = useState(0);
  const handledRefreshSeedRef = useRef(0);
  const [authSession, setAuthSession] = useState(() => readAuthSession());
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [activeMainView, setActiveMainView] = useState("games");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historySyncLoading, setHistorySyncLoading] = useState(false);
  const [recommendationHistory, setRecommendationHistory] = useState(() =>
    normalizeHistoryEntries(readRecommendationHistory())
  );
  const [error, setError] = useState("");
  const isAuthenticated = Boolean(authSession?.authenticated && authSession?.accessToken);

  useEffect(() => {
    setBackendAccessToken(authSession?.accessToken || "");
  }, [authSession]);

  useEffect(() => {
    if (!isAuthenticated) {
      setHistoryLoaded(false);
      return undefined;
    }
    let ignore = false;

    async function verifySession() {
      try {
        await fetchBackendSession();
      } catch (error) {
        if (!ignore) {
          clearAuthSession();
          setBackendAccessToken("");
          setAuthSession(null);
          setAuthError("Tu sesion expiro. Inicia sesion de nuevo.");
        }
      }
    }

    verifySession();
    return () => {
      ignore = true;
    };
  }, [isAuthenticated, authSession?.accessToken]);

  useEffect(() => {
    if (!isAuthenticated) {
      return undefined;
    }
    let ignore = false;

    async function loadRecommendationHistory() {
      setHistorySyncLoading(true);
      try {
        const remoteEntries = await fetchRecommendationHistoryFromBackend();
        if (ignore) {
          return;
        }
        const normalizedRemote = normalizeHistoryEntries(remoteEntries);
        if (normalizedRemote.length) {
          setRecommendationHistory(normalizedRemote);
          writeRecommendationHistory(normalizedRemote);
        } else {
          const localEntries = normalizeHistoryEntries(readRecommendationHistory());
          setRecommendationHistory(localEntries);
        }
      } catch (error) {
        if (!ignore) {
          const localEntries = normalizeHistoryEntries(readRecommendationHistory());
          setRecommendationHistory(localEntries);
        }
      } finally {
        if (!ignore) {
          setHistoryLoaded(true);
          setHistorySyncLoading(false);
        }
      }
    }

    loadRecommendationHistory();
    return () => {
      ignore = true;
    };
  }, [isAuthenticated, authSession?.accessToken]);

  useEffect(() => {
    if (!isAuthenticated || !historyLoaded) {
      return undefined;
    }
    let ignore = false;

    async function syncRecommendationHistory() {
      const mergedEntries = upsertRecommendationHistoryEntries(
        recommendationHistory,
        games,
        pitcherStrikeoutLinesById,
        pitcherStrikeoutValueById
      );
      setHistorySyncLoading(true);
      try {
        const resolvedEntries = normalizeHistoryEntries(
          await resolveRecommendationHistoryEntries(mergedEntries)
        );
        if (ignore) {
          return;
        }
        const beforeSignature = buildHistorySignature(normalizeHistoryEntries(recommendationHistory));
        const afterSignature = buildHistorySignature(resolvedEntries);
        const changed =
          beforeSignature !== afterSignature || resolvedEntries.length !== recommendationHistory.length;
        if (changed) {
          setRecommendationHistory(resolvedEntries);
          writeRecommendationHistory(resolvedEntries);
          try {
            await upsertRecommendationHistoryToBackend(resolvedEntries);
          } catch (error) {
            // Keep local copy when backend is temporarily unavailable.
          }
        }
      } finally {
        if (!ignore) {
          setHistorySyncLoading(false);
        }
      }
    }

    syncRecommendationHistory();
    return () => {
      ignore = true;
    };
  }, [
    isAuthenticated,
    historyLoaded,
    games,
    pitcherStrikeoutLinesById,
    pitcherStrikeoutValueById,
    recommendationHistory
  ]);

  useEffect(() => {
    let ignore = false;
    const forceRefresh = refreshSeed !== handledRefreshSeedRef.current;
    handledRefreshSeedRef.current = refreshSeed;

    function applyLoadedData(snapshot) {
      setGames(snapshot?.games ?? []);
      setPitcherErasById(snapshot?.pitcherErasById ?? {});
      setPitcherStrikeoutsPerGameById(snapshot?.pitcherStrikeoutsPerGameById ?? {});
      setPitcherStrikeoutLinesById(snapshot?.pitcherStrikeoutLinesById ?? {});
      setPitcherStrikeoutValueById(snapshot?.pitcherStrikeoutValueById ?? {});
      setPitcherHandednessById(snapshot?.pitcherHandednessById ?? {});
    }

    async function loadGames() {
      setLoading(true);
      setOddsLoading(true);
      setError("");
      try {
        if (!forceRefresh) {
          const cached = readAppDataCache(selectedDate);
          if (cached) {
            if (!ignore) {
              applyLoadedData(cached);
              setOddsLoading(false);
              setLoading(false);
            }
            return;
          }
        }

        const payload = await fetchMlbScheduleByDate(selectedDate);
        const dateNode = payload.dates?.[0];
        const fetchedGames = dateNode?.games ?? [];
        const pitcherIds = fetchedGames.flatMap((game) => [
          game.teams?.away?.probablePitcher?.id,
          game.teams?.home?.probablePitcher?.id
        ]);
        const season = selectedDate.split("-")[0];
        const [erasMap, strikeoutsPerGameMap, strikeoutLinesMap, handednessMap] =
          await Promise.all([
            fetchPitcherErasByIds(pitcherIds, season),
            fetchPitcherStrikeoutsPerGameByIds(pitcherIds, season),
            fetchPitcherStrikeoutLinesByGames(fetchedGames),
            fetchPitcherHandednessByIds(pitcherIds)
          ]);
        const strikeoutValueMap = await evaluatePitcherStrikeoutValueByGames(
          fetchedGames,
          strikeoutLinesMap,
          { season, pitcherHandednessById: handednessMap }
        );

        if (!ignore) {
          const nextSnapshot = {
            games: fetchedGames,
            pitcherErasById: erasMap,
            pitcherStrikeoutsPerGameById: strikeoutsPerGameMap,
            pitcherStrikeoutLinesById: strikeoutLinesMap,
            pitcherStrikeoutValueById: strikeoutValueMap,
            pitcherHandednessById: handednessMap
          };
          applyLoadedData(nextSnapshot);
          writeAppDataCache(selectedDate, nextSnapshot);
          setOddsLoading(false);
        }
      } catch (err) {
        if (!ignore) {
          const rawMessage = `${err?.message || ""}`.toLowerCase();
          const isAuthIssue =
            rawMessage.includes("missing bearer token") ||
            rawMessage.includes("invalid or expired token") ||
            rawMessage.includes("invalid token");
          if (isAuthIssue) {
            clearAuthSession();
            setAuthSession(null);
            setAuthError("Tu sesion expiro. Inicia sesion de nuevo.");
          }
          setError("No se pudo cargar la data de MLB.");
          setGames([]);
          setPitcherErasById({});
          setPitcherStrikeoutsPerGameById({});
          setPitcherStrikeoutLinesById({});
          setPitcherStrikeoutValueById({});
          setPitcherHandednessById({});
          setOddsLoading(false);
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadGames();
    return () => {
      ignore = true;
    };
  }, [selectedDate, refreshSeed]);

  const subtitle = useMemo(() => {
    return `Mostrando juegos para ${selectedDate}`;
  }, [selectedDate]);

  const matchFilterOptions = useMemo(() => {
    return [...games]
      .sort((a, b) => {
        const rankDiff = getMatchPriority(a) - getMatchPriority(b);
        if (rankDiff !== 0) {
          return rankDiff;
        }
        const timeA = new Date(a?.gameDate ?? "").getTime() || 0;
        const timeB = new Date(b?.gameDate ?? "").getTime() || 0;
        return timeA - timeB;
      })
      .map((game) => ({
        id: String(game?.gamePk),
        label: getMatchTagLabel(game),
        isLive: isGameLive(game),
        isUpcoming: !hasGameStarted(game)
      }));
  }, [games]);

  const visibleGames = useMemo(() => {
    let filteredGames = games;
    if (gamesViewMode === "upcoming") {
      filteredGames = filteredGames.filter((game) => !hasGameStarted(game));
    }
    if (selectedMatchFilter !== "all") {
      filteredGames = filteredGames.filter((game) => {
        return String(game?.gamePk) === selectedMatchFilter;
      });
    }
    return filteredGames;
  }, [games, gamesViewMode, selectedMatchFilter]);

  function handleDateChange(nextDate) {
    if (!nextDate) {
      return;
    }
    if (nextDate < minSelectableDate || nextDate > maxSelectableDate) {
      return;
    }
    setSelectedDate(nextDate);
  }

  async function handleRefreshOddsForGame(game) {
    try {
      const result = await fetchPitcherStrikeoutLinesForGame(game, { forceRefresh: true });
      const awayPitcherId = game?.teams?.away?.probablePitcher?.id;
      const homePitcherId = game?.teams?.home?.probablePitcher?.id;
      const nextLinesByPitcherId = { ...pitcherStrikeoutLinesById };

      if (awayPitcherId) {
        delete nextLinesByPitcherId[awayPitcherId];
      }
      if (homePitcherId) {
        delete nextLinesByPitcherId[homePitcherId];
      }
      Object.assign(nextLinesByPitcherId, result.linesByPitcherId);

      const season = selectedDate.split("-")[0];
      const refreshedValueMap = await evaluatePitcherStrikeoutValueByGames(
        [game],
        nextLinesByPitcherId,
        { season, pitcherHandednessById }
      );
      const nextStrikeoutValueById = { ...pitcherStrikeoutValueById };
      if (awayPitcherId) {
        delete nextStrikeoutValueById[awayPitcherId];
      }
      if (homePitcherId) {
        delete nextStrikeoutValueById[homePitcherId];
      }
      Object.assign(nextStrikeoutValueById, refreshedValueMap);

      setPitcherStrikeoutLinesById(nextLinesByPitcherId);
      setPitcherStrikeoutValueById(nextStrikeoutValueById);
      writeAppDataCache(selectedDate, {
        games,
        pitcherErasById,
        pitcherStrikeoutsPerGameById,
        pitcherStrikeoutLinesById: nextLinesByPitcherId,
        pitcherStrikeoutValueById: nextStrikeoutValueById,
        pitcherHandednessById
      });

      return result.debug;
    } catch (error) {
      const rawMessage = `${error?.message || ""}`.toLowerCase();
      const isAuthIssue =
        rawMessage.includes("missing bearer token") ||
        rawMessage.includes("invalid or expired token") ||
        rawMessage.includes("invalid token");
      if (isAuthIssue) {
        clearAuthSession();
        setBackendAccessToken("");
        setAuthSession(null);
        setAuthError("Tu sesion expiro. Inicia sesion de nuevo.");
      }
      return { error: "No se pudo refrescar odds." };
    }
  }

  async function handleLogin({ username, password, rememberMe }) {
    setAuthLoading(true);
    setAuthError("");
    try {
      const authPayload = await loginToBackend({ username, password, rememberMe });
      const nextAuthSession = {
        authenticated: true,
        username: authPayload?.username || username.trim(),
        accessToken: authPayload?.accessToken || "",
        expiresAt: Number(authPayload?.expiresAt || 0),
        loggedAt: Date.now()
      };
      if (!nextAuthSession.accessToken || !nextAuthSession.expiresAt) {
        throw new Error("Respuesta invalida del backend.");
      }
      writeAuthSession(nextAuthSession, rememberMe);
      setAuthSession(nextAuthSession);
    } catch (error) {
      setAuthError("Usuario o contrasena incorrectos.");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await logoutFromBackend();
    } catch (error) {
      // Best effort server-side invalidation.
    } finally {
      clearAuthSession();
      setBackendAccessToken("");
      setAuthSession(null);
      setHistoryLoaded(false);
    }
  }

  async function handleLoadHistoryExample() {
    const yesterday = addDays(getTodayIsoDate(), -1);
    const sampleEntries = [
      {
        entryKey: `sample-${yesterday}-1`,
        gamePk: 999001,
        gameDate: yesterday,
        eventLabel: "ARI vs PHI",
        pitcherId: 607074,
        pitcherName: "Zac Gallen",
        offeredLine: 5.5,
        recommendation: "Under",
        probability: 0.99,
        valueLabel: "Sobrevalorada",
        status: "success",
        actualStrikeouts: 4,
        createdAt: Date.now() - 24 * 60 * 60 * 1000,
        resolvedAt: Date.now() - 12 * 60 * 60 * 1000
      },
      {
        entryKey: `sample-${yesterday}-2`,
        gamePk: 999002,
        gameDate: yesterday,
        eventLabel: "NYY vs BOS",
        pitcherId: 592450,
        pitcherName: "Gerrit Cole",
        offeredLine: 6.5,
        recommendation: "Over",
        probability: 0.62,
        valueLabel: "Valor",
        status: "failed",
        actualStrikeouts: 5,
        createdAt: Date.now() - 24 * 60 * 60 * 1000 + 1000,
        resolvedAt: Date.now() - 12 * 60 * 60 * 1000 + 1000
      },
      {
        entryKey: `sample-${yesterday}-3`,
        gamePk: 999003,
        gameDate: yesterday,
        eventLabel: "LAD vs SD",
        pitcherId: 605141,
        pitcherName: "Yu Darvish",
        offeredLine: 4.5,
        recommendation: "Over",
        probability: 0.58,
        valueLabel: "Valor",
        status: "pending",
        actualStrikeouts: null,
        createdAt: Date.now() - 24 * 60 * 60 * 1000 + 2000,
        resolvedAt: null
      }
    ];

    const byKey = new Map(recommendationHistory.map((entry) => [entry.entryKey, entry]));
    for (const sample of sampleEntries) {
      if (!byKey.has(sample.entryKey)) {
        byKey.set(sample.entryKey, sample);
      }
    }
    const nextEntries = normalizeHistoryEntries([...byKey.values()]);
    setRecommendationHistory(nextEntries);
    writeRecommendationHistory(nextEntries);
    try {
      await upsertRecommendationHistoryToBackend(nextEntries);
    } catch (error) {
      // Keep local examples if backend write fails.
    }
    setActiveMainView("history");
  }

  const historySummary = useMemo(() => {
    const success = recommendationHistory.filter((entry) => entry.status === "success").length;
    const failed = recommendationHistory.filter((entry) => entry.status === "failed").length;
    const pending = recommendationHistory.filter((entry) => entry.status === "pending").length;
    return { success, failed, pending };
  }, [recommendationHistory]);

  if (!isAuthenticated) {
    return (
      <main className="app auth-page">
        <LoginView onLogin={handleLogin} authError={authError} loading={authLoading} />
      </main>
    );
  }

  return (
    <main className="app">
      <div className="app-header">
        <h1>MLB Schedule Viewer</h1>
        <button type="button" className="logout-button" onClick={handleLogout}>
          Cerrar sesion
        </button>
      </div>
      <p>{subtitle}</p>
      <DateFilter
        value={selectedDate}
        onChange={handleDateChange}
        loading={loading}
        minDate={minSelectableDate}
        maxDate={maxSelectableDate}
      />
      <div className="games-view-toggle" role="tablist" aria-label="Vista principal">
        <button
          type="button"
          className={`games-view-button ${activeMainView === "games" ? "active" : ""}`}
          onClick={() => setActiveMainView("games")}
        >
          Juegos
        </button>
        <button
          type="button"
          className={`games-view-button ${activeMainView === "history" ? "active" : ""}`}
          onClick={() => setActiveMainView("history")}
        >
          Historial recomendaciones
        </button>
        <button type="button" className="games-view-button" onClick={handleLoadHistoryExample}>
          Cargar ejemplo de ayer
        </button>
      </div>
      {activeMainView === "history" ? (
        <section className="history-panel">
          <p className="history-summary">
            Exitos: <strong>{historySummary.success}</strong> · Failed:{" "}
            <strong>{historySummary.failed}</strong> · Pendientes:{" "}
            <strong>{historySummary.pending}</strong>
            {historySyncLoading ? " · Actualizando..." : ""}
          </p>
          {!recommendationHistory.length ? (
            <p>No hay historial todavia. Se ira llenando cuando terminen juegos evaluados.</p>
          ) : (
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Evento</th>
                    <th>Pitcher</th>
                    <th>Linea</th>
                    <th>Recomendacion</th>
                    <th>Resultado</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recommendationHistory.map((entry) => (
                    <tr key={entry.entryKey}>
                      <td>{formatHistoryDate(entry.gameDate)}</td>
                      <td>{entry.eventLabel}</td>
                      <td>{entry.pitcherName}</td>
                      <td>{Number(entry.offeredLine).toFixed(1)} K</td>
                      <td>
                        {entry.recommendation} ({(Number(entry.probability || 0) * 100).toFixed(0)}%)
                      </td>
                      <td>
                        {entry.actualStrikeouts === null || entry.actualStrikeouts === undefined
                          ? "-"
                          : `${entry.actualStrikeouts} K`}
                      </td>
                      <td>
                        <span className={`history-status ${entry.status}`}>
                          {entry.status === "success"
                            ? "Exito"
                            : entry.status === "failed"
                              ? "Failed"
                              : "Pendiente"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
      {activeMainView !== "history" ? (
        <>
      <div className="games-view-toggle" role="tablist" aria-label="Filtro de juegos">
        <button
          type="button"
          className={`games-view-button ${gamesViewMode === "upcoming" ? "active" : ""}`}
          onClick={() => setGamesViewMode("upcoming")}
        >
          Proximos
        </button>
        <button
          type="button"
          className={`games-view-button ${gamesViewMode === "all" ? "active" : ""}`}
          onClick={() => setGamesViewMode("all")}
        >
          Todos
        </button>
        <button
          type="button"
          className="games-view-button"
          onClick={() => {
            setRefreshSeed((current) => current + 1);
          }}
          disabled={loading}
        >
          {loading ? "Refrescando data..." : "Refrescar data (fecha)"}
        </button>
      </div>
      <div className="match-filter-strip" role="tablist" aria-label="Filtro por match">
        <button
          type="button"
          className={`match-filter-tag ${selectedMatchFilter === "all" ? "active" : ""}`}
          onClick={() => setSelectedMatchFilter("all")}
        >
          Todos los matches
        </button>
        {matchFilterOptions.map((match) => (
          <button
            key={match.id}
            type="button"
            className={`match-filter-tag ${selectedMatchFilter === match.id ? "active" : ""}`}
            onClick={() => setSelectedMatchFilter(match.id)}
            title={match.isLive ? "En vivo" : match.isUpcoming ? "Proximo" : undefined}
          >
            <span
              className={`match-status-dot ${
                match.isLive ? "live" : match.isUpcoming ? "upcoming" : ""
              }`}
              aria-hidden="true"
            />
            {match.label}
          </button>
        ))}
      </div>
      {error ? <p className="error">{error}</p> : null}
      {loading ? (
        <p>Cargando juegos...</p>
      ) : (
        <GamesList
          games={visibleGames}
          pitcherErasById={pitcherErasById}
          pitcherStrikeoutsPerGameById={pitcherStrikeoutsPerGameById}
          pitcherStrikeoutLinesById={pitcherStrikeoutLinesById}
          pitcherStrikeoutValueById={pitcherStrikeoutValueById}
          pitcherHandednessById={pitcherHandednessById}
          oddsLoading={oddsLoading}
          onRefreshOddsForGame={handleRefreshOddsForGame}
        />
      )}
        </>
      ) : null}
    </main>
  );
}
