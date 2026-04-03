import { useEffect, useMemo, useState } from "react";
import {
  fetchPitcherStrikeoutLinesForGame,
  fetchPitcherStrikeoutLinesByGames,
  fetchMlbScheduleByDate,
  fetchPitcherErasByIds,
  fetchPitcherStrikeoutsPerGameByIds
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
  const abstractState = `${game?.status?.abstractGameState ?? ""}`.toLowerCase();
  const detailedState = `${game?.status?.detailedState ?? ""}`.toLowerCase();
  if (abstractState === "live" || abstractState === "final") {
    return true;
  }
  return (
    detailedState.includes("in progress") ||
    detailedState.includes("warmup") ||
    detailedState.includes("final")
  );
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
  const [oddsLoading, setOddsLoading] = useState(false);
  const [gamesViewMode, setGamesViewMode] = useState("all");
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
        const [erasMap, strikeoutsPerGameMap, strikeoutLinesMap] = await Promise.all([
          fetchPitcherErasByIds(pitcherIds, season),
          fetchPitcherStrikeoutsPerGameByIds(pitcherIds, season),
          fetchPitcherStrikeoutLinesByGames(fetchedGames)
        ]);

        if (!ignore) {
          setGames(fetchedGames);
          setPitcherErasById(erasMap);
          setPitcherStrikeoutsPerGameById(strikeoutsPerGameMap);
          setPitcherStrikeoutLinesById(strikeoutLinesMap);
          setOddsLoading(false);
        }
      } catch (err) {
        if (!ignore) {
          setError("No se pudo cargar la data de MLB.");
          setGames([]);
          setPitcherErasById({});
          setPitcherStrikeoutsPerGameById({});
          setPitcherStrikeoutLinesById({});
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

  const visibleGames = useMemo(() => {
    if (gamesViewMode === "all") {
      return games;
    }
    return games.filter((game) => !hasGameStarted(game));
  }, [games, gamesViewMode]);

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

    setPitcherStrikeoutLinesById((current) => {
      const next = { ...current };
      if (awayPitcherId) {
        delete next[awayPitcherId];
      }
      if (homePitcherId) {
        delete next[homePitcherId];
      }
      return { ...next, ...result.linesByPitcherId };
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
      {error ? <p className="error">{error}</p> : null}
      {loading ? (
        <p>Cargando juegos...</p>
      ) : (
        <GamesList
          games={visibleGames}
          pitcherErasById={pitcherErasById}
          pitcherStrikeoutsPerGameById={pitcherStrikeoutsPerGameById}
          pitcherStrikeoutLinesById={pitcherStrikeoutLinesById}
          oddsLoading={oddsLoading}
          onRefreshOddsForGame={handleRefreshOddsForGame}
        />
      )}
    </main>
  );
}
