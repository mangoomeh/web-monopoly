# Web Monopoly

A complete, browser-based take on the classic property-trading board game (London edition), written in plain HTML, CSS and JavaScript — no build step, no dependencies.

**Play it live: https://mangoomeh.github.io/web-monopoly/**

![Web Monopoly](./snippet.png)

## Features
- 2–6 players: pass-and-play humans and/or CPU opponents, each with their own token
- Full rules: buying, rent (colour-set doubling, stations, utilities), houses & hotels with even building and a limited bank supply, mortgages (10% interest), Chance & Community Chest decks, Jail (doubles / £50 fine / Get Out of Jail Free cards, three-doubles rule), Income & Super Tax, bankruptcy
- Auctions for unbought property (optional)
- Trading property, Get Out of Jail Free cards and cash between players; CPUs judge deals by what each side gains (they won't hand you a colour set cheaply) and propose their own
- CPU difficulty per opponent: Easy, Normal or Hard (Hard sizes its cash reserve to the rent ahead, mortgages spare property to build, and prices property by what it does for rivals too)
- When a CPU turns down your trade it makes a counter-offer you can agree to or tweak
- CPU personalities (optional): each CPU is randomly a Steady player, Collector, Developer, Hoarder, Dealmaker or Gambler
- Round events (optional): a surprise every round, such as a building boom, rent strike, heatwave, tax holiday or council rates
- CPU moves (building, trades, raising cash) are shown on screen long enough to follow, even at Instant speed
- After the game ends you can close the results to look over the final board and game log
- Single player: a daily challenge (same deal for everyone each day), six scenarios, a career record with 18 achievements, and CPU chatter
- Optional Free Parking jackpot house rule, adjustable starting cash and CPU speed
- Animated tokens and dice, game log, title-deed cards (click any property)
- Auto-saves to your browser at the end of every turn
- Responsive: works on desktop and phones
- Installable PWA: add it to your home screen / desktop and play offline

## Running locally
Open `index.html` in a browser, or serve the folder:
```
python3 -m http.server
```

## Testing
The game itself needs no build, but there's a test suite (Node 18+):
```
npm install
npm test                         # rules & CPU checks, plus simulated CPU-only games
npx playwright install chromium  # once
npm run test:browser             # walks through the real page, desktop and phone sized
```
- `tests/unit.js`: focused checks of rules, round events, CPU trade decisions, the daily challenge's seeding and the career record.
- `tests/sim.js`: plays seeded CPU-only games and checks invariants after every turn (house/hotel stock, no negative cash, even building, Jail cards). `GAMES=40 node tests/sim.js` runs more and prints who won.
- `tests/browser.js`: setup, a few turns, rent preview, trade hint, undo, results chart and the daily challenge, with no page errors.

GitHub Actions runs all three on every push (`.github/workflows/test.yml`).

## Project layout
- `index.html` – page shell
- `css/style.css` – board and UI styling
- `js/data.js` – board spaces, cards, rules constants
- `js/game.js` – game engine, CPU logic and rendering
- `js/solo.js` – single-player extras: career & achievements, daily challenge, scenarios, CPU chatter
- `tests/` – headless test suite (see Testing)
- `manifest.webmanifest`, `sw.js`, `icons/` – PWA install & offline support (bump `CACHE` in `sw.js` when shipping changes)

## History
Originally built as a project for GA SEI-33; rebuilt from the ground up as a full game.
