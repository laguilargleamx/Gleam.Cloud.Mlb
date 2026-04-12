import { useEffect, useMemo, useState } from "react";
import {
  evaluatePitcherStrikeoutValueByGames,
  fetchPitcherStrikeoutLinesForGame,
  fetchPitcherStrikeoutLinesByGames,
  fetchPitcherHandednessByIds,
  fetchMlbScheduleByDate,
  fetchPitcherErasByIds,
  fetchPitcherStrikeoutsPerGameByIds,
  getTeamAbbreviation
} from "./api/mlbApi";
import DateFilter from "./components/DateFilter";
import GamesList from "./components/GamesList";

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
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;

    async function loadGames() {
      setLoading(true);
      setOddsLoading(true);
      setError("");
      try {
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
          setGames(fetchedGames);
          setPitcherErasById(erasMap);
          setPitcherStrikeoutsPerGameById(strikeoutsPerGameMap);
          setPitcherStrikeoutLinesById(strikeoutLinesMap);
          setPitcherStrikeoutValueById(strikeoutValueMap);
          setPitcherHandednessById(handednessMap);
          setOddsLoading(false);
        }
      } catch (err) {
        if (!ignore) {
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
  }, [selectedDate]);

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

    setPitcherStrikeoutLinesById(nextLinesByPitcherId);
    setPitcherStrikeoutValueById((current) => {
      const next = { ...current };
      if (awayPitcherId) {
        delete next[awayPitcherId];
      }
      if (homePitcherId) {
        delete next[homePitcherId];
      }
      return { ...next, ...refreshedValueMap };
    });

    return result.debug;
  }

  return (
    <main className="app">
      <h1>MLB Schedule Viewer</h1>
      <p>{subtitle}</p>
      <DateFilter
        value={selectedDate}
        onChange={handleDateChange}
        loading={loading}
        minDate={minSelectableDate}
        maxDate={maxSelectableDate}
      />
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
    </main>
  );
}
