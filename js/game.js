// Web Monopoly — game engine, CPU players and UI.
"use strict";

const SAVE_KEY = "web-monopoly-save-v2";
const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n < 0 ? "-£" : "£") + Math.abs(Math.round(n)).toLocaleString("en-GB");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Seeded games (the daily challenge) draw their randomness from here so everyone
// gets the same deal. Dice have their own stream, so choices that use up other
// random numbers (auctions, events) don't change the dice.
let rng = null;
function rand(stream = "misc") {
  if (!rng) return Math.random();
  let t = (rng[stream] = (rng[stream] + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr, stream) => arr[Math.floor(rand(stream) * arr.length)];
// Single-player extras (js/solo.js) listen in here; it's optional.
const hook = (kind, data) => typeof onGameEvent === "function" && onGameEvent(kind, data);

const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const SPEEDS = { slow: 1.6, normal: 1, fast: 0.4, instant: 0.08 };
// Once the game is over, pauses never end, so any CPU move still in flight stops where it is.
const sleep = (ms) => new Promise((r) => S.over || setTimeout(r, ms * SPEEDS[S.options.speed || "normal"]));
// Show what a CPU just did and hold it on screen long enough to read, even at instant speed.
const announce = (html, ms = 1800) => {
  setStatus(html);
  render();
  return new Promise((r) => S.over || setTimeout(r, Math.max(900, ms * SPEEDS[S.options.speed || "normal"])));
};

const CHANCE_JAIL_CARD = CHANCE_CARDS.findIndex((c) => c.action === "jailFree");
const CHEST_JAIL_CARD = CHEST_CARDS.findIndex((c) => c.action === "jailFree");
const GROUP_TILES = {};
BOARD.forEach((b, i) => { if (b.group) (GROUP_TILES[b.group] = GROUP_TILES[b.group] || []).push(i); });

// ---------------------------------------------------------------- state

let S = null; // whole game state (serialisable)
let pending = null; // current question waiting for a human click

function newState(setup) {
  rng = setup.seed != null ? { misc: setup.seed, dice: setup.seed ^ 0x5bd1e995 } : null;
  return {
    rng,
    mode: setup.mode || null,
    players: setup.players.map((p, id) => ({
      id, name: p.name, cpu: p.cpu, level: p.level || "normal", token: p.token, color: PLAYER_COLORS[id],
      persona: p.cpu ? p.persona || (setup.options.personas ? pick(Object.keys(PERSONAS)) : null) : null,
      cash: setup.options.startCash, pos: 0, inJail: false, jailTurns: 0, jailCards: [], bankrupt: false,
    })),
    tiles: BOARD.map(() => ({ owner: null, houses: 0, mortgaged: false })),
    turn: 0,
    round: 1,
    decks: {
      chance: shuffle(CHANCE_CARDS.map((_, i) => i)),
      chest: shuffle(CHEST_CARDS.map((_, i) => i)),
    },
    housesLeft: RULES.maxHouses,
    hotelsLeft: RULES.maxHotels,
    pot: 0,
    dice: [1, 1],
    log: [],
    options: setup.options,
    status: "",
  };
}

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) { /* storage unavailable */ }
}
function loadSave() {
  try { const raw = localStorage.getItem(SAVE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- queries

const P = (id) => S.players[id];
const alive = () => S.players.filter((p) => !p.bankrupt);
const ownedBy = (p) => S.tiles.map((t, i) => (t.owner === p.id ? i : -1)).filter((i) => i >= 0);
const isBuyable = (i) => "price" in BOARD[i];
const ownsSet = (pid, group) => GROUP_TILES[group].every((i) => S.tiles[i].owner === pid);
const groupHasBuildings = (group) => GROUP_TILES[group].some((i) => S.tiles[i].houses > 0);
const countType = (pid, type) => BOARD.filter((b, i) => b.type === type && S.tiles[i].owner === pid).length;
const unmortgageCost = (i) => Math.ceil((BOARD[i].price / 2) * (1 + RULES.mortgageInterest));
const unownedCount = () => S.tiles.filter((t, i) => isBuyable(i) && t.owner === null).length;

// The round event in force, if events are on.
const activeEvent = () => (S.options.events && S.event ? EVENTS.find((e) => e.id === S.event.id) : null);
const eventIs = (id) => activeEvent()?.id === id;
const discounted = (amount) => Math.ceil((amount * 0.75) / 5) * 5;
const houseCost = (group) => (eventIs("boom") ? discounted(GROUPS[group].houseCost) : GROUPS[group].houseCost);
const buyPrice = (i) => (eventIs("sale") ? discounted(BOARD[i].price) : BOARD[i].price);
const goSalary = () => (eventIs("payday") ? 300 : RULES.goSalary);
const mortgageValue = (i) => (eventIs("crash") ? BOARD[i].price * 0.4 : BOARD[i].price / 2);
// How far a dice total moves you (roadworks hold everyone back a square).
const stepsFor = (roll) => roll - (eventIs("roadworks") ? 1 : 0);

function eventRentFactor(i) {
  const b = BOARD[i];
  if (b.group && S.event?.group === b.group) return eventIs("hot") ? 2 : eventIs("strike") ? 0 : 1;
  if (b.type === "station") return eventIs("rail") ? 0 : eventIs("tourists") ? 2 : 1;
  if (b.type === "utility" && eventIs("heatwave")) return 2;
  return 1;
}

function rentFor(i, diceTotal, cardMode) {
  return baseRent(i, diceTotal, cardMode) * eventRentFactor(i);
}

function baseRent(i, diceTotal, cardMode) {
  const b = BOARD[i], t = S.tiles[i];
  if (t.owner === null || t.mortgaged) return 0;
  if (b.type === "property") {
    if (t.houses > 0) return b.rents[t.houses];
    return ownsSet(t.owner, b.group) ? b.rents[0] * 2 : b.rents[0];
  }
  if (b.type === "station") {
    const rent = 25 * 2 ** (countType(t.owner, "station") - 1);
    return cardMode === "station" ? rent * 2 : rent;
  }
  if (b.type === "utility") {
    const mult = cardMode === "utility" || countType(t.owner, "utility") === 2 ? 10 : 4;
    return mult * diceTotal;
  }
  return 0;
}

// Running game stats for the end screen (created lazily so old saves still load).
function stats() {
  if (!S.stats) S.stats = { history: [], rentGot: S.players.map(() => 0), biggestRent: null, trades: [] };
  return S.stats;
}
function recordWorth(final = false) {
  const h = stats().history;
  const point = { round: S.round, final, worth: S.players.map((p) => (p.bankrupt ? 0 : netWorth(p))) };
  if (!final && h.length && h[h.length - 1].round === S.round) h[h.length - 1] = point;
  else h.push(point);
}

function netWorth(p) {
  let worth = p.cash;
  for (const i of ownedBy(p)) {
    const b = BOARD[i], t = S.tiles[i];
    worth += t.mortgaged ? b.price / 2 : b.price;
    if (t.houses) worth += t.houses * GROUPS[b.group].houseCost;
  }
  return worth;
}

// Cash a player could raise by selling every building and mortgaging everything.
function liquidValue(p) {
  let v = p.cash;
  for (const i of ownedBy(p)) {
    const b = BOARD[i], t = S.tiles[i];
    if (t.houses) v += (t.houses * GROUPS[b.group].houseCost) / 2;
    if (!t.mortgaged) v += mortgageValue(i);
  }
  return v;
}

// ---------------------------------------------------------------- building & mortgages

// Why p can't build on tile i right now, or "" if they can.
function buildBlocker(p, i) {
  const b = BOARD[i], t = S.tiles[i];
  if (b.type !== "property" || t.owner !== p.id) return "Not yours to build on";
  if (t.houses >= 5) return "Fully built";
  const set = GROUP_TILES[b.group];
  if (!ownsSet(p.id, b.group)) return `Need the full colour set (you have ${set.filter((j) => S.tiles[j].owner === p.id).length} of ${set.length})`;
  if (set.some((j) => S.tiles[j].mortgaged)) return "Pay off this set's mortgages to build";
  if (t.houses > Math.min(...set.map((j) => S.tiles[j].houses))) return "Build evenly: the rest of the set needs one first";
  if (t.houses === 4 ? S.hotelsLeft < 1 : S.housesLeft < 1) return `The bank has run out of ${t.houses === 4 ? "hotels" : "houses"}`;
  if (p.cash < houseCost(b.group)) return `Need ${fmt(houseCost(b.group))} to build`;
  return "";
}
const canBuild = (p, i) => !buildBlocker(p, i);

function build(p, i) {
  const t = S.tiles[i], cost = houseCost(BOARD[i].group);
  p.cash -= cost;
  if (t.houses === 4) { S.hotelsLeft--; S.housesLeft += 4; } else S.housesLeft--;
  t.houses++;
  log(`${p.name} built a ${t.houses === 5 ? "hotel" : "house"} on ${BOARD[i].name} for ${fmt(cost)}.`, p);
  if (t.houses === 5) hook("hotel", { p, i });
}

function canSell(p, i) {
  const b = BOARD[i], t = S.tiles[i];
  if (b.type !== "property" || t.owner !== p.id || t.houses === 0) return false;
  return t.houses >= Math.max(...GROUP_TILES[b.group].map((j) => S.tiles[j].houses));
}

function sell(p, i) {
  const t = S.tiles[i], cost = GROUPS[BOARD[i].group].houseCost;
  let refund;
  if (t.houses === 5 && S.housesLeft < 4) {
    // The bank can't break the hotel into four houses, so to keep building even
    // the whole set comes down to the highest level the bank's houses allow.
    // (With a hotel in the set, every site holds four houses or a hotel.)
    const set = GROUP_TILES[BOARD[i].group];
    const hotels = set.filter((j) => S.tiles[j].houses === 5).length, fours = set.length - hotels;
    let level = 4;
    while (level > 0 && hotels * level - fours * (4 - level) > S.housesLeft) level--;
    let units = 0;
    for (const j of set) {
      units += S.tiles[j].houses - level;
      if (S.tiles[j].houses === 5) S.hotelsLeft++;
      S.tiles[j].houses = level;
    }
    S.housesLeft -= hotels * level - fours * (4 - level);
    refund = (units * cost) / 2;
    log(`The bank is short of houses, so ${p.name} sold ${GROUP_NAMES[BOARD[i].group]} down to ${level} house${level === 1 ? "" : "s"} each for ${fmt(refund)}.`, p);
  } else if (t.houses === 5) {
    // A hotel breaks back down into four houses.
    S.hotelsLeft++;
    S.housesLeft -= 4;
    refund = cost / 2;
    t.houses = 4;
    log(`${p.name} sold the hotel on ${BOARD[i].name} for ${fmt(refund)}.`, p);
  } else {
    S.housesLeft++;
    t.houses--;
    refund = cost / 2;
    log(`${p.name} sold a house on ${BOARD[i].name} for ${fmt(refund)}.`, p);
  }
  p.cash += refund;
}

function canMortgage(p, i) {
  const b = BOARD[i], t = S.tiles[i];
  if (t.owner !== p.id || t.mortgaged) return false;
  return !(b.group && groupHasBuildings(b.group));
}

function mortgage(p, i) {
  S.tiles[i].mortgaged = true;
  const value = mortgageValue(i);
  p.cash += value;
  log(`${p.name} mortgaged ${BOARD[i].name} for ${fmt(value)}${eventIs("crash") ? " (market crash)" : ""}.`, p);
}

const canUnmortgage = (p, i) => S.tiles[i].owner === p.id && S.tiles[i].mortgaged && p.cash >= unmortgageCost(i);

function unmortgage(p, i) {
  const cost = unmortgageCost(i);
  S.tiles[i].mortgaged = false;
  p.cash -= cost;
  log(`${p.name} paid off the mortgage on ${BOARD[i].name} (${fmt(cost)}).`, p);
}

// ---------------------------------------------------------------- money

// Make p pay `amount` to creditor (a player, or null for the bank).
// Returns false if p went bankrupt instead.
async function pay(p, amount, creditor, toPot = false) {
  if (amount <= 0) return true;
  if (p.cash < amount) {
    const before = p.cash;
    const raised = p.cpu ? cpuRaiseFunds(p, amount) : await humanRaiseFunds(p, amount, creditor);
    if (p.cpu && p.cash > before) {
      hook("raised", { p, amount });
      await announce(`${p.token} <b>${esc(p.name)}</b> raised ${fmt(p.cash - before)} by mortgaging or selling houses to pay ${fmt(amount)}.`);
    }
    if (!raised) {
      await goBankrupt(p, creditor);
      return false;
    }
  }
  p.cash -= amount;
  hook("paid", { p, amount });
  if (creditor) creditor.cash += amount;
  else if (toPot && S.options.freeParking) S.pot += amount;
  render();
  return true;
}

async function humanRaiseFunds(p, amount, creditor) {
  while (true) {
    const choice = await ask(
      p,
      `<b>${esc(p.name)}</b> owes <b>${fmt(amount)}</b>${creditor ? ` to ${esc(creditor.name)}` : ""} but only has ${fmt(p.cash)}.
       Sell buildings, mortgage or trade (<b>Manage</b> / <b>Trade</b>) to raise the money.`,
      [
        { label: `Pay ${fmt(amount)}`, value: "pay", primary: true, disabled: () => p.cash < amount },
        { label: "Declare bankruptcy", value: "bankrupt", danger: true },
      ]
    );
    if (choice === "pay" && p.cash >= amount) return true;
    if (choice === "bankrupt") {
      const sure = await modal({
        title: "Declare bankruptcy?",
        html: `<p>You'll be out of the game. Everything you own goes to ${creditor ? esc(creditor.name) : "the bank"}.</p>`,
        buttons: [{ label: "Cancel", value: false }, { label: "Go bankrupt", value: true, danger: true }],
      });
      if (sure) return false;
    }
  }
}

async function goBankrupt(p, creditor) {
  hook("bankrupt", { p, creditor });
  for (const i of ownedBy(p)) {
    const t = S.tiles[i];
    if (t.houses) {
      const cost = GROUPS[BOARD[i].group].houseCost;
      p.cash += (t.houses * cost) / 2;
      if (t.houses === 5) S.hotelsLeft++; else S.housesLeft += t.houses;
      t.houses = 0;
    }
    if (creditor) t.owner = creditor.id;
    else { t.owner = null; t.mortgaged = false; }
  }
  if (creditor) {
    creditor.cash += p.cash;
    creditor.jailCards.push(...p.jailCards);
  } else {
    for (const d of p.jailCards) S.decks[d].push(d === "chance" ? CHANCE_JAIL_CARD : CHEST_JAIL_CARD);
  }
  p.jailCards = [];
  p.cash = 0;
  p.bankrupt = true;
  p.inJail = false;
  log(`💥 ${p.name} is bankrupt! Their assets go to ${creditor ? creditor.name : "the bank"}.`, p);
  render();
  toast(`${p.name} is bankrupt!`);
  await sleep(1200);
}

// ---------------------------------------------------------------- movement

async function moveSteps(p, steps) {
  const delay = steps > 12 ? 45 : 130;
  for (let k = 0; k < steps; k++) {
    p.pos = (p.pos + 1) % 40;
    if (p.pos === 0) {
      const salary = goSalary();
      p.cash += salary;
      log(`${p.name} passed GO and collected ${fmt(salary)}.`, p);
      hook("go", { p });
    }
    renderTokens();
    renderPlayers();
    await sleep(delay);
  }
}

async function moveBack(p, steps) {
  for (let k = 0; k < steps; k++) {
    p.pos = (p.pos + 39) % 40;
    renderTokens();
    await sleep(130);
  }
}

const moveTo = (p, dest) => moveSteps(p, (dest - p.pos + 40) % 40);

function sendToJail(p) {
  p.pos = 10;
  p.inJail = true;
  p.jailTurns = 0;
  log(`🚔 ${p.name} was sent to Jail.`, p);
  hook("jail", { p });
  render();
}

async function rollDice() {
  const el = $("#dice");
  el.classList.add("rolling");
  for (let k = 0; k < 6; k++) {
    S.dice = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
    renderDice();
    await sleep(70);
  }
  el.classList.remove("rolling");
  S.dice = [1 + Math.floor(rand("dice") * 6), 1 + Math.floor(rand("dice") * 6)];
  renderDice();
  return S.dice;
}

// ---------------------------------------------------------------- turn flow

async function gameLoop() {
  while (!S.over) {
    if (alive().length <= 1) return showWinner();
    if (S.options.roundLimit && S.round > S.options.roundLimit) {
      log(`⏱️ ${S.options.roundLimit} rounds are up — highest net worth wins.`, null, true);
      return showWinner();
    }
    if (stats().history.at(-1)?.round !== S.round) recordWorth();
    if (S.round === 5 && !S.hinted) {
      S.hinted = true;
      log("🎩 Rumour has it the dice are ticklish… try a few quick taps.");
    }
    if (S.options.events && S.eventRound !== S.round) {
      await startRoundEvent();
      if (alive().length <= 1) return showWinner();
    }
    const p = P(S.turn);
    if (!p.bankrupt) {
      log(`— ${p.name}'s turn —`, p, true);
      await playTurn(p);
    }
    if (alive().length <= 1) return showWinner();
    do {
      S.turn = (S.turn + 1) % S.players.length;
      if (S.turn === 0) S.round++;
    } while (P(S.turn).bankrupt);
    save();
  }
}

async function playTurn(p) {
  S.doubles = 0;
  render();
  if (p.inJail) {
    const res = await jailTurn(p);
    if (res !== "free") {
      if (!p.bankrupt) await endTurn(p);
      return;
    }
  }
  while (true) {
    if (p.cpu) {
      await cpuManage(p);
      setStatus(`${p.token} <b>${esc(p.name)}</b> is rolling…`);
      await sleep(600);
    } else {
      await ask(p, S.doubles ? "Doubles! Roll again." : `${p.token} <b>${esc(p.name)}</b>, it's your turn.`, [
        { label: "🎲 Roll dice", value: "roll", primary: true },
      ]);
    }
    const [a, b] = await rollDice();
    const double = a === b;
    log(`${p.name} rolled ${a} + ${b} = ${a + b}${double ? " (doubles)" : ""}.`, p);
    if (double && S.doubles < 2) hook("doubles", { p });
    if (double && ++S.doubles === 3) {
      log(`${p.name} rolled three doubles in a row!`, p);
      sendToJail(p);
      break;
    }
    if (double && eventIs("lucky")) {
      p.cash += 50;
      log(`🍀 Lucky streak: ${p.name} collects ${fmt(50)} for rolling doubles.`, p);
    }
    await moveSteps(p, stepsFor(a + b));
    await landOn(p, a + b);
    if (p.bankrupt || p.inJail || !double) break;
  }
  if (!p.bankrupt) await endTurn(p);
}

async function endTurn(p) {
  if (p.cpu) {
    await cpuTryTrade(p);
    await cpuManage(p);
    render();
    await sleep(700);
  } else {
    await ask(p, `${p.token} <b>${esc(p.name)}</b> — build, mortgage or trade, then end your turn.`, [
      { label: "End turn ➜", value: "end", primary: true, disabled: () => p.cash < 0 },
    ]);
  }
}

// Draw this round's event, apply anything that happens at once, and show it.
async function startRoundEvent() {
  S.eventRound = S.round;
  if (!S.decks.events?.length) S.decks.events = shuffle(EVENTS.map((_, k) => k));
  const e = EVENTS[S.decks.events.pop()];
  S.event = { id: e.id };
  if (e.text.includes("{group}")) {
    // Prefer a set somebody owns part of, so the event matters.
    const groups = Object.keys(GROUP_TILES), owned = groups.filter((g) => GROUP_TILES[g].some((i) => S.tiles[i].owner !== null));
    const pool = owned.length ? owned : groups;
    S.event.group = pick(pool);
  }
  log(`${e.icon} Round ${S.round} event — ${e.title}: ${eventText()}`, null, true);
  if (e.id !== "quiet") hook("event", { id: e.id });
  const html = eventHtml();
  if (e.id === "quiet") return render();
  if (alive().some((p) => !p.cpu)) await ask({ cpu: true }, "", [{ label: "OK", value: true, primary: true }], html, 6000);
  else await announce(html, 2500);
  if (e.id === "dividend") for (const p of alive()) p.cash += 50;
  if (e.id === "charity") {
    const byCash = alive().slice().sort((x, y) => y.cash - x.cash);
    const [rich, poor] = [byCash[0], byCash[byCash.length - 1]];
    if (rich !== poor) {
      log(`💝 ${rich.name} gives ${fmt(100)} to ${poor.name}.`, rich);
      await pay(rich, 100, poor);
    }
  }
  if (e.id === "amnesty") for (const p of alive().filter((p) => p.inJail)) { p.inJail = false; log(`🔓 ${p.name} walks out of Jail.`, p); }
  if (e.id === "rates") {
    for (const p of alive()) {
      const n = ownedBy(p).length;
      if (n) { log(`${p.name} pays ${fmt(n * 10)} in council rates.`, p); await pay(p, n * 10, null, true); }
    }
  }
  render();
}

const eventText = () => activeEvent().text.replace("{group}", GROUP_NAMES[S.event.group]);
const eventHtml = () => `<div class="card event"><div class="card-title">${activeEvent().icon} ${activeEvent().title}</div><p>${esc(eventText())}</p></div>`;

// Returns "free" if the player should now roll normally, "done" otherwise.
async function jailTurn(p) {
  p.jailTurns++;
  let choice;
  if (p.cpu) {
    // Hard CPUs know Jail is a safe place to wait once rivals have built.
    const early = unownedCount() > 8 && !(p.level === "hard" && S.tiles.some((t) => t.houses && t.owner !== p.id));
    if (p.jailCards.length && early) choice = "card";
    else if (early && p.cash > 300) choice = "pay";
    else choice = "roll";
    await sleep(600);
  } else {
    choice = await ask(p, `${p.token} <b>${esc(p.name)}</b> is in Jail (attempt ${p.jailTurns} of 3).`, [
      { label: "🎲 Roll for doubles", value: "roll", primary: true },
      { label: `Pay ${fmt(RULES.jailFine)}`, value: "pay", disabled: () => p.cash < RULES.jailFine },
      ...(p.jailCards.length ? [{ label: "Use Get Out of Jail Free", value: "card" }] : []),
    ]);
  }
  if (choice === "card") {
    const deck = p.jailCards.pop();
    S.decks[deck].push(deck === "chance" ? CHANCE_JAIL_CARD : CHEST_JAIL_CARD);
    p.inJail = false;
    log(`${p.name} used a Get Out of Jail Free card.`, p);
    hook("freed", { p });
    return "free";
  }
  if (choice === "pay") {
    if (!(await pay(p, RULES.jailFine, null, true))) return "done";
    p.inJail = false;
    log(`${p.name} paid ${fmt(RULES.jailFine)} to get out of Jail.`, p);
    hook("freed", { p });
    return "free";
  }
  const [a, b] = await rollDice();
  log(`${p.name} rolled ${a} + ${b} in Jail.`, p);
  if (a !== b) {
    if (p.jailTurns < 3) {
      log(`${p.name} stays in Jail.`, p);
      return "done";
    }
    log(`${p.name} must pay ${fmt(RULES.jailFine)} after three failed attempts.`, p);
    if (!(await pay(p, RULES.jailFine, null, true))) return "done";
  } else {
    log(`Doubles! ${p.name} is out of Jail.`, p);
    hook("freed", { p });
  }
  p.inJail = false;
  render();
  await moveSteps(p, stepsFor(a + b));
  await landOn(p, a + b);
  return "done";
}

async function landOn(p, diceTotal, cardMode) {
  const i = p.pos, b = BOARD[i], t = S.tiles[i];
  render();
  if (isBuyable(i)) {
    if (t.owner === null) return offerToBuy(p, i);
    if (t.owner === p.id) return hook("landOwn", { p, i });
    const owner = P(t.owner);
    if (t.mortgaged) {
      hook("landMortgaged", { p, owner, i });
      return log(`${b.name} is mortgaged — no rent due.`, p);
    }
    const rent = rentFor(i, diceTotal, cardMode);
    if (!rent) return log(`${activeEvent()?.icon || ""} No rent due on ${b.name} this round.`, p);
    log(`${p.name} owes ${owner.name} ${fmt(rent)} rent for ${b.name}.`, p);
    if (!p.cpu) await showInfo(p, `You landed on <b>${esc(b.name)}</b>, owned by ${esc(owner.name)}. Rent: <b>${fmt(rent)}</b>.`);
    if (await pay(p, rent, owner)) {
      toast(`${p.name} paid ${owner.name} ${fmt(rent)}`);
      const st = stats();
      st.rentGot[owner.id] += rent;
      if (!st.biggestRent || rent > st.biggestRent.amount) st.biggestRent = { amount: rent, payer: p.id, owner: owner.id, tile: i, round: S.round };
      hook("rent", { p, owner, rent, i });
    }
    return;
  }
  switch (b.type) {
    case "tax":
      if (eventIs("taxfree")) return log(`🎉 Tax holiday: ${p.name} pays no ${b.name}.`, p);
      log(`${p.name} pays ${b.name} of ${fmt(b.amount)}.`, p);
      if (!p.cpu) await showInfo(p, `<b>${b.name}</b>: pay ${fmt(b.amount)}.`);
      hook("tax", { p });
      await pay(p, b.amount, null, true);
      return;
    case "chance":
    case "chest":
      return drawCard(p, b.type, diceTotal);
    case "gotojail":
      if (!p.cpu) await showInfo(p, "👮 Go to Jail! Do not pass GO.");
      sendToJail(p);
      return;
    case "parking":
      if (S.options.freeParking && S.pot > 0) {
        log(`${p.name} collects the Free Parking jackpot of ${fmt(S.pot)}!`, p);
        toast(`${p.name} wins the ${fmt(S.pot)} jackpot!`);
        hook("jackpot", { p, amount: S.pot });
        p.cash += S.pot;
        S.pot = 0;
        render();
      }
      return;
  }
}

async function drawCard(p, deck, diceTotal) {
  const cards = deck === "chance" ? CHANCE_CARDS : CHEST_CARDS;
  const idx = S.decks[deck].shift();
  const card = cards[idx];
  if (card.action === "jailFree") p.jailCards.push(deck);
  else S.decks[deck].push(idx);
  log(`${p.name} drew ${deck === "chance" ? "Chance" : "Community Chest"}: “${card.text}”`, p);
  await showInfo(p, cardHtml(deck, card.text), true);
  const good = card.action === "collectEach" || card.action === "jailFree" || (card.action === "money" && card.amount > 0) || (card.action === "move" && card.to === 0);
  const bad = ["repairs", "payEach", "jail", "moveBack"].includes(card.action) || (card.action === "money" && card.amount < 0);
  if (good || bad) hook("card", { p, good, deck, action: card.action });

  switch (card.action) {
    case "money":
      if (card.amount > 0) { p.cash += card.amount; render(); }
      else await pay(p, -card.amount, null, true);
      break;
    case "move":
      await moveTo(p, card.to);
      await landOn(p, diceTotal);
      break;
    case "moveBack":
      await moveBack(p, card.steps);
      await landOn(p, diceTotal);
      break;
    case "nearest": {
      let dest = p.pos;
      do dest = (dest + 1) % 40; while (BOARD[dest].type !== card.kind);
      await moveTo(p, dest);
      await landOn(p, diceTotal, card.kind);
      break;
    }
    case "jail":
      sendToJail(p);
      break;
    case "repairs": {
      let total = 0;
      for (const i of ownedBy(p)) {
        const h = S.tiles[i].houses;
        total += h === 5 ? card.hotel : h * card.house;
      }
      if (total) {
        log(`${p.name} pays ${fmt(total)} for repairs.`, p);
        await pay(p, total, null, true);
      }
      break;
    }
    case "payEach":
      for (const o of alive()) {
        if (o !== p && !(await pay(p, card.amount, o))) break;
      }
      break;
    case "collectEach":
      for (const o of alive()) {
        if (o !== p) await pay(o, card.amount, p);
      }
      break;
  }
  render();
}

async function offerToBuy(p, i) {
  const b = BOARD[i], price = buyPrice(i);
  let buy;
  if (p.cpu) {
    buy = cpuWantsToBuy(p, i);
    await sleep(500);
  } else {
    buy = (await ask(
      p,
      `<b>${esc(b.name)}</b> is for sale for <b>${fmt(price)}</b>${price < b.price ? ` (${activeEvent().title.toLowerCase()})` : ""}. You have ${fmt(p.cash)}.`,
      [
        { label: `Buy for ${fmt(price)}`, value: "buy", primary: true, disabled: () => p.cash < price },
        { label: S.options.auction ? "Auction it" : "Don't buy", value: "pass" },
      ],
      deedHtml(i)
    )) === "buy";
  }
  if (buy && p.cash >= price) {
    p.cash -= price;
    S.tiles[i].owner = p.id;
    log(`🏠 ${p.name} bought ${b.name} for ${fmt(price)}.`, p);
    toast(`${p.name} bought ${b.name}`);
    hook("buy", { p, i });
    render();
  } else {
    log(`${p.name} didn't buy ${b.name}.`, p);
    if (S.options.auction) await auction(i, p);
  }
}

async function auction(i, starter) {
  const b = BOARD[i];
  const order = [];
  for (let k = 0; k < S.players.length; k++) {
    const q = P((starter.id + k) % S.players.length);
    if (!q.bankrupt) order.push(q);
  }
  let queue = order.slice(), high = 0, leader = null;
  log(`🔨 Auction for ${b.name} begins.`);
  while (queue.length && !(queue.length === 1 && queue[0] === leader)) {
    const q = queue.shift();
    if (q === leader) { queue.push(q); continue; }
    let bid = 0;
    if (q.cpu) {
      setStatus(`🔨 Auction: <b>${esc(b.name)}</b> — high bid ${fmt(high)}${leader ? ` (${esc(leader.name)})` : ""}. ${q.token} ${esc(q.name)} is thinking…`);
      await sleep(450);
      const max = Math.min((level(q).smart ? smartPrice(q, i) : cpuValue(q, i) * level(q).bid) * persona(q).bid, q.cash - 40);
      if (high + 10 <= max) bid = high + (max - high > 60 && rand() < 0.5 ? 20 : 10);
    } else {
      const steps = [1, 10, 50, 100];
      const res = await ask(
        q,
        `🔨 Auction: <b>${esc(b.name)}</b> — high bid <b>${fmt(high)}</b>${leader ? ` by ${esc(leader.name)}` : ""}.
         ${q.token} <b>${esc(q.name)}</b>, your bid? (cash ${fmt(q.cash)})`,
        [
          ...steps.map((s) => ({ label: `+${fmt(s)} (${fmt(high + s)})`, value: high + s, primary: s === 10, disabled: () => q.cash < high + s })),
          { label: "Drop out", value: 0, danger: true },
        ],
        deedHtml(i)
      );
      bid = res;
    }
    if (bid > high && q.cash >= bid) {
      high = bid;
      leader = q;
      queue.push(q);
      log(`${q.name} bids ${fmt(bid)}.`, q);
    } else {
      log(`${q.name} drops out of the auction.`, q);
    }
    render();
  }
  if (leader) {
    leader.cash -= high;
    S.tiles[i].owner = leader.id;
    log(`🔨 ${leader.name} won ${b.name} at auction for ${fmt(high)}.`, leader);
    hook("auction", { p: leader, price: high, i });
    toast(`${leader.name} won ${b.name} for ${fmt(high)}`);
  } else {
    log(`Nobody bid on ${b.name}; it stays with the bank.`);
  }
  render();
}

async function showWinner() {
  clearSave();
  const ranked = S.players.slice().sort((a, b) => (a.bankrupt - b.bankrupt) || netWorth(b) - netWorth(a));
  const w = ranked[0];
  log(`🏆 ${w.name} wins the game!`, w, true);
  setStatus(`🏆 <b>${esc(w.name)}</b> wins!`);
  S.over = true;
  recordWorth(true);
  hook("gameover", { winner: w });
  render();
  const results = `<ol class="standings">${ranked.map((p) => `<li><span class="tok" style="--c:${p.color}">${p.token}</span> ${esc(p.name)} <span>${p.bankrupt ? "bankrupt" : fmt(netWorth(p))}</span></li>`).join("")}</ol>
    ${statsHtml()}${typeof soloResultsHtml === "function" ? soloResultsHtml(w) : ""}`;
  // Players can close the results to look over the final board and the game log.
  let again = await modal({
    title: `🏆 ${esc(w.name)} wins!`,
    html: results,
    wide: true,
    onMount: wireChart,
    buttons: [{ label: "View board & log", value: false }, { label: "New game", value: true, primary: true }],
  });
  while (!again) {
    again = (await ask({ cpu: true }, `🏆 <b>${esc(w.name)}</b> wins! The game is over.`, [
      { label: "Results", value: "results" },
      { label: "New game", value: "new", primary: true },
    ])) === "new";
    if (!again) {
      again = await modal({ title: `🏆 ${esc(w.name)} wins!`, html: results, wide: true, onMount: wireChart, buttons: [{ label: "Close", value: false }, { label: "New game", value: true, primary: true }] });
    }
  }
  location.reload();
}

// ---------------------------------------------------------------- end-of-game stats

// Player colours as chart lines: yellow and orange are darkened a step so the
// lines stay legible on the cream panel (validated for colour-blind separation).
const chartColor = (p) => ({ "#fdd835": "#e0a800", "#fb8c00": "#ef7d00" })[p.color] || p.color;
const shortMoney = (v) => (v >= 1000 ? `£${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : `£${v}`);

function chartGeom() {
  const h = stats().history;
  const W = 560, H = 220, L = 46, R = 30, T = 12, B = 24;
  const raw = Math.max(100, ...h.flatMap((pt) => pt.worth));
  const step = [100, 250, 500, 1000, 2500, 5000, 10000].find((s) => raw / s <= 4) || 25000;
  const top = Math.ceil(raw / step) * step;
  const x = (k) => L + (h.length > 1 ? (k * (W - L - R)) / (h.length - 1) : (W - L - R) / 2);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  return { h, W, H, L, R, T, B, top, step, x, y };
}

function statsHtml() {
  const st = stats(), g = chartGeom(), h = g.h;
  const label = (pt) => (pt.final ? "End" : `R${pt.round}`);
  let svg = "";
  for (let v = 0; v <= g.top; v += g.step) {
    svg += `<line class="grid" x1="${g.L}" x2="${g.W - g.R}" y1="${g.y(v)}" y2="${g.y(v)}"/><text class="axis" x="${g.L - 6}" y="${g.y(v) + 4}" text-anchor="end">${shortMoney(v)}</text>`;
  }
  const every = Math.max(1, Math.ceil(h.length / 7));
  h.forEach((pt, k) => {
    if (k % every === 0 || k === h.length - 1) svg += `<text class="axis" x="${g.x(k)}" y="${g.H - 6}" text-anchor="middle">${label(pt)}</text>`;
  });
  // One line per player; their token at the end of the line names it.
  const ends = [];
  for (const p of S.players) {
    const d = h.map((pt, k) => `${k ? "L" : "M"}${g.x(k).toFixed(1)},${g.y(pt.worth[p.id]).toFixed(1)}`).join("");
    svg += `<path d="${d}" fill="none" stroke="${chartColor(p)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = h[h.length - 1].worth[p.id];
    svg += `<circle cx="${g.x(h.length - 1)}" cy="${g.y(last)}" r="4" fill="${chartColor(p)}" stroke="var(--panel)" stroke-width="2"/>`;
    ends.push({ p, y: g.y(last) });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 14);
  for (const e of ends) svg += `<text x="${g.x(h.length - 1) + 8}" y="${e.y + 5}" font-size="13">${e.p.token}</text>`;
  svg += `<line class="crosshair" y1="${g.T}" y2="${g.H - g.B}" visibility="hidden"/><rect class="hit" x="${g.L}" y="0" width="${g.W - g.L - g.R}" height="${g.H}" fill="transparent"/>`;

  const legend = S.players.map((p) => `<span><i style="background:${chartColor(p)}"></i>${p.token} ${esc(p.name)}</span>`).join("");
  const table = `<table class="chart-table"><tr><th>Round</th>${S.players.map((p) => `<th>${p.token} ${esc(p.name)}</th>`).join("")}</tr>
    ${h.map((pt) => `<tr><td>${pt.final ? "End" : pt.round}</td>${pt.worth.map((v) => `<td>${fmt(v)}</td>`).join("")}</tr>`).join("")}</table>`;

  const facts = [`🎲 ${S.round} round${S.round > 1 ? "s" : ""} played`];
  const topRent = Math.max(...st.rentGot);
  if (topRent > 0) {
    const r = P(st.rentGot.indexOf(topRent));
    facts.push(`🏠 Most rent collected: <b>${esc(r.name)}</b>, ${fmt(topRent)}`);
  }
  if (st.biggestRent) {
    const b = st.biggestRent;
    facts.push(`💥 Biggest single rent: <b>${esc(P(b.payer).name)}</b> paid ${esc(P(b.owner).name)} ${fmt(b.amount)} on ${esc(BOARD[b.tile].name)} (round ${b.round})`);
  }
  facts.push(st.trades.length
    ? `🤝 ${st.trades.length} trade${st.trades.length > 1 ? "s" : ""}<details><summary>Show trades</summary><ul>${st.trades.map((t) => `<li>Round ${t.round}: ${esc(t.text)}</li>`).join("")}</ul></details>`
    : "🤝 No trades this game");

  return `<h3 class="stats-head">Net worth over the game</h3>
    <div class="chart-legend">${legend}</div>
    <div class="stats-chart"><svg viewBox="0 0 ${g.W} ${g.H}" role="img" aria-label="Net worth of each player by round">${svg}</svg><div class="chart-tip" hidden></div></div>
    <details class="chart-table-wrap"><summary>Show as a table</summary>${table}</details>
    <ul class="stat-facts">${facts.map((f) => `<li>${f}</li>`).join("")}</ul>`;
}

// Hover / tap on the chart: a crosshair and every player's net worth at that point.
function wireChart(box) {
  const svg = box.querySelector(".stats-chart svg");
  if (!svg) return;
  const g = chartGeom(), tip = box.querySelector(".chart-tip"), cross = svg.querySelector(".crosshair");
  const show = (e) => {
    const pt = svg.createSVGPoint();
    [pt.x, pt.y] = [e.clientX, e.clientY];
    const at = pt.matrixTransform(svg.getScreenCTM().inverse());
    const k = g.h.length > 1 ? Math.max(0, Math.min(g.h.length - 1, Math.round(((at.x - g.L) * (g.h.length - 1)) / (g.W - g.L - g.R)))) : 0;
    const point = g.h[k];
    cross.setAttribute("x1", g.x(k));
    cross.setAttribute("x2", g.x(k));
    cross.setAttribute("visibility", "visible");
    const rows = S.players.map((p) => ({ p, v: point.worth[p.id] })).sort((a, b) => b.v - a.v);
    tip.innerHTML = `<b>${point.final ? "End of game" : `Round ${point.round}`}</b>${rows.map((r) => `<div><i style="background:${chartColor(r.p)}"></i>${r.p.token} ${esc(r.p.name)}<span>${fmt(r.v)}</span></div>`).join("")}`;
    tip.hidden = false;
    const left = (g.x(k) / g.W) * svg.clientWidth;
    tip.style.left = `${Math.min(Math.max(left, 70), svg.clientWidth - 70)}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
}

// ---------------------------------------------------------------- CPU logic

// How difficulty changes a CPU's play. `rivals` scales how much it minds a trade
// helping the other side; `reserve` scales the cash it holds back when buying and
// building; `bid` scales how high it goes at auction; `accept` is the margin a
// trade must give it; `setCaution` is the least weight it gives a rival's gain
// when a deal completes a colour set for them; easy CPUs never start trades. Hard CPUs (`smart`) size
// their cash reserve to the rent they could land on, price property by what it
// does for their position and for rivals', and build where rent pays back best.
const CPU_LEVELS = {
  easy: { label: "Easy", rivals: 0.35, setCaution: 1, reserve: 2, bid: 0.75, accept: 0, noProposals: true },
  normal: { label: "Normal", rivals: 1, setCaution: 1.15, reserve: 1, bid: 1, accept: 25 },
  hard: { label: "Hard", rivals: 1.15, setCaution: 1.3, reserve: 1, bid: 1, accept: 40, smart: true },
};
const level = (p) => CPU_LEVELS[p.level] || CPU_LEVELS.normal;

// Optional CPU personalities, on top of difficulty. `stations` scales how much it
// values stations and utilities, `reserve`/`buildReserve` the cash it holds back,
// `idleCash` how little it thinks of unused cash, `patience` how long it waits
// before asking about a deal again, `accept` the margin it wants from a trade,
// `rivals` how much it minds others gaining, `bid` how high it goes at auction.
const PERSONAS = {
  steady: { icon: "⚖️", label: "Steady", text: "Plays it by the book." },
  collector: { icon: "🚂", label: "Collector", text: "Loves stations and utilities.", stations: 2 },
  developer: { icon: "🏗️", label: "Developer", text: "Builds fast, mortgaging whatever it takes.", buildReserve: 0.5, mortgageToBuild: true },
  hoarder: { icon: "💰", label: "Hoarder", text: "Sits on a big pile of cash.", reserve: 1.8, buildReserve: 1.8, idleCash: 0 },
  dealmaker: { icon: "🤝", label: "Dealmaker", text: "Always after a trade, and easier to deal with.", patience: 0.5, accept: -15, rivals: 0.85 },
  gambler: { icon: "🎲", label: "Gambler", text: "Buys nearly everything and bids high.", reserve: 0.3, bid: 1.2 },
};
const PERSONA_DEFAULTS = { stations: 1, reserve: 1, buildReserve: 1, idleCash: 0.3, patience: 1, accept: 0, rivals: 1, bid: 1, mortgageToBuild: false };
const persona = (p) => ({ ...PERSONA_DEFAULTS, ...PERSONAS[p.persona] });

function cpuValue(p, i) {
  const b = BOARD[i];
  let v = b.price;
  if (b.group) {
    const set = GROUP_TILES[b.group];
    const mine = set.filter((j) => S.tiles[j].owner === p.id).length;
    const owners = new Set(set.map((j) => S.tiles[j].owner).filter((o) => o !== null && o !== p.id));
    if (mine === set.length - 1) v *= 1.9; // completes my set
    else if (mine > 0 && owners.size === 0) v *= 1.35;
    if (owners.size === 1 && set.filter((j) => S.tiles[j].owner === [...owners][0]).length === set.length - 1) v *= 1.5; // blocks a rival
  } else if (b.type === "station") v *= 1 + 0.25 * countType(p.id, "station");
  else if (b.type === "utility") v *= countType(p.id, "utility") ? 1.3 : 0.9;
  return Math.round(v);
}

// Cash worth keeping back against the rent p could land on with its next roll.
function dangerReserve(p, withEvent = true) {
  let expected = 0, worst = 0;
  for (let roll = 2; roll <= 12; roll++) {
    const i = (p.pos + (withEvent ? stepsFor(roll) : roll)) % 40, t = S.tiles[i];
    if (!isBuyable(i) || t.owner === null || t.owner === p.id) continue;
    const rent = withEvent ? rentFor(i, roll) : baseRent(i, roll);
    expected += rent * (6 - Math.abs(7 - roll)) / 36;
    worst = Math.max(worst, rent);
  }
  return Math.max(60, expected * 2 + worst * 0.35);
}

// The most a smart CPU would pay for tile i: what it adds to p's position, plus
// part of what it would add to the rival who'd gain most from it.
function smartPrice(p, i) {
  const before = S.tiles.map((t) => t.owner);
  const worth = (q, paid) => {
    const after = before.slice();
    after[i] = q.id;
    return positionValue(q.id, after, q.cash - paid, persona(p)) - positionValue(q.id, before, q.cash, persona(p));
  };
  const denial = Math.max(0, ...alive().filter((q) => q !== p).map((q) => rivalWeight(p, q) * (worth(q, BOARD[i].price) - BOARD[i].price * 0.2)));
  let lo = 0, hi = Math.max(0, p.cash - dangerReserve(p) * persona(p).reserve);
  while (hi - lo > 5) {
    const mid = (lo + hi) / 2;
    if (worth(p, mid) + denial * 0.5 > 0) lo = mid; else hi = mid;
  }
  return Math.floor(lo / 10) * 10;
}

// Extra cash a Normal CPU keeps back because this round's event makes the
// squares ahead dearer (Hard CPUs already reckon with the real rents; Easy ones don't).
const eventCaution = (p) => (p.level === "normal" && activeEvent() ? Math.max(0, dangerReserve(p) - dangerReserve(p, false)) : 0);

function cpuWantsToBuy(p, i) {
  const price = buyPrice(i);
  if (level(p).smart) return smartPrice(p, i) >= price;
  const keen = cpuValue(p, i) >= price * 1.4;
  const reserve = keen ? 40 : unownedCount() > 14 ? 100 : 180;
  return p.cash - price >= reserve * level(p).reserve * persona(p).reserve + eventCaution(p);
}

function cpuRaiseFunds(p, amount) {
  // During a hot street, the set earning double rent is the last thing to mortgage.
  const hot = (i) => eventIs("hot") && BOARD[i].group === S.event.group;
  const mortgageables = () => ownedBy(p).filter((i) => canMortgage(p, i)).sort((a, b) => hot(a) - hot(b));
  while (p.cash < amount) {
    // 1. mortgage things that aren't part of a full set
    let m = mortgageables().filter((i) => !BOARD[i].group || !ownsSet(p.id, BOARD[i].group));
    if (m.length) { m.sort((a, b) => hot(a) - hot(b) || BOARD[a].price - BOARD[b].price); mortgage(p, m[0]); continue; }
    // 2. sell buildings
    const s = ownedBy(p).filter((i) => canSell(p, i));
    if (s.length) { s.sort((a, b) => S.tiles[b].houses - S.tiles[a].houses); sell(p, s[0]); continue; }
    // 3. mortgage everything else
    m = mortgageables();
    if (m.length) { mortgage(p, m[0]); continue; }
    break;
  }
  render();
  return p.cash >= amount;
}

async function cpuManage(p) {
  if (p.bankrupt) return;
  let reserve = (level(p).smart ? dangerReserve(p) + 40 : (150 + 20 * alive().length) * level(p).reserve) * persona(p).buildReserve + eventCaution(p);
  // A building boom is the time to build: Normal and Hard CPUs dig deeper.
  if (eventIs("boom") && p.level !== "easy") reserve *= 0.6;
  // No mortgaging to build during a market crash; it pays out less.
  const smart = (level(p).smart || persona(p).mortgageToBuild) && !eventIs("crash");
  const freed = [], built = new Map(), mortgaged = [];
  // Smart CPUs get every set they own up to three houses before anything else.
  const underBuilt = () => S.housesLeft > 0 && ownedBy(p).some((i) => BOARD[i].group && ownsSet(p.id, BOARD[i].group) && S.tiles[i].houses < 3
    && GROUP_TILES[BOARD[i].group].every((j) => !S.tiles[j].mortgaged));
  // pay off mortgages when rich
  for (const i of ownedBy(p)) {
    if (smart && underBuilt() && !(BOARD[i].group && ownsSet(p.id, BOARD[i].group))) continue;
    if (S.tiles[i].mortgaged && p.cash - unmortgageCost(i) > reserve * 2) { unmortgage(p, i); freed.push(BOARD[i].name); }
  }
  // build evenly, best groups first
  while (true) {
    let options = ownedBy(p).filter((i) => canBuild(p, i) && p.cash - houseCost(BOARD[i].group) >= reserve);
    if (!options.length && smart && underBuilt()) {
      // Mortgage a property that isn't part of a set to pay for the next house.
      const spare = ownedBy(p).filter((i) => canMortgage(p, i) && !(BOARD[i].group && ownsSet(p.id, BOARD[i].group)));
      if (!spare.length) break;
      spare.sort((a, b) => BOARD[a].price - BOARD[b].price);
      mortgage(p, spare[0]);
      mortgaged.push(BOARD[spare[0]].name);
      continue;
    }
    if (!options.length) break;
    // Smart CPUs build where the next house adds the most rent per pound.
    const payback = (i) => ((BOARD[i].rents[S.tiles[i].houses + 1] - BOARD[i].rents[S.tiles[i].houses]) * LANDING[BOARD[i].group]) / GROUPS[BOARD[i].group].houseCost;
    options.sort((a, b) => S.tiles[a].houses - S.tiles[b].houses || (level(p).smart ? payback(b) - payback(a) : BOARD[b].price - BOARD[a].price));
    build(p, options[0]);
    built.set(options[0], S.tiles[options[0]].houses);
  }
  const done = [];
  if (mortgaged.length) done.push(`mortgaged ${mortgaged.map(esc).join(", ")}`);
  if (freed.length) done.push(`paid off the mortgage on ${freed.map(esc).join(", ")}`);
  if (built.size) done.push(`built up ${[...built].map(([i, h]) => `${esc(BOARD[i].name)} (${h === 5 ? "hotel" : `${h} house${h > 1 ? "s" : ""}`})`).join(", ")}`);
  if (done.length) await announce(`${p.token} <b>${esc(p.name)}</b> ${done.join(" and ")}.`, 2000);
}

// ---------------------------------------------------------------- CPU trading

// How much a set's squares get landed on, relative to average (Jail feeds orange and red).
const LANDING = { brown: 0.85, lightblue: 0.95, pink: 1, orange: 1.2, red: 1.1, yellow: 1, green: 0.95, darkblue: 0.9 };
const STATION_BONUS = [0, 0, 40, 110, 250];

// What `pid`'s holdings are worth to them if tile i belonged to owners[i] and
// they had `cash`. A full set is worth its deeds plus the rent it can earn once
// built up, which depends on having the cash to build.
function positionValue(pid, owners, cash, view = PERSONA_DEFAULTS) {
  const deed = (i) => (S.tiles[i].mortgaged ? BOARD[i].price * 0.45 : BOARD[i].price);
  let v = 0, potential = 0, needed = 0;
  for (const [g, tiles] of Object.entries(GROUP_TILES)) {
    const mine = tiles.filter((i) => owners[i] === pid);
    if (!mine.length) continue;
    for (const i of mine) v += deed(i);
    // Rent at three houses, less a share of what those houses cost.
    const earning = tiles.reduce((s, i) => s + BOARD[i].rents[3], 0) * 0.6 * LANDING[g] - tiles.length * GROUPS[g].houseCost * 0.9;
    if (mine.length === tiles.length) {
      potential += earning;
      for (const i of tiles) {
        needed += Math.max(0, 3 - S.tiles[i].houses) * GROUPS[g].houseCost;
        if (S.tiles[i].mortgaged) needed += unmortgageCost(i);
      }
    } else if (tiles.every((i) => owners[i] === pid || owners[i] === null)) {
      v += earning * 0.15 * (mine.length / tiles.length); // still possible to complete from the bank
    }
  }
  v += potential * (0.6 + 0.4 * (needed ? Math.min(1, Math.max(0, cash - 100) / needed) : 1));
  // Running low on cash is risky; cash beyond what building needs earns nothing.
  v += cash - Math.max(0, 150 - cash) - view.idleCash * Math.max(0, cash - needed - 300);
  for (const type of ["station", "utility"]) {
    const mine = BOARD.map((b, i) => i).filter((i) => BOARD[i].type === type && owners[i] === pid);
    for (const i of mine) v += deed(i) * (1 + (view.stations - 1) * 0.25);
    v += (type === "station" ? STATION_BONUS[mine.length] : mine.length === 2 ? 40 : 0) * view.stations;
  }
  return v;
}

// How much CPU `p` minds `other` gaining: fully in a duel, less with several
// rivals (helping one of them still leaves the rest behind), more if `other` leads.
function rivalWeight(p, other) {
  const rivals = alive().filter((q) => q !== p);
  const w = rivals.length <= 1 ? 1 : netWorth(other) >= Math.max(...rivals.map(netWorth)) ? 0.85 : 0.6;
  return w * level(p).rivals * persona(p).rivals;
}

// Value of a trade to CPU `p`: p gives `give` and gets `get` plus `cashToP`
// (negative if p pays). It's p's own gain minus a share of what `other` gains,
// so handing a rival a colour set costs what that set is worth to them.
function cpuTradeScore(p, other, give, get, cashToP) {
  const before = S.tiles.map((t) => t.owner);
  const after = before.slice();
  for (const i of give) if (!isCard(i)) after[i] = other.id;
  for (const i of get) if (!isCard(i)) after[i] = p.id;
  // A Get Out of Jail Free card saves the £50 fine; once the board is built up
  // staying in Jail is often better, so it's worth less.
  const cards = (get.filter(isCard).length - give.filter(isCard).length) * (unownedCount() > 8 ? 50 : 20);
  const view = persona(p);
  const mine = positionValue(p.id, after, p.cash + cashToP, view) - positionValue(p.id, before, p.cash, view) + cards;
  const theirs = positionValue(other.id, after, other.cash - cashToP, view) - positionValue(other.id, before, other.cash, view) - cards;
  // Handing a rival a whole colour set is how games are lost: unless we complete
  // one of our own in the same deal, their gain counts (at least) in full.
  const completes = (pid) => Object.keys(GROUP_TILES).some((g) => GROUP_TILES[g].every((i) => after[i] === pid) && !GROUP_TILES[g].every((i) => before[i] === pid));
  const weight = completes(other.id) && !completes(p.id) ? Math.max(rivalWeight(p, other), level(p).setCaution) : rivalWeight(p, other);
  return { mine, theirs, score: mine - weight * theirs };
}

const cpuAccepts = (p, other, give, get, cashToP) =>
  p.cash + cashToP >= 50 && cpuTradeScore(p, other, give, get, cashToP).score > level(p).accept + persona(p).accept;

// The cash (from p to other, in £10 steps, possibly negative) that makes the
// deal just good enough for `other`, or null if no amount in range will do.
function cheapestCash(lo, hi, ok) {
  if (!ok(hi)) return null;
  while (hi - lo > 10) {
    const mid = Math.round((lo + hi) / 20) * 10;
    if (mid <= lo || mid >= hi) break;
    if (ok(mid)) hi = mid; else lo = mid;
  }
  return ok(lo) ? lo : hi;
}

// When CPU `cpu` turns down `human`'s offer (human gives `give` plus `cash`, gets
// `get`), find the deal nearest to it that the CPU would take: a different cash
// amount, one more of the human's properties, or one fewer of the CPU's. Of
// those, offer the one that looks best for the human.
function cpuCounterOffer(cpu, human, give, get, cash) {
  const lo = -Math.max(0, Math.floor((cpu.cash - 50) / 10) * 10), hi = Math.floor(human.cash / 10) * 10;
  const options = [{ give, get }];
  for (const j of tradeItems(human)) if (!give.includes(j)) options.push({ give: [...give, j], get });
  if (get.length > 1) for (const j of get) options.push({ give, get: get.filter((k) => k !== j) });
  let best = null;
  for (const o of options) {
    const c = cheapestCash(lo, hi, (c) => cpuAccepts(cpu, human, o.get, o.give, c));
    if (c === null || (!o.give.length && !o.get.length)) continue;
    const forHuman = cpuTradeScore(human, cpu, o.give, o.get, -c).mine;
    if (!best || forHuman > best.forHuman) best = { ...o, cash: c, forHuman };
  }
  return best && (best.cash !== cash || best.give !== give || best.get !== get) ? best : null;
}

// A CPU looks for the best deal that gets it closer to a colour set (or more
// stations/utilities) and that the other side should accept.
async function cpuTryTrade(p) {
  if (level(p).noProposals) return;
  S.tradeAsked = S.tradeAsked || {};
  const myTiles = tradeable(p);
  let best = null;
  for (const other of alive().filter((o) => o !== p)) {
    const theirTiles = tradeable(other);
    const wants = new Map(); // key -> tiles to ask for
    for (const i of theirTiles) {
      const b = BOARD[i];
      if (b.group) {
        const tiles = GROUP_TILES[b.group];
        if (!tiles.some((j) => S.tiles[j].owner === p.id)) continue;
        const missing = tiles.filter((j) => S.tiles[j].owner !== p.id);
        // Ask for everything still missing if they hold all of it, else just this one.
        const want = missing.every((j) => theirTiles.includes(j)) ? missing : [i];
        wants.set(want.join(","), want);
      } else if (countType(p.id, b.type)) wants.set(`${i}`, [i]);
    }
    for (const [key, get] of wants) {
      const k = `${p.id}-${other.id}-${key}`;
      if ((S.tradeAsked[k] || 0) > S.round) continue;
      // What we might hand over: nothing, any single property, or our share of a set they're building.
      const gives = [[], ...myTiles.filter((j) => !get.some((g) => BOARD[g].group && BOARD[g].group === BOARD[j].group)).map((j) => [j])];
      for (const g of Object.keys(GROUP_TILES)) {
        const ours = GROUP_TILES[g].filter((j) => S.tiles[j].owner === p.id);
        const theirs = GROUP_TILES[g].filter((j) => S.tiles[j].owner === other.id);
        if (ours.length > 1 && theirs.length && ours.every((j) => myTiles.includes(j)) && GROUP_TILES[g].every((j) => ours.includes(j) || theirs.includes(j))) gives.push(ours);
      }
      for (const d of p.jailCards) gives.push([`jail:${d}`]);
      const accept = other.cpu
        ? (give, c) => cpuAccepts(other, p, get, give, c)
        // For a human, offer what our own judgement would call a fair deal for them.
        : (give, c) => { const t = cpuTradeScore(other, p, get, give, c); return t.mine > 0 && t.score > -40; };
      for (const give of gives) {
        const c = cheapestCash(-Math.max(0, Math.floor((other.cash - 100) / 10) * 10),
          Math.max(0, Math.floor((p.cash - 200) / 10) * 10), (c) => accept(give, c));
        if (c === null || (!give.length && c <= 0)) continue;
        const { score } = cpuTradeScore(p, other, give, get, -c);
        if (score > level(p).accept + persona(p).accept + 15 && (!best || score > best.score)) best = { other, give, get, cash: c, score, k };
      }
    }
  }
  if (!best) return;
  const { other, give, get, cash } = best;
  S.tradeAsked[best.k] = S.round + Math.ceil((other.cpu ? 2 : 6) * persona(p).patience);
  const side = (items, money) => [...items.map(itemName), money > 0 ? fmt(money) : ""].filter(Boolean).join(" + ") || "nothing";
  if (!other.cpu) {
    const accepted = await modal({
      title: `🤝 Offer from ${p.token} ${esc(p.name)}`,
      html: `<p><b>${esc(other.name)}</b>, ${esc(p.name)} offers you <b>${esc(side(give, cash))}</b>
        in exchange for <b>${esc(side(get, -cash))}</b>.</p>${get.map((j) => deedHtml(j)).join("")}`,
      buttons: [{ label: "Decline", value: false, danger: true }, { label: "Accept", value: true, primary: true }],
    });
    if (!accepted) {
      log(`${other.name} turned down ${p.name}'s offer for ${side(get, 0)}.`, p);
      hook("declined", { p, other });
      return;
    }
  }
  if (other.cpu) {
    await announce(`🤝 ${p.token} <b>${esc(p.name)}</b> offers ${other.token} <b>${esc(other.name)}</b> ${esc(side(give, cash))} for ${esc(side(get, -cash))}…`, 2200);
  }
  transferItems(get, other, p);
  transferItems(give, p, other);
  p.cash -= cash;
  other.cash += cash;
  log(`🤝 ${p.name} traded with ${other.name}: gave ${side(give, cash)}, got ${side(get, -cash)}.`, p, true);
  stats().trades.push({ round: S.round, who: [p.id, other.id], text: `${p.name} gave ${other.name} ${side(give, cash)} for ${side(get, -cash)}` });
  hook("trade", { p, other });
  toast(`${p.name} traded for ${get.map((j) => BOARD[j].name).join(", ")}`);
  if (other.cpu) await announce(`🤝 ${esc(other.name)} accepted. ${esc(p.name)} now owns ${esc(get.map((j) => BOARD[j].name).join(", "))}.`, 1800);
  render();
}

// ---------------------------------------------------------------- UI: prompts, modals, toasts

// `timeout` (ms) auto-picks the first action, e.g. to move on from a card.
function ask(p, html, actions, card = "", timeout = 0) {
  return new Promise((resolve) => {
    pending = { p, html, actions, card, resolve, timeout };
    if (timeout) pending.timer = setTimeout(() => choose(0), timeout);
    render();
  });
}

function choose(k) {
  if (!pending) return;
  const a = pending.actions[k];
  if (!a || (typeof a.disabled === "function" ? a.disabled() : a.disabled)) return;
  const r = pending.resolve;
  clearTimeout(pending.timer);
  pending = null;
  r(a.value);
  render();
}

// Tell a player what happened. Humans get an OK button only when `ack` is set
// (cards), and even then the game moves on by itself after a few seconds.
async function showInfo(p, html, ack = false) {
  if (p.cpu || !ack) {
    setStatus(html);
    await sleep(p.cpu ? 1400 : 1100);
  } else {
    await ask(p, "", [{ label: "OK", value: true, primary: true }], html, 5000);
  }
}

function setStatus(html) {
  S.status = html;
  renderPrompt();
}

function log(msg, p, strong = false) {
  S.log.push({ msg, c: p ? p.color : null, strong });
  if (S.log.length > 200) S.log.shift();
  renderLog();
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// Easter egg: tap the logo or the dice five times quickly, or type the Konami
// code, and it rains money. Purely for show; the game state is never touched.
const PENNYBAGS = [
  "Rich Uncle Pennybags approves. 🎩",
  "Bank error in your favour. (Not really.)",
  "Do not pass GO. Do collect confetti.",
  "Made with ❤️ since GA SEI-33.",
];
function moneyRain() {
  hook("egg", {});
  toast(PENNYBAGS[Math.floor(Math.random() * PENNYBAGS.length)]);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || document.querySelector(".money-rain")) return;
  const rain = document.createElement("div");
  rain.className = "money-rain";
  rain.setAttribute("aria-hidden", "true");
  for (let k = 0; k < 40; k++) {
    const s = document.createElement("span");
    s.textContent = ["💷", "💵", "💰", "🎩", "🪙"][k % 5];
    s.style.cssText = `left:${Math.random() * 100}%;animation-delay:${Math.random() * 1.2}s;animation-duration:${2 + Math.random() * 1.5}s;font-size:${18 + Math.random() * 22}px`;
    rain.append(s);
  }
  document.body.append(rain);
  $(".brand").classList.add("spin");
  setTimeout(() => { rain.remove(); $(".brand").classList.remove("spin"); }, 4000);
}

function setupEasterEgg() {
  let taps = [];
  const tap = () => {
    const now = Date.now();
    taps = taps.filter((t) => now - t < 1500).concat(now);
    if (taps.length >= 5) { taps = []; moneyRain(); }
  };
  $(".brand").addEventListener("click", tap);
  $("#dice").addEventListener("click", tap);
  const code = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
  let at = 0;
  document.addEventListener("keydown", (e) => {
    at = e.key === code[at] ? at + 1 : e.key === code[0] ? 1 : 0;
    if (at === code.length) { at = 0; moneyRain(); }
  });
}

// Generic modal. Resolves with the clicked button's value.
let modalState = null;
function modal({ title, html, buttons = [], onMount, wide }) {
  return new Promise((resolve) => {
    const root = $("#modal");
    root.innerHTML = `<div class="modal-box ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
      <h2>${title}</h2><div class="modal-body">${html}</div>
      <div class="modal-buttons">${buttons.map((b, k) => `<button data-k="${k}" class="${b.primary ? "primary" : ""} ${b.danger ? "danger" : ""}">${b.label}</button>`).join("")}</div>
    </div>`;
    root.hidden = false;
    const close = (v) => { root.hidden = true; root.innerHTML = ""; modalState = null; resolve(v); };
    modalState = { close };
    root.querySelectorAll(".modal-buttons button").forEach((btn) =>
      btn.addEventListener("click", () => {
        const b = buttons[+btn.dataset.k];
        if (b.onClick && b.onClick() === false) return;
        close(b.value);
      })
    );
    if (onMount) onMount(root.querySelector(".modal-box"), close);
  });
}

function cardHtml(deck, text) {
  return `<div class="card ${deck}"><div class="card-title">${deck === "chance" ? "❓ Chance" : "🎁 Community Chest"}</div><p>${esc(text)}</p></div>`;
}

function deedHtml(i) {
  const b = BOARD[i], t = S.tiles[i];
  const owner = t.owner !== null ? P(t.owner) : null;
  let body = "";
  if (b.type === "property") {
    const r = b.rents;
    body = `<table>
      <tr><td>Rent</td><td>${fmt(r[0])}</td></tr>
      <tr><td>Rent with colour set</td><td>${fmt(r[0] * 2)}</td></tr>
      ${[1, 2, 3, 4].map((h) => `<tr><td>With ${h} house${h > 1 ? "s" : ""}</td><td>${fmt(r[h])}</td></tr>`).join("")}
      <tr><td>With hotel</td><td>${fmt(r[5])}</td></tr>
    </table>
    <p class="small">Houses ${fmt(GROUPS[b.group].houseCost)} each · Hotel ${fmt(GROUPS[b.group].houseCost)} + 4 houses</p>`;
  } else if (b.type === "station") {
    body = `<table>${[1, 2, 3, 4].map((n) => `<tr><td>${n} station${n > 1 ? "s" : ""} owned</td><td>${fmt(25 * 2 ** (n - 1))}</td></tr>`).join("")}</table>`;
  } else {
    body = `<p class="small">Rent is 4× the dice roll if one utility is owned, 10× if both are owned.</p>`;
  }
  return `<div class="deed">
    <div class="deed-head" style="background:${b.group ? GROUPS[b.group].color : "#ddd"}; color:${b.group && !["yellow", "lightblue"].includes(b.group) ? "#fff" : "#111"}">
      ${b.icon ? `<span class="deed-icon">${b.icon}</span>` : '<span class="small">TITLE DEED</span>'}<b>${esc(b.name)}</b></div>
    ${body}
    <p class="small">Price ${fmt(b.price)} · Mortgage ${fmt(b.price / 2)}</p>
    ${owner ? `<p class="deed-owner">Owner: <span class="tok" style="--c:${owner.color}">${owner.token}</span> ${esc(owner.name)}${t.mortgaged ? " · <b>MORTGAGED</b>" : ""}${t.houses ? ` · ${t.houses === 5 ? "hotel" : t.houses + " house" + (t.houses > 1 ? "s" : "")}` : ""}${t.owner !== null && !t.mortgaged ? ` · current rent ${b.type === "utility" ? (countType(t.owner, "utility") === 2 ? "10×" : "4×") + " dice" : fmt(rentFor(i, 0))}` : ""}</p>` : '<p class="deed-owner">Unowned</p>'}
  </div>`;
}

// ---------------------------------------------------------------- UI: manage properties

function openManage(p) {
  const rowsHtml = () => {
    const mine = ownedBy(p);
    if (!mine.length) return "<p>You don't own any property yet.</p>";
    return `<div class="manage-list">${mine.map((i) => {
      const b = BOARD[i], t = S.tiles[i];
      const color = b.group ? GROUPS[b.group].color : "#bbb";
      const houses = t.houses === 5 ? "🏨 " : "🏠".repeat(t.houses) + (t.houses ? " " : "");
      // What it earns now, and what the next house would make it.
      let status;
      if (t.mortgaged) status = "Mortgaged · no rent";
      else if (b.type === "utility") status = `Rent ${countType(p.id, "utility") === 2 ? 10 : 4}× the dice`;
      else if (b.type === "station") status = `Rent ${fmt(rentFor(i, 0))}`;
      else {
        const next = ownsSet(p.id, b.group) && t.houses < 5 ? b.rents[t.houses + 1] * eventRentFactor(i) : null;
        status = `${houses}Rent ${fmt(rentFor(i, 0))}${next !== null ? ` → ${fmt(next)} with ${t.houses === 4 ? "a hotel" : "another house"}` : ""}`;
      }
      const blocker = b.type === "property" && !t.mortgaged ? buildBlocker(p, i) : "";
      const hint = t.mortgaged
        ? (canUnmortgage(p, i) ? "" : `Need ${fmt(unmortgageCost(i))} to pay off the mortgage`)
        : blocker === "Fully built" ? "" : blocker;
      const mortgageNote = !t.mortgaged && !canMortgage(p, i) ? "Sell this set's houses before mortgaging" : "Mortgage for half its price";
      return `<div class="manage-row ${t.mortgaged ? "mortgaged" : ""}">
        <span class="swatch" style="background:${color}">${b.icon || ""}</span>
        <span class="mname">${esc(b.name)}<small>${status}</small>${hint ? `<small class="mhint">${esc(hint)}</small>` : ""}</span>
        <span class="mbtns">${b.type === "property" ? `
          <button data-act="build" data-i="${i}" ${canBuild(p, i) ? "" : "disabled"} title="${esc(blocker || `Build for ${fmt(houseCost(b.group))}`)}">+🏠 ${fmt(houseCost(b.group))}</button>
          <button data-act="sell" data-i="${i}" ${canSell(p, i) ? "" : "disabled"} title="${t.houses ? (canSell(p, i) ? `Sell for ${fmt(GROUPS[b.group].houseCost / 2)}` : "Sell evenly: sell from the others first") : "No houses to sell"}">−🏠</button>` : ""}
        ${t.mortgaged
          ? `<button data-act="unmortgage" data-i="${i}" ${canUnmortgage(p, i) ? "" : "disabled"}>Unmortgage ${fmt(unmortgageCost(i))}</button>`
          : `<button data-act="mortgage" data-i="${i}" ${canMortgage(p, i) ? "" : "disabled"} title="${mortgageNote}">Mortgage +${fmt(mortgageValue(i))}</button>`}</span>
      </div>`;
    }).join("")}</div>
    <p class="small">Build evenly across a full colour set. Bank stock: ${S.housesLeft} houses, ${S.hotelsLeft} hotels.</p>`;
  };
  // Each change made here can be undone until the window is closed.
  const undo = [];
  const snapshot = () => ({ tiles: S.tiles.map((t) => ({ ...t })), cash: p.cash, houses: S.housesLeft, hotels: S.hotelsLeft, log: S.log.slice() });
  modal({
    title: `${p.token} ${esc(p.name)} — ${'<span id="manage-cash"></span>'}`,
    html: `<div id="manage-rows"></div><button id="manage-undo" class="ghost" disabled>↶ Undo</button>`,
    buttons: [{ label: "Done", value: true, primary: true }],
    wide: true,
    onMount(box) {
      const refresh = () => {
        box.querySelector("#manage-rows").innerHTML = rowsHtml();
        box.querySelector("#manage-cash").textContent = fmt(p.cash);
        const u = box.querySelector("#manage-undo");
        u.disabled = !undo.length;
        u.textContent = undo.length ? `↶ Undo ${undo[undo.length - 1].what}` : "↶ Undo";
        render();
      };
      box.addEventListener("click", (e) => {
        if (e.target.closest("#manage-undo")) {
          const snap = undo.pop();
          if (!snap) return;
          S.tiles.forEach((t, k) => Object.assign(t, snap.tiles[k]));
          [p.cash, S.housesLeft, S.hotelsLeft, S.log] = [snap.cash, snap.houses, snap.hotels, snap.log];
          renderLog();
          return refresh();
        }
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const i = +btn.dataset.i, act = btn.dataset.act;
        undo.push({ ...snapshot(), what: { build: "build", sell: "sale", mortgage: "mortgage", unmortgage: "unmortgage" }[act] + ` on ${BOARD[i].name}` });
        ({ build, sell, mortgage, unmortgage })[act](p, i);
        refresh();
      });
      refresh();
    },
  });
}

// ---------------------------------------------------------------- UI: trading

function tradeable(p) {
  return ownedBy(p).filter((i) => !(BOARD[i].group && groupHasBuildings(BOARD[i].group)));
}

// Trade items are tile indices, or "jail:chance" / "jail:chest" for a Get Out of Jail Free card.
const isCard = (x) => typeof x === "string";
const tradeItems = (p) => [...tradeable(p), ...p.jailCards.map((d) => `jail:${d}`)];
const parseItem = (v) => (v.startsWith("jail:") ? v : +v);
const itemName = (x) => (isCard(x) ? `Get Out of Jail Free card` : BOARD[x].name);

function transferItems(items, from, to) {
  for (const x of items) {
    if (!isCard(x)) { S.tiles[x].owner = to.id; continue; }
    const deck = x.slice(5);
    from.jailCards.splice(from.jailCards.indexOf(deck), 1);
    to.jailCards.push(deck);
  }
}

function openTrade(p) {
  const others = alive().filter((o) => o !== p);
  if (!others.length) return;
  let other = others[0];
  const propList = (owner, side) => {
    const list = tradeItems(owner);
    if (!list.length) return '<p class="small">Nothing to trade.</p>';
    return list.map((i) => isCard(i)
      ? `<label class="trade-prop"><input type="checkbox" data-side="${side}" value="${i}">
        <span class="swatch" style="background:#f3e3a6">🎫</span> Get Out of Jail Free</label>`
      : `<label class="trade-prop"><input type="checkbox" data-side="${side}" value="${i}">
        <span class="swatch" style="background:${BOARD[i].group ? GROUPS[BOARD[i].group].color : "#bbb"}">${BOARD[i].icon || ""}</span>
        ${esc(BOARD[i].name)}${S.tiles[i].mortgaged ? " <small>(mortgaged)</small>" : ""}</label>`).join("");
  };
  modal({
    title: "🤝 Propose a trade",
    wide: true,
    html: `<label class="trade-with">Trade with <select id="trade-other">${others.map((o) => `<option value="${o.id}">${o.token} ${esc(o.name)}${o.cpu ? ` (CPU · ${level(o).label}${o.persona ? ` · ${PERSONAS[o.persona].label}` : ""})` : ""}</option>`).join("")}</select></label>
      <div class="trade-cols">
        <div><h3>You give</h3><div id="trade-give"></div><label class="trade-cash">Cash £<input type="number" id="cash-give" min="0" step="10" value="0"></label></div>
        <div><h3>You get</h3><div id="trade-get"></div><label class="trade-cash">Cash £<input type="number" id="cash-get" min="0" step="10" value="0"></label></div>
      </div><p id="trade-hint" class="trade-hint"></p><p id="trade-msg" class="trade-msg"></p>`,
    buttons: [
      { label: "Cancel", value: false },
      { label: "Propose", value: true, primary: true, onClick: () => { proposeTrade(); return false; } },
    ],
    onMount(box, close) {
      const fill = () => {
        box.querySelector("#trade-give").innerHTML = propList(p, "give");
        box.querySelector("#trade-get").innerHTML = propList(other, "get");
        box.querySelector("#cash-give").max = p.cash;
        box.querySelector("#cash-get").max = other.cash;
      };
      const readForm = () => ({
        give: [...box.querySelectorAll('input[data-side="give"]:checked')].map((x) => parseItem(x.value)),
        get: [...box.querySelectorAll('input[data-side="get"]:checked')].map((x) => parseItem(x.value)),
        cashGive: Math.max(0, Math.floor(+box.querySelector("#cash-give").value || 0)),
        cashGet: Math.max(0, Math.floor(+box.querySelector("#cash-get").value || 0)),
      });
      // Live read on whether a CPU would take the deal as it stands.
      const hint = () => {
        const el = box.querySelector("#trade-hint");
        const { give, get, cashGive, cashGet } = readForm();
        if (!other.cpu || (!give.length && !get.length && !cashGive && !cashGet) || cashGive > p.cash || cashGet > other.cash) return (el.textContent = "");
        const net = cashGive - cashGet, ok = (c) => cpuAccepts(other, p, get, give, c);
        if (ok(net)) {
          const less = cheapestCash(-Math.max(0, Math.floor((other.cash - 50) / 10) * 10), net, ok);
          el.textContent = `✅ ${other.name} would accept this${less !== null && net - less >= 20 ? ` (you could offer ${fmt(net - less)} less)` : ""}.`;
        } else {
          const c = cheapestCash(net, Math.floor(p.cash / 10) * 10, ok);
          el.textContent = c !== null ? `🤔 ${other.name} would want about ${fmt(c - net)} more.` : `❌ ${other.name} isn't interested on these terms.`;
        }
      };
      box.querySelector(".trade-cols").addEventListener("input", hint);
      box.querySelector(".trade-cols").addEventListener("change", hint);
      box.querySelector("#trade-other").addEventListener("change", (e) => { other = P(+e.target.value); fill(); hint(); });
      fill();
      proposeTrade = async () => {
        const msg = box.querySelector("#trade-msg");
        const { give, get, cashGive, cashGet } = readForm();
        if (!give.length && !get.length && !cashGive && !cashGet) return (msg.textContent = "Add something to the trade.");
        if (cashGive > p.cash) return (msg.textContent = `You only have ${fmt(p.cash)}.`);
        if (cashGet > other.cash) return (msg.textContent = `${other.name} only has ${fmt(other.cash)}.`);
        let accepted;
        if (other.cpu) {
          accepted = cpuAccepts(other, p, get, give, cashGive - cashGet);
          if (!accepted) {
            const c = cpuCounterOffer(other, p, give, get, cashGive - cashGet);
            if (!c) return (msg.textContent = `${other.name} declines, and can't see a deal to be made here.`);
            // Put the counter-offer in the form so it can be agreed to or tweaked.
            box.querySelectorAll("input[data-side]").forEach((x) => (x.checked = (x.dataset.side === "give" ? c.give : c.get).includes(parseItem(x.value))));
            box.querySelector("#cash-give").value = Math.max(0, c.cash);
            box.querySelector("#cash-get").value = Math.max(0, -c.cash);
            const side = (items, money) => [...items.map((j) => esc(itemName(j))), money > 0 ? fmt(money) : ""].filter(Boolean).join(" + ") || "nothing";
            msg.innerHTML = `${esc(other.name)} declines, but counters: you give <b>${side(c.give, c.cash)}</b>, you get <b>${side(c.get, -c.cash)}</b>.
              <button class="primary counter-yes">Agree</button> <span class="small">or change it and propose again.</span>`;
            msg.querySelector(".counter-yes").addEventListener("click", () => proposeTrade());
            hint();
            return;
          }
        } else {
          const box2 = box.querySelector(".modal-buttons");
          box2.innerHTML = `<span class="handoff">${other.token} ${esc(other.name)}, accept this trade?</span>
            <button data-x="no" class="danger">Decline</button><button data-x="yes" class="primary">Accept</button>`;
          accepted = await new Promise((r) => box2.addEventListener("click", (e) => {
            const x = e.target.closest("button[data-x]");
            if (x) r(x.dataset.x === "yes");
          }));
          if (!accepted) { msg.textContent = `${other.name} declined.`; close(false); return; }
        }
        transferItems(give, p, other);
        transferItems(get, other, p);
        p.cash += cashGet - cashGive;
        other.cash += cashGive - cashGet;
        const names = (l) => l.map(itemName).join(", ");
        const gave = [names(give), cashGive ? fmt(cashGive) : ""].filter(Boolean).join(" + ") || "nothing";
        const got = [names(get), cashGet ? fmt(cashGet) : ""].filter(Boolean).join(" + ") || "nothing";
        log(`🤝 ${p.name} traded with ${other.name}: gave ${gave}, got ${got}.`, p);
        stats().trades.push({ round: S.round, who: [p.id, other.id], text: `${p.name} gave ${other.name} ${gave} for ${got}` });
        hook("trade", { p, other });
        toast("Trade completed!");
        close(true);
        render();
      };
    },
  });
}
let proposeTrade = () => {};

// ---------------------------------------------------------------- rendering

function tileGridPos(i) {
  if (i <= 10) return { row: 11, col: 11 - i, side: "bottom" };
  if (i <= 20) return { row: 11 - (i - 10), col: 1, side: "left" };
  if (i <= 30) return { row: 1, col: 1 + (i - 20), side: "top" };
  return { row: 1 + (i - 30), col: 11, side: "right" };
}

function buildBoard() {
  const board = $("#board");
  board.querySelectorAll(".tile").forEach((t) => t.remove());
  BOARD.forEach((b, i) => {
    const { row, col, side } = tileGridPos(i);
    const el = document.createElement("div");
    const corner = i % 10 === 0;
    el.className = `tile side-${side} type-${b.type} ${corner ? "corner" : ""}`;
    el.style.gridRow = row;
    el.style.gridColumn = col;
    el.dataset.i = i;
    el.innerHTML = `
      ${b.group ? `<div class="bar" style="background:${GROUPS[b.group].color}"><div class="buildings"></div></div>` : ""}
      <div class="tname">${esc(b.name)}</div>
      ${SHORT_NAMES[i] ? `<div class="tshort">${esc(SHORT_NAMES[i])}</div>` : ""}
      ${b.icon ? `<div class="ticon">${b.icon}</div>` : ""}
      ${b.price ? `<div class="tprice">${fmt(b.price)}</div>` : b.amount ? `<div class="tprice">Pay ${fmt(b.amount)}</div>` : ""}
      ${i === 0 ? '<div class="tprice">Collect £200</div>' : ""}
      <div class="owner-strip"></div>
      <div class="rent-tag"></div>
      <div class="tokens"></div>`;
    if (isBuyable(i)) el.addEventListener("click", () => modal({ title: esc(b.name), html: deedHtml(i), buttons: [{ label: "Close", value: true }] }));
    board.appendChild(el);
  });
}

function render() {
  if (!S) return;
  renderTiles();
  renderTokens();
  renderPlayers();
  renderPrompt();
  renderDice();
  renderLog();
  if (S.players.length) hook("render", {});
}

// The human about to roll, if any: their reachable squares get highlighted.
function rollerUp() {
  const p = pending?.p;
  return p && !p.cpu && !p.inJail && pending.actions.some((a) => a.value === "roll") ? p : null;
}

// What landing on tile i with dice total `roll` would cost p: [label, worrying?].
function landingCost(p, i, roll) {
  const b = BOARD[i], t = S.tiles[i];
  if (b.type === "gotojail") return ["Jail", true];
  if (b.type === "tax") return eventIs("taxfree") ? null : [fmt(b.amount), b.amount > p.cash * 0.3];
  if (!isBuyable(i) || t.owner === null || t.owner === p.id || t.mortgaged) return null;
  const rent = rentFor(i, roll);
  return rent ? [fmt(rent), rent >= 150 || rent > p.cash * 0.3] : null;
}

function renderTiles() {
  const roller = rollerUp();
  const reach = new Map();
  if (roller) for (let r = 2; r <= 12; r++) reach.set((roller.pos + stepsFor(r)) % 40, r);
  document.querySelectorAll("#board .tile").forEach((el) => {
    const i = +el.dataset.i, t = S.tiles[i];
    el.classList.toggle("reach", reach.has(i));
    const tag = el.querySelector(".rent-tag");
    const cost = reach.has(i) ? landingCost(roller, i, reach.get(i)) : null;
    tag.textContent = cost ? cost[0] : "";
    tag.classList.toggle("danger", !!cost?.[1]);
    if (!isBuyable(i)) return;
    // Hover summary, so the deed card is only needed for the full rent table.
    const b = BOARD[i], o = t.owner !== null ? P(t.owner) : null;
    const rent = b.type === "utility" ? `${countType(t.owner, "utility") === 2 ? 10 : 4}× dice` : fmt(rentFor(i, 0));
    el.title = o
      ? `${b.name} · owned by ${o.name}${t.mortgaged ? " · mortgaged, no rent" : ` · rent ${rent}`}${t.houses ? ` · ${t.houses === 5 ? "hotel" : `${t.houses} house${t.houses > 1 ? "s" : ""}`}` : ""}`
      : `${b.name} · for sale, ${fmt(buyPrice(i))}`;
    const strip = el.querySelector(".owner-strip");
    const owner = t.owner !== null ? P(t.owner) : null;
    strip.style.background = owner ? owner.color : "transparent";
    el.classList.toggle("owned", !!owner);
    if (owner) el.style.setProperty("--oc", owner.color);
    // Owned tiles show the owner's token where the price was.
    el.querySelector(".tprice").innerHTML = owner
      ? `<span class="obadge" style="--c:${owner.color}" title="Owned by ${esc(owner.name)}${t.mortgaged ? " (mortgaged)" : ""}">${owner.token}</span>`
      : fmt(BOARD[i].price);
    el.classList.toggle("mortgaged", t.mortgaged);
    const bld = el.querySelector(".buildings");
    if (bld) bld.innerHTML = t.houses === 5 ? '<i class="hotel"></i>' : '<i class="house"></i>'.repeat(t.houses);
  });
}

function renderTokens() {
  document.querySelectorAll("#board .tokens").forEach((t) => (t.innerHTML = ""));
  for (const p of S.players) {
    if (p.bankrupt) continue;
    const tile = document.querySelector(`#board .tile[data-i="${p.pos}"] .tokens`);
    const cur = p.id === S.turn ? "current" : "";
    tile.classList.toggle("crowd", tile.children.length >= 2);
    tile.insertAdjacentHTML("beforeend", `<span class="tok ${cur} ${p.inJail ? "jailed" : ""}" style="--c:${p.color}" title="${esc(p.name)}">${p.token}</span>`);
  }
}

function renderPlayers() {
  $("#players").innerHTML = S.players.map((p) => {
    const props = ownedBy(p);
    return `<div class="player ${p.id === S.turn ? "active" : ""} ${p.bankrupt ? "bankrupt" : ""}" style="--c:${p.color}">
      <div class="phead"><span class="tok" style="--c:${p.color}">${p.token}</span>
        <span class="pname">${esc(p.name)}${p.cpu ? ` <small>CPU${p.level && p.level !== "normal" ? ` · ${level(p).label}` : ""}</small>` : ""}${p.persona ? ` <small class="persona" title="${esc(PERSONAS[p.persona].text)}">${PERSONAS[p.persona].icon}<span> ${PERSONAS[p.persona].label}</span></small>` : ""}</span>
        <span class="pcash">${p.bankrupt ? "Bankrupt" : fmt(p.cash)}</span></div>
      ${p.bubble && p.bubble.until > Date.now() ? `<div class="bubble ${Date.now() - (p.bubble.since || 0) < 250 ? "fresh" : ""}">${esc(p.bubble.text)}</div>` : ""}
      <div class="pmeta">${p.inJail ? "🚔 In Jail · " : ""}${p.jailCards.length ? `🎫×${p.jailCards.length} · ` : ""}Net worth ${fmt(netWorth(p))}</div>
      <div class="pprops">${props.map((i) => `<span class="chip ${S.tiles[i].mortgaged ? "mort" : ""}" data-i="${i}" title="${esc(BOARD[i].name)}" style="background:${BOARD[i].group ? GROUPS[BOARD[i].group].color : "#ccc"}">${BOARD[i].icon || (S.tiles[i].houses === 5 ? "H" : S.tiles[i].houses || "")}</span>`).join("")}</div>
    </div>`;
  }).join("");
}

function renderPrompt() {
  const el = $("#prompt");
  const p = pending ? pending.p : null;
  if (pending) {
    el.innerHTML = `${pending.card ? `<div class="prompt-card">${pending.card}</div>` : ""}
      ${pending.html ? `<div class="prompt-msg">${pending.html}</div>` : ""}
      <div class="prompt-actions">${pending.actions.map((a, k) => {
        const dis = typeof a.disabled === "function" ? a.disabled() : a.disabled;
        const auto = pending.timeout && k === 0 ? `auto" style="--t:${pending.timeout}ms` : "";
        return `<button data-k="${k}" class="${a.primary ? "primary" : ""} ${a.danger ? "danger" : ""} ${auto}" ${dis ? "disabled" : ""}>${a.label}</button>`;
      }).join("")}</div>`;
  } else {
    el.innerHTML = `<div class="prompt-msg">${S.status || ""}</div>`;
  }
  const human = p && !p.cpu;
  $("#tools").hidden = !human;
  if (human) $("#tools-who").innerHTML = `<span class="tok" style="--c:${p.color}">${p.token}</span>`;
  $("#pot").textContent = S.options.freeParking ? `Free Parking jackpot: ${fmt(S.pot)}` : "";
  $("#round").textContent = `${S.mode?.label ? `${S.mode.label} · ` : ""}Round ${S.round}${S.options.roundLimit ? ` of ${S.options.roundLimit}` : ""}`;
  const e = activeEvent();
  $("#event").innerHTML = e && e.id !== "quiet" ? `${e.icon} <b>${esc(e.title)}</b>${S.event.group ? `: ${GROUP_NAMES[S.event.group]}` : ""}` : "";
  $("#event").title = e ? eventText() : "";
}

const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function renderDice() {
  $("#dice").innerHTML = S.dice.map((d) => `<div class="die">${[...Array(9)].map((_, k) => `<i class="${PIPS[d].includes(k) ? "on" : ""}"></i>`).join("")}</div>`).join("");
}

function renderLog() {
  const el = $("#log");
  if (!el || !S) return;
  const items = (list) => list.map((l) => `<li class="${l.strong ? "strong" : ""}" style="${l.c ? `--c:${l.c}` : ""}">${esc(l.msg)}</li>`).join("");
  el.innerHTML = items(S.log.slice(-80));
  el.scrollTop = el.scrollHeight;
  $("#ticker").innerHTML = items(S.log.slice(-4));
}

// ---------------------------------------------------------------- setup screen

// The new-game screen remembers its players and options, so a trip to Career or
// Scenarios (or the next game) starts from the same setup.
const SETUP_KEY = "web-monopoly-setup";

function openSetup() {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(SETUP_KEY)); } catch (e) { /* storage unavailable */ }
  const rows = Array.isArray(draft?.rows) && draft.rows.length >= 2 ? draft.rows
    : DEFAULT_NAMES.slice(0, 4).map((name, k) => ({ name, cpu: k > 0, level: "normal", token: TOKENS[k] }));
  const opts = { startCash: 1500, auction: true, freeParking: false, events: false, personas: true, chatter: true, speed: "normal", ...draft?.opts };
  const saveDraft = () => {
    try { localStorage.setItem(SETUP_KEY, JSON.stringify({ rows, opts })); } catch (e) { /* storage unavailable */ }
  };
  const on = (v) => (v ? "checked" : "");
  const rowsHtml = () => rows.map((r, k) => `<div class="setup-row" style="--c:${PLAYER_COLORS[k]}">
      <button class="tok tok-pick" data-k="${k}" title="Change token" style="--c:${PLAYER_COLORS[k]}">${r.token}</button>
      <input class="sname" data-k="${k}" value="${esc(r.name)}" maxlength="14" aria-label="Player ${k + 1} name">
      <select class="stype" data-k="${k}" aria-label="Player ${k + 1} type"><option value="h" ${r.cpu ? "" : "selected"}>Human</option>${Object.entries(CPU_LEVELS).map(([v, l]) => `<option value="${v}" ${r.cpu && r.level === v ? "selected" : ""}>CPU · ${l.label}</option>`).join("")}</select>
      <button class="sdel" data-k="${k}" ${rows.length <= 2 ? "disabled" : ""} aria-label="Remove player">✕</button>
    </div>`).join("");
  modal({
    title: '<span class="logo-mini">WEB MONOPOLY</span>',
    wide: true,
    html: `${typeof soloModesHtml === "function" ? soloModesHtml() : ""}
      <p class="small">Or set up your own game: pass-and-play with friends, or take on CPU opponents. 2–6 players.</p>
      <div id="setup-rows"></div>
      <button id="add-player" class="ghost">+ Add player</button>
      <div class="setup-opts">
        <label>Starting cash <select id="o-cash">${[1000, 1500, 2000].map((c) => `<option ${opts.startCash === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
        <label>CPU speed <select id="o-speed">${Object.keys(SPEEDS).map((v) => `<option value="${v}" ${opts.speed === v ? "selected" : ""}>${v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select></label>
        <label><input type="checkbox" id="o-auction" ${on(opts.auction)}> Auction unbought property</label>
        <label><input type="checkbox" id="o-fp" ${on(opts.freeParking)}> Free Parking jackpot (taxes &amp; fines)</label>
        <label><input type="checkbox" id="o-events" ${on(opts.events)}> Round events (a surprise every round)</label>
        <label><input type="checkbox" id="o-personas" ${on(opts.personas)}> CPU personalities</label>
        <label><input type="checkbox" id="o-chatter" ${on(opts.chatter)}> CPU chatter</label>
      </div>`,
    buttons: [{ label: "Start game", value: true, primary: true }],
    onMount(box, close) {
      const list = box.querySelector("#setup-rows");
      const draw = () => {
        list.innerHTML = rowsHtml();
        box.querySelector("#add-player").disabled = rows.length >= 6;
      };
      list.addEventListener("input", (e) => { if (e.target.classList.contains("sname")) rows[+e.target.dataset.k].name = e.target.value; });
      list.addEventListener("change", (e) => {
        if (!e.target.classList.contains("stype")) return;
        const r = rows[+e.target.dataset.k];
        r.cpu = e.target.value !== "h";
        if (r.cpu) r.level = e.target.value;
      });
      list.addEventListener("click", (e) => {
        const pick = e.target.closest(".tok-pick"), del = e.target.closest(".sdel");
        if (pick) {
          const r = rows[+pick.dataset.k];
          const used = rows.map((x) => x.token);
          let n = TOKENS.indexOf(r.token);
          do n = (n + 1) % TOKENS.length; while (used.includes(TOKENS[n]));
          r.token = TOKENS[n];
          draw();
        } else if (del && rows.length > 2) {
          rows.splice(+del.dataset.k, 1);
          draw();
        }
      });
      box.querySelector("#add-player").addEventListener("click", () => {
        if (rows.length >= 6) return;
        const token = TOKENS.find((t) => !rows.some((r) => r.token === t));
        rows.push({ name: DEFAULT_NAMES[rows.length], cpu: true, level: rows.find((x) => x.cpu)?.level || "normal", token });
        draw();
      });
      box.querySelector("#o-cash").addEventListener("change", (e) => (opts.startCash = +e.target.value));
      box.querySelector("#o-speed").addEventListener("change", (e) => (opts.speed = e.target.value));
      box.querySelector("#o-auction").addEventListener("change", (e) => (opts.auction = e.target.checked));
      box.querySelector("#o-fp").addEventListener("change", (e) => (opts.freeParking = e.target.checked));
      box.querySelector("#o-events").addEventListener("change", (e) => (opts.events = e.target.checked));
      box.querySelector("#o-personas").addEventListener("change", (e) => (opts.personas = e.target.checked));
      box.querySelector("#o-chatter").addEventListener("change", (e) => (opts.chatter = e.target.checked));
      // Daily challenge / scenarios / career tiles close the setup with their mode.
      box.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => close(b.dataset.mode)));
      draw();
    },
  }).then((mode) => {
    rows.forEach((r, k) => (r.name = r.name.trim() || `Player ${k + 1}`));
    saveDraft();
    if (mode !== true) return openSoloMode(mode, rows.find((r) => !r.cpu)?.name);
    startGame(newState({ players: rows, options: opts }), true);
  });
}

function startGame(state, fresh) {
  S = state;
  rng = S.rng || null;
  pending = null;
  $("#speed").value = S.options.speed;
  if (fresh) {
    S.turn = Math.floor(rand() * S.players.length);
    log(`New game! ${P(S.turn).name} goes first.`, null, true);
    for (const p of S.players.filter((p) => p.persona)) log(`${PERSONAS[p.persona].icon} ${p.name} is a ${PERSONAS[p.persona].label}: ${PERSONAS[p.persona].text}`, p);
    hook("start", {});
  } else {
    log("Game resumed.", null, true);
  }
  save();
  render();
  gameLoop();
}

// ---------------------------------------------------------------- boot

// Phones: controls live in a dock under the board that sticks to the bottom of the screen.
const phoneLayout = window.matchMedia("(max-width: 860px)");
function placeControls() {
  const controls = [$("#prompt"), $("#tools")];
  if (phoneLayout.matches) $("#dock").append(...controls, $("#toast"));
  else {
    controls.forEach((el) => $("#center").insertBefore(el, $("#pot")));
    document.body.append($("#toast"));
  }
}

function init() {
  buildBoard();
  setupEasterEgg();
  placeControls();
  phoneLayout.addEventListener("change", placeControls);
  $("#prompt").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]");
    if (b) choose(+b.dataset.k);
  });
  $("#btn-manage").addEventListener("click", () => pending && !pending.p.cpu && openManage(pending.p));
  $("#btn-trade").addEventListener("click", () => pending && !pending.p.cpu && openTrade(pending.p));
  $("#players").addEventListener("click", (e) => {
    const c = e.target.closest(".chip");
    if (c) modal({ title: esc(BOARD[+c.dataset.i].name), html: deedHtml(+c.dataset.i), buttons: [{ label: "Close", value: true }] });
  });
  $("#speed").addEventListener("change", (e) => { if (S) { S.options.speed = e.target.value; save(); } });
  $("#btn-new").addEventListener("click", async () => {
    const ok = await modal({ title: "Start a new game?", html: "<p>The current game will be lost.</p>", buttons: [{ label: "Cancel", value: false }, { label: "New game", value: true, danger: true }] });
    if (ok) { clearSave(); location.reload(); }
  });
  $("#btn-end").addEventListener("click", async () => {
    const ok = await modal({ title: "End the game now?", html: "<p>The player with the highest net worth wins.</p>", buttons: [{ label: "Cancel", value: false }, { label: "End game", value: true, primary: true }] });
    if (ok && !S.over) { S.endedEarly = true; showWinner(); }
  });
  $("#btn-rules").addEventListener("click", () => modal({ title: "How to play", html: $("#rules-tpl").innerHTML, buttons: [{ label: "Got it", value: true, primary: true }], wide: true }));
  document.addEventListener("keydown", (e) => {
    if (modalState || !pending || pending.p.cpu) return;
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "Enter" || e.key === " ") {
      const k = pending.actions.findIndex((a) => a.primary && !(typeof a.disabled === "function" ? a.disabled() : a.disabled));
      if (k >= 0) { e.preventDefault(); choose(k); }
    }
  });

  const saved = loadSave();
  S = saved || newState({ players: [], options: { speed: "normal" } });
  $("#speed").value = S.options.speed || "normal";
  render();
  if (saved && saved.players && alive().length > 1) {
    modal({
      title: '<span class="logo-mini">WEB MONOPOLY</span>',
      html: `<p>Welcome back! You have a game in progress (round ${saved.round}).</p>`,
      buttons: [{ label: "New game", value: false }, { label: "Continue", value: true, primary: true }],
    }).then((cont) => (cont ? startGame(saved, false) : (clearSave(), openSetup())));
  } else {
    openSetup();
  }
}

document.addEventListener("DOMContentLoaded", init);
