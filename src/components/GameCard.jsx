import { useEffect, useState } from "react";
import {
  fetchGameLineups,
  fetchPitcherGameLogs,
  fetchPlayersHittingStatsByIds,
  fetchPlayersHittingStreaksByIds,
  getPitcherImageUrl,
  getTeamAbbreviation,
  getTeamLogoUrl
} from "../api/mlbApi";

function TeamLogo({ team }) {
  const [hasImageError, setHasImageError] = useState(false);
  const logoUrl = getTeamLogoUrl(team);
  const teamCode = getTeamAbbreviation(team);

  if (!logoUrl || hasImageError) {
    return <div className="team-badge">{teamCode}</div>;
  }

  return (
    <div className="team-badge">
      <img
        src={logoUrl}
        alt={`${team.name} logo`}
        loading="lazy"
        onError={() => setHasImageError(true)}
      />
    </div>
  );
}

function TeamRow({ side }) {
  return (
    <div className="score-row">
      <div className="team-left">
        <TeamLogo team={side.team} />
        <div className="team-copy">
          <strong>{side.team.name}</strong>
          <span>
            {side.leagueRecord.wins}-{side.leagueRecord.losses}
          </span>
        </div>
      </div>
      <strong className="team-score">{side.score ?? "-"}</strong>
    </div>
  );
}

function formatSoPerGame(strikeoutsPerGame) {
  if (
    strikeoutsPerGame === undefined ||
    strikeoutsPerGame === null ||
    strikeoutsPerGame === ""
  ) {
    return null;
  }
  const numeric = Number(strikeoutsPerGame);
  if (Number.isNaN(numeric)) {
    return null;
  }
  return numeric.toFixed(1);
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

function PitcherBlock({
  team,
  side,
  era,
  strikeoutsPerGame,
  strikeoutLine,
  gameStarted,
  oddsLoading,
  onOpenDetails
}) {
  const pitcher = side.probablePitcher;
  const imageUrl = getPitcherImageUrl(pitcher?.id);
  const code = getTeamAbbreviation(team);
  const eraLabel = era ?? "--";
  const soPerGameLabel = formatSoPerGame(strikeoutsPerGame);
  const hasPitcher = Boolean(pitcher?.id);

  return (
    <button
      type="button"
      className={`pitcher-block ${hasPitcher ? "pitcher-block-clickable" : ""}`}
      onClick={hasPitcher ? onOpenDetails : undefined}
      disabled={!hasPitcher}
      title={hasPitcher ? "Ver juegos del pitcher en temporada" : undefined}
    >
      <div className="pitcher-avatar">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={pitcher.fullName}
            loading="lazy"
            width="56"
            height="56"
          />
        ) : (
          <div className="no-image">Sin foto</div>
        )}
      </div>
      <div className="pitcher-text">
        <span>{code}:</span>
        <strong>
          {pitcher?.fullName ?? "Sin pitcher probable"}
          {soPerGameLabel ? ` ${soPerGameLabel} SO/J` : ""}
        </strong>
        <small>ERA {eraLabel}</small>
        {gameStarted ? (
          <small>Juego iniciado</small>
        ) : oddsLoading ? (
          <small>Cargando odds...</small>
        ) : strikeoutLine?.line !== undefined ? (
          <small>
            {strikeoutLine?.sportsbookTitle ?? "Sportsbook"}: {strikeoutLine.line} K
          </small>
        ) : (
          <small>Sin linea de sportsbook</small>
        )}
      </div>
    </button>
  );
}

function formatGameLogDate(dateString) {
  if (!dateString) {
    return "-";
  }
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return dateString;
  }
  return date.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function PitcherGameLogModal({
  pitcherName,
  season,
  gameLogs,
  loading,
  error,
  onClose
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-label={`Juegos de ${pitcherName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{pitcherName}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
            x
          </button>
        </div>
        <p className="modal-subtitle">Temporada {season} - Game log de pitcheo</p>
        {loading ? <p>Cargando juegos...</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {!loading && !error ? (
          gameLogs.length ? (
            <div className="modal-table-wrap">
              <table className="modal-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Vs</th>
                    <th>IP</th>
                    <th>SO</th>
                  </tr>
                </thead>
                <tbody>
                  {gameLogs.map((log) => (
                    <tr key={`${log.gameDate}-${log.opponentName}`}>
                      <td>{formatGameLogDate(log.gameDate)}</td>
                      <td>{log.opponentName}</td>
                      <td>{log.inningsPitched}</td>
                      <td>{log.strikeOuts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No hay juegos de temporada para mostrar.</p>
          )
        ) : null}
      </div>
    </div>
  );
}

function StatsTable({ title, players, statsByPlayerId, streaksByPlayerId }) {
  return (
    <section className="lineup-stats-table">
      <h4>{title}</h4>
      {!players.length ? (
        <p className="lineup-empty">Lineup no publicado</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Jugador</th>
              <th>H</th>
              <th>2B</th>
              <th>3B</th>
              <th>HST</th>
              <th>1BST</th>
              <th>XBHST</th>
              <th>Fire</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player) => {
              const stats = statsByPlayerId?.[player.playerId];
              const streaks = streaksByPlayerId?.[player.playerId];
              const isFireUp =
                (streaks?.hitStreak ?? 0) >= 4 || (streaks?.singleStreak ?? 0) >= 3;
              return (
                <tr key={`${title}-${player.playerId}`}>
                  <td>{player.fullName}</td>
                  <td>{stats?.hits ?? "-"}</td>
                  <td>{stats?.doubles ?? "-"}</td>
                  <td>{stats?.triples ?? "-"}</td>
                  <td>{streaks?.hitStreak ?? "-"}</td>
                  <td>{streaks?.singleStreak ?? "-"}</td>
                  <td>{streaks?.xbhStreak ?? "-"}</td>
                  <td>{isFireUp ? "🔥" : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function GameCard({
  game,
  pitcherErasById,
  pitcherStrikeoutsPerGameById,
  pitcherStrikeoutLinesById,
  oddsLoading,
  onRefreshOddsForGame
}) {
  const [lineups, setLineups] = useState(null);
  const [lineupStatsByPlayerId, setLineupStatsByPlayerId] = useState({});
  const [lineupStreaksByPlayerId, setLineupStreaksByPlayerId] = useState({});
  const [activeStatsTeam, setActiveStatsTeam] = useState("away");
  const [lineupOpen, setLineupOpen] = useState(false);
  const [lineupLoading, setLineupLoading] = useState(false);
  const [lineupStatsLoading, setLineupStatsLoading] = useState(false);
  const [lineupError, setLineupError] = useState("");
  const [showStatsInfo, setShowStatsInfo] = useState(false);
  const [pitcherModal, setPitcherModal] = useState({
    open: false,
    pitcherName: "",
    gameLogs: [],
    loading: false,
    error: ""
  });
  const [oddsRefreshLoading, setOddsRefreshLoading] = useState(false);

  const localTime = new Date(game.gameDate).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
  const awayPitcherId = game.teams.away.probablePitcher?.id;
  const homePitcherId = game.teams.home.probablePitcher?.id;
  const season = game.season ?? game.officialDate?.split("-")[0];
  const gameStarted = hasGameStarted(game);
  const effectiveOddsLoading = oddsLoading || oddsRefreshLoading;

  async function handleToggleLineup() {
    const nextOpen = !lineupOpen;
    setLineupOpen(nextOpen);
    if (nextOpen) {
      setActiveStatsTeam("away");
      setShowStatsInfo(false);
    }

    if (!nextOpen || lineups || lineupLoading) {
      return;
    }

    setLineupLoading(true);
    setLineupError("");
    const fetchedLineups = await fetchGameLineups(game.gamePk);
    if (!fetchedLineups) {
      setLineupError("No se pudo obtener el lineup de este juego.");
      setLineupLoading(false);
      return;
    }
    setLineups(fetchedLineups);
    const lineupPlayerIds = [...fetchedLineups.away, ...fetchedLineups.home].map(
      (player) => player.playerId
    );
    const season = game.season ?? game.officialDate?.split("-")[0];

    setLineupStatsLoading(true);
    const [fetchedStats, fetchedStreaks] = await Promise.all([
      fetchPlayersHittingStatsByIds(lineupPlayerIds, season),
      fetchPlayersHittingStreaksByIds(lineupPlayerIds, season)
    ]);
    setLineupStatsByPlayerId(fetchedStats);
    setLineupStreaksByPlayerId(fetchedStreaks);
    setLineupStatsLoading(false);
    setLineupLoading(false);
  }

  async function handlePitcherDetailsOpen(side) {
    const pitcherId = side?.probablePitcher?.id;
    const pitcherName = side?.probablePitcher?.fullName ?? "Pitcher";
    if (!pitcherId || !season) {
      return;
    }

    setPitcherModal({
      open: true,
      pitcherName,
      gameLogs: [],
      loading: true,
      error: ""
    });

    try {
      const logs = await fetchPitcherGameLogs(pitcherId, season);
      setPitcherModal({
        open: true,
        pitcherName,
        gameLogs: logs,
        loading: false,
        error: ""
      });
    } catch (error) {
      setPitcherModal({
        open: true,
        pitcherName,
        gameLogs: [],
        loading: false,
        error: "No se pudieron cargar los juegos del pitcher."
      });
    }
  }

  function handlePitcherDetailsClose() {
    setPitcherModal((current) => ({ ...current, open: false }));
  }

  async function handleRefreshOddsClick() {
    if (!onRefreshOddsForGame) {
      return;
    }
    setOddsRefreshLoading(true);
    await onRefreshOddsForGame(game);
    setOddsRefreshLoading(false);
  }

  useEffect(() => {
    if (!pitcherModal.open) {
      return undefined;
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        handlePitcherDetailsClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pitcherModal.open]);

  return (
    <article className="game-card">
      <div className="game-meta">
        <strong>{localTime}</strong>
        <span>{game.status.detailedState}</span>
      </div>

      <div className="scoreboard">
        <TeamRow side={game.teams.away} />
        <TeamRow side={game.teams.home} />
      </div>

      <p className="venue-line">{game.venue.name}</p>

      <div className="pitchers-row">
        <PitcherBlock
          team={game.teams.away.team}
          side={game.teams.away}
          era={pitcherErasById?.[awayPitcherId]}
          strikeoutsPerGame={pitcherStrikeoutsPerGameById?.[awayPitcherId]}
          strikeoutLine={pitcherStrikeoutLinesById?.[awayPitcherId]}
          gameStarted={gameStarted}
          oddsLoading={effectiveOddsLoading}
          onOpenDetails={() => handlePitcherDetailsOpen(game.teams.away)}
        />
        <PitcherBlock
          team={game.teams.home.team}
          side={game.teams.home}
          era={pitcherErasById?.[homePitcherId]}
          strikeoutsPerGame={pitcherStrikeoutsPerGameById?.[homePitcherId]}
          strikeoutLine={pitcherStrikeoutLinesById?.[homePitcherId]}
          gameStarted={gameStarted}
          oddsLoading={effectiveOddsLoading}
          onOpenDetails={() => handlePitcherDetailsOpen(game.teams.home)}
        />
      </div>

      <div className="odds-actions">
        <button
          type="button"
          className="lineup-toggle odds-refresh-button"
          onClick={handleRefreshOddsClick}
          disabled={oddsRefreshLoading}
        >
          {oddsRefreshLoading ? "Refrescando odds..." : "Refrescar odds (este juego)"}
        </button>
      </div>

      <button
        type="button"
        className="lineup-toggle"
        onClick={handleToggleLineup}
        disabled={lineupLoading}
      >
        {lineupLoading
          ? "Cargando lineup..."
          : lineupOpen
            ? "Ocultar lineups"
            : "Ver lineups"}
      </button>

      {lineupOpen ? (
        <div className="lineup-panel">
          {lineupError ? <p className="error">{lineupError}</p> : null}
          {!lineupError && lineups ? (
            <>
              <div className="lineup-stats-header">
                <strong>Stats temporada (bateo)</strong>
                <div className="lineup-stats-actions">
                  {lineupStatsLoading ? <span>Cargando...</span> : null}
                  <button
                    type="button"
                    className="stats-info-button"
                    onClick={() => setShowStatsInfo((current) => !current)}
                    aria-label="Ver significado de columnas"
                    title="Significado de columnas"
                  >
                    i
                  </button>
                </div>
              </div>
              {showStatsInfo ? (
                <div className="stats-info-panel">
                  <p>
                    <strong>H:</strong> Hits totales temporada.
                  </p>
                  <p>
                    <strong>2B:</strong> Doubles totales temporada.
                  </p>
                  <p>
                    <strong>3B:</strong> Triples totales temporada.
                  </p>
                  <p>
                    <strong>HST:</strong> Racha actual de juegos seguidos con hit.
                  </p>
                  <p>
                    <strong>1BST:</strong> Racha actual de juegos seguidos con al menos un
                    sencillo.
                  </p>
                  <p>
                    <strong>XBHST:</strong> Racha actual con extra-base hit (2B/3B/HR).
                  </p>
                  <p>
                    <strong>Fire:</strong> Se activa con <strong>HST &gt;= 4</strong> o{" "}
                    <strong>1BST &gt;= 3</strong>.
                  </p>
                </div>
              ) : null}
              <div className="lineup-tabs" role="tablist" aria-label="Equipo">
                <button
                  type="button"
                  role="tab"
                  className={`lineup-tab ${activeStatsTeam === "away" ? "active" : ""}`}
                  onClick={() => setActiveStatsTeam("away")}
                >
                  {game.teams.away.team.name}
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`lineup-tab ${activeStatsTeam === "home" ? "active" : ""}`}
                  onClick={() => setActiveStatsTeam("home")}
                >
                  {game.teams.home.team.name}
                </button>
              </div>
              <div className="lineup-stats-grid">
                <StatsTable
                  title={
                    activeStatsTeam === "away"
                      ? game.teams.away.team.name
                      : game.teams.home.team.name
                  }
                  players={activeStatsTeam === "away" ? lineups.away : lineups.home}
                  statsByPlayerId={lineupStatsByPlayerId}
                  streaksByPlayerId={lineupStreaksByPlayerId}
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {pitcherModal.open ? (
        <PitcherGameLogModal
          pitcherName={pitcherModal.pitcherName}
          season={season}
          gameLogs={pitcherModal.gameLogs}
          loading={pitcherModal.loading}
          error={pitcherModal.error}
          onClose={handlePitcherDetailsClose}
        />
      ) : null}
    </article>
  );
}
