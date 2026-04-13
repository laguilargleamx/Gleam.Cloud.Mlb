import GameCard from "./GameCard";

export default function GamesList({
  games,
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
  if (!games.length) {
    return <p>No hay juegos para esa fecha.</p>;
  }

  return (
    <section className="games-list">
      {games.map((game) => (
        <GameCard
          key={game.gamePk}
          game={game}
          pitcherErasById={pitcherErasById}
          pitcherStrikeoutsPerGameById={pitcherStrikeoutsPerGameById}
          pitcherStrikeoutLinesById={pitcherStrikeoutLinesById}
          pitcherStrikeoutValueById={pitcherStrikeoutValueById}
          pitcherHandednessById={pitcherHandednessById}
          gameWeatherByGamePk={gameWeatherByGamePk}
          oddsLoading={oddsLoading}
          onRefreshOddsForGame={onRefreshOddsForGame}
          onUpsertHistoryEntries={onUpsertHistoryEntries}
        />
      ))}
    </section>
  );
}
