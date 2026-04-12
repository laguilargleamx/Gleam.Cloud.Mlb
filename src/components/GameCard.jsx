import { useEffect, useState } from "react";
import {
  fetchGameLineups,
  fetchPitcherGameLogs,
  fetchTeamStrikeoutsByGame,
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

function TeamRow({ side, onTeamClick }) {
  return (
    <div className="score-row">
      <div className="team-left">
        <TeamLogo team={side.team} />
        <div className="team-copy">
          <button type="button" className="team-name-link" onClick={() => onTeamClick(side.team)}>
            {side.team.name}
          </button>
          <span>
            {side.leagueRecord.wins}-{side.leagueRecord.losses}
          </span>
        </div>
      </div>
      <strong className="team-score">{side.score ?? "-"}</strong>
    </div>
  );
}

function TeamHistoryModal({ teamName, season, logs, loading, error, totalStarterStrikeouts, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-label={`Historial de ${teamName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{teamName}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
            x
          </button>
        </div>
        <p className="modal-subtitle">Temporada {season} (regular) - Rendimiento vs starter rival</p>
        {loading ? <p>Cargando historial del equipo...</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {!loading && !error ? (
          logs.length ? (
            <>
              <p className="team-history-total">
                Total SO al starter en este historial: <strong>{totalStarterStrikeouts}</strong>
              </p>
              <div className="modal-table-wrap">
                <table className="modal-table">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Vs</th>
                      <th>Starter rival</th>
                      <th>Mano</th>
                      <th>SO starter</th>
                      <th>IP starter</th>
                      <th>Picheos starter</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={`${teamName}-${log.gameDate}-${log.opponentName}`}>
                        <td>{formatGameLogDate(log.gameDate)}</td>
                        <td>{log.opponentName}</td>
                        <td>{log.opposingStarter}</td>
                        <td>{log.opposingStarterHandedness}</td>
                        <td>{log.opposingStarterStrikeOuts}</td>
                        <td>{log.opposingStarterInningsPitched}</td>
                        <td>{log.opposingStarterNumberOfPitches}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p>No hay juegos finalizados de temporada regular para este equipo.</p>
          )
        ) : null}
      </div>
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

function formatHandednessLabel(handedness) {
  if (!handedness || handedness === "-") {
    return "";
  }
  const normalized = `${handedness}`.toLowerCase();
  if (normalized.startsWith("zur")) {
    return "ZD";
  }
  if (normalized.startsWith("der")) {
    return "DR";
  }
  return `${handedness}`.slice(0, 2).toUpperCase();
}

function formatPercentFromRatio(ratio) {
  const numeric = Number(ratio);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${(numeric * 100).toFixed(0)}%`;
}

function formatSignedPercentFromRatio(ratio) {
  const numeric = Number(ratio);
  if (!Number.isFinite(numeric)) {
    return "";
  }
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${(numeric * 100).toFixed(1)}%`;
}

function formatStrikeoutValueSummary(strikeoutValue) {
  if (!strikeoutValue) {
    return "";
  }
  if (strikeoutValue?.unavailableReason) {
    return `Sin evaluacion: ${strikeoutValue.unavailableReason}`;
  }
  const projectedK = Number(strikeoutValue?.projectedStrikeouts);
  const projectedLabel = Number.isFinite(projectedK) ? projectedK.toFixed(1) : "--";
  const probabilityLabel = formatPercentFromRatio(strikeoutValue?.probabilityOver);
  const edgeLabel = Number.isFinite(Number(strikeoutValue?.edgeOver))
    ? ` (${formatSignedPercentFromRatio(strikeoutValue.edgeOver)})`
    : "";

  return `${strikeoutValue?.valueLabel ?? "Nula"}${edgeLabel} · Proy ${projectedLabel} K · P(Over) ${probabilityLabel}`;
}

function formatProjectionDelta(strikeoutValue) {
  if (!strikeoutValue || strikeoutValue?.unavailableReason) {
    return "";
  }
  const projected = Number(strikeoutValue?.projectedStrikeouts);
  const offeredLine = Number(strikeoutValue?.offeredLine);
  if (!Number.isFinite(projected) || !Number.isFinite(offeredLine)) {
    return "";
  }
  const delta = projected - offeredLine;
  const sign = delta > 0 ? "+" : "";
  return `Delta Proy-Linea: ${sign}${delta.toFixed(1)} K`;
}

function formatRecommendationNarrative(strikeoutValue) {
  if (!strikeoutValue) {
    return "";
  }
  if (strikeoutValue?.unavailableReason) {
    return `No se genera sugerencia: ${strikeoutValue.unavailableReason}.`;
  }

  const label = `${strikeoutValue?.valueLabel ?? "Nula"}`.toLowerCase();
  const projected = Number(strikeoutValue?.projectedStrikeouts);
  const line = Number(strikeoutValue?.offeredLine);
  const probabilityOver = Number(strikeoutValue?.probabilityOver);
  const edge = Number(strikeoutValue?.edgeOver);
  const sampleSize = Number(strikeoutValue?.statsSampleSize) || 0;
  const opponentSample = Number(strikeoutValue?.opponentSampleSize) || 0;
  const opponentFactor = Number(strikeoutValue?.opponentFactor);
  const workloadFactor = Number(strikeoutValue?.workloadFactor);
  const baseProjection = Number(strikeoutValue?.baseProjection);
  const lineThresholdUsed = Number(strikeoutValue?.lineThresholdUsed);
  const marketOverNoVig = Number(strikeoutValue?.impliedOverProbabilityNoVig);
  const decisionReason = `${strikeoutValue?.decisionReason || ""}`.trim();

  const projectedLabel = Number.isFinite(projected) ? projected.toFixed(1) : "--";
  const lineLabel = Number.isFinite(line) ? line.toFixed(1) : "--";
  const thresholdLabel = Number.isFinite(lineThresholdUsed) ? lineThresholdUsed.toFixed(1) : lineLabel;
  const overLabel = formatPercentFromRatio(probabilityOver);
  const edgeLabel = Number.isFinite(edge) ? formatSignedPercentFromRatio(edge) : "N/D";
  const marketLabel = Number.isFinite(marketOverNoVig) ? formatPercentFromRatio(marketOverNoVig) : "N/D";
  const baseLabel = Number.isFinite(baseProjection) ? baseProjection.toFixed(1) : "--";
  const rivalImpact = Number.isFinite(opponentFactor)
    ? opponentFactor >= 1
      ? "favorece algo mas de ponches"
      : "tiende a reducir el techo de ponches"
    : "no aporta un ajuste claro";
  const workloadImpact = Number.isFinite(workloadFactor)
    ? workloadFactor >= 1
      ? "con carga reciente estable"
      : "con carga reciente mas limitada"
    : "con carga reciente no concluyente";

  if (label === "valor") {
    return `Se sugiere valor en esta linea: Proy ${projectedLabel}K (base ${baseLabel} x carga x rival) vs linea ${lineLabel}K. Probabilidad real modelada P(Over) ${overLabel} (umbral ${thresholdLabel}) vs mercado ${marketLabel}; edge ${edgeLabel}. El rival ${rivalImpact} y el modelo usa ${sampleSize} juegos del pitcher (${opponentSample} del rival), ${workloadImpact}. ${decisionReason}`;
  }
  if (label === "sobrevalorada") {
    return `Se considera sobrevalorada esta linea: Proy ${projectedLabel}K (base ${baseLabel} x carga x rival) vs linea ${lineLabel}K. Probabilidad real modelada P(Over) ${overLabel} (umbral ${thresholdLabel}) vs mercado ${marketLabel}; edge ${edgeLabel}. El rival ${rivalImpact} y la muestra del modelo incluye ${sampleSize} juegos del pitcher (${opponentSample} del rival), ${workloadImpact}. ${decisionReason}`;
  }

  return `Linea considerada nula: Proy ${projectedLabel}K (base ${baseLabel} x carga x rival) cerca de linea ${lineLabel}K. Probabilidad real modelada P(Over) ${overLabel} (umbral ${thresholdLabel}) vs mercado ${marketLabel}; edge ${edgeLabel}. Se apoya en ${sampleSize} juegos recientes del pitcher y ${opponentSample} del rival, ${workloadImpact}. ${decisionReason}`;
}

function getRecommendationBadge(strikeoutValue) {
  if (!strikeoutValue || strikeoutValue?.unavailableReason) {
    return null;
  }

  const probabilityOver = Number(strikeoutValue?.probabilityOver);
  const safeProbabilityOver = Number.isFinite(probabilityOver) ? probabilityOver : 0.5;
  const valueLabel = `${strikeoutValue?.valueLabel ?? "Nula"}`.toLowerCase();

  if (valueLabel === "valor") {
    return {
      tone: "over",
      label: "Over",
      probability: safeProbabilityOver
    };
  }
  if (valueLabel === "sobrevalorada") {
    return {
      tone: "under",
      label: "Under",
      probability: 1 - safeProbabilityOver
    };
  }
  return {
    tone: "nula",
    label: "Nula",
    probability: safeProbabilityOver
  };
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

function getLiveInningLabel(game) {
  const inningOrdinal = game?.linescore?.currentInningOrdinal;
  const inningState = game?.linescore?.inningState || game?.linescore?.inningHalf;
  if (!inningOrdinal || !inningState) {
    return null;
  }
  const stateText = `${inningState}`.toLowerCase();
  if (stateText.includes("top")) {
    return `Top ${inningOrdinal}`;
  }
  if (stateText.includes("bottom")) {
    return `Bot ${inningOrdinal}`;
  }
  return `${inningState} ${inningOrdinal}`;
}

function LiveSituationIndicator({ linescore, large = false }) {
  const offense = linescore?.offense ?? {};
  const onFirst = Boolean(offense?.first);
  const onSecond = Boolean(offense?.second);
  const onThird = Boolean(offense?.third);
  const outs = Number(linescore?.outs ?? 0);

  return (
    <div
      className={`live-situation ${large ? "large" : ""}`}
      aria-label="Situacion en bases y outs"
    >
      <div className="base-diamond">
        <span className={`base-dot base-second ${onSecond ? "occupied" : ""}`} />
        <span className={`base-dot base-first ${onFirst ? "occupied" : ""}`} />
        <span className={`base-dot base-third ${onThird ? "occupied" : ""}`} />
      </div>
      <div className="outs-dots" aria-label={`${outs} outs`}>
        <span className={`out-dot ${outs >= 1 ? "active" : ""}`} />
        <span className={`out-dot ${outs >= 2 ? "active" : ""}`} />
        <span className={`out-dot ${outs >= 3 ? "active" : ""}`} />
      </div>
    </div>
  );
}

function PitcherBlock({
  team,
  side,
  era,
  strikeoutsPerGame,
  strikeoutLine,
  strikeoutValue,
  handedness,
  gameStarted,
  oddsLoading,
  onOpenDetails
}) {
  const pitcher = side.probablePitcher;
  const imageUrl = getPitcherImageUrl(pitcher?.id);
  const code = getTeamAbbreviation(team);
  const eraLabel = era ?? "--";
  const soPerGameLabel = formatSoPerGame(strikeoutsPerGame);
  const handednessLabel = formatHandednessLabel(handedness);
  const hasPitcher = Boolean(pitcher?.id);
  const lineUpdatedLabel = formatRelativeUpdateTime(strikeoutLine?.updatedAt);
  const valueSummary = formatStrikeoutValueSummary(strikeoutValue);
  const projectionDeltaLabel = formatProjectionDelta(strikeoutValue);
  const recommendationNarrative = formatRecommendationNarrative(strikeoutValue);
  const recommendationBadge = getRecommendationBadge(strikeoutValue);

  return (
    <button
      type="button"
      className={`pitcher-block ${hasPitcher ? "pitcher-block-clickable" : ""} ${
        recommendationBadge ? "has-recommendation-badge" : ""
      }`}
      onClick={hasPitcher ? onOpenDetails : undefined}
      disabled={!hasPitcher}
      title={hasPitcher ? "Ver juegos del pitcher en temporada" : undefined}
    >
      {recommendationBadge ? (
        <div className={`pitcher-recommendation-badge ${recommendationBadge.tone}`}>
          <strong>{recommendationBadge.label}</strong>
          <span>{formatPercentFromRatio(recommendationBadge.probability)}</span>
        </div>
      ) : null}
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
          {handednessLabel ? ` (${handednessLabel})` : ""}
        </strong>
        <small>ERA {eraLabel}</small>
        {gameStarted ? (
          <small>Juego iniciado</small>
        ) : oddsLoading ? (
          <small>Cargando odds...</small>
        ) : strikeoutLine?.line !== undefined ? (
          <>
            <small className="pitcher-line-meta">
              {strikeoutLine?.sportsbookTitle ?? "Sportsbook"}: {strikeoutLine.line} K
              {lineUpdatedLabel ? ` · Ultima actualizacion ${lineUpdatedLabel}` : ""}
            </small>
            {valueSummary || projectionDeltaLabel || recommendationNarrative ? (
              <div className="pitcher-eval-block">
                {valueSummary ? <small className="pitcher-eval-summary">{valueSummary}</small> : null}
                {projectionDeltaLabel ? (
                  <small className="pitcher-eval-delta">{projectionDeltaLabel}</small>
                ) : null}
                {recommendationNarrative ? (
                  <small className="pitcher-eval-narrative">{recommendationNarrative}</small>
                ) : null}
              </div>
            ) : null}
          </>
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

function formatRelativeUpdateTime(updatedAt) {
  const updatedAtTimestamp = Number(updatedAt);
  if (!updatedAtTimestamp || Number.isNaN(updatedAtTimestamp)) {
    return "";
  }

  const elapsedMs = Date.now() - updatedAtTimestamp;
  if (elapsedMs < 0) {
    return "justo ahora";
  }

  const minutes = Math.floor(elapsedMs / (1000 * 60));
  if (minutes < 1) {
    return "justo ahora";
  }
  if (minutes < 60) {
    return `hace ${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "hace 1 hora" : `hace ${hours} horas`;
  }

  const days = Math.floor(hours / 24);
  return days === 1 ? "hace 1 dia" : `hace ${days} dias`;
}

function PitcherGameLogModal({
  pitcherName,
  season,
  gameLogs,
  loading,
  error,
  onClose
}) {
  const [opponentTeamLogs, setOpponentTeamLogs] = useState([]);
  const [opponentTeamLoading, setOpponentTeamLoading] = useState(false);
  const [opponentTeamError, setOpponentTeamError] = useState("");
  const [selectedOpponentName, setSelectedOpponentName] = useState("");

  async function handleOpponentClick(log) {
    if (!log?.opponentId) {
      return;
    }

    setSelectedOpponentName(log.opponentName ?? "Equipo");
    setOpponentTeamLoading(true);
    setOpponentTeamError("");
    try {
      const logs = await fetchTeamStrikeoutsByGame(log.opponentId, season);
      setOpponentTeamLogs(logs);
    } catch (fetchError) {
      setOpponentTeamLogs([]);
      setOpponentTeamError("No se pudo cargar el historial de SO del equipo.");
    } finally {
      setOpponentTeamLoading(false);
    }
  }

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
        <p className="modal-subtitle">Temporada {season} (regular) - Game log de pitcheo</p>
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
                    <tr key={`${log.gamePk ?? log.gameDate}-${log.opponentName}`}>
                      <td>{formatGameLogDate(log.gameDate)}</td>
                      <td>
                        {log.opponentId ? (
                          <button
                            type="button"
                            className="opponent-link-button"
                            onClick={() => handleOpponentClick(log)}
                          >
                            {log.opponentName}
                          </button>
                        ) : (
                          log.opponentName
                        )}
                      </td>
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
        {selectedOpponentName ? (
          <section className="opponent-team-section">
            <h4>{selectedOpponentName} - Historial temporada regular</h4>
            {opponentTeamLoading ? <p>Cargando historial del equipo...</p> : null}
            {opponentTeamError ? <p className="error">{opponentTeamError}</p> : null}
            {!opponentTeamLoading && !opponentTeamError ? (
              opponentTeamLogs.length ? (
                <div className="modal-table-wrap">
                  <table className="modal-table">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Vs</th>
                        <th>Starter rival</th>
                        <th>SO starter</th>
                        <th>IP starter</th>
                        <th>Picheos starter</th>
                      </tr>
                    </thead>
                    <tbody>
                      {opponentTeamLogs.map((teamLog) => (
                        <tr key={`${selectedOpponentName}-${teamLog.gameDate}-${teamLog.opponentName}`}>
                          <td>{formatGameLogDate(teamLog.gameDate)}</td>
                          <td>{teamLog.opponentName}</td>
                          <td>{teamLog.opposingStarter}</td>
                          <td>{teamLog.opposingStarterStrikeOuts}</td>
                          <td>{teamLog.opposingStarterInningsPitched}</td>
                          <td>{teamLog.opposingStarterNumberOfPitches}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>No hay juegos finalizados para este equipo.</p>
              )
            ) : null}
          </section>
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
  pitcherStrikeoutValueById,
  pitcherHandednessById,
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
  const [teamHistoryModal, setTeamHistoryModal] = useState({
    open: false,
    teamName: "",
    logs: [],
    totalStarterStrikeouts: 0,
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
  const liveInningLabel = isGameLive(game) ? getLiveInningLabel(game) : null;
  const statusLabel = liveInningLabel
    ? `${game.status.detailedState} - ${liveInningLabel}`
    : game.status.detailedState;
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

  async function handleTeamHistoryOpen(team) {
    const teamId = team?.id;
    const teamName = team?.name ?? "Equipo";
    if (!teamId || !season) {
      return;
    }

    setTeamHistoryModal({
      open: true,
      teamName,
      logs: [],
      totalStarterStrikeouts: 0,
      loading: true,
      error: ""
    });

    try {
      const logs = await fetchTeamStrikeoutsByGame(teamId, season);
      const totalStarterStrikeouts = logs.reduce(
        (acc, log) => acc + (Number(log.opposingStarterStrikeOuts) || 0),
        0
      );
      setTeamHistoryModal({
        open: true,
        teamName,
        logs,
        totalStarterStrikeouts,
        loading: false,
        error: ""
      });
    } catch (fetchError) {
      setTeamHistoryModal({
        open: true,
        teamName,
        logs: [],
        totalStarterStrikeouts: 0,
        loading: false,
        error: "No se pudo cargar el historial del equipo."
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
        <span>{statusLabel}</span>
      </div>

      <div className="scoreboard">
        <TeamRow side={game.teams.away} onTeamClick={handleTeamHistoryOpen} />
        <TeamRow side={game.teams.home} onTeamClick={handleTeamHistoryOpen} />
        {isGameLive(game) ? (
          <div className="scoreboard-live-overlay">
            <LiveSituationIndicator linescore={game.linescore} large />
          </div>
        ) : null}
      </div>

      <p className="venue-line">{game.venue.name}</p>

      <div className="pitchers-row">
        <PitcherBlock
          team={game.teams.away.team}
          side={game.teams.away}
          era={pitcherErasById?.[awayPitcherId]}
          strikeoutsPerGame={pitcherStrikeoutsPerGameById?.[awayPitcherId]}
          strikeoutLine={pitcherStrikeoutLinesById?.[awayPitcherId]}
          strikeoutValue={pitcherStrikeoutValueById?.[awayPitcherId]}
          handedness={pitcherHandednessById?.[awayPitcherId]}
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
          strikeoutValue={pitcherStrikeoutValueById?.[homePitcherId]}
          handedness={pitcherHandednessById?.[homePitcherId]}
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
      {teamHistoryModal.open ? (
        <TeamHistoryModal
          teamName={teamHistoryModal.teamName}
          season={season}
          logs={teamHistoryModal.logs}
          totalStarterStrikeouts={teamHistoryModal.totalStarterStrikeouts}
          loading={teamHistoryModal.loading}
          error={teamHistoryModal.error}
          onClose={() => setTeamHistoryModal((current) => ({ ...current, open: false }))}
        />
      ) : null}
    </article>
  );
}
