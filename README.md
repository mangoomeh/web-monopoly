# Web Monopoly

A complete, browser-based take on the classic property-trading board game (London edition), written in plain HTML, CSS and JavaScript — no build step, no dependencies.

**Play it live: https://mangoomeh.github.io/web-monopoly/**

![Web Monopoly](./snippet.png)

## Features
- 2–6 players: pass-and-play humans and/or CPU opponents, each with their own token
- Full rules: buying, rent (colour-set doubling, stations, utilities), houses & hotels with even building and a limited bank supply, mortgages (10% interest), Chance & Community Chest decks, Jail (doubles / £50 fine / Get Out of Jail Free cards, three-doubles rule), Income & Super Tax, bankruptcy
- Auctions for unbought property (optional)
- Trading property and cash between players; CPUs judge deals by what each side gains (they won't hand you a colour set cheaply) and propose their own
- CPU difficulty per opponent: Easy, Normal or Hard
- CPU moves (building, trades, raising cash) are shown on screen long enough to follow, even at Instant speed
- After the game ends you can close the results to look over the final board and game log
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

## Project layout
- `index.html` – page shell
- `css/style.css` – board and UI styling
- `js/data.js` – board spaces, cards, rules constants
- `js/game.js` – game engine, CPU logic and rendering
- `manifest.webmanifest`, `sw.js`, `icons/` – PWA install & offline support (bump `CACHE` in `sw.js` when shipping changes)

## History
Originally built as a project for GA SEI-33; rebuilt from the ground up as a full game.
