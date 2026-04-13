import { useEffect, useMemo, useRef, useState } from "react";
import {
  evaluatePitcherStrikeoutValueByGames,
  fetchGameLineups,
  fetchHitterGameLogs,
  fetchPitcherGameLogs,
  fetchPitcherStrikeoutLinesForGame,
  fetchPitcherStrikeoutLinesByGames,
  fetchPitcherHandednessByIds,
  fetchGameWeatherByGames,
  fetchMlbScheduleByDate,
  fetchPlayersHittingStatsByIds,
  fetchPlayersHittingStreaksByIds,
  fetchPlayersVsPitcherStatsByIds,
  fetchPitcherErasByIds,
  fetchPitcherStrikeoutsPerGameByIds,
  getTeamAbbreviation,
  getTeamLogoUrl,
  fetchBackendSession,
  fetchRecommendationHistoryFromBackend,
  loginToBackend,
  pruneSampleRecommendationHistoryFromBackend,
  upsertRecommendationHistoryToBackend,
  setBackendAccessToken
} from "./api/mlbApi";
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
        pickDomain: "strikeouts",
        gamePk: Number(game?.gamePk || 0),
        gameDate: gameDate || "",
        eventLabel,
        pitcherId,
        pitcherName: pitcher?.fullName || "Pitcher",
        marketLabel: `${recommendationInfo.recommendation} ${offeredLine.toFixed(1)} K`,
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

function upsertBatterHistoryEntries(currentEntries, newEntries) {
  const byKey = new Map(
    (Array.isArray(currentEntries) ? currentEntries : []).map((entry) => [entry?.entryKey, entry])
  );
  for (const entry of newEntries ?? []) {
    const key = `${entry?.entryKey || ""}`.trim();
    if (!key) {
      continue;
    }
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, entry);
      continue;
    }
    if (previous.status === "pending") {
      byKey.set(key, {
        ...previous,
        ...entry,
        createdAt: previous.createdAt,
        resolvedAt: previous.resolvedAt,
        status: previous.status,
        actualStrikeouts: previous.actualStrikeouts
      });
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
        .filter((entry) => `${entry?.pickDomain || "strikeouts"}` === "strikeouts")
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
  const uniqueHitterSeasonKeys = [
    ...new Set(
      pendingEntries
        .filter((entry) => `${entry?.pickDomain || "strikeouts"}` !== "strikeouts")
        .map((entry) => {
          const season = `${entry?.gameDate || ""}`.slice(0, 4);
          const playerId = Number(entry?.pitcherId || 0);
          if (!playerId || !season) {
            return "";
          }
          return `${playerId}-${season}`;
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
  const hitterLogsEntries = await Promise.all(
    uniqueHitterSeasonKeys.map(async (key) => {
      const [playerIdRaw, season] = key.split("-");
      const playerId = Number(playerIdRaw);
      const logs = await fetchHitterGameLogs(playerId, season);
      return [key, logs];
    })
  );
  const logsByPitcherSeason = Object.fromEntries(logsEntries);
  const logsByHitterSeason = Object.fromEntries(hitterLogsEntries);
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

    if (`${entry?.pickDomain || "strikeouts"}` === "strikeouts") {
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
    }

    const hitterLogs = logsByHitterSeason?.[`${pitcherId}-${season}`] ?? [];
    const matchingHitterGame = hitterLogs.find(
      (log) => Number(log?.gamePk || 0) === Number(entry?.gamePk || 0)
    );
    if (!matchingHitterGame) {
      return entry;
    }
    const hits = Number(matchingHitterGame?.hits || 0);
    const reachesBase =
      hits + Number(matchingHitterGame?.baseOnBalls || 0) + Number(matchingHitterGame?.hitByPitch || 0);

    if (`${entry?.pickDomain || ""}`.toLowerCase() === "hits") {
      return {
        ...entry,
        actualStrikeouts: hits,
        status: hits > 0 ? "success" : "failed",
        resolvedAt: nowMs
      };
    }
    return {
      ...entry,
      actualStrikeouts: reachesBase,
      status: reachesBase > 0 ? "success" : "failed",
      resolvedAt: nowMs
    };
  });
}

function buildHistorySignature(entries) {
  return (entries ?? [])
    .map(
      (entry) =>
        `${entry?.entryKey}|${entry?.pickDomain}|${entry?.status}|${entry?.offeredLine}|${entry?.recommendation}|${entry?.actualStrikeouts ?? ""}`
    )
    .join(";");
}

function normalizeHistoryEntries(entries) {
  function isSampleEntry(entry) {
    return `${entry?.entryKey || ""}`.startsWith("sample-") || Number(entry?.gamePk || 0) >= 900000;
  }

  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      entryKey: `${entry?.entryKey || ""}`,
      pickDomain: `${entry?.pickDomain || "strikeouts"}`,
      gamePk: Number(entry?.gamePk || 0),
      gameDate: `${entry?.gameDate || ""}`,
      eventLabel: `${entry?.eventLabel || ""}`,
      pitcherId: Number(entry?.pitcherId || 0),
      pitcherName: `${entry?.pitcherName || ""}`,
      marketLabel: `${entry?.marketLabel || ""}`,
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
    .filter((entry) => !isSampleEntry(entry))
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

function clampProbability(value, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function estimateHitProbability(stats, streaks, opposingPitcherHandedness, vsPitcherStats) {
  const avg = Number(stats?.avg);
  const ops = Number(stats?.ops);
  const hitStreak = Number(streaks?.hitStreak || 0);
  const singleStreak = Number(streaks?.singleStreak || 0);
  const handText = `${opposingPitcherHandedness || ""}`.toLowerCase();

  const baseAvg = Number.isFinite(avg) && avg > 0 ? avg : 0.245;
  const opsAdjustment = Number.isFinite(ops) ? clampProbability((ops - 0.72) * 0.16, -0.04, 0.06) : 0;
  const streakAdjustment = clampProbability(hitStreak * 0.008 + singleStreak * 0.006, 0, 0.06);
  const handAdjustment = handText.startsWith("zur") ? 0.005 : 0;

  const baseProbability = clampProbability(
    baseAvg + opsAdjustment + streakAdjustment + handAdjustment,
    0.14,
    0.8
  );
  const atBatsVsPitcher = Number(vsPitcherStats?.atBats || 0);
  const hitsVsPitcher = Number(vsPitcherStats?.hits || 0);
  if (atBatsVsPitcher <= 0 || hitsVsPitcher < 0) {
    return baseProbability;
  }
  const rawVsHitRate = clampProbability(hitsVsPitcher / atBatsVsPitcher, 0.05, 0.95);
  const sampleWeight = clampProbability((atBatsVsPitcher - 2) / 18, 0, 0.3);
  return clampProbability(
    baseProbability * (1 - sampleWeight) + rawVsHitRate * sampleWeight,
    0.14,
    0.8
  );
}

function estimateOnBaseProbability(stats, streaks, hitProbability, vsPitcherStats) {
  const obp = Number(stats?.obp);
  const hitStreak = Number(streaks?.hitStreak || 0);
  const xbhStreak = Number(streaks?.xbhStreak || 0);

  const baseObp =
    Number.isFinite(obp) && obp > 0 ? obp : clampProbability(Number(hitProbability) + 0.07, 0.22, 0.42);
  const streakAdjustment = clampProbability(hitStreak * 0.006 + xbhStreak * 0.003, 0, 0.05);
  const baseProbability = clampProbability(baseObp + streakAdjustment, 0.2, 0.9);
  const plateAppearancesVsPitcher = Number(vsPitcherStats?.plateAppearances || 0);
  if (plateAppearancesVsPitcher <= 0) {
    return baseProbability;
  }
  const onBaseEvents =
    Number(vsPitcherStats?.hits || 0) +
    Number(vsPitcherStats?.walks || 0) +
    Number(vsPitcherStats?.hitByPitch || 0);
  const rawVsOnBaseRate = clampProbability(onBaseEvents / plateAppearancesVsPitcher, 0.08, 0.98);
  const sampleWeight = clampProbability((plateAppearancesVsPitcher - 3) / 20, 0, 0.32);
  return clampProbability(
    baseProbability * (1 - sampleWeight) + rawVsOnBaseRate * sampleWeight,
    0.2,
    0.9
  );
}

function formatPercent(probability) {
  const numeric = Number(probability);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${Math.round(numeric * 100)}%`;
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

function buildSelectableDates(minDate, maxDate) {
  const dates = [];
  let cursor = new Date(`${minDate}T00:00:00`);
  const end = new Date(`${maxDate}T00:00:00`);
  while (cursor <= end) {
    const year = cursor.getFullYear();
    const month = `${cursor.getMonth() + 1}`.padStart(2, "0");
    const day = `${cursor.getDate()}`.padStart(2, "0");
    dates.push(`${year}-${month}-${day}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function formatDateOption(isoDate) {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return date.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short"
  });
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

function getMatchTimeLabel(game) {
  const gameTime = new Date(game?.gameDate ?? "").getTime();
  if (!gameTime || Number.isNaN(gameTime)) {
    return "--:--";
  }
  return new Date(gameTime).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
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
  const minSelectableDate = useMemo(() => todayDate, [todayDate]);
  const maxSelectableDate = useMemo(() => addDays(todayDate, 5), [todayDate]);
  const [selectedDate, setSelectedDate] = useState(todayDate);
  const [games, setGames] = useState([]);
  const [pitcherErasById, setPitcherErasById] = useState({});
  const [pitcherStrikeoutsPerGameById, setPitcherStrikeoutsPerGameById] = useState({});
  const [pitcherStrikeoutLinesById, setPitcherStrikeoutLinesById] = useState({});
  const [pitcherStrikeoutValueById, setPitcherStrikeoutValueById] = useState({});
  const [pitcherHandednessById, setPitcherHandednessById] = useState({});
  const [gameWeatherByGamePk, setGameWeatherByGamePk] = useState({});
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
  const tickerStripRef = useRef(null);
  const [canScrollTickerRight, setCanScrollTickerRight] = useState(false);
  const [topPicksLoading, setTopPicksLoading] = useState(false);
  const [topPicksError, setTopPicksError] = useState("");
  const [topPicks, setTopPicks] = useState({
    strikeouts: [],
    hits: [],
    onBase: []
  });
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
        await pruneSampleRecommendationHistoryFromBackend();
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
    if (!isAuthenticated || activeMainView !== "top") {
      return undefined;
    }
    let ignore = false;

    async function loadTopPicks() {
      setTopPicksLoading(true);
      setTopPicksError("");
      try {
        const strikeoutCandidates = [];
        for (const game of games) {
          const awayTeam = game?.teams?.away?.team;
          const homeTeam = game?.teams?.home?.team;
          const eventLabel = `${getTeamAbbreviation(awayTeam)} vs ${getTeamAbbreviation(homeTeam)}`;
          for (const side of [game?.teams?.away, game?.teams?.home]) {
            const pitcher = side?.probablePitcher;
            const pitcherId = Number(pitcher?.id || 0);
            if (!pitcherId) {
              continue;
            }
            const lineNode = pitcherStrikeoutLinesById?.[pitcherId];
            const strikeoutValue = pitcherStrikeoutValueById?.[pitcherId];
            if (!lineNode || !strikeoutValue || strikeoutValue?.unavailableReason) {
              continue;
            }
            const recommendation = resolveRecommendationByValue(strikeoutValue);
            if (recommendation.recommendation === "Nula") {
              continue;
            }
            strikeoutCandidates.push({
              key: `so-${game?.gamePk}-${pitcherId}`,
              gamePk: Number(game?.gamePk || 0),
              gameDate: `${game?.officialDate || `${game?.gameDate || ""}`.slice(0, 10)}`,
              playerId: pitcherId,
              eventLabel,
              playerName: pitcher?.fullName || "Pitcher",
              marketLabel: `${recommendation.recommendation} ${Number(lineNode?.line).toFixed(1)} K`,
              recommendation: recommendation.recommendation,
              offeredLine: Number(lineNode?.line),
              probability: recommendation.probability
            });
          }
        }

        const lineupResults = await Promise.all(
          games.map(async (game) => {
            const lineups = await fetchGameLineups(game?.gamePk);
            return [game, lineups];
          })
        );

        const hitterCandidates = [];
        for (const [game, lineups] of lineupResults) {
          if (!lineups?.away?.length && !lineups?.home?.length) {
            continue;
          }
          const awayPitcherId = game?.teams?.away?.probablePitcher?.id;
          const homePitcherId = game?.teams?.home?.probablePitcher?.id;
          const awayOpposingHand = pitcherHandednessById?.[homePitcherId];
          const homeOpposingHand = pitcherHandednessById?.[awayPitcherId];
          const awayTeam = game?.teams?.away?.team;
          const homeTeam = game?.teams?.home?.team;
          const eventLabel = `${getTeamAbbreviation(awayTeam)} vs ${getTeamAbbreviation(homeTeam)}`;

          for (const player of lineups?.away ?? []) {
            if (!player?.playerId) {
              continue;
            }
            hitterCandidates.push({
              key: `h-away-${game?.gamePk}-${player.playerId}`,
              gamePk: Number(game?.gamePk || 0),
              gameDate: `${game?.officialDate || `${game?.gameDate || ""}`.slice(0, 10)}`,
              eventLabel,
              playerId: player.playerId,
              playerName: player.fullName,
              opposingPitcherId: Number(homePitcherId || 0),
              opposingPitcherHandedness: awayOpposingHand
            });
          }
          for (const player of lineups?.home ?? []) {
            if (!player?.playerId) {
              continue;
            }
            hitterCandidates.push({
              key: `h-home-${game?.gamePk}-${player.playerId}`,
              gamePk: Number(game?.gamePk || 0),
              gameDate: `${game?.officialDate || `${game?.gameDate || ""}`.slice(0, 10)}`,
              eventLabel,
              playerId: player.playerId,
              playerName: player.fullName,
              opposingPitcherId: Number(awayPitcherId || 0),
              opposingPitcherHandedness: homeOpposingHand
            });
          }
        }

        const uniqueHitterIds = [...new Set(hitterCandidates.map((candidate) => candidate.playerId))];
        const hitterIdsByPitcherId = hitterCandidates.reduce((acc, candidate) => {
          const pitcherId = Number(candidate?.opposingPitcherId || 0);
          const playerId = Number(candidate?.playerId || 0);
          if (!pitcherId || !playerId) {
            return acc;
          }
          if (!acc[pitcherId]) {
            acc[pitcherId] = new Set();
          }
          acc[pitcherId].add(playerId);
          return acc;
        }, {});
        const season = selectedDate.split("-")[0];
        const [statsByPlayerId, streaksByPlayerId, vsPitcherEntries] = await Promise.all([
          fetchPlayersHittingStatsByIds(uniqueHitterIds, season),
          fetchPlayersHittingStreaksByIds(uniqueHitterIds, season),
          Promise.all(
            Object.entries(hitterIdsByPitcherId).map(async ([pitcherId, playerIdsSet]) => {
              const map = await fetchPlayersVsPitcherStatsByIds(
                [...playerIdsSet],
                Number(pitcherId)
              );
              return [pitcherId, map];
            })
          )
        ]);
        const vsPitcherStatsByPitcherId = Object.fromEntries(vsPitcherEntries);

        const hitCandidates = [];
        const onBaseCandidates = [];
        for (const candidate of hitterCandidates) {
          const stats = statsByPlayerId?.[candidate.playerId];
          const streaks = streaksByPlayerId?.[candidate.playerId];
          const vsPitcherStats =
            vsPitcherStatsByPitcherId?.[`${candidate.opposingPitcherId}`]?.[candidate.playerId] ??
            null;
          const hitProbability = estimateHitProbability(
            stats,
            streaks,
            candidate.opposingPitcherHandedness,
            vsPitcherStats
          );
          const onBaseProbability = estimateOnBaseProbability(
            stats,
            streaks,
            hitProbability,
            vsPitcherStats
          );
          hitCandidates.push({
            key: `hit-${candidate.key}`,
            gamePk: candidate.gamePk,
            gameDate: candidate.gameDate,
            playerId: candidate.playerId,
            eventLabel: candidate.eventLabel,
            playerName: candidate.playerName,
            marketLabel: "Conectar hit",
            probability: hitProbability
          });
          onBaseCandidates.push({
            key: `ob-${candidate.key}`,
            gamePk: candidate.gamePk,
            gameDate: candidate.gameDate,
            playerId: candidate.playerId,
            eventLabel: candidate.eventLabel,
            playerName: candidate.playerName,
            marketLabel: "Embasarse",
            probability: onBaseProbability
          });
        }

        const topDomain = (rows) => [...rows].sort((a, b) => b.probability - a.probability).slice(0, 2);
        const topStrikeouts = topDomain(strikeoutCandidates);
        const topHits = topDomain(hitCandidates);
        const topOnBase = topDomain(onBaseCandidates);
        if (!ignore) {
          setTopPicks({
            strikeouts: topStrikeouts,
            hits: topHits,
            onBase: topOnBase
          });

          const batterEntries = [
            ...topHits.map((pick) => ({
              entryKey: `bat-hits-${pick.gamePk}-${pick.playerId}`,
              pickDomain: "hits",
              gamePk: pick.gamePk,
              gameDate: pick.gameDate,
              eventLabel: pick.eventLabel,
              pitcherId: pick.playerId,
              pitcherName: pick.playerName,
              marketLabel: pick.marketLabel,
              offeredLine: 0,
              recommendation: "Hit",
              probability: pick.probability,
              valueLabel: "Bateadores",
              status: "pending",
              actualStrikeouts: null,
              createdAt: Date.now(),
              resolvedAt: null
            })),
            ...topOnBase.map((pick) => ({
              entryKey: `bat-onbase-${pick.gamePk}-${pick.playerId}`,
              pickDomain: "onBase",
              gamePk: pick.gamePk,
              gameDate: pick.gameDate,
              eventLabel: pick.eventLabel,
              pitcherId: pick.playerId,
              pitcherName: pick.playerName,
              marketLabel: pick.marketLabel,
              offeredLine: 0,
              recommendation: "Embasarse",
              probability: pick.probability,
              valueLabel: "Bateadores",
              status: "pending",
              actualStrikeouts: null,
              createdAt: Date.now(),
              resolvedAt: null
            }))
          ];
          const nextHistory = normalizeHistoryEntries(
            upsertBatterHistoryEntries(recommendationHistory, batterEntries)
          );
          if (buildHistorySignature(nextHistory) !== buildHistorySignature(recommendationHistory)) {
            setRecommendationHistory(nextHistory);
            writeRecommendationHistory(nextHistory);
            try {
              await upsertRecommendationHistoryToBackend(nextHistory);
            } catch (error) {
              // Keep local data if backend sync fails.
            }
          }
        }
      } catch (error) {
        if (!ignore) {
          setTopPicksError("No se pudieron calcular los top picks del dia.");
        }
      } finally {
        if (!ignore) {
          setTopPicksLoading(false);
        }
      }
    }

    loadTopPicks();
    return () => {
      ignore = true;
    };
  }, [
    isAuthenticated,
    activeMainView,
    games,
    selectedDate,
    pitcherStrikeoutLinesById,
    pitcherStrikeoutValueById,
    pitcherHandednessById,
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
      setGameWeatherByGamePk(snapshot?.gameWeatherByGamePk ?? {});
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
        const [erasMap, strikeoutsPerGameMap, strikeoutLinesMap, handednessMap, weatherByGamePk] =
          await Promise.all([
            fetchPitcherErasByIds(pitcherIds, season),
            fetchPitcherStrikeoutsPerGameByIds(pitcherIds, season),
            fetchPitcherStrikeoutLinesByGames(fetchedGames),
            fetchPitcherHandednessByIds(pitcherIds),
            fetchGameWeatherByGames(fetchedGames, { forceRefresh })
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
            pitcherHandednessById: handednessMap,
            gameWeatherByGamePk: weatherByGamePk
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
          setGameWeatherByGamePk({});
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

  const selectableDates = useMemo(
    () => buildSelectableDates(minSelectableDate, maxSelectableDate),
    [minSelectableDate, maxSelectableDate]
  );

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
        timeLabel: getMatchTimeLabel(game),
        awayAbbr: getTeamAbbreviation(game?.teams?.away?.team),
        homeAbbr: getTeamAbbreviation(game?.teams?.home?.team),
        awayLogo: getTeamLogoUrl(game?.teams?.away?.team),
        homeLogo: getTeamLogoUrl(game?.teams?.home?.team),
        awayRecord: `${game?.teams?.away?.leagueRecord?.wins ?? "-"}-${game?.teams?.away?.leagueRecord?.losses ?? "-"}`,
        homeRecord: `${game?.teams?.home?.leagueRecord?.wins ?? "-"}-${game?.teams?.home?.leagueRecord?.losses ?? "-"}`,
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
      const selectedGame = filteredGames.find((game) => String(game?.gamePk) === selectedMatchFilter);
      if (selectedGame) {
        filteredGames = [
          selectedGame,
          ...filteredGames.filter((game) => String(game?.gamePk) !== selectedMatchFilter)
        ];
      }
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
        pitcherHandednessById,
        gameWeatherByGamePk
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

  const historyDates = useMemo(() => {
    return [...new Set(recommendationHistory.map((entry) => entry?.gameDate).filter(Boolean))].sort(
      (a, b) => `${b}`.localeCompare(`${a}`)
    );
  }, [recommendationHistory]);

  const [historySelectedDate, setHistorySelectedDate] = useState("");

  useEffect(() => {
    if (!historyDates.length) {
      if (historySelectedDate) {
        setHistorySelectedDate("");
      }
      return;
    }
    if (!historySelectedDate || !historyDates.includes(historySelectedDate)) {
      setHistorySelectedDate(historyDates[0]);
    }
  }, [historyDates, historySelectedDate]);

  const selectedHistoryEntries = useMemo(() => {
    if (!historySelectedDate) {
      return [];
    }
    return recommendationHistory.filter((entry) => {
      if (entry?.gameDate !== historySelectedDate) {
        return false;
      }
      const recommendation = `${entry?.recommendation || ""}`.toLowerCase().trim();
      return recommendation !== "nula";
    });
  }, [recommendationHistory, historySelectedDate]);

  const [historyPickGroup, setHistoryPickGroup] = useState("strikeouts");

  const selectedHistoryEntriesByGroup = useMemo(() => {
    if (historyPickGroup === "batters") {
      return selectedHistoryEntries.filter(
        (entry) => {
          const domain = `${entry?.pickDomain || "strikeouts"}`.toLowerCase();
          return domain === "hits" || domain === "onbase";
        }
      );
    }
    return selectedHistoryEntries.filter(
      (entry) => `${entry?.pickDomain || "strikeouts"}`.toLowerCase() === "strikeouts"
    );
  }, [selectedHistoryEntries, historyPickGroup]);

  const selectedHistorySummary = useMemo(() => {
    const success = selectedHistoryEntriesByGroup.filter((entry) => entry.status === "success").length;
    const failed = selectedHistoryEntriesByGroup.filter((entry) => entry.status === "failed").length;
    const pending = selectedHistoryEntriesByGroup.filter((entry) => entry.status === "pending").length;
    return { success, failed, pending };
  }, [selectedHistoryEntriesByGroup]);

  const selectedHistoryDateIndex = historyDates.indexOf(historySelectedDate);

  useEffect(() => {
    if (activeMainView === "history") {
      setCanScrollTickerRight(false);
      return undefined;
    }
    const node = tickerStripRef.current;
    if (!node) {
      setCanScrollTickerRight(false);
      return undefined;
    }

    function updateTickerScrollState() {
      const remaining = node.scrollWidth - node.clientWidth - node.scrollLeft;
      setCanScrollTickerRight(remaining > 6);
    }

    updateTickerScrollState();
    node.addEventListener("scroll", updateTickerScrollState);
    window.addEventListener("resize", updateTickerScrollState);
    return () => {
      node.removeEventListener("scroll", updateTickerScrollState);
      window.removeEventListener("resize", updateTickerScrollState);
    };
  }, [activeMainView, matchFilterOptions.length, selectedDate]);

  function handleTickerScrollRight() {
    const node = tickerStripRef.current;
    if (!node) {
      return;
    }
    node.scrollBy({ left: 220, behavior: "smooth" });
  }

  if (!isAuthenticated) {
    return (
      <main className="app auth-page">
        <LoginView onLogin={handleLogin} authError={authError} loading={authLoading} />
      </main>
    );
  }

  return (
    <main className="app">
      <div className="match-ticker-header">
        <div
          ref={tickerStripRef}
          className="match-filter-strip match-filter-strip-top"
          role="tablist"
          aria-label="Filtro por match"
        >
          <div className="match-filter-tag match-date-card">
            <select
              className="match-date-select"
              value={selectedDate}
              onChange={(event) => handleDateChange(event.target.value)}
              disabled={loading}
            >
              {selectableDates.map((isoDate) => (
                <option key={isoDate} value={isoDate}>
                  {formatDateOption(isoDate)}
                </option>
              ))}
            </select>
          </div>
          {matchFilterOptions.map((match) => (
            <button
              key={match.id}
              type="button"
              className={`match-filter-tag match-ticker-card ${
                selectedMatchFilter === match.id ? "active" : ""
              }`}
              onClick={() =>
                setSelectedMatchFilter((current) => (current === match.id ? "all" : match.id))
              }
              title={match.isLive ? "En vivo" : match.isUpcoming ? "Proximo" : undefined}
            >
              <div className="match-ticker-time">{match.timeLabel}</div>
              <div className="match-ticker-row">
                {match.isLive ? <span className="match-status-dot live" aria-hidden="true" /> : null}
                {match.awayLogo ? (
                  <img className="match-team-logo" src={match.awayLogo} alt={`${match.awayAbbr} logo`} />
                ) : (
                  <span className="match-team-fallback">{match.awayAbbr.slice(0, 1)}</span>
                )}
                <strong>{match.awayAbbr}</strong>
                <small>{match.awayRecord}</small>
              </div>
              <div className="match-ticker-row">
                {match.isLive ? <span className="match-status-dot live" aria-hidden="true" /> : null}
                {match.homeLogo ? (
                  <img className="match-team-logo" src={match.homeLogo} alt={`${match.homeAbbr} logo`} />
                ) : (
                  <span className="match-team-fallback">{match.homeAbbr.slice(0, 1)}</span>
                )}
                <strong>{match.homeAbbr}</strong>
                <small>{match.homeRecord}</small>
              </div>
            </button>
          ))}
        </div>
        {canScrollTickerRight ? (
          <button
            type="button"
            className="match-ticker-arrow"
            onClick={handleTickerScrollRight}
            aria-label="Desplazar juegos hacia la derecha"
          >
            ›
          </button>
        ) : null}
      </div>
      <div className="games-view-toggle main-nav" role="tablist" aria-label="Vista principal">
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
          Bitacora de Picks
        </button>
        <button
          type="button"
          className={`games-view-button ${activeMainView === "top" ? "active" : ""}`}
          onClick={() => setActiveMainView("top")}
        >
          Top Picks del dia
        </button>
      </div>
      {activeMainView === "top" ? (
        <section className="history-panel">
          <div className="history-header-row">
            <strong>Top Picks del dia ({selectedDate})</strong>
          </div>
          <p className="history-summary">
            2 recomendaciones por dominio (Strikeouts, Hits y Embasarse) en todos los juegos del dia.
            {topPicksLoading ? " · Calculando..." : ""}
          </p>
          {topPicksError ? <p className="error">{topPicksError}</p> : null}
          {!topPicksLoading ? (
            <div className="top-picks-grid">
              {[
                { key: "strikeouts", title: "Strikeouts (Over/Under)", rows: topPicks.strikeouts },
                { key: "hits", title: "Hits", rows: topPicks.hits },
                { key: "onBase", title: "Embasarse", rows: topPicks.onBase }
              ].map((domain) => (
                <article key={domain.key} className="top-picks-card">
                  <h3>{domain.title}</h3>
                  {!domain.rows.length ? (
                    <p>Sin suficiente data para este dominio.</p>
                  ) : (
                    <ol>
                      {domain.rows.map((row) => (
                        <li key={row.key}>
                          <strong>{row.playerName}</strong>
                          <span>{row.eventLabel}</span>
                          <small>
                            {row.marketLabel} · Prob. {formatPercent(row.probability)}
                          </small>
                        </li>
                      ))}
                    </ol>
                  )}
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {activeMainView === "history" ? (
        <section className="history-panel">
          <div className="history-header-row">
            <strong>Bitacora de Picks</strong>
            {historyDates.length ? (
              <div className="history-day-pager">
                <button
                  type="button"
                  className="games-view-button"
                  onClick={() => setHistorySelectedDate(historyDates[selectedHistoryDateIndex + 1] || "")}
                  disabled={selectedHistoryDateIndex < 0 || selectedHistoryDateIndex >= historyDates.length - 1}
                >
                  Dia anterior
                </button>
                <span>
                  {formatHistoryDate(historySelectedDate)}
                  {historyDates.length > 1
                    ? ` · ${selectedHistoryDateIndex + 1}/${historyDates.length}`
                    : ""}
                </span>
                <button
                  type="button"
                  className="games-view-button"
                  onClick={() => setHistorySelectedDate(historyDates[selectedHistoryDateIndex - 1] || "")}
                  disabled={selectedHistoryDateIndex <= 0}
                >
                  Dia siguiente
                </button>
              </div>
            ) : null}
          </div>
          <p className="history-summary">
            Exitos: <strong>{selectedHistorySummary.success}</strong> · Failed:{" "}
            <strong>{selectedHistorySummary.failed}</strong> · Pendientes:{" "}
            <strong>{selectedHistorySummary.pending}</strong>
            {historyDates.length ? ` · Total dias: ${historyDates.length}` : ""}
            {historySyncLoading ? " · Actualizando..." : ""}
          </p>
          <div className="games-view-toggle" role="tablist" aria-label="Tipo de picks">
            <button
              type="button"
              className={`games-view-button ${historyPickGroup === "strikeouts" ? "active" : ""}`}
              onClick={() => setHistoryPickGroup("strikeouts")}
            >
              Picks Strikeouts
            </button>
            <button
              type="button"
              className={`games-view-button ${historyPickGroup === "batters" ? "active" : ""}`}
              onClick={() => setHistoryPickGroup("batters")}
            >
              Picks Bateadores
            </button>
          </div>
          {!recommendationHistory.length ? (
            <p>No hay resultados todavia. Se ira llenando cuando terminen juegos evaluados.</p>
          ) : (
            selectedHistoryEntriesByGroup.length ? (
              <div className="history-table-wrap">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Evento</th>
                      <th>Jugador</th>
                      <th>Pick</th>
                      <th>Recomendacion</th>
                      <th>Resultado</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedHistoryEntriesByGroup.map((entry) => (
                      <tr key={entry.entryKey}>
                        <td>{entry.eventLabel}</td>
                        <td>{entry.pitcherName}</td>
                        <td>
                          {entry.marketLabel ||
                            (`${entry?.pickDomain || "strikeouts"}`.toLowerCase() === "strikeouts"
                              ? `${Number(entry.offeredLine).toFixed(1)} K`
                              : `${entry.recommendation}`)}
                        </td>
                        <td>
                          {entry.recommendation} ({(Number(entry.probability || 0) * 100).toFixed(0)}%)
                        </td>
                        <td>
                          {entry.actualStrikeouts === null || entry.actualStrikeouts === undefined ? "-" : `${entry.actualStrikeouts}`}
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
            ) : (
              <p>No hay picks de este tipo para ese dia.</p>
            )
          )}
        </section>
      ) : null}
      {activeMainView !== "history" ? (
        <>
      <div className="games-view-toggle games-controls" role="tablist" aria-label="Filtro de juegos">
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
          gameWeatherByGamePk={gameWeatherByGamePk}
          oddsLoading={oddsLoading}
          onRefreshOddsForGame={handleRefreshOddsForGame}
        />
      )}
        </>
      ) : null}
    </main>
  );
}
