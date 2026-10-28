// Loads the game's own scripts into a sandbox with just enough of a browser faked
// out to run the engine headless: no drawing, and every pause resolves at once.
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function fakeElement() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty() {} },
    dataset: {},
    addEventListener() {},
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
    append() {},
    insertBefore() {},
    remove() {},
    setAttribute() {},
    innerHTML: "",
    textContent: "",
    value: "normal",
  };
}

function loadGame({ solo = true } = {}) {
  const store = {};
  const ctx = {
    console, Math, JSON, Date, Promise, Object, Array, Number, String, Map, Set,
    setTimeout: (f) => setImmediate(f),
    clearTimeout() {},
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    matchMedia: () => ({ matches: true }),
    document: { addEventListener() {}, querySelector: () => fakeElement(), querySelectorAll: () => [], createElement: () => fakeElement(), body: fakeElement() },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)), removeItem: (k) => delete store[k] },
    location: { origin: "", pathname: "" },
    navigator: {},
  };
  vm.createContext(ctx);
  for (const f of ["js/data.js", "js/game.js", ...(solo ? ["js/solo.js"] : [])]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  }
  const run = (code) => vm.runInContext(code, ctx);
  run(`render = () => {}; renderTiles = () => {}; renderTokens = () => {}; renderPlayers = () => {};
       renderPrompt = () => {}; renderDice = () => {}; renderLog = () => {}; toast = () => {}; save = () => {};`);
  return { ctx, run };
}

// A tiny test runner: named checks, a summary, and a non-zero exit on failure.
function runner(title) {
  let failed = 0, passed = 0;
  const check = async (name, fn) => {
    try {
      const ok = await fn();
      if (ok === false) throw new Error("check returned false");
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}\n      ${e.message}`);
    }
  };
  const done = () => {
    console.log(`${title}: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  };
  return { check, done };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = { loadGame, runner, assert, ROOT };
