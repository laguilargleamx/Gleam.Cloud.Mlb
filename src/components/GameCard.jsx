import { useEffect, useState } from "react";
import {
  fetchGameLineups,
  fetchPitcherGameLogs,
  fetchTeamStrikeoutsByGame,
  fetchPlayersHittingStatsByIds,
  fetchPlayersHittingStreaksByIds,
  fetchPlayersVsPitcherStatsByIds,
  fetchBullpenProbablesForGame,
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
  const sampleSize = Number(strikeoutValue?.statsSampleSize) || 0;
  const opponentSample = Number(strikeoutValue?.opponentSampleSize) || 0;
  const workloadFactor = Number(strikeoutValue?.workloadFactor);

  const projectedLabel = Number.isFinite(projected) ? projected.toFixed(1) : "--";
  const lineLabel = Number.isFinite(line) ? line.toFixed(1) : "--";
  const overLabel = formatPercentFromRatio(probabilityOver);
  const workloadImpact = Number.isFinite(workloadFactor)
    ? workloadFactor >= 1
      ? "con carga reciente estable"
      : "con carga reciente mas limitada"
    : "con carga reciente no concluyente";

  if (label === "valor") {
    return `Nuestra sugerencia es ir por Over. La linea esta en ${lineLabel}K y estimamos alrededor de ${projectedLabel}K, por eso vemos margen a favor. La confianza para Over es ${overLabel} y usamos ${sampleSize} juegos recientes del pitcher (${opponentSample} del rival), ${workloadImpact}.`;
  }
  if (label === "sobrevalorada") {
    return `Nuestra sugerencia es ir por Under. La linea (${lineLabel}K) se ve alta para este contexto, porque estimamos cerca de ${projectedLabel}K. La opcion Over se ve baja (${overLabel}), asi que Under toma ventaja. Se considera el momento del pitcher y como llega el rival.`;
  }

  return `Aqui no vemos una ventaja clara. La linea (${lineLabel}K) y la proyeccion (${projectedLabel}K) estan bastante cerca, por eso la jugada se considera neutral por ahora.`;
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

function formatGameWeatherLine(gameWeather) {
  if (!gameWeather) {
    return "";
  }
  if (gameWeather?.isIndoorLikely) {
    return "Clima estimado: techo cerrado/interior";
  }
  const summary = `${gameWeather?.summary || ""}`.trim();
  if (summary) {
    return `Clima estimado: ${summary}`;
  }
  const temp = Number(gameWeather?.temperatureC);
  const wind = Number(gameWeather?.windSpeedKph);
  if (Number.isFinite(temp) || Number.isFinite(wind)) {
    const chunks = [];
    if (Number.isFinite(temp)) {
      chunks.push(`${temp.toFixed(1)}C`);
    }
    if (Number.isFinite(wind)) {
      chunks.push(`Viento ${wind.toFixed(0)} km/h`);
    }
    return `Clima estimado: ${chunks.join(" | ")}`;
  }
  return "";
}

function formatBullpenPitcherLine(pitcher) {
  const probability = Number(pitcher?.probability || 0);
  const rest = Number(pitcher?.daysSinceLast || 0);
  const pitches = Number(pitcher?.pitchesLast || 0);
  const status = pitcher?.status || "disponible";
  const era = Number(pitcher?.era);
  const eraLabel = Number.isFinite(era) ? `ERA ${era.toFixed(2)}` : "ERA --";
  return `${eraLabel} · ${probability}% · Descanso ${rest}d · Ult ${pitches} p · ${status}`;
}

function normalizeEraValue(value, fallback = 4.15) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

function computeBullpenWeightedEra(teamBullpen) {
  const pitchers = teamBullpen?.pitchers ?? [];
  if (!pitchers.length) {
    return 4.1;
  }
  let weightedEra = 0;
  let weightTotal = 0;
  for (const pitcher of pitchers) {
    const era = normalizeEraValue(pitcher?.era, 4.1);
    const probability = Number(pitcher?.probability || 0);
    const weight = Number.isFinite(probability) && probability > 0 ? probability : 10;
    weightedEra += era * weight;
    weightTotal += weight;
  }
  if (!weightTotal) {
    return 4.1;
  }
  return weightedEra / weightTotal;
}

function computeLineupOffenseIndex(players, statsByPlayerId) {
  const rows = (players ?? [])
    .map((player) => statsByPlayerId?.[player?.playerId])
    .filter(Boolean);
  if (!rows.length) {
    return {
      offenseFactor: 1,
      avgObp: 0.315,
      avgOps: 0.72
    };
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
  const obpDelta = avgObp - 0.315;
  const opsDelta = avgOps - 0.72;
  const offenseFactor = clampProbability(1 + obpDelta * 1.6 + opsDelta * 0.65, 0.83, 1.22);
  return { offenseFactor, avgObp, avgOps };
}

function buildRunProjectionModel({
  lineups,
  lineupStatsByPlayerId,
  awayStarterEra,
  homeStarterEra,
  awayBullpen,
  homeBullpen,
  weather
}) {
  if (!lineups?.away?.length || !lineups?.home?.length) {
    return null;
  }
  const awayOffense = computeLineupOffenseIndex(lineups.away, lineupStatsByPlayerId);
  const homeOffense = computeLineupOffenseIndex(lineups.home, lineupStatsByPlayerId);

  const awayStarterFactor = clampProbability(1 + (normalizeEraValue(homeStarterEra) - 4.0) * 0.085, 0.78, 1.28);
  const homeStarterFactor = clampProbability(1 + (normalizeEraValue(awayStarterEra) - 4.0) * 0.085, 0.78, 1.28);

  const awayBullpenEra = computeBullpenWeightedEra(homeBullpen);
  const homeBullpenEra = computeBullpenWeightedEra(awayBullpen);
  const awayBullpenFactor = clampProbability(1 + (awayBullpenEra - 3.95) * 0.055, 0.84, 1.2);
  const homeBullpenFactor = clampProbability(1 + (homeBullpenEra - 3.95) * 0.055, 0.84, 1.2);

  const weatherTemp = Number(weather?.temperatureC);
  const weatherWind = Number(weather?.windSpeedKph);
  const weatherRain = Number(weather?.precipitationProbability);
  const weatherIsIndoor = Boolean(weather?.isIndoorLikely);
  let weatherFactor = 1;
  if (!weatherIsIndoor) {
    if (Number.isFinite(weatherTemp)) {
      weatherFactor += clampProbability((weatherTemp - 20) * 0.0035, -0.04, 0.05);
    }
    if (Number.isFinite(weatherWind)) {
      weatherFactor += clampProbability((weatherWind - 14) * 0.0025, -0.015, 0.035);
    }
    if (Number.isFinite(weatherRain) && weatherRain >= 55) {
      weatherFactor -= 0.02;
    }
  }
  weatherFactor = clampProbability(weatherFactor, 0.9, 1.12);

  const baseRunsPerTeam = 4.25;
  const awayRuns = clampProbability(
    baseRunsPerTeam * awayOffense.offenseFactor * awayStarterFactor * awayBullpenFactor * weatherFactor,
    1.6,
    8.4
  );
  const homeRuns = clampProbability(
    baseRunsPerTeam * homeOffense.offenseFactor * homeStarterFactor * homeBullpenFactor * weatherFactor,
    1.6,
    8.4
  );
  const totalRuns = awayRuns + homeRuns;
  const baselineLine = 8.5;
  const lean = totalRuns >= baselineLine + 0.2 ? "Over" : totalRuns <= baselineLine - 0.2 ? "Under" : "Nula";
  const edge = Math.abs(totalRuns - baselineLine);
  const confidence = lean === "Nula" ? 0.5 : clampProbability(0.51 + edge * 0.09, 0.51, 0.68);
  const awayAttackLevel =
    awayOffense.offenseFactor >= 1.06
      ? "fuerte"
      : awayOffense.offenseFactor <= 0.95
        ? "baja"
        : "normal";
  const homeAttackLevel =
    homeOffense.offenseFactor >= 1.06
      ? "fuerte"
      : homeOffense.offenseFactor <= 0.95
        ? "baja"
        : "normal";
  const weatherImpactLabel = weatherIsIndoor
    ? "bajo"
    : weatherFactor >= 1.04
      ? "favorece mas carreras"
      : weatherFactor <= 0.97
        ? "puede bajar un poco las carreras"
        : "neutral";
  const leanLabel =
    lean === "Over" ? "Nos inclinamos al Over" : lean === "Under" ? "Nos inclinamos al Under" : "Sin ventaja clara";
  const plainExplanation = `Proyectamos un juego de ${totalRuns.toFixed(1)} carreras. ${leanLabel} con confianza ${Math.round(confidence * 100)}%.`;

  const reasons = [
    `La visita llega con ataque ${awayAttackLevel}, y el local con ataque ${homeAttackLevel}.`,
    `Los abridores proyectan ${normalizeEraValue(homeStarterEra).toFixed(2)} y ${normalizeEraValue(awayStarterEra).toFixed(2)} de ERA.`,
    `El bullpen probable pinta en ${awayBullpenEra.toFixed(2)} y ${homeBullpenEra.toFixed(2)} de ERA para cerrar el juego.`,
    weather?.summary
      ? `Clima ${weatherImpactLabel}: ${weather.summary}${weatherIsIndoor ? " (techo reduce impacto)." : "."}`
      : weatherIsIndoor
        ? "Parque con techo: el clima tiene poco impacto."
        : "No hay señal fuerte de clima extremo."
  ];

  return {
    awayRuns,
    homeRuns,
    totalRuns,
    baselineLine,
    lean,
    leanLabel,
    confidence,
    plainExplanation,
    reasons
  };
}

function roundToHalf(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.round(numeric * 2) / 2;
}

function buildRunsHistoryEntries(game, model) {
  if (!game || !model) {
    return [];
  }
  const gamePk = Number(game?.gamePk || 0);
  const gameDate = `${game?.officialDate || `${game?.gameDate || ""}`.slice(0, 10)}`;
  const awayTeam = game?.teams?.away?.team;
  const homeTeam = game?.teams?.home?.team;
  const awayAbbr = getTeamAbbreviation(awayTeam);
  const homeAbbr = getTeamAbbreviation(homeTeam);
  const eventLabel = `${awayAbbr} vs ${homeAbbr}`;
  const createdAt = Date.now();
  const gameTotalLine = Number(model?.baselineLine || 8.5);
  const gameTotalLean = `${model?.lean || "Nula"}`;
  const gameTotalProbability = Number(model?.confidence || 0.5);
  const entries = [];
  if (gameTotalLean === "Over" || gameTotalLean === "Under") {
    entries.push({
      entryKey: `total-game-${gamePk}`,
      pickDomain: "game_total",
      gamePk,
      gameDate,
      eventLabel,
      pitcherId: 999001,
      pitcherName: "Total Juego",
      marketLabel: `Total juego O/U ${gameTotalLine.toFixed(1)}`,
      offeredLine: gameTotalLine,
      recommendation: gameTotalLean,
      probability: gameTotalProbability,
      valueLabel: "Totales",
      status: "pending",
      actualStrikeouts: null,
      createdAt,
      resolvedAt: null
    });
  }

  const teamRows = [
    {
      team: awayTeam,
      projectedRuns: Number(model?.awayRuns)
    },
    {
      team: homeTeam,
      projectedRuns: Number(model?.homeRuns)
    }
  ];
  for (const row of teamRows) {
    const teamId = Number(row?.team?.id || 0);
    if (!teamId || !Number.isFinite(row.projectedRuns)) {
      continue;
    }
    const teamLine = Math.max(3, roundToHalf(row.projectedRuns));
    const delta = row.projectedRuns - teamLine;
    const recommendation = delta >= 0.25 ? "Over" : delta <= -0.25 ? "Under" : "Nula";
    if (recommendation === "Nula") {
      continue;
    }
    const probability = clampProbability(0.52 + Math.abs(delta) * 0.11, 0.52, 0.69);
    entries.push({
      entryKey: `total-team-${gamePk}-${teamId}`,
      pickDomain: "team_total",
      gamePk,
      gameDate,
      eventLabel,
      pitcherId: teamId,
      pitcherName: row?.team?.name || "Equipo",
      marketLabel: `Total ${getTeamAbbreviation(row?.team)} O/U ${teamLine.toFixed(1)}`,
      offeredLine: teamLine,
      recommendation,
      probability,
      valueLabel: "Totales",
      status: "pending",
      actualStrikeouts: null,
      createdAt,
      resolvedAt: null
    });
  }
  return entries;
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

function clampProbability(value, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function formatProbabilityPercent(probability) {
  const numeric = Number(probability);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${Math.round(numeric * 100)}%`;
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

function formatVsPitcherLabel(vsPitcherStats) {
  const hits = Number(vsPitcherStats?.hits || 0);
  const atBats = Number(vsPitcherStats?.atBats || 0);
  if (atBats <= 0) {
    return "-";
  }
  return `${hits}/${atBats}`;
}

function StatsTable({
  title,
  players,
  statsByPlayerId,
  streaksByPlayerId,
  vsPitcherStatsByPlayerId,
  opposingPitcherHandedness
}) {
  const playersWithProbabilities = players.map((player) => {
    const stats = statsByPlayerId?.[player.playerId];
    const streaks = streaksByPlayerId?.[player.playerId];
    const vsPitcherStats = vsPitcherStatsByPlayerId?.[player.playerId];
    const hitProbability = estimateHitProbability(
      stats,
      streaks,
      opposingPitcherHandedness,
      vsPitcherStats
    );
    const onBaseProbability = estimateOnBaseProbability(
      stats,
      streaks,
      hitProbability,
      vsPitcherStats
    );
    return {
      ...player,
      stats,
      streaks,
      vsPitcherStats,
      hitProbability,
      onBaseProbability
    };
  });

  const topHitThreats = [...playersWithProbabilities]
    .sort((a, b) => b.hitProbability - a.hitProbability)
    .slice(0, 3);
  const topOnBaseThreats = [...playersWithProbabilities]
    .sort((a, b) => b.onBaseProbability - a.onBaseProbability)
    .slice(0, 3);

  return (
    <section className="lineup-stats-table">
      <h4>{title}</h4>
      {!players.length ? (
        <p className="lineup-empty">Lineup no publicado</p>
      ) : (
        <>
          <div className="lineup-prob-summary">
            <p>
              <strong>Top Hit:</strong>{" "}
              {topHitThreats.map((player) => `${player.fullName} (${formatProbabilityPercent(player.hitProbability)})`).join(" · ")}
            </p>
            <p>
              <strong>Top Embasarse:</strong>{" "}
              {topOnBaseThreats
                .map((player) => `${player.fullName} (${formatProbabilityPercent(player.onBaseProbability)})`)
                .join(" · ")}
            </p>
          </div>
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
                <th>VS P</th>
                <th>Hit%</th>
                <th>Emb%</th>
                <th>Fire</th>
              </tr>
            </thead>
            <tbody>
              {playersWithProbabilities.map((player) => {
                const stats = player.stats;
                const streaks = player.streaks;
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
                    <td>{formatVsPitcherLabel(player.vsPitcherStats)}</td>
                    <td>{formatProbabilityPercent(player.hitProbability)}</td>
                    <td>{formatProbabilityPercent(player.onBaseProbability)}</td>
                    <td>{isFireUp ? "🔥" : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
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
  gameWeatherByGamePk,
  oddsLoading,
  onRefreshOddsForGame,
  onUpsertHistoryEntries
}) {
  const [lineups, setLineups] = useState(null);
  const [lineupStatsByPlayerId, setLineupStatsByPlayerId] = useState({});
  const [lineupStreaksByPlayerId, setLineupStreaksByPlayerId] = useState({});
  const [activeStatsTeam, setActiveStatsTeam] = useState("away");
  const [lineupOpen, setLineupOpen] = useState(false);
  const [lineupLoading, setLineupLoading] = useState(false);
  const [lineupStatsLoading, setLineupStatsLoading] = useState(false);
  const [lineupVsPitcherStatsByTeam, setLineupVsPitcherStatsByTeam] = useState({
    away: {},
    home: {}
  });
  const [bullpenOpen, setBullpenOpen] = useState(false);
  const [bullpenLoading, setBullpenLoading] = useState(false);
  const [bullpenError, setBullpenError] = useState("");
  const [bullpenProbables, setBullpenProbables] = useState(null);
  const [runsProjectionOpen, setRunsProjectionOpen] = useState(false);
  const [runsProjectionLoading, setRunsProjectionLoading] = useState(false);
  const [runsProjectionError, setRunsProjectionError] = useState("");
  const [runsProjection, setRunsProjection] = useState(null);
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
  const weatherLine = formatGameWeatherLine(gameWeatherByGamePk?.[game?.gamePk]);
  const effectiveOddsLoading = oddsLoading || oddsRefreshLoading;
  const activeOpposingPitcherHandedness =
    activeStatsTeam === "away"
      ? pitcherHandednessById?.[homePitcherId]
      : pitcherHandednessById?.[awayPitcherId];

  async function ensureLineupDataLoaded() {
    if (lineups || lineupLoading) {
      return {
        lineups,
        statsByPlayerId: lineupStatsByPlayerId
      };
    }
    setLineupLoading(true);
    setLineupError("");
    const fetchedLineups = await fetchGameLineups(game.gamePk, game);
    if (!fetchedLineups) {
      setLineupError("No se pudo obtener el lineup de este juego.");
      setLineupLoading(false);
      return { lineups: null, statsByPlayerId: {} };
    }
    setLineups(fetchedLineups);
    const lineupPlayerIds = [...fetchedLineups.away, ...fetchedLineups.home].map(
      (player) => player.playerId
    );
    const awayLineupPlayerIds = (fetchedLineups.away ?? []).map((player) => player.playerId);
    const homeLineupPlayerIds = (fetchedLineups.home ?? []).map((player) => player.playerId);
    const awayOpposingPitcherId = Number(homePitcherId || 0);
    const homeOpposingPitcherId = Number(awayPitcherId || 0);
    const season = game.season ?? game.officialDate?.split("-")[0];

    setLineupStatsLoading(true);
    const [fetchedStats, fetchedStreaks, awayVsPitcherStats, homeVsPitcherStats] = await Promise.all([
      fetchPlayersHittingStatsByIds(lineupPlayerIds, season),
      fetchPlayersHittingStreaksByIds(lineupPlayerIds, season),
      fetchPlayersVsPitcherStatsByIds(awayLineupPlayerIds, awayOpposingPitcherId),
      fetchPlayersVsPitcherStatsByIds(homeLineupPlayerIds, homeOpposingPitcherId)
    ]);
    setLineupStatsByPlayerId(fetchedStats);
    setLineupStreaksByPlayerId(fetchedStreaks);
    setLineupVsPitcherStatsByTeam({
      away: awayVsPitcherStats ?? {},
      home: homeVsPitcherStats ?? {}
    });
    setLineupStatsLoading(false);
    setLineupLoading(false);
    return {
      lineups: fetchedLineups,
      statsByPlayerId: fetchedStats
    };
  }

  async function handleToggleLineup() {
    const nextOpen = !lineupOpen;
    setLineupOpen(nextOpen);
    if (nextOpen) {
      setActiveStatsTeam("away");
      setShowStatsInfo(false);
    }

    if (!nextOpen) {
      return;
    }
    await ensureLineupDataLoaded();
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

  async function handleToggleBullpen() {
    const nextOpen = !bullpenOpen;
    setBullpenOpen(nextOpen);
    if (!nextOpen || bullpenProbables || bullpenLoading) {
      return;
    }
    setBullpenLoading(true);
    setBullpenError("");
    const payload = await fetchBullpenProbablesForGame(game);
    if (!payload) {
      setBullpenError("No se pudo estimar bullpen probable para este juego.");
      setBullpenLoading(false);
      return;
    }
    setBullpenProbables(payload);
    setBullpenLoading(false);
  }

  async function handleToggleRunsProjection() {
    const nextOpen = !runsProjectionOpen;
    setRunsProjectionOpen(nextOpen);
    if (!nextOpen || runsProjection || runsProjectionLoading) {
      return;
    }
    setRunsProjectionLoading(true);
    setRunsProjectionError("");
    const [lineupPayload, loadedBullpen] = await Promise.all([
      ensureLineupDataLoaded(),
      bullpenProbables ? Promise.resolve(bullpenProbables) : fetchBullpenProbablesForGame(game)
    ]);
    const loadedLineups = lineupPayload?.lineups ?? null;
    const loadedStatsByPlayerId = lineupPayload?.statsByPlayerId ?? lineupStatsByPlayerId;
    const bullpenPayload = loadedBullpen || bullpenProbables;
    if (!bullpenProbables && loadedBullpen) {
      setBullpenProbables(loadedBullpen);
    }
    if (!loadedLineups || !bullpenPayload) {
      setRunsProjectionError("No hay suficientes datos para proyectar carreras.");
      setRunsProjectionLoading(false);
      return;
    }
    const awayStarterEraValue = Number(pitcherErasById?.[awayPitcherId]);
    const homeStarterEraValue = Number(pitcherErasById?.[homePitcherId]);
    if (
      !Number.isFinite(awayStarterEraValue) ||
      awayStarterEraValue <= 0 ||
      !Number.isFinite(homeStarterEraValue) ||
      homeStarterEraValue <= 0
    ) {
      setRunsProjectionError(
        "No se puede calcular Over/Under: falta ERA valida de al menos uno de los abridores."
      );
      setRunsProjectionLoading(false);
      return;
    }
    const model = buildRunProjectionModel({
      lineups: loadedLineups,
      lineupStatsByPlayerId: loadedStatsByPlayerId,
      awayStarterEra: awayStarterEraValue,
      homeStarterEra: homeStarterEraValue,
      awayBullpen: bullpenPayload?.away,
      homeBullpen: bullpenPayload?.home,
      weather: gameWeatherByGamePk?.[game?.gamePk]
    });
    if (!model) {
      setRunsProjectionError("No se pudo calcular proyeccion de carreras para este juego.");
      setRunsProjectionLoading(false);
      return;
    }
    setRunsProjection(model);
    if (onUpsertHistoryEntries) {
      const entries = buildRunsHistoryEntries(game, model);
      if (entries.length) {
        await onUpsertHistoryEntries(entries);
      }
    }
    setRunsProjectionLoading(false);
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
      {weatherLine ? <p className="weather-line">{weatherLine}</p> : null}

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
        onClick={handleToggleBullpen}
        disabled={bullpenLoading}
      >
        {bullpenLoading
          ? "Calculando bullpen probable..."
          : bullpenOpen
            ? "Ocultar bullpen probable"
            : "Ver bullpen probable"}
      </button>

      {bullpenOpen ? (
        <div className="bullpen-panel">
          {bullpenError ? <p className="error">{bullpenError}</p> : null}
          {!bullpenError && bullpenProbables ? (
            <div className="bullpen-grid">
              {[
                { key: "away", label: game.teams.away.team.name },
                { key: "home", label: game.teams.home.team.name }
              ].map((side) => (
                <section key={`${game.gamePk}-${side.key}`} className="bullpen-column">
                  <h4>{side.label}</h4>
                  {(bullpenProbables?.[side.key]?.pitchers ?? []).length ? (
                    <ul className="bullpen-list">
                      {(bullpenProbables?.[side.key]?.pitchers ?? []).map((pitcher) => (
                        <li key={`${side.key}-${pitcher.pitcherId}`} className="bullpen-row">
                          <strong>{pitcher.fullName}</strong>
                          <span>{formatBullpenPitcherLine(pitcher)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="lineup-empty">Sin suficientes datos de bullpen.</p>
                  )}
                </section>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        className="lineup-toggle"
        onClick={handleToggleRunsProjection}
        disabled={runsProjectionLoading}
      >
        {runsProjectionLoading
          ? "Calculando proyeccion O/U..."
          : runsProjectionOpen
            ? "Ocultar proyeccion de carreras"
            : "Ver proyeccion de carreras (O/U)"}
      </button>

      {runsProjectionOpen ? (
        <div className="runs-projection-panel">
          {runsProjectionError ? <p className="error">{runsProjectionError}</p> : null}
          {!runsProjectionError && runsProjection ? (
            <>
              <p className="runs-projection-main">
                <strong>Total proyectado:</strong> {runsProjection.totalRuns.toFixed(1)} carreras ·{" "}
                <strong>
                  {getTeamAbbreviation(game.teams.away.team)} {runsProjection.awayRuns.toFixed(1)}
                </strong>{" "}
                vs{" "}
                <strong>
                  {getTeamAbbreviation(game.teams.home.team)} {runsProjection.homeRuns.toFixed(1)}
                </strong>
              </p>
              <p className="runs-projection-main">
                <strong>Recomendacion rapida:</strong> {runsProjection.leanLabel} · Confianza{" "}
                {Math.round(runsProjection.confidence * 100)}%
              </p>
              <p className="runs-projection-main">
                {runsProjection.plainExplanation} (Referencia interna: {runsProjection.baselineLine.toFixed(1)}).
              </p>
              <div className="runs-projection-reasons">
                {runsProjection.reasons.map((reason, index) => (
                  <p key={`${game.gamePk}-run-reason-${index}`}>- {reason}</p>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

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
                    <strong>VS P:</strong> Historial del bateador vs pitcher rival (Hits/Turnos).
                  </p>
                  <p>
                    <strong>Hit%:</strong> Probabilidad estimada de conectar al menos un hit hoy.
                  </p>
                  <p>
                    <strong>Emb%:</strong> Probabilidad estimada de embasarse hoy (hit, base por bolas, etc.).
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
                  vsPitcherStatsByPlayerId={
                    activeStatsTeam === "away"
                      ? lineupVsPitcherStatsByTeam.away
                      : lineupVsPitcherStatsByTeam.home
                  }
                  opposingPitcherHandedness={activeOpposingPitcherHandedness}
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
