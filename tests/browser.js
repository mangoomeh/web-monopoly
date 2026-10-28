// A walk through the real page in a headless browser, desktop and phone sized.
// Needs Playwright with Chromium: npm install && npx playwright install chromium
//   node tests/browser.js
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { runner, assert, ROOT } = require("./harness");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

// Answer whatever the game is waiting on until `until()` holds: our turn's main
// button, or the first button of any pop-up (which declines CPU offers).
async function playUntil(page, until, arg = null, limit = 90000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await page.evaluate(until, arg)) return;
    const modalUp = await page.evaluate(() => !document.querySelector("#modal").hidden);
    if (modalUp) await page.click("#modal .modal-buttons button >> nth=0");
    else await page.evaluate(() => pending && !pending.p.cpu && choose(Math.max(0, pending.actions.findIndex((a) => a.primary))));
    await page.waitForTimeout(100);
  }
  throw new Error("timed out playing the game");
}

(async () => {
  const { check, done } = runner("browser");
  const server = await serve();
  const url = `http://localhost:${server.address().port}/index.html`;
  const browser = await chromium.launch();

  for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
    console.log(label);
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForSelector(".modes");

    await check("setup survives a trip to Career and back", async () => {
      await page.fill('.sname[data-k="0"]', "Tester");
      await page.selectOption('.stype[data-k="1"]', "hard");
      await page.click('.sdel[data-k="3"]');
      await page.check("#o-events");
      await page.selectOption("#o-speed", "instant");
      await page.click('[data-mode="career"]');
      await page.waitForSelector(".career-tiles");
      await page.click("#modal .modal-buttons button.primary");
      await page.waitForSelector(".modes");
      const rows = await page.$$eval(".sname", (x) => x.map((e) => e.value).join(","));
      return rows === "Tester,Ada,Brunel" && (await page.isChecked("#o-events"));
    });

    await check("a game starts and reaches our roll", async () => {
      await page.click("text=Start game");
      await playUntil(page, () => pending && !pending.p.cpu && pending.actions.some((a) => a.value === "roll"));
      return true;
    });

    await check("reachable squares are highlighted before rolling", async () => {
      return (await page.$$(".tile.reach")).length === 11;
    });

    await check("the trade screen tells you what a CPU would do", async () => {
      await page.evaluate(() => { const i = BOARD.findIndex((b) => b.name === "Mayfair"); S.tiles[i].owner = 1; S.tiles[i].houses = 0; render(); });
      await page.click("#btn-trade");
      await page.check('input[data-side="get"][value="39"]');
      const hint = await page.$eval("#trade-hint", (e) => e.textContent);
      await page.click("#modal .modal-buttons button >> nth=0");
      return /would (accept|want)|isn't interested/.test(hint);
    });

    await check("Manage can undo a build", async () => {
      await page.evaluate(() => { [1, 3].forEach((i) => Object.assign(S.tiles[i], { owner: 0, houses: 0, mortgaged: false })); S.players[0].cash = 1000; render(); });
      await page.click("#btn-manage");
      await page.click('button[data-act="build"][data-i="1"]');
      await page.click("#manage-undo");
      const back = await page.evaluate(() => S.tiles[1].houses === 0 && S.players[0].cash === 1000);
      await page.click("#modal .modal-buttons button.primary");
      return back;
    });

    await check("CPUs play their turns without errors", async () => {
      const start = await page.evaluate(() => S.round);
      await playUntil(page, (r) => S.round >= r + 3 || S.over, start);
      return true;
    });

    await check("ending the game shows results with the net-worth chart", async () => {
      await page.click("#btn-end");
      await page.click('#modal button:has-text("End game")');
      await page.waitForSelector(".stats-chart svg");
      return (await page.$$(".stats-chart path")).length === 3;
    });

    await check("the daily challenge starts a seeded 30-round game", async () => {
      await page.evaluate(() => localStorage.removeItem("web-monopoly-save-v2"));
      await page.goto(url);
      await page.waitForSelector(".modes");
      await page.click('[data-mode="daily"]');
      await page.waitForFunction(() => S && S.players.length);
      return page.evaluate(() => !!S.rng && S.options.roundLimit === 30 && S.players.length === 4);
    });

    await check("no errors on the page", () => {
      assert(!errors.length, errors.join(" | "));
    });
    await page.close();
  }

  await browser.close();
  server.close();
  done();
})();
