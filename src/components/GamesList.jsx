import GameCard from "./GameCard";

export default function GamesList({
  games,
  pitcherErasById,
  pitcherStrikeoutsPerGameById,
  pitcherStrikeoutLinesById,
  pitcherHandednessById,
  oddsLoading,
  onRefreshOddsForGame
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
          pitcherHandednessById={pitcherHandednessById}
          oddsLoading={oddsLoading}
          onRefreshOddsForGame={onRefreshOddsForGame}
        />
      ))}
    </section>
  );
}
