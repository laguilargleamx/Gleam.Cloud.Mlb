import GameCard from "./GameCard";

export default function GamesList({ games, pitcherErasById }) {
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
        />
      ))}
    </section>
  );
}
