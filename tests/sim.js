// Plays whole CPU-only games headless and checks the game's invariants after
// every turn. Games are seeded, so a failure can be replayed exactly.
//   node tests/sim.js            quick run (a few games per table)
//   GAMES=40 node tests/sim.js   longer run; also prints who won, for balance checks
"use strict";
const { loadGame } = require("./harness");

const GAMES = +process.env.GAMES || 8;
const MAX_ROUNDS = 150;
const TABLES = [
  { name: "4 Normal, classic rules", levels: ["normal", "normal", "normal", "normal"], options: {} },
  { name: "Easy vs Normal vs Hard, events + personalities", levels: ["easy", "normal", "hard"], options: { events: true, personas: true, chatter: true } },
  { name: "Hard duel, Free Parking", levels: ["hard", "hard"], options: { freeParking: true, personas: true } },
  { name: "6 players, no auctions", levels: ["normal", "hard", "easy", "normal", "hard", "easy"], options: { auction: false, events: true, personas: true } },
];

// Things that must always hold; returns a list of what's broken.
const INVARIANTS = `(() => {
  const bad = [];
  const houses = S.tiles.reduce((n, t) => n + (t.houses > 0 && t.houses < 5 ? t.houses : 0), 0);
  const hotels = S.tiles.filter((t) => t.houses === 5).length;
  if (S.housesLeft + houses !== RULES.maxHouses) bad.push("house stock " + S.housesLeft + " + " + houses + " on board");
  if (S.hotelsLeft + hotels !== RULES.maxHotels) bad.push("hotel stock " + S.hotelsLeft + " + " + hotels + " on board");
  for (const p of S.players) {
    if (!p.bankrupt && p.cash < 0) bad.push(p.name + " has " + p.cash);
    if (p.bankrupt && ownedBy(p).length) bad.push("bankrupt " + p.name + " still owns property");
  }
  for (const [g, tiles] of Object.entries(GROUP_TILES)) {
    const h = tiles.map((i) => S.tiles[i].houses);
    if (Math.max(...h) === 0) continue;
    if (!ownsSet(S.tiles[tiles[0]].owner, g)) bad.push(g + " has houses without one owner of the set");
    if (tiles.some((i) => S.tiles[i].mortgaged)) bad.push(g + " has houses and a mortgage");
    if (Math.max(...h) - Math.min(...h) > 1) bad.push(g + " built unevenly: " + h);
  }
  for (const [deck, card] of [["chance", CHANCE_JAIL_CARD], ["chest", CHEST_JAIL_CARD]]) {
    const n = S.decks[deck].filter((c) => c === card).length + S.players.reduce((k, p) => k + p.jailCards.filter((d) => d === deck).length, 0);
    if (n !== 1) bad.push(deck + " jail card exists " + n + " times");
  }
  return bad;
})()`;

async function playGame(table, seed) {
  const g = loadGame();
  g.ctx.violations = [];
  g.run(`
    S = newState({ seed: ${seed}, players: ${JSON.stringify(table.levels)}.map((level, k) => ({ name: DEFAULT_NAMES[k], cpu: true, level, token: TOKENS[k] })),
                   options: { startCash: 1500, auction: true, speed: "instant", ...${JSON.stringify(table.options)} } });
    rng = S.rng;
    save = () => { const bad = ${INVARIANTS}; if (bad.length) violations.push("round " + S.round + ": " + bad.join("; ")); };
  `);
  const finished = new Promise((resolve) => (g.ctx.showWinner = async () => resolve("winner")));
  const loop = g.run("gameLoop()");
  let over = false;
  const capped = new Promise((resolve) => {
    const tick = () => (over ? null : g.run(`S.round`) > MAX_ROUNDS ? resolve("capped") : setImmediate(tick));
    tick();
  });
  const crashed = loop.then(() => "ended", (e) => { throw e; });
  // A game that stops making progress (an endless loop, or a crash the loop swallowed) fails fast.
  let lastRound = -1, idle = 0;
  const stuck = new Promise((resolve, reject) => {
    const watch = setInterval(() => {
      if (over) return clearInterval(watch);
      const r = g.run("S.round");
      idle = r === lastRound ? idle + 1 : 0;
      lastRound = r;
      if (idle >= 20) { clearInterval(watch); over = true; reject(new Error("game stuck in round " + r)); }
    }, 500);
  });
  const how = await Promise.race([finished, capped, crashed, stuck]);
  over = true;
  g.run(`S.over = true`); // stops the game loop if it's still going
  const winner = g.run(`S.players.slice().sort((a, b) => (a.bankrupt - b.bankrupt) || netWorth(b) - netWorth(a))[0].level`);
  return { how, winner, violations: g.ctx.violations, rounds: g.run("S.round") };
}

(async () => {
  let failed = 0;
  for (const table of TABLES) {
    const wins = {};
    let rounds = 0;
    for (let k = 0; k < GAMES; k++) {
      const seed = 1000 + k * 7919 + table.levels.length;
      try {
        const r = await playGame(table, seed);
        rounds += r.rounds;
        wins[r.winner] = (wins[r.winner] || 0) + 1;
        if (r.violations.length) {
          failed++;
          console.log(`  ✗ ${table.name}, seed ${seed}: ${r.violations.slice(0, 3).join(" | ")}`);
        }
      } catch (e) {
        failed++;
        console.log(`  ✗ ${table.name}, seed ${seed} crashed: ${e.stack.split("\n").slice(0, 3).join(" ")}`);
      }
    }
    console.log(`  ${failed ? "·" : "✓"} ${table.name}: ${GAMES} games, avg ${Math.round(rounds / GAMES)} rounds${GAMES >= 20 ? `, wins ${JSON.stringify(wins)}` : ""}`);
  }
  console.log(`sim: ${failed ? `${failed} problem game(s)` : "all games clean"}`);
  if (failed) process.exitCode = 1;
})();
