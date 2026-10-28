// Focused checks of rules and CPU decisions. Run with: node tests/unit.js
"use strict";
const { loadGame, runner, assert } = require("./harness");

const { check, done } = runner("unit");
const g = loadGame();
const run = g.run;
// Runs a check's code in its own scope inside the game; the code returns the verdict.
const ok = (code) => run(`(() => {${code}})()`);

// A fresh game with `n` CPUs (or humans where `cpus[k]` is false) and given owners.
run(`
  function setup(n, { cash, own = {}, cpus, options = {} } = {}) {
    S = newState({
      players: Array.from({ length: n }, (_, k) => ({ name: "P" + k, cpu: cpus ? cpus[k] : true, level: "normal", token: TOKENS[k] })),
      options: { startCash: 1500, speed: "instant", ...options },
    });
    if (cash) S.players.forEach((p, k) => (p.cash = cash[k]));
    for (const [pid, names] of Object.entries(own)) for (const nm of names) S.tiles[tile(nm)].owner = +pid;
    return S;
  }
  function tile(name) { const i = BOARD.findIndex((b) => b.name.startsWith(name)); if (i < 0) throw new Error("no tile " + name); return i; }
`);

(async () => {
  console.log("CPU trading");
  await check("won't hand a rival a colour set for a cheap piece of its own", () => ok(`
    setup(3, { cash: [800, 800, 800], own: { 0: ["Whitechapel", "Mayfair"], 1: ["Old Kent", "Park Lane"] } });
    return !cpuAccepts(P(0), P(1), [tile("Mayfair")], [tile("Old Kent")], 0);`));
  await check("in a duel, won't sell the last orange for £250 (wants £500+)", () => ok(`
    setup(2, { cash: [1000, 1000], own: { 0: ["Bow", "Marlborough"], 1: ["Vine"] }, cpus: [false, true] });
    return !cpuAccepts(P(1), P(0), [tile("Vine")], [], 250) && !cpuAccepts(P(1), P(0), [tile("Vine")], [], 500);`));
  await check("won't spend its last £190 on a property", () => ok(`
    setup(2, { cash: [1000, 200], own: { 0: ["Strand"] }, cpus: [false, true] });
    return !cpuAccepts(P(1), P(0), [], [tile("Strand")], -190);`));
  await check("won't sell a whole colour set it owns", () => ok(`
    setup(2, { cash: [1500, 1500], own: { 0: ["Bow", "Marlborough", "Vine"], 1: ["Electric"] } });
    cpuTryTrade(P(0));
    return [16, 18, 19].every((i) => S.tiles[i].owner === 0);`));
  await check("in a 4-player game, won't sell a set's last piece cheaply", () => ok(`
    setup(4, { cash: [1500, 1500, 1500, 1500], own: { 0: ["Bow", "Marlborough"], 1: ["Vine"] } });
    return !cpuAccepts(P(1), P(0), [tile("Vine")], [], 300) && !cpuAccepts(P(1), P(0), [tile("Vine")], [], 450);`));
  await check("Hard CPUs don't bid each other far over list at auction", async () => {
    run(`setup(4, { cash: [1500, 1500, 1500, 1500], cpus: [true, true, true, true] }); S.players.forEach((p) => (p.level = "hard"));`);
    await run(`auction(39, P(0))`);
    const price = run(`S.players.reduce((t, p) => t + (1500 - p.cash), 0)`);
    assert(run(`S.tiles[39].owner !== null`), "nobody bought Mayfair");
    return price <= 500;
  });
  await check("...but will go higher to complete or block a set", () => ok(`
    setup(4, { cpus: [true, true, true, true], own: { 1: ["Park Lane"] } });
    return auctionCap(P(0), 39) === 800 && auctionCap(P(0), 1) === 75;`));
  await check("won't overpay for a station you're flipping", () => ok(`
    setup(4, { cpus: [false, true, true, true], own: { 0: ["King's Cross"], 1: ["Marylebone"] } });
    P(1).persona = "collector";
    return cpuAccepts(P(1), P(0), [], [5], -200) && !cpuAccepts(P(1), P(0), [], [5], -250);`));
  await check("...even with something of theirs slipped into the deal", () => ok(`
    setup(4, { cpus: [false, true, true, true], own: { 0: ["Whitehall", "Northumberland"], 1: ["Pall Mall", "Trafalgar"] } });
    P(1).level = "hard";
    const pinks = [tile("Whitehall"), tile("Northumberland")];
    return !cpuAccepts(P(1), P(0), [tile("Trafalgar")], pinks, -420) && purchaseCap(P(1), pinks) === 600;`));
  await check("won't pay to swap sides of a set it can't complete", () => ok(`
    setup(4, { cpus: [false, true, true, true], own: { 0: ["Leicester", "Coventry"], 1: ["Piccadilly"] } });
    P(1).level = "hard"; P(1).persona = "dealmaker";
    return !cpuAccepts(P(1), P(0), [tile("Piccadilly")], [tile("Leicester"), tile("Coventry")], -320);`));
  await check("a deal where the CPU adds a Get Out of Jail Free card and cash is judged without errors", () => ok(`
    setup(4, { cpus: [false, true, true, true], own: { 0: ["King's Cross"], 1: ["Marylebone", "Fenchurch", "Liverpool"] } });
    P(1).jailCards = ["chance"];
    cpuAccepts(P(1), P(0), ["jail:chance"], [5], -100);
    return typeof overpays(P(1), ["jail:chance"], [5], -100) === "boolean";`));
  await check("the brown set isn't sold cheaply", () => ok(`
    setup(4, { cpus: [false, true, true, true], own: { 0: ["Old Kent"], 1: ["Whitechapel"] } });
    P(1).level = "hard";
    return !cpuAccepts(P(1), P(0), [tile("Whitechapel")], [], 250);`));
  await check("Hard CPUs at a table with a person mind the person most, and each other less", () => ok(`
    setup(4, { cpus: [false, true, true, true] });
    S.players.forEach((p) => (p.level = "hard"));
    const vsPerson = rivalWeight(P(1), P(0)), vsCpu = rivalWeight(P(1), P(2));
    setup(4);
    S.players.forEach((p) => (p.level = "hard"));
    return vsPerson > rivalWeight(P(1), P(0)) && vsCpu < rivalWeight(P(1), P(2));`));
  await check("a counter-offer is a deal the CPU then accepts", () => ok(`
    setup(2, { cash: [1500, 1500], own: { 0: ["Bow", "Marlborough", "Strand"], 1: ["Vine"] }, cpus: [false, true] });
    const c = cpuCounterOffer(P(1), P(0), [], [tile("Vine")], 100);
    return c && cpuAccepts(P(1), P(0), c.get, c.give, c.cash);`));
  await check("Get Out of Jail Free cards trade and move between players", () => ok(`
    setup(2, { cpus: [false, true] });
    P(0).jailCards = ["chance"]; P(1).jailCards = ["chest"];
    const sells = cpuAccepts(P(1), P(0), ["jail:chest"], [], 200), free = cpuAccepts(P(1), P(0), ["jail:chest"], [], 0);
    transferItems(["jail:chance"], P(0), P(1));
    return sells && !free && P(0).jailCards.length === 0 && P(1).jailCards.join() === "chest,chance";`));

  console.log("Building");
  await check("explains why you can't build", () => ok(`
    setup(2, { cpus: [false, true], own: { 0: ["Old Kent"] } });
    const a = buildBlocker(P(0), tile("Old Kent"));
    S.tiles[tile("Whitechapel")].owner = 0;
    const ok = buildBlocker(P(0), tile("Old Kent"));
    build(P(0), tile("Old Kent"));
    const uneven = buildBlocker(P(0), tile("Old Kent"));
    return a.startsWith("Need the full colour set") && ok === "" && uneven.startsWith("Build evenly");`));

  await check("selling a hotel when the bank is out of houses brings the whole set down evenly", () => ok(`
    setup(2, { cpus: [false, true], own: { 0: ["Park Lane", "Mayfair"] } });
    [37, 39].forEach((i) => (S.tiles[i].houses = 5)); S.hotelsLeft = 10; S.housesLeft = 0; P(0).cash = 0;
    sell(P(0), 39);
    return S.tiles[37].houses === 0 && S.tiles[39].houses === 0 && S.hotelsLeft === 12 && S.housesLeft === 0 && P(0).cash === 1000;`));
  await check("…or to as many houses each as the bank can supply", () => ok(`
    setup(2, { cpus: [false, true], own: { 0: ["Park Lane", "Mayfair"] } });
    [37, 39].forEach((i) => (S.tiles[i].houses = 5)); S.hotelsLeft = 10; S.housesLeft = 3; P(0).cash = 0;
    sell(P(0), 37);
    return S.tiles[37].houses === 1 && S.tiles[39].houses === 1 && S.housesLeft === 1 && S.hotelsLeft === 12 && P(0).cash === 800;`));

  console.log("Round events");
  const rent = (id, group, i, roll = 0) => run(`S.event = { id: "${id}", group: ${group ? `"${group}"` : "null"} }; rentFor(${i}, ${roll})`);
  run(`setup(2, { options: { events: true }, own: { 1: ["Park Lane", "Mayfair", "King's Cross", "Marylebone", "Electric"] } })`);
  await check("hot street doubles and rent strike cancels a set's rent", () => rent("quiet", null, 39) === 100 && rent("hot", "darkblue", 39) === 200 && rent("strike", "darkblue", 39) === 0);
  await check("rail strike / tourist season / heatwave", () => rent("rail", null, 5) === 0 && rent("tourists", null, 5) === 100 && rent("heatwave", null, 12, 7) === 56);
  await check("building boom, property sale and bonus season", () => ok(`
    S.event = { id: "boom" }; const h = houseCost("darkblue");
    S.event = { id: "sale" }; const p = buyPrice(tile("Old Kent"));
    S.event = { id: "payday" }; const go = goSalary();
    return h === 150 && p === 45 && go === 300;`));
  await check("nothing changes with events switched off", () => ok(`
    S.options.events = false; S.event = { id: "hot", group: "darkblue" };
    const r = rentFor(39, 0);
    S.options.events = true;
    return r === 100;`));
  await check("council rates, dividend and amnesty apply at once", async () => {
    run(`S.decks.events = [EVENTS.findIndex((e) => e.id === "rates")]; S.eventRound = 0; P(0).cash = 1500; P(1).cash = 1500;`);
    await run(`startRoundEvent()`);
    const rates = run(`P(1).cash`);
    run(`S.decks.events = [EVENTS.findIndex((e) => e.id === "dividend")]`);
    await run(`startRoundEvent()`);
    run(`P(0).inJail = true; S.decks.events = [EVENTS.findIndex((e) => e.id === "amnesty")]`);
    await run(`startRoundEvent()`);
    assert(rates === 1450, `rates left P1 with ${rates}`);
    return run(`P(0).cash === 1550 && !P(0).inJail`);
  });

  await check("market crash pays 20% less to mortgage", () => ok(`
    setup(2, { options: { events: true }, own: { 0: ["Mayfair"] } }); P(0).cash = 0;
    S.event = { id: "crash" }; mortgage(P(0), 39);
    return P(0).cash === 160;`));
  await check("charity drive: the richest gives £100 to the poorest", async () => {
    run(`setup(3, { options: { events: true }, cash: [900, 300, 1200] }); S.decks.events = [EVENTS.findIndex((e) => e.id === "charity")]; S.eventRound = 0;`);
    await run(`startRoundEvent()`);
    return run(`P(2).cash === 1100 && P(1).cash === 400 && P(0).cash === 900`);
  });
  await check("lucky streak pays £50 for doubles, roadworks moves one square less", async () => {
    run(`setup(2, { options: { events: true } }); S.event = { id: "lucky" };
      let rolls = [[3, 3], [1, 2]]; rollDice = async () => (S.dice = rolls.shift());
      landOn = async () => {}; endTurn = async () => {}; P(0).pos = 0; P(0).cash = 1000;`);
    await run(`playTurn(P(0))`);
    const lucky = run(`P(0).cash === 1050 && P(0).pos === 9`);
    run(`S.event = { id: "roadworks" }; rolls = [[2, 3]]; P(0).pos = 0;`);
    await run(`playTurn(P(0))`);
    assert(lucky, "lucky streak");
    return run(`P(0).pos === 4 && stepsFor(5) === 4`);
  });

  console.log("CPUs and events");
  const builtWith = (eventId) => ok(`
    setup(2, { options: { events: true }, own: { 0: ["Old Kent", "Whitechapel"] } });
    P(0).cash = 450; S.event = ${eventId ? `{ id: "${eventId}" }` : "null"};
    cpuManage(P(0)); return S.tiles[1].houses + S.tiles[3].houses;`);
  await check("Normal CPUs build more during a building boom", async () => {
    const [plain, boom] = [await builtWith(null), await builtWith("boom")];
    assert(boom > plain, `built ${plain} normally, ${boom} in the boom`);
  });
  await check("Hard CPUs don't mortgage to build during a market crash", async () => {
    const mortgagedTo = (eventId) => ok(`
      setup(2, { options: { events: true }, own: { 0: ["Old Kent", "Whitechapel", "Mayfair"] } });
      P(0).level = "hard"; P(0).cash = 100; S.event = ${eventId ? `{ id: "${eventId}" }` : "null"};
      cpuManage(P(0)); return S.tiles[39].mortgaged;`);
    assert(await mortgagedTo(null), "should mortgage Mayfair to build normally");
    return !(await mortgagedTo("crash"));
  });
  await check("Normal CPUs keep more cash back when an event makes rents ahead dearer", () => ok(`
    setup(2, { options: { events: true }, own: { 1: ["Pall Mall", "Whitehall", "Northumberland"] } });
    [11, 13, 14].forEach((i) => (S.tiles[i].houses = 3)); P(0).pos = 7;
    S.event = { id: "quiet" }; const calm = eventCaution(P(0));
    S.event = { id: "hot", group: "pink" }; const hot = eventCaution(P(0));
    P(0).level = "easy"; const easy = eventCaution(P(0));
    return calm === 0 && hot > 100 && easy === 0;`));
  await check("raising cash, the hot street set is mortgaged last", () => ok(`
    setup(2, { options: { events: true }, own: { 0: ["Strand", "Old Kent"] } });
    S.event = { id: "hot", group: "red" }; P(0).cash = 0;
    cpuRaiseFunds(P(0), 20);
    return S.tiles[1].mortgaged && !S.tiles[21].mortgaged;`));

  console.log("Daily challenge");
  const deal = (seed) => run(`(() => {
    const st = newState({ seed: ${seed}, players: [human("Me"), cpuRow(1, "normal"), cpuRow(2, "hard"), cpuRow(3, "normal")], options: { personas: true, startCash: 1500 } });
    S = st; rng = st.rng;
    const dice = Array.from({ length: 6 }, () => Math.floor(rand("dice") * 6));
    return JSON.stringify({ chance: st.decks.chance, chest: st.decks.chest, personas: st.players.map((p) => p.persona), dice });
  })()`);
  await check("the same day deals the same game", () => deal(20261028) === deal(20261028));
  await check("a different day deals a different game", () => deal(20261028) !== deal(20261029));

  console.log("Career & achievements");
  await check("a game ended early doesn't count", () => ok(`
    setup(2, { cpus: [false, true] }); S.endedEarly = true; const before = career.games;
    return recordCareer(P(0)); career.games === before;`));
  await check("a real win counts, and a tie for last isn't a comeback", () => ok(`
    setup(2, { cpus: [false, true] }); const before = career.wins;
    stats().history.push({ round: 6, worth: [1500, 1500] });
    P(1).bankrupt = true; recordCareer(P(0));
    return career.wins === before + 1 && !career.achievements.comeback;`));
  await check("badges saved before tiers count as Bronze and can be upgraded", () => ok(`
    career.achievements.rich = "2026-10-20"; const was = tierOf("rich");
    award("rich", 0); const same = career.achievements.rich === "2026-10-20";
    award("rich", 1);
    return was === 0 && same && tierOf("rich") === 1 && career.achievements.rich.tier === 1;`));
  await check("tiers follow the thresholds", () => ok(`
    return tierFor(4, [5, 7, 10]) === -1 && tierFor(5, [5, 7, 10]) === 0 && tierFor(8, [5, 7, 10]) === 1 && tierFor(12, [5, 7, 10]) === 2;`));
  await check("what a scenario hands you at the start doesn't unlock anything", () => ok(`
    delete career.achievements.all_aboard;
    setup(2, { cpus: [false, true], own: { 0: ["King's Cross", "Marylebone", "Fenchurch", "Liverpool"] } });
    return watchBoard(); !career.achievements.all_aboard;`));

  done();
})();
