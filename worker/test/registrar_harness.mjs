// Shared test harness for the LEAGUE_REGISTRAR Durable Object (v1.8 Slice A).
//
// Every worker path that arbitrates display-name uniqueness — /join, the
// rename, profile propagation — now fails closed without an atomic registrar
// (Slice A/A). Tests that exercise those paths therefore need a real registrar
// in their env, not a stub: this runs the REAL LeagueRegistrar over real
// SQLite (node:sqlite), one instance per league name, exactly as production
// binds it. A guarantee proved against this is proved about shipping code.
import { DatabaseSync } from "node:sqlite";
import { LeagueRegistrar } from "../src/league_registrar.js";

/** The Durable Object SQL surface over node:sqlite (positional bindings). */
export function sqlShim(db) {
  return {
    exec(query, ...binds) {
      const trimmed = query.trim();
      if (!binds.length && /;\s*\S/.test(trimmed.replace(/;\s*$/, ""))) {
        db.exec(trimmed);
        return { toArray: () => [] };
      }
      const statement = db.prepare(trimmed);
      if (/RETURNING|^\s*SELECT/i.test(trimmed)) {
        const rows = statement.all(...binds);
        return { toArray: () => rows };
      }
      const info = statement.run(...binds);
      return { toArray: () => [], rowsWritten: Number(info.changes ?? 0) };
    },
  };
}

/** A LEAGUE_REGISTRAR namespace: one real DO instance per league name. */
export function registrarNamespace() {
  const instances = new Map();
  return {
    idFromName(name) { return { name }; },
    get(id) {
      if (!instances.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        instances.set(id.name, new LeagueRegistrar({ storage: { sql: sqlShim(db) } }));
      }
      const inst = instances.get(id.name);
      return { fetch: (url, init) => inst.fetch(new Request(url, init)) };
    },
  };
}
