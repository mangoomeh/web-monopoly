// Web Monopoly — single-player extras: career record and achievements, the daily
// challenge, scenarios and CPU chatter. The engine calls onGameEvent() as things
// happen; nothing in here changes the rules.
"use strict";

// ---------------------------------------------------------------- career

const CAREER_KEY = "web-monopoly-career";

function loadCareer() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CAREER_KEY)); } catch (e) { /* storage unavailable */ }
  return { name: "You", games: 0, wins: 0, streak: 0, bestStreak: 0, bestWorth: 0, byLevel: {}, daily: {}, scenarios: {}, achievements: {}, ...saved };
}
let career = loadCareer();
function saveCareer() {
  try { localStorage.setItem(CAREER_KEY, JSON.stringify(career)); } catch (e) { /* storage unavailable */ }
}

// The human in a single-player game; career and achievements only count those.
function soloHuman() {
  if (!S || !S.players.length) return null;
  const humans = S.players.filter((p) => !p.cpu);
  return humans.length === 1 ? humans[0] : null;
}

const LEVEL_ORDER = ["easy", "normal", "hard"];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const hardestCpu = () => LEVEL_ORDER[Math.max(...S.players.filter((p) => p.cpu).map((p) => LEVEL_ORDER.indexOf(p.level || "normal")))];

function recordCareer(winner) {
  const me = soloHuman();
  // Games ended with the End game button don't count (a round-1 "win" would be free).
  if (!me || S.careerDone || S.endedEarly) return;
  S.careerDone = true;
  const won = winner === me, worth = netWorth(me), level = hardestCpu();
  const lv = (career.byLevel[level] = career.byLevel[level] || { games: 0, wins: 0 });
  career.games++;
  lv.games++;
  career.bestWorth = Math.max(career.bestWorth, worth);
  if (won) {
    career.wins++;
    lv.wins++;
    career.streak++;
    career.bestStreak = Math.max(career.bestStreak, career.streak);
  } else career.streak = 0;
  if (S.mode?.kind === "daily") {
    const prev = career.daily[S.mode.date], res = { won, worth, rounds: S.round };
    if (!prev || (won && !prev.won) || (won === prev.won && worth > prev.worth)) career.daily[S.mode.date] = res;
  }
  if (S.mode?.kind === "scenario" && won) career.scenarios[S.mode.id] = true;
  saveCareer();

  const myTrades = stats().trades.filter((t) => t.who?.includes(me.id)).length;
  if (myTrades >= 5) unlock("dealmaker");
  if (!won) return;
  unlock("first_win");
  if (level === "hard") unlock("win_hard");
  if (career.streak >= 3) unlock("streak3");
  if (S.players.filter((p) => p.cpu).length >= 5) unlock("full_table");
  if (alive().length === 1 && S.round <= 30) unlock("blitz");
  if (!myTrades) unlock("lone_wolf");
  // Strictly last (among those still in) at some point from round 5 on.
  if (stats().history.some((pt) => pt.round >= 5 && !pt.final && pt.worth.every((v, k) => k === me.id || v === 0 || pt.worth[me.id] < v))) unlock("comeback");
  if (S.mode?.kind === "daily") unlock("daily");
  if (SCENARIOS.every((sc) => career.scenarios[sc.id])) unlock("scenarios");
}

// ---------------------------------------------------------------- achievements

const ACHIEVEMENTS = [
  { id: "first_win", icon: "🏆", title: "First win", text: "Win a game." },
  { id: "win_hard", icon: "🔥", title: "Giant slayer", text: "Win against a Hard CPU." },
  { id: "streak3", icon: "📈", title: "On a roll", text: "Win three games in a row." },
  { id: "full_table", icon: "👥", title: "Full table", text: "Win against five CPUs." },
  { id: "blitz", icon: "⚡", title: "Blitz", text: "Bankrupt every opponent within 30 rounds." },
  { id: "lone_wolf", icon: "🐺", title: "Lone wolf", text: "Win without making a single trade." },
  { id: "comeback", icon: "🔄", title: "Comeback", text: "Win after being in last place from round 5 on." },
  { id: "first_set", icon: "🎨", title: "Set collector", text: "Own a full colour set." },
  { id: "tycoon", icon: "🎩", title: "Tycoon", text: "Own three full colour sets at once." },
  { id: "all_aboard", icon: "🚂", title: "All aboard", text: "Own all four stations." },
  { id: "mayfair_hotel", icon: "🏨", title: "Mayfair hotel", text: "Build a hotel on Mayfair." },
  { id: "jackpot", icon: "💰", title: "Jackpot", text: "Collect £1,000 or more in a single rent." },
  { id: "dealmaker", icon: "🤝", title: "Art of the deal", text: "Make five trades in one game." },
  { id: "survivor", icon: "🛟", title: "Close call", text: "Pay a bill and be left with less than £20." },
  { id: "rich", icon: "💎", title: "Five grand", text: "Reach a net worth of £5,000." },
  { id: "daily", icon: "📅", title: "Daily driver", text: "Win a daily challenge." },
  { id: "scenarios", icon: "🎯", title: "Scenario master", text: "Complete every scenario." },
  { id: "secret", icon: "🤫", title: "Pennybags' secret", text: "Find the easter egg." },
];

function unlock(id) {
  if (career.achievements[id]) return;
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  career.achievements[id] = new Date().toISOString().slice(0, 10);
  saveCareer();
  if (S && S.players.length) {
    (S.newFeats = S.newFeats || []).push(id);
    log(`🏅 Achievement unlocked: ${a.icon} ${a.title} — ${a.text}`, null, true);
  }
  setTimeout(() => toast(`🏅 Achievement unlocked: ${a.title}`), 300);
}

const featHtml = (a) => `<div class="feat ${career.achievements[a.id] ? "" : "locked"}" title="${esc(a.text)}">
  <span class="feat-icon">${a.icon}</span><b>${esc(a.title)}</b><small>${esc(a.text)}</small></div>`;

// Things that are true of the board at any moment: checked after each redraw.
function watchBoard() {
  const sets = S.players.map((p) => Object.keys(GROUP_TILES).filter((g) => ownsSet(p.id, g)));
  S.knownSets = S.knownSets || {};
  for (const p of S.players) {
    const known = S.knownSets[p.id];
    S.knownSets[p.id] = sets[p.id];
    if (known && p.cpu && !p.bankrupt && sets[p.id].some((g) => !known.includes(g))) chat(p, "set", 1);
  }
  const me = soloHuman();
  if (!me || S.over || me.bankrupt) return;
  const checks = {
    first_set: sets[me.id].length >= 1,
    tycoon: sets[me.id].length >= 3,
    all_aboard: countType(me.id, "station") === 4,
    mayfair_hotel: S.tiles[39].owner === me.id && S.tiles[39].houses === 5,
    rich: netWorth(me) >= 5000,
  };
  // Anything a scenario hands you at the start doesn't count.
  if (!S.preSatisfied) S.preSatisfied = Object.keys(checks).filter((id) => checks[id]);
  for (const id in checks) if (checks[id] && !S.preSatisfied.includes(id)) unlock(id);
}

// ---------------------------------------------------------------- CPU chatter

// Lines by moment, then by personality (falling back to `any`). {name} is the other player.
const CHATTER = {
  buy: {
    any: ["Don't mind if I do.", "Mine now.", "A sound investment."],
    gambler: ["Why not? Let's roll!", "Fortune favours the bold!", "I'll take it — I'll take everything!"],
    hoarder: ["Fine… but only because it's a bargain.", "There goes my rainy-day fund."],
    collector: ["Another one for the collection!", "Ooh, shiny."],
    developer: ["Can't build on nothing.", "Future hotel site, right here."],
  },
  payRent: {
    any: ["Ouch.", "That's daylight robbery, {name}.", "Put it on my tab?"],
    hoarder: ["My beautiful money…", "Do you take IOUs, {name}?"],
    gambler: ["Easy come, easy go!", "Worth it for the view."],
    dealmaker: ["Let's talk about this, {name}…", "I'll remember this at the negotiating table."],
  },
  getRent: {
    any: ["Thank you kindly, {name}.", "Pleasure doing business.", "Come again soon!"],
    hoarder: ["Into the vault it goes.", "Every penny counts."],
    developer: ["That pays for another house.", "Location, location, location."],
    collector: ["All aboard the gravy train!"],
  },
  set: {
    any: ["The full set! Now we're talking.", "Look at that — a complete set."],
    developer: ["Time to break ground.", "Bring on the bulldozers!"],
    collector: ["The collection grows!"],
    dealmaker: ["See? Trading pays."],
  },
  hotel: {
    any: ["Hotel's open for business!", "Please enjoy your stay."],
    developer: ["Another masterpiece.", "Five stars, if I say so myself."],
  },
  jail: {
    any: ["This is a misunderstanding!", "I'll be out in no time."],
    gambler: ["Worth it.", "I regret nothing!"],
    hoarder: ["At least it's free in here."],
  },
  declined: {
    any: ["Your loss, {name}.", "Suit yourself.", "The offer won't last forever."],
    dealmaker: ["Everyone has a price, {name}. I'll find yours.", "Let's call that an opening bid."],
  },
  bankrupt: {
    any: ["I'll be back.", "Good game, everyone.", "Well, that escalated quickly."],
    gambler: ["Double or nothing next time?"],
    hoarder: ["But I was saving that!"],
  },
};

function chat(p, kind, chance = 0.5, other) {
  if (!S.options.chatter || !p.cpu || S.over) return;
  // At most one line per CPU per round, except for the big moments.
  const big = kind === "bankrupt" || kind === "declined";
  if (!big && (p.chatRound === S.round || Math.random() > chance)) return;
  p.chatRound = S.round;
  const lines = CHATTER[kind][p.persona] && Math.random() < 0.7 ? CHATTER[kind][p.persona] : CHATTER[kind].any;
  const text = lines[Math.floor(Math.random() * lines.length)].replace("{name}", other ? other.name : "friend");
  p.bubble = { text, until: Date.now() + 4500 };
  log(`💬 ${p.name}: “${text}”`, p);
  renderPlayers();
  setTimeout(renderPlayers, 4600);
}

// ---------------------------------------------------------------- engine events

function onGameEvent(kind, d) {
  const me = soloHuman();
  switch (kind) {
    case "render": return watchBoard();
    case "buy": return chat(d.p, "buy", 0.35);
    case "rent":
      if (me && d.owner === me && d.rent >= 1000) unlock("jackpot");
      if (d.rent < 100) return;
      if (d.p.cpu) return chat(d.p, "payRent", 0.6, d.owner);
      return chat(d.owner, "getRent", 0.6, d.p);
    case "paid":
      if (me && d.p === me && d.amount >= 50 && me.cash < 20 && !S.over) unlock("survivor");
      return;
    case "jail": return chat(d.p, "jail", 0.6);
    case "hotel": return chat(d.p, "hotel", 0.7);
    case "declined": return chat(d.p, "declined", 1, d.other);
    case "bankrupt": return chat(d.p, "bankrupt", 1);
    case "egg": return unlock("secret");
    case "gameover": return recordCareer(d.winner);
  }
}

// ---------------------------------------------------------------- daily challenge & scenarios

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const human = (name) => ({ name: name || career.name, cpu: false, token: TOKENS[0] });
const cpuRow = (k, level, persona) => ({ name: DEFAULT_NAMES[k], cpu: true, level, persona, token: TOKENS[k] });
const baseOptions = () => ({ startCash: 1500, auction: true, freeParking: false, events: false, personas: true, chatter: true, speed: $("#speed").value || "normal" });

// Everyone gets the same dice, cards, events and opponents on a given day. The
// day of the week sets how tough the table is.
const DAILY_LINEUPS = [
  ["hard", "hard", "normal"], // Sunday
  ["easy", "normal", "normal"],
  ["normal", "normal", "normal"],
  ["normal", "normal", "hard"],
  ["normal", "hard", "normal"],
  ["hard", "normal", "normal"],
  ["hard", "hard", "hard"], // Saturday
];

function startDaily(name) {
  const key = todayKey(), seed = +key.replace(/-/g, "");
  const label = `Daily ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  const players = [human(name), ...DAILY_LINEUPS[new Date().getDay()].map((lv, k) => cpuRow(k + 1, lv))];
  startGame(newState({ seed, mode: { kind: "daily", date: key, label }, players, options: { ...baseOptions(), events: true, roundLimit: 30 } }), true);
}

const SCENARIOS = [
  { id: "underdog", icon: "🐭", title: "Underdog", text: "You start with £500; three Normal CPUs start with £1,500.",
    levels: ["normal", "normal", "normal"], setup: (st) => { st.players[0].cash = 500; } },
  { id: "hardtable", icon: "🔥", title: "The Hard Table", text: "Three Hard CPUs. No mercy.", levels: ["hard", "hard", "hard"] },
  { id: "blitz", icon: "⏱️", title: "Blitz", text: "Round events are on and the game ends after 20 rounds: highest net worth wins.",
    levels: ["normal", "normal", "hard"], options: { events: true, roundLimit: 20 } },
  { id: "railway", icon: "🚂", title: "Railway Tycoon", text: "You own all four stations but have only £600, against three Hard CPUs.",
    levels: ["hard", "hard", "hard"], setup: (st) => { st.players[0].cash = 600; [5, 15, 25, 35].forEach((i) => (st.tiles[i].owner = 0)); } },
  { id: "duel", icon: "⚔️", title: "Duel", text: "One on one against a Hard Developer.", levels: ["hard"], personas: ["developer"] },
  { id: "firesale", icon: "🎲", title: "Fire Sale", text: "Every property is dealt out at random before the first roll, and everyone has £800. Trade your way to a set against three Dealmakers.",
    levels: ["normal", "normal", "normal"], personas: ["dealmaker", "dealmaker", "dealmaker"],
    setup: (st) => {
      st.players.forEach((p) => (p.cash = 800));
      shuffle(BOARD.map((b, i) => i).filter(isBuyable)).forEach((i, k) => (st.tiles[i].owner = k % st.players.length));
    } },
];

function startScenario(sc, name) {
  const players = [human(name), ...sc.levels.map((lv, k) => cpuRow(k + 1, lv, sc.personas?.[k]))];
  const state = newState({ mode: { kind: "scenario", id: sc.id, label: sc.title }, players, options: { ...baseOptions(), ...sc.options } });
  sc.setup?.(state);
  startGame(state, true);
}

function openScenarios(name) {
  modal({
    title: "🎯 Scenarios",
    wide: true,
    html: `<p class="small">Set challenges against the CPUs. Win one to tick it off.</p>
      <div class="scenario-list">${SCENARIOS.map((sc) => `<button class="scenario" data-sc="${sc.id}">
        <span class="sc-icon">${sc.icon}</span><span><b>${esc(sc.title)}</b>${career.scenarios[sc.id] ? " ✅" : ""}<small>${esc(sc.text)}</small></span></button>`).join("")}</div>`,
    buttons: [{ label: "Back", value: null }],
    onMount(box, close) {
      box.querySelectorAll("[data-sc]").forEach((b) => b.addEventListener("click", () => close(b.dataset.sc)));
    },
  }).then((id) => (id ? startScenario(SCENARIOS.find((sc) => sc.id === id), name) : openSetup()));
}

// ---------------------------------------------------------------- screens

function openCareer() {
  const pct = (w, g) => (g ? `${Math.round((100 * w) / g)}%` : "—");
  const days = Object.values(career.daily);
  const levels = LEVEL_ORDER.filter((l) => career.byLevel[l]).map((l) => `<tr><td>${CPU_LEVELS[l].label}</td><td>${career.byLevel[l].wins} / ${career.byLevel[l].games}</td><td>${pct(career.byLevel[l].wins, career.byLevel[l].games)}</td></tr>`).join("");
  return modal({
    title: "🏅 Career",
    wide: true,
    html: `<p class="small">Single-player games on this device (you against CPUs).</p>
      <div class="career-tiles">
        <div><b>${career.wins}</b><small>${career.wins === 1 ? "win" : "wins"} from ${plural(career.games, "game")}</small></div>
        <div><b>${pct(career.wins, career.games)}</b><small>win rate</small></div>
        <div><b>${career.streak}</b><small>streak (best ${career.bestStreak})</small></div>
        <div><b>${fmt(career.bestWorth)}</b><small>best net worth</small></div>
      </div>
      ${levels ? `<table class="career-table"><tr><th>Toughest CPU</th><th>Wins</th><th>Rate</th></tr>${levels}</table>` : ""}
      <p class="small">📅 Daily challenges: ${days.filter((d) => d.won).length} won of ${days.length} played · 🎯 Scenarios: ${SCENARIOS.filter((sc) => career.scenarios[sc.id]).length} of ${SCENARIOS.length}</p>
      <h3 class="stats-head">Achievements · ${Object.keys(career.achievements).length} of ${ACHIEVEMENTS.length}</h3>
      <div class="feat-grid">${ACHIEVEMENTS.map(featHtml).join("")}</div>`,
    buttons: [
      { label: "Reset career", value: "reset", danger: true, onClick() {
        const btn = [...document.querySelectorAll("#modal .modal-buttons button")].find((b) => b.textContent.startsWith("Reset"));
        if (btn.dataset.armed) return true;
        btn.dataset.armed = "1";
        btn.textContent = "Reset: tap again to confirm";
        return false;
      } },
      { label: "Close", value: true, primary: true },
    ],
  }).then((v) => {
    if (v === "reset") {
      career = loadCareer();
      Object.assign(career, { games: 0, wins: 0, streak: 0, bestStreak: 0, bestWorth: 0, byLevel: {}, daily: {}, scenarios: {}, achievements: {} });
      saveCareer();
    }
  });
}

// Tiles at the top of the new-game screen.
function soloModesHtml() {
  const d = career.daily[todayKey()];
  return `<div class="modes">
    <button class="mode" data-mode="daily"><b>📅 Daily challenge</b><small>${d ? (d.won ? `Won today with ${fmt(d.worth)}` : "Played today: try again?") : "Same deal for everyone today"}</small></button>
    <button class="mode" data-mode="scenarios"><b>🎯 Scenarios</b><small>${SCENARIOS.filter((sc) => career.scenarios[sc.id]).length} of ${SCENARIOS.length} complete</small></button>
    <button class="mode" data-mode="career"><b>🏅 Career</b><small>${plural(career.wins, "win")} · ${Object.keys(career.achievements).length}/${ACHIEVEMENTS.length} badges</small></button>
  </div>`;
}

function openSoloMode(mode, name) {
  if (name && name !== "Player") { career.name = name; saveCareer(); }
  if (mode === "daily") return startDaily(name);
  if (mode === "scenarios") return openScenarios(name);
  if (mode === "career") return openCareer().then(openSetup);
  openSetup();
}

// Extra lines on the results screen.
function soloResultsHtml(w) {
  const me = soloHuman();
  if (!me) return "";
  const won = w === me;
  let html = "";
  if (S.endedEarly) return `<p class="small">This game was ended early, so it doesn't count towards your career.</p>`;
  if (S.mode?.kind === "daily") {
    const text = `Web Monopoly · ${S.mode.label}\n${won ? "🏆 Won" : "💸 Lost"} · ${fmt(netWorth(me))} net worth · ${S.round} rounds\n${location.origin}${location.pathname}`;
    html += `<div class="solo-result"><b>📅 ${esc(S.mode.label)}</b>: ${won ? "you won!" : "not this time."}
      <button class="copy-result ghost" data-text="${esc(text)}">📋 Copy result</button></div>`;
  }
  if (S.mode?.kind === "scenario") {
    const sc = SCENARIOS.find((x) => x.id === S.mode.id);
    html += `<div class="solo-result"><b>${sc.icon} ${esc(sc.title)}</b>: ${won ? "scenario complete ✅" : "not this time, try again!"}</div>`;
  }
  const feats = (S.newFeats || []).map((id) => ACHIEVEMENTS.find((a) => a.id === id));
  if (feats.length) html += `<h3 class="stats-head">🏅 New achievements</h3><div class="feat-grid">${feats.map(featHtml).join("")}</div>`;
  html += `<p class="small">Career: ${plural(career.wins, "win")} from ${plural(career.games, "game")} · current streak ${career.streak}</p>`;
  return html;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".copy-result");
  if (!btn) return;
  navigator.clipboard?.writeText(btn.dataset.text)
    .then(() => (btn.textContent = "✅ Copied"))
    .catch(() => (btn.outerHTML = `<textarea class="copy-fallback" readonly>${esc(btn.dataset.text)}</textarea>`));
});

document.addEventListener("DOMContentLoaded", () => {
  $("#btn-career")?.addEventListener("click", () => openCareer());
});
