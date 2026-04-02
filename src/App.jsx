import { useEffect, useMemo, useState } from "react";
import { fetchMlbScheduleByDate, fetchPitcherErasByIds } from "./api/mlbApi";
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

export default function App() {
  const todayDate = useMemo(() => getTodayIsoDate(), []);
  const minSelectableDate = useMemo(() => addDays(todayDate, -3), [todayDate]);
  const maxSelectableDate = useMemo(() => addDays(todayDate, 14), [todayDate]);
  const [selectedDate, setSelectedDate] = useState(todayDate);
  const [games, setGames] = useState([]);
  const [pitcherErasById, setPitcherErasById] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;

    async function loadGames() {
      setLoading(true);
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
        const erasMap = await fetchPitcherErasByIds(pitcherIds, season);

        if (!ignore) {
          setGames(fetchedGames);
          setPitcherErasById(erasMap);
        }
      } catch (err) {
        if (!ignore) {
          setError("No se pudo cargar la data de MLB.");
          setGames([]);
          setPitcherErasById({});
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

  function handleDateChange(nextDate) {
    if (!nextDate) {
      return;
    }
    if (nextDate < minSelectableDate || nextDate > maxSelectableDate) {
      return;
    }
    setSelectedDate(nextDate);
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
      {error ? <p className="error">{error}</p> : null}
      {loading ? (
        <p>Cargando juegos...</p>
      ) : (
        <GamesList games={games} pitcherErasById={pitcherErasById} />
      )}
    </main>
  );
}
