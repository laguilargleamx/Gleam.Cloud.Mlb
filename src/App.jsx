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
  fetchGameScoreSummary,
  fetchMlbScheduleByDate,
  fetchPlayersHittingStatsByIds,
  fetchPlayersHittingStreaksByIds,
  fetchPlayersVsPitcherStatsByIds,
  fetchPitcherErasByIds,
  fetchPitcherStrikeoutsPerGameByIds,
  getTeamAbbreviation,
  getTeamLogoUrl,
  fetchBackendSession,
  fetchOddsApiUsageSummary,
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

function upsertGenericHistoryEntries(currentEntries, newEntries) {
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
        .filter((entry) => {
          const domain = `${entry?.pickDomain || "strikeouts"}`.toLowerCase();
          return domain === "hits" || domain === "onbase";
        })
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
  const uniquePendingGamePks = [...new Set(pendingEntries.map((entry) => Number(entry?.gamePk || 0)).filter(Boolean))];
  const gameScoreEntries = await Promise.all(
    uniquePendingGamePks.map(async (gamePk) => [gamePk, await fetchGameScoreSummary(gamePk)])
  );
  const gameScoreByGamePk = Object.fromEntries(gameScoreEntries);
  const nowMs = Date.now();
  return (entries ?? []).map((entry) => {
    if (entry?.status !== "pending") {
      return entry;
    }
    const domain = `${entry?.pickDomain || "strikeouts"}`.toLowerCase();
    const season = `${entry?.gameDate || ""}`.slice(0, 4);
    const entityId = Number(entry?.pitcherId || 0);
    if (!entityId || !season) {
      return entry;
    }

    if (domain === "strikeouts") {
      const logs = logsByPitcherSeason?.[`${entityId}-${season}`] ?? [];
      const matchingGame = logs.find((log) => Number(log?.gamePk || 0) === Number(entry?.gamePk || 0));
      if (!matchingGame) {
        return entry;
      }
      const actualStrikeouts = Number(matchingGame?.strikeOuts);
      const line = Number(entry?.offeredLine);
      if (!Number.isFinite(actualStrikeouts) || !Number.isFinite(line)) {
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

    if (domain === "game_total" || domain === "team_total") {
      const gameSummary = gameScoreByGamePk?.[Number(entry?.gamePk || 0)];
      if (!gameSummary?.isFinal) {
        return entry;
      }
      const line = Number(entry?.offeredLine);
      if (!Number.isFinite(line)) {
        return entry;
      }
      const actualRuns =
        domain === "game_total"
          ? Number(gameSummary?.totalRuns)
          : Number(gameSummary?.homeTeamId || 0) === entityId
            ? Number(gameSummary?.homeRuns)
            : Number(gameSummary?.awayTeamId || 0) === entityId
              ? Number(gameSummary?.awayRuns)
              : NaN;
      if (!Number.isFinite(actualRuns)) {
        return entry;
      }
      const isSuccess = entry?.recommendation === "Over" ? actualRuns > line : actualRuns < line;
      return {
        ...entry,
        actualStrikeouts: actualRuns,
        status: isSuccess ? "success" : "failed",
        resolvedAt: nowMs
      };
    }

    const hitterLogs = logsByHitterSeason?.[`${entityId}-${season}`] ?? [];
    const matchingHitterGame = hitterLogs.find(
      (log) => Number(log?.gamePk || 0) === Number(entry?.gamePk || 0)
    );
    if (!matchingHitterGame) {
      return entry;
    }
    const hits = Number(matchingHitterGame?.hits || 0);
    const reachesBase =
      hits + Number(matchingHitterGame?.baseOnBalls || 0) + Number(matchingHitterGame?.hitByPitch || 0);
    if (domain === "hits") {
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
      pickDomain: normalizeLegacyPickDomain(entry?.pickDomain, entry?.marketLabel, entry?.pitcherName),
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

function normalizeEraValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function computeLineupOffenseFactor(players, statsByPlayerId) {
  const rows = (players ?? [])
    .map((player) => statsByPlayerId?.[player?.playerId])
    .filter(Boolean);
  if (!rows.length) {
    return 1;
  }
  let obpSum = 0;
  let opsSum = 0;
  for (const stat of rows) {
    const obp = Number(stat?.obp);
    const ops = Number(stat?.ops);
    obpSum += Number.isFinite(obp) && obp > 0 ? obp : 0.315;
    opsSum += Number.isFinite(ops) && ops > 0 ? ops : 0.72;
  }
  const avgObp = obpSum / rows.length;
  const avgOps = opsSum / rows.length;
  const factor = 1 + (avgObp - 0.315) * 1.45 + (avgOps - 0.72) * 0.62;
  return clampProbability(factor, 0.84, 1.2);
}

function formatPercent(probability) {
  const numeric = Number(probability);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${Math.round(numeric * 100)}%`;
}

function formatOddsUsageLabel(usage) {
  if (!usage || typeof usage !== "object") {
    return "Odds API: --";
  }
  const tokenLabel = `${usage?.currentTokenLabel || ""}`.trim();
  const tokenCalls = Number(usage?.currentTokenCalls || 0);
  const remaining = Number(usage?.requestsRemaining);
  const prefix = tokenLabel ? `${tokenLabel}` : "Odds API";
  if (Number.isFinite(remaining)) {
    return `${prefix} · Restantes ${remaining} · Llamadas ${tokenCalls}`;
  }
  return `${prefix} · Llamadas ${tokenCalls}`;
}

function formatOddsUsageTooltip(usage) {
  if (!usage || typeof usage !== "object") {
    return "Sin datos de uso de The Odds API.";
  }
  const history = Array.isArray(usage?.tokenHistory) ? usage.tokenHistory : [];
  if (!history.length) {
    return "Sin historial de tokens aun.";
  }
  const rows = history
    .slice(0, 4)
    .map((row) => `${row?.tokenLabel || row?.tokenFingerprint || "token"}: ${Number(row?.totalCalls || 0)} llamadas`);
  return `Historial tokens: ${rows.join(" | ")}`;
}

function summarizeResolvedEntries(entries) {
  const wins = (entries ?? []).filter((entry) => entry?.status === "success").length;
  const losses = (entries ?? []).filter((entry) => entry?.status === "failed").length;
  const resolved = wins + losses;
  const winRate = resolved ? wins / resolved : null;
  return { wins, losses, resolved, winRate };
}

function formatWinRateLabel(summary) {
  if (!summary || !Number.isFinite(summary.winRate)) {
    return "--";
  }
  return `${(summary.winRate * 100).toFixed(1)}%`;
}

function summarizeOutcomeCounts(entries) {
  const wins = (entries ?? []).filter((entry) => entry?.status === "success").length;
  const losses = (entries ?? []).filter((entry) => entry?.status === "failed").length;
  const pending = (entries ?? []).filter((entry) => entry?.status === "pending").length;
  const total = wins + losses + pending;
  return { wins, losses, pending, total };
}

function normalizeLegacyPickDomain(rawDomain, marketLabel, pitcherName) {
  const domain = `${rawDomain || "strikeouts"}`.toLowerCase().trim();
  if (domain && domain !== "strikeouts") {
    return domain;
  }
  const market = `${marketLabel || ""}`.toLowerCase();
  const player = `${pitcherName || ""}`.toLowerCase();
  if (market.includes("total juego o/u") || player.includes("total juego")) {
    return "game_total";
  }
  if (market.includes("total ") && market.includes(" o/u ")) {
    return "team_total";
  }
  return "strikeouts";
}

function formatHistoryPickLabel(entry) {
  const domain = `${entry?.pickDomain || "strikeouts"}`.toLowerCase();
  if (domain === "game_total" || domain === "team_total") {
    return entry?.marketLabel || `Total O/U ${Number(entry?.offeredLine || 0).toFixed(1)}`;
  }
  if (domain === "strikeouts") {
    return entry?.marketLabel || `${Number(entry?.offeredLine).toFixed(1)} K`;
  }
  return entry?.marketLabel || `${entry?.recommendation || "-"}`;
}

function formatHistoryRecommendationLabel(entry) {
  const probability = (Number(entry?.probability || 0) * 100).toFixed(0);
  const domain = `${entry?.pickDomain || "strikeouts"}`.toLowerCase();
  if (domain === "game_total" || domain === "team_total") {
    return `${entry?.recommendation} vs ${Number(entry?.offeredLine || 0).toFixed(1)} (${probability}%)`;
  }
  return `${entry?.recommendation} (${probability}%)`;
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

const GAME_LOAD_STEPS_TEMPLATE = [
  { id: "cache", label: "Cache local", status: "pending", detail: "" },
  { id: "schedule", label: "Juegos MLB", status: "pending", detail: "" },
  { id: "eras", label: "ERA abridores", status: "pending", detail: "" },
  { id: "strikeouts", label: "SO por juego", status: "pending", detail: "" },
  { id: "odds", label: "Odds y lineas", status: "pending", detail: "" },
  { id: "handedness", label: "Mano pitcher", status: "pending", detail: "" },
  { id: "weather", label: "Clima", status: "pending", detail: "" },
  { id: "evaluation", label: "Evaluacion modelo K", status: "pending", detail: "" }
];

function createGameLoadSteps() {
  return GAME_LOAD_STEPS_TEMPLATE.map((step) => ({ ...step }));
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
  const [gameTotalsByGamePk, setGameTotalsByGamePk] = useState({});
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
    onBase: [],
    totals: []
  });
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historySyncLoading, setHistorySyncLoading] = useState(false);
  const [historyLoadProgress, setHistoryLoadProgress] = useState({
    status: "pending",
    detail: "Pendiente"
  });
  const [oddsApiUsage, setOddsApiUsage] = useState(null);
  const [gameLoadSteps, setGameLoadSteps] = useState(() => createGameLoadSteps());
  const [recommendationHistory, setRecommendationHistory] = useState(() =>
    normalizeHistoryEntries(readRecommendationHistory())
  );
  const [error, setError] = useState("");
  const isAuthenticated = Boolean(authSession?.authenticated && authSession?.accessToken);

  function updateGameLoadStep(stepId, status, detail = "") {
    setGameLoadSteps((current) =>
      current.map((step) => (step.id === stepId ? { ...step, status, detail } : step))
    );
  }

  function updateManyGameLoadSteps(stepIds, status, detail = "") {
    const idSet = new Set(stepIds);
    setGameLoadSteps((current) =>
      current.map((step) => (idSet.has(step.id) ? { ...step, status, detail } : step))
    );
  }

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
      setHistoryLoadProgress({ status: "pending", detail: "Inicia sesion para sincronizar historial." });
      setOddsApiUsage(null);
      return undefined;
    }
    let ignore = false;

    async function loadRecommendationHistory() {
      setHistorySyncLoading(true);
      setHistoryLoadProgress({ status: "running", detail: "Sincronizando historial..." });
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
          setHistoryLoadProgress({
            status: "success",
            detail: `Historial remoto cargado (${normalizedRemote.length}).`
          });
        } else {
          const localEntries = normalizeHistoryEntries(readRecommendationHistory());
          setRecommendationHistory(localEntries);
          setHistoryLoadProgress({
            status: "success",
            detail: `Sin data remota. Historial local (${localEntries.length}).`
          });
        }
      } catch (error) {
        if (!ignore) {
          const localEntries = normalizeHistoryEntries(readRecommendationHistory());
          setRecommendationHistory(localEntries);
          setHistoryLoadProgress({
            status: "error",
            detail: `Fallo backend. Usando historial local (${localEntries.length}).`
          });
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
    if (!isAuthenticated) {
      return undefined;
    }
    let ignore = false;

    async function refreshOddsUsageSummary() {
      try {
        const summary = await fetchOddsApiUsageSummary();
        if (!ignore) {
          setOddsApiUsage(summary || null);
        }
      } catch (error) {
        if (!ignore) {
          setOddsApiUsage(null);
        }
      }
    }

    refreshOddsUsageSummary();
    const timer = setInterval(refreshOddsUsageSummary, 60000);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [isAuthenticated]);

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
        const totalsCandidates = [];
        for (const [game, lineups] of lineupResults) {
          const gamePk = Number(game?.gamePk || 0);
          if (!gamePk || !lineups?.away?.length || !lineups?.home?.length) {
            continue;
          }
          const totalLine = Number(gameTotalsByGamePk?.[gamePk]?.line);
          if (!Number.isFinite(totalLine) || totalLine <= 0) {
            continue;
          }
          const awayPitcherEra = normalizeEraValue(
            pitcherErasById?.[game?.teams?.away?.probablePitcher?.id]
          );
          const homePitcherEra = normalizeEraValue(
            pitcherErasById?.[game?.teams?.home?.probablePitcher?.id]
          );
          if (!awayPitcherEra || !homePitcherEra) {
            continue;
          }
          const awayOffense = computeLineupOffenseFactor(lineups.away, statsByPlayerId);
          const homeOffense = computeLineupOffenseFactor(lineups.home, statsByPlayerId);
          const awayStarterFactor = clampProbability(1 + (homePitcherEra - 4) * 0.085, 0.8, 1.25);
          const homeStarterFactor = clampProbability(1 + (awayPitcherEra - 4) * 0.085, 0.8, 1.25);
          const weatherNode = gameWeatherByGamePk?.[gamePk];
          const weatherTemp = Number(weatherNode?.temperatureC);
          const weatherWind = Number(weatherNode?.windSpeedKph);
          const weatherRain = Number(weatherNode?.precipitationProbability);
          const isIndoor = Boolean(weatherNode?.isIndoorLikely);
          let weatherFactor = 1;
          if (!isIndoor) {
            if (Number.isFinite(weatherTemp)) {
              weatherFactor += clampProbability((weatherTemp - 20) * 0.0032, -0.04, 0.05);
            }
            if (Number.isFinite(weatherWind)) {
              weatherFactor += clampProbability((weatherWind - 14) * 0.0023, -0.015, 0.035);
            }
            if (Number.isFinite(weatherRain) && weatherRain >= 55) {
              weatherFactor -= 0.02;
            }
          }
          weatherFactor = clampProbability(weatherFactor, 0.9, 1.12);
          const projectedTotal =
            8.5 *
            ((awayOffense * awayStarterFactor + homeOffense * homeStarterFactor) / 2) *
            weatherFactor;
          const lean = projectedTotal >= totalLine + 0.2 ? "Over" : projectedTotal <= totalLine - 0.2 ? "Under" : "Nula";
          if (lean === "Nula") {
            continue;
          }
          const edge = Math.abs(projectedTotal - totalLine);
          const probability = clampProbability(0.51 + edge * 0.09, 0.51, 0.68);
          const awayTeam = game?.teams?.away?.team;
          const homeTeam = game?.teams?.home?.team;
          totalsCandidates.push({
            key: `totals-${gamePk}`,
            gamePk,
            gameDate: `${game?.officialDate || `${game?.gameDate || ""}`.slice(0, 10)}`,
            playerId: 999001,
            eventLabel: `${getTeamAbbreviation(awayTeam)} vs ${getTeamAbbreviation(homeTeam)}`,
            playerName: "Total Juego",
            marketLabel: `${lean} ${totalLine.toFixed(1)} (Proy ${projectedTotal.toFixed(1)})`,
            probability
          });
        }
        const topTotals = topDomain(totalsCandidates);
        if (!ignore) {
          setTopPicks({
            strikeouts: topStrikeouts,
            hits: topHits,
            onBase: topOnBase,
            totals: topTotals
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
    pitcherErasById,
    pitcherHandednessById,
    gameWeatherByGamePk,
    gameTotalsByGamePk,
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
      setGameTotalsByGamePk(snapshot?.gameTotalsByGamePk ?? {});
    }

    async function loadGames() {
      setLoading(true);
      setOddsLoading(true);
      setError("");
      setGameLoadSteps(createGameLoadSteps());
      try {
        if (forceRefresh) {
          updateGameLoadStep("cache", "skipped", "Refresh manual solicitado.");
        } else {
          updateGameLoadStep("cache", "running", "Revisando cache local...");
        }
        if (!forceRefresh) {
          const cached = readAppDataCache(selectedDate);
          if (cached) {
            if (!ignore) {
              applyLoadedData(cached);
              updateGameLoadStep("cache", "success", "Cache local aplicado.");
              updateManyGameLoadSteps(
                ["schedule", "eras", "strikeouts", "odds", "handedness", "weather", "evaluation"],
                "skipped",
                "Omitido por cache."
              );
              setOddsLoading(false);
              setLoading(false);
            }
            return;
          }
          updateGameLoadStep("cache", "success", "Sin cache valido. Consultando APIs.");
        }

        updateGameLoadStep("schedule", "running", "Consultando calendario MLB...");
        const payload = await fetchMlbScheduleByDate(selectedDate);
        const dateNode = payload.dates?.[0];
        const fetchedGames = dateNode?.games ?? [];
        updateGameLoadStep("schedule", "success", `${fetchedGames.length} juegos recibidos.`);
        const pitcherIds = fetchedGames.flatMap((game) => [
          game.teams?.away?.probablePitcher?.id,
          game.teams?.home?.probablePitcher?.id
        ]);
        const season = selectedDate.split("-")[0];
        updateManyGameLoadSteps(
          ["eras", "strikeouts", "odds", "handedness", "weather"],
          "running",
          "Consultando..."
        );
        const [
          erasResult,
          strikeoutsPerGameResult,
          oddsResult,
          handednessResult,
          weatherResult
        ] = await Promise.allSettled([
          fetchPitcherErasByIds(pitcherIds, season),
          fetchPitcherStrikeoutsPerGameByIds(pitcherIds, season),
          fetchPitcherStrikeoutLinesByGames(fetchedGames),
          fetchPitcherHandednessByIds(pitcherIds),
          fetchGameWeatherByGames(fetchedGames, { forceRefresh })
        ]);
        updateGameLoadStep(
          "eras",
          erasResult.status === "fulfilled" ? "success" : "error",
          erasResult.status === "fulfilled" ? "OK" : "Fallo (continuando)."
        );
        updateGameLoadStep(
          "strikeouts",
          strikeoutsPerGameResult.status === "fulfilled" ? "success" : "error",
          strikeoutsPerGameResult.status === "fulfilled" ? "OK" : "Fallo (continuando)."
        );
        updateGameLoadStep(
          "odds",
          oddsResult.status === "fulfilled" ? "success" : "error",
          oddsResult.status === "fulfilled" ? "OK" : "Fallo (continuando)."
        );
        updateGameLoadStep(
          "handedness",
          handednessResult.status === "fulfilled" ? "success" : "error",
          handednessResult.status === "fulfilled" ? "OK" : "Fallo (continuando)."
        );
        updateGameLoadStep(
          "weather",
          weatherResult.status === "fulfilled" ? "success" : "error",
          weatherResult.status === "fulfilled" ? "OK" : "Fallo (continuando)."
        );
        const erasMap = erasResult.status === "fulfilled" ? erasResult.value : {};
        const strikeoutsPerGameMap =
          strikeoutsPerGameResult.status === "fulfilled" ? strikeoutsPerGameResult.value : {};
        const oddsSnapshot =
          oddsResult.status === "fulfilled"
            ? oddsResult.value
            : { linesByPitcherId: {}, totalsByGamePk: {}, usageSummary: null };
        const handednessMap = handednessResult.status === "fulfilled" ? handednessResult.value : {};
        const weatherByGamePk = weatherResult.status === "fulfilled" ? weatherResult.value : {};
        const strikeoutLinesMap = oddsSnapshot?.linesByPitcherId ?? {};
        const totalsByGamePk = oddsSnapshot?.totalsByGamePk ?? {};
        if (!ignore && oddsSnapshot?.usageSummary) {
          setOddsApiUsage(oddsSnapshot.usageSummary);
        }
        let strikeoutValueMap = {};
        if (strikeoutLinesMap && Object.keys(strikeoutLinesMap).length) {
          updateGameLoadStep("evaluation", "running", "Calculando recomendaciones K...");
          strikeoutValueMap = await evaluatePitcherStrikeoutValueByGames(
            fetchedGames,
            strikeoutLinesMap,
            { season, pitcherHandednessById: handednessMap }
          );
          updateGameLoadStep("evaluation", "success", "OK");
        } else {
          updateGameLoadStep("evaluation", "skipped", "Sin lineas para evaluar.");
        }

        if (!ignore) {
          const nextSnapshot = {
            games: fetchedGames,
            pitcherErasById: erasMap,
            pitcherStrikeoutsPerGameById: strikeoutsPerGameMap,
            pitcherStrikeoutLinesById: strikeoutLinesMap,
            pitcherStrikeoutValueById: strikeoutValueMap,
            pitcherHandednessById: handednessMap,
            gameWeatherByGamePk: weatherByGamePk,
            gameTotalsByGamePk: totalsByGamePk
          };
          applyLoadedData(nextSnapshot);
          writeAppDataCache(selectedDate, nextSnapshot);
          setOddsLoading(false);
        }
      } catch (err) {
        if (!ignore) {
          setGameLoadSteps((current) =>
            current.map((step) =>
              step.status === "running"
                ? { ...step, status: "error", detail: `${err?.message || "Fallo inesperado"}` }
                : step
            )
          );
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
          setGameTotalsByGamePk({});
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
      const nextTotalsByGamePk = {
        ...gameTotalsByGamePk,
        ...(result?.totalsByGamePk ?? {})
      };
      if (result?.usageSummary) {
        setOddsApiUsage(result.usageSummary);
      }

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
      setGameTotalsByGamePk(nextTotalsByGamePk);
      writeAppDataCache(selectedDate, {
        games,
        pitcherErasById,
        pitcherStrikeoutsPerGameById,
        pitcherStrikeoutLinesById: nextLinesByPitcherId,
        pitcherStrikeoutValueById: nextStrikeoutValueById,
        pitcherHandednessById,
        gameWeatherByGamePk,
        gameTotalsByGamePk: nextTotalsByGamePk
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

  async function handleUpsertHistoryEntries(entries) {
    const normalizedIncoming = normalizeHistoryEntries(entries);
    if (!normalizedIncoming.length) {
      return;
    }
    const nextHistory = normalizeHistoryEntries(
      upsertGenericHistoryEntries(recommendationHistory, normalizedIncoming)
    );
    if (buildHistorySignature(nextHistory) === buildHistorySignature(recommendationHistory)) {
      return;
    }
    setRecommendationHistory(nextHistory);
    writeRecommendationHistory(nextHistory);
    try {
      await upsertRecommendationHistoryToBackend(nextHistory);
    } catch (error) {
      // Keep local history when backend sync fails.
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
    if (historyPickGroup === "totals") {
      return selectedHistoryEntries.filter((entry) => {
        const domain = `${entry?.pickDomain || ""}`.toLowerCase();
        return domain === "game_total" || domain === "team_total";
      });
    }
    if (historyPickGroup === "batters") {
      return selectedHistoryEntries.filter(
        (entry) => {
          const domain = `${entry?.pickDomain || "strikeouts"}`.toLowerCase();
          return domain === "hits" || domain === "onbase";
        }
      );
    }
    return selectedHistoryEntries.filter(
      (entry) => {
        const domain = `${entry?.pickDomain || "strikeouts"}`.toLowerCase();
        if (domain !== "strikeouts") {
          return false;
        }
        const market = `${entry?.marketLabel || ""}`.toLowerCase();
        const player = `${entry?.pitcherName || ""}`.toLowerCase();
        return !market.includes("total") && !player.includes("total juego");
      }
    );
  }, [selectedHistoryEntries, historyPickGroup]);

  const selectedHistorySummary = useMemo(() => {
    const success = selectedHistoryEntriesByGroup.filter((entry) => entry.status === "success").length;
    const failed = selectedHistoryEntriesByGroup.filter((entry) => entry.status === "failed").length;
    const pending = selectedHistoryEntriesByGroup.filter((entry) => entry.status === "pending").length;
    return { success, failed, pending };
  }, [selectedHistoryEntriesByGroup]);

  const dashboardSummary = useMemo(() => {
    const nonNulaHistory = recommendationHistory.filter((entry) => {
      const recommendation = `${entry?.recommendation || ""}`.toLowerCase().trim();
      return recommendation !== "nula";
    });
    const resolvedHistory = nonNulaHistory.filter(
      (entry) => entry?.status === "success" || entry?.status === "failed"
    );
    const pendingCount = nonNulaHistory.filter((entry) => entry?.status === "pending").length;

    const strikeoutsResolved = resolvedHistory.filter((entry) => {
      const domain = `${entry?.pickDomain || "strikeouts"}`.toLowerCase();
      if (domain !== "strikeouts") {
        return false;
      }
      const market = `${entry?.marketLabel || ""}`.toLowerCase();
      const player = `${entry?.pitcherName || ""}`.toLowerCase();
      return !market.includes("total") && !player.includes("total juego");
    });
    const battersResolved = resolvedHistory.filter((entry) => {
      const domain = `${entry?.pickDomain || "strikeouts"}`.toLowerCase();
      return domain === "hits" || domain === "onbase";
    });
    const totalsResolved = resolvedHistory.filter((entry) => {
      const domain = `${entry?.pickDomain || ""}`.toLowerCase();
      return domain === "game_total" || domain === "team_total";
    });
    const totalsAll = nonNulaHistory.filter((entry) => {
      const domain = `${entry?.pickDomain || ""}`.toLowerCase();
      return domain === "game_total" || domain === "team_total";
    });
    const totalsOver = totalsAll.filter(
      (entry) => `${entry?.recommendation || ""}`.toLowerCase() === "over"
    );
    const totalsUnder = totalsAll.filter(
      (entry) => `${entry?.recommendation || ""}`.toLowerCase() === "under"
    );
    const totalsGameOnly = totalsAll.filter(
      (entry) => `${entry?.pickDomain || ""}`.toLowerCase() === "game_total"
    );
    const totalsTeamOnly = totalsAll.filter(
      (entry) => `${entry?.pickDomain || ""}`.toLowerCase() === "team_total"
    );

    const todayIsoDate = getTodayIsoDate();
    const sevenDayWindowStart = addDays(todayIsoDate, -6);
    const recentResolved = resolvedHistory.filter((entry) => {
      const gameDate = `${entry?.gameDate || ""}`.slice(0, 10);
      return gameDate && gameDate >= sevenDayWindowStart && gameDate <= todayIsoDate;
    });
    const byDateMap = new Map();
    for (const entry of resolvedHistory) {
      const dateKey = `${entry?.gameDate || ""}`.slice(0, 10);
      if (!dateKey) {
        continue;
      }
      const node = byDateMap.get(dateKey) ?? { date: dateKey, wins: 0, losses: 0, resolved: 0, winRate: null };
      if (entry?.status === "success") {
        node.wins += 1;
      }
      if (entry?.status === "failed") {
        node.losses += 1;
      }
      node.resolved = node.wins + node.losses;
      node.winRate = node.resolved ? node.wins / node.resolved : null;
      byDateMap.set(dateKey, node);
    }
    const dailyTrend = [...byDateMap.values()]
      .sort((a, b) => `${a.date}`.localeCompare(`${b.date}`))
      .slice(-10);

    const byDomain = [
      { key: "strikeouts", label: "Strikeouts", ...summarizeResolvedEntries(strikeoutsResolved) },
      { key: "batters", label: "Bateadores", ...summarizeResolvedEntries(battersResolved) },
      { key: "totals", label: "Totales O/U", ...summarizeResolvedEntries(totalsResolved) }
    ];

    return {
      overall: summarizeResolvedEntries(resolvedHistory),
      recent7Days: summarizeResolvedEntries(recentResolved),
      pendingCount,
      byDomain,
      totals: {
        over: summarizeOutcomeCounts(totalsOver),
        under: summarizeOutcomeCounts(totalsUnder),
        gameOnly: summarizeOutcomeCounts(totalsGameOnly),
        teamOnly: summarizeOutcomeCounts(totalsTeamOnly)
      },
      chart: {
        overallOutcome: summarizeOutcomeCounts(nonNulaHistory),
        byDomain,
        dailyTrend
      }
    };
  }, [recommendationHistory]);

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
        <button
          type="button"
          className={`games-view-button ${activeMainView === "dashboard" ? "active" : ""}`}
          onClick={() => setActiveMainView("dashboard")}
        >
          Dashboard
        </button>
      </div>
      {activeMainView === "top" ? (
        <section className="history-panel">
          <div className="history-header-row">
            <strong>Top Picks del dia ({selectedDate})</strong>
          </div>
          <p className="history-summary">
            2 recomendaciones por dominio (Strikeouts, Hits, Embasarse y Totales O/U) en todos los juegos del dia.
            {topPicksLoading ? " · Calculando..." : ""}
          </p>
          {topPicksError ? <p className="error">{topPicksError}</p> : null}
          {!topPicksLoading ? (
            <div className="top-picks-grid">
              {[
                { key: "strikeouts", title: "Strikeouts (Over/Under)", rows: topPicks.strikeouts, icon: "K" },
                { key: "hits", title: "Hits", rows: topPicks.hits, icon: "H" },
                { key: "onBase", title: "Embasarse", rows: topPicks.onBase, icon: "OB" },
                { key: "totals", title: "Totales O/U", rows: topPicks.totals, icon: "O/U" }
              ].map((domain) => (
                <article key={domain.key} className={`top-picks-card domain-${domain.key}`}>
                  <div className="top-picks-card-head">
                    <h3>{domain.title}</h3>
                    <span className="top-picks-domain-icon">{domain.icon}</span>
                  </div>
                  {!domain.rows.length ? (
                    <p>Sin suficiente data para este dominio.</p>
                  ) : (
                    <div className="top-picks-list">
                      {domain.rows.map((row) => (
                        <article key={row.key} className="top-pick-item">
                          <div className="top-pick-item-main">
                            <strong>{row.playerName}</strong>
                            <span>{row.eventLabel}</span>
                            <small>{row.marketLabel}</small>
                          </div>
                          <span className="top-pick-prob">Prob. {formatPercent(row.probability)}</span>
                        </article>
                      ))}
                    </div>
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
            <button
              type="button"
              className={`games-view-button ${historyPickGroup === "totals" ? "active" : ""}`}
              onClick={() => setHistoryPickGroup("totals")}
            >
              Totales O/U
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
                          {formatHistoryPickLabel(entry)}
                        </td>
                        <td>
                          {formatHistoryRecommendationLabel(entry)}
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
      {activeMainView === "dashboard" ? (
        <section className="history-panel dashboard-panel">
          <div className="history-header-row">
            <strong>Dashboard de rendimiento</strong>
          </div>
          <p className="history-summary">
            Win rate global y por dominio basado en picks resueltos (Exito/Failed).
          </p>
          <div className="dashboard-metrics-grid">
            <article className="dashboard-metric-card">
              <span className="dashboard-metric-label">Win rate general</span>
              <strong className="dashboard-metric-value">{formatWinRateLabel(dashboardSummary.overall)}</strong>
              <small>
                {dashboardSummary.overall.wins} Exitos · {dashboardSummary.overall.losses} Failed ·{" "}
                {dashboardSummary.overall.resolved} resueltos
              </small>
            </article>
            <article className="dashboard-metric-card">
              <span className="dashboard-metric-label">Ultimos 7 dias</span>
              <strong className="dashboard-metric-value">{formatWinRateLabel(dashboardSummary.recent7Days)}</strong>
              <small>
                {dashboardSummary.recent7Days.wins} Exitos · {dashboardSummary.recent7Days.losses} Failed ·{" "}
                {dashboardSummary.recent7Days.resolved} resueltos
              </small>
            </article>
            <article className="dashboard-metric-card">
              <span className="dashboard-metric-label">Picks pendientes</span>
              <strong className="dashboard-metric-value">{dashboardSummary.pendingCount}</strong>
              <small>Se actualizaran automaticamente cuando termine el juego.</small>
            </article>
          </div>
          <div className="dashboard-breakdown">
            {dashboardSummary.byDomain.map((domain) => (
              <article key={domain.key} className="dashboard-breakdown-row">
                <strong>{domain.label}</strong>
                <span>{formatWinRateLabel(domain)}</span>
                <small>
                  {domain.wins} Exitos · {domain.losses} Failed · {domain.resolved} resueltos
                </small>
              </article>
            ))}
          </div>
          <div className="dashboard-chart-block">
            <h3>Grafica general</h3>
            <div className="dashboard-stacked-bar">
              <span
                className="segment wins"
                style={{
                  width: `${dashboardSummary.chart.overallOutcome.total
                    ? (dashboardSummary.chart.overallOutcome.wins /
                        dashboardSummary.chart.overallOutcome.total) *
                      100
                    : 0}%`
                }}
                title={`Exitos: ${dashboardSummary.chart.overallOutcome.wins}`}
              />
              <span
                className="segment losses"
                style={{
                  width: `${dashboardSummary.chart.overallOutcome.total
                    ? (dashboardSummary.chart.overallOutcome.losses /
                        dashboardSummary.chart.overallOutcome.total) *
                      100
                    : 0}%`
                }}
                title={`Failed: ${dashboardSummary.chart.overallOutcome.losses}`}
              />
              <span
                className="segment pending"
                style={{
                  width: `${dashboardSummary.chart.overallOutcome.total
                    ? (dashboardSummary.chart.overallOutcome.pending /
                        dashboardSummary.chart.overallOutcome.total) *
                      100
                    : 0}%`
                }}
                title={`Pendientes: ${dashboardSummary.chart.overallOutcome.pending}`}
              />
            </div>
            <p className="dashboard-chart-legend">
              Exitos: {dashboardSummary.chart.overallOutcome.wins} · Failed:{" "}
              {dashboardSummary.chart.overallOutcome.losses} · Pendientes:{" "}
              {dashboardSummary.chart.overallOutcome.pending}
            </p>
            <div className="dashboard-domain-bars">
              {dashboardSummary.chart.byDomain.map((domain) => (
                <article key={domain.key} className="dashboard-domain-bar-row">
                  <strong>{domain.label}</strong>
                  <div className="dashboard-domain-bar-track">
                    <span
                      className="dashboard-domain-bar-fill"
                      style={{ width: `${Number.isFinite(domain.winRate) ? domain.winRate * 100 : 0}%` }}
                    />
                  </div>
                  <small>{formatWinRateLabel(domain)}</small>
                </article>
              ))}
            </div>
            <div className="dashboard-trend-chart">
              {dashboardSummary.chart.dailyTrend.length ? (
                dashboardSummary.chart.dailyTrend.map((point) => (
                  <article key={point.date} className="dashboard-trend-bar-wrap" title={`${point.date} · ${formatWinRateLabel(point)}`}>
                    <div
                      className="dashboard-trend-bar"
                      style={{ height: `${Math.max(8, (Number.isFinite(point.winRate) ? point.winRate : 0) * 100)}%` }}
                    />
                    <small>{point.date.slice(5)}</small>
                  </article>
                ))
              ) : (
                <p className="dashboard-empty">No hay suficientes picks resueltos para tendencia diaria.</p>
              )}
            </div>
          </div>
          <div className="dashboard-totals-section">
            <h3>Totales Over/Under de carreras</h3>
            <div className="dashboard-totals-grid">
              <article className="dashboard-totals-card over">
                <strong>Over</strong>
                <span>{dashboardSummary.totals.over.total} picks</span>
                <small>
                  Exitos: {dashboardSummary.totals.over.wins} · Failed: {dashboardSummary.totals.over.losses} · Pend:{" "}
                  {dashboardSummary.totals.over.pending}
                </small>
              </article>
              <article className="dashboard-totals-card under">
                <strong>Under</strong>
                <span>{dashboardSummary.totals.under.total} picks</span>
                <small>
                  Exitos: {dashboardSummary.totals.under.wins} · Failed: {dashboardSummary.totals.under.losses} · Pend:{" "}
                  {dashboardSummary.totals.under.pending}
                </small>
              </article>
              <article className="dashboard-totals-card neutral">
                <strong>Total Juego O/U</strong>
                <span>{dashboardSummary.totals.gameOnly.total} picks</span>
                <small>
                  Exitos: {dashboardSummary.totals.gameOnly.wins} · Failed: {dashboardSummary.totals.gameOnly.losses} · Pend:{" "}
                  {dashboardSummary.totals.gameOnly.pending}
                </small>
              </article>
              <article className="dashboard-totals-card neutral">
                <strong>Total Equipo O/U</strong>
                <span>{dashboardSummary.totals.teamOnly.total} picks</span>
                <small>
                  Exitos: {dashboardSummary.totals.teamOnly.wins} · Failed: {dashboardSummary.totals.teamOnly.losses} · Pend:{" "}
                  {dashboardSummary.totals.teamOnly.pending}
                </small>
              </article>
            </div>
          </div>
        </section>
      ) : null}
      {activeMainView === "games" || activeMainView === "top" ? (
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
        <div className="odds-usage-counter" title={formatOddsUsageTooltip(oddsApiUsage)}>
          {formatOddsUsageLabel(oddsApiUsage)}
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {loading ? (
        <section className="load-progress-panel">
          <strong>Progreso de carga</strong>
          <div className="load-progress-list">
            <div className="load-progress-row">
              <span className={`load-progress-state ${historyLoadProgress.status}`}>
                {historyLoadProgress.status === "success"
                  ? "OK"
                  : historyLoadProgress.status === "running"
                    ? "..."
                    : historyLoadProgress.status === "error"
                      ? "ERR"
                      : "PEND"}
              </span>
              <span className="load-progress-label">Historial</span>
              <small>{historyLoadProgress.detail || "-"}</small>
            </div>
            {gameLoadSteps.map((step) => (
              <div key={step.id} className="load-progress-row">
                <span className={`load-progress-state ${step.status}`}>
                  {step.status === "success"
                    ? "OK"
                    : step.status === "running"
                      ? "..."
                      : step.status === "error"
                        ? "ERR"
                        : step.status === "skipped"
                          ? "SKIP"
                          : "PEND"}
                </span>
                <span className="load-progress-label">{step.label}</span>
                <small>{step.detail || "-"}</small>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <GamesList
          games={visibleGames}
          pitcherErasById={pitcherErasById}
          pitcherStrikeoutsPerGameById={pitcherStrikeoutsPerGameById}
          pitcherStrikeoutLinesById={pitcherStrikeoutLinesById}
          pitcherStrikeoutValueById={pitcherStrikeoutValueById}
          pitcherHandednessById={pitcherHandednessById}
          gameWeatherByGamePk={gameWeatherByGamePk}
          gameTotalsByGamePk={gameTotalsByGamePk}
          oddsLoading={oddsLoading}
          onRefreshOddsForGame={handleRefreshOddsForGame}
          onUpsertHistoryEntries={handleUpsertHistoryEntries}
        />
      )}
        </>
      ) : null}
    </main>
  );
}
