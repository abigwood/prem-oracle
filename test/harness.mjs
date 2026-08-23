// Executes real functions out of app.js.
//
// app.js is a browser script, not a module: it cannot be imported, and the
// python suite can only assert that its source says the right words. For the
// v1.6.6 arithmetic — points, result states, movement, folding — "the source
// says so" is not evidence. This lifts the named functions out and runs them,
// which is what makes W/F/R claims assertable rather than eyeballed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const APP = readFileSync(join(ROOT, "app.js"), "utf8");

/** One top-level function's source, sliced the way the python suite slices. */
export function sourceOf(name) {
  const head = `function ${name}(`;
  const at = APP.indexOf(head);
  if (at < 0) throw new Error(`app.js has no function ${name}`);
  const end = APP.indexOf("\n}", at);
  if (end < 0) throw new Error(`unterminated function ${name}`);
  // `async` is part of the declaration, not decoration in front of it: lifting
  // an async function without it is a syntax error the moment the body awaits.
  const from = APP.startsWith("async ", at - "async ".length) ? at - "async ".length : at;
  return APP.slice(from, end + 2);
}

/** One top-level `const NAME = ...;` declaration, single line or arrow body. */
export function constOf(name) {
  const head = `const ${name} =`;
  const at = APP.indexOf(head);
  if (at < 0) throw new Error(`app.js has no const ${name}`);
  // A declaration ends at the first ";" that is not inside a bracket, a string
  // or a template. Guessing at "the first line ending in ;" breaks on every
  // multi-line arrow body, which is most of the interesting ones.
  let depth = 0, quote = null, i = at;
  for (; i < APP.length; i++) {
    const c = APP[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return APP.slice(at, i + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

/**
 * A sandbox with `names` lifted from app.js, over whatever stubs you pass.
 * Everything the app reaches for that a test does not care about — the DOM,
 * localStorage, team badges — is stubbed, so a test failure is about the logic
 * under test and not about the browser it usually runs in.
 */
export function load(names, stubs = {}) {
  const sandbox = {
    picks: {},
    fixtures: [],
    extraFixtures: {},
    leagueState: null,
    leagueStates: {},
    leagueCodes: [],
    matesState: null,
    escapeHTML: (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    countPhrase: (count, word) => `<span class="nowrap">${count} ${word}</span>`,
    teamBadge: () => "<i class=badge></i>",
    fixtureRevealSection: () => "",
    pickRevealSection: () => "",
    isLeagueHost: () => false,
    slateForPeriod: () => null,
    currentPeriodKey: () => null,
    fixtureById: (id) => sandbox.fixtures.find((f) => String(f.id) === String(id)) || null,
    uid: () => "u1",
    console,
    Date,
    ...stubs,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const name of names) {
    const src = APP.includes(`function ${name}(`) ? sourceOf(name) : constOf(name);
    // A `const` at the top of a vm context is a lexical binding, not a property
    // of the context object, so it resolves by name inside but is invisible to
    // the test outside. Publishing it makes both work.
    vm.runInContext(`${src}\nglobalThis[${JSON.stringify(name)}] = ${name};`,
      sandbox, { filename: `app.js:${name}` });
  }
  sandbox.evalIn = (expression) => vm.runInContext(expression, sandbox);
  return sandbox;
}
