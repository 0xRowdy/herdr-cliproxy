// The server's everyday settings, the ones the Management Center's settings page carries:
// routing, logging and management access. Everything travels through narrow
// /v8/management/config paths — whole sections that hold no secrets, and the two management
// leaves (the section itself carries the management secret, so it is never read whole).
// GET /config, /config.yaml and /credentials/download stay forbidden, as ever. A successful
// write also saves the server's config file in the v8 layout: the server's own migration.
//
// This module is pure data and logic — no herdr or gpui imports — so its diffing can be
// exercised outside the app. `draft` mirrors `saved` ({routing, observability, management});
// a field's place is `<section>.<path>` ("routing.retry.request-retry").

export const GROUPS = [
  { id: "routing", title: "Routing", section: "routing", patch: "/config/routing", fields: [
    { path: "strategy", kind: "choice", label: "Strategy", def: "round-robin", choices: [
      { value: "round-robin", label: "Round-robin", hint: "every account in turn" },
      { value: "weighted-round-robin", label: "Weighted", hint: "each account by its weight" },
      { value: "fill-first", label: "Fill-first", hint: "the first account until it can't" },
    ] },
    { path: "session-affinity", kind: "bool", label: "Session affinity", def: false, hint: "a conversation keeps one account" },
    { path: "session-affinity-ttl", kind: "duration", label: "Affinity lasts", def: "1h", hint: "only with session affinity" },
    { path: "retry.request-retry", kind: "int", label: "Request retries", def: 3, min: 0, hint: "extra rounds over other accounts" },
    { path: "retry.max-retry-interval", kind: "int", label: "Retry wait", def: 30, unit: "s", min: 0, hint: "longest cooldown wait between rounds" },
    { path: "cooldown.disable-cooling", kind: "bool", label: "Disable cooldowns", def: false, hint: "no blackout after failures" },
    { path: "force-model-prefix", kind: "bool", label: "Require model prefix", def: false, hint: "unprefixed models only use unprefixed accounts" },
  ] },
  { id: "observability", title: "Logging & usage", section: "observability", patch: "/config/observability", fields: [
    { path: "logs.debug", kind: "bool", label: "Debug logging", def: false },
    { path: "logs.logging-to-file", kind: "bool", label: "Log to files", def: false, hint: "rotating files instead of stdout" },
    { path: "logs.request-log", kind: "bool", label: "Record requests", def: false, hint: "proxy requests; management ones never" },
    { path: "logs.error-logs-max-files", kind: "int", label: "Error logs kept", def: 10, min: 0 },
    { path: "usage.usage-statistics-enabled", kind: "bool", label: "Usage statistics", def: false, hint: "the usage this window shows" },
  ] },
  { id: "management", title: "Management access", section: "management", patch: "/config/management", leaves: true, fields: [
    { path: "allow-remote", kind: "bool", label: "Allow remote", def: false,
      warn: "Off, only localhost can manage the server — Herdr on another machine loses this window." },
    { path: "disable-control-panel", kind: "bool", label: "Disable web UI", def: false, hint: "the Management Center at /management.html" },
  ] },
];

export const fieldId = (group, field) => `${group.id}.${field.path}`;

// Every field by its id, for walking the typed inputs.
export const FIELDS = new Map(GROUPS.flatMap((g) => g.fields.map((f) => [fieldId(g, f), { g, f }])));

const parts = (path) => path.split(".");
export const get = (obj, path) => parts(path).reduce((o, k) => (o == null ? undefined : o[k]), obj);
export function set(obj, path, value) {
  const [head, ...rest] = parts(path);
  const next = { ...obj };
  next[head] = rest.length ? set(obj?.[head] ?? {}, rest.join("."), value) : value;
  return next;
}
export const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));

// What the view shows before anything is typed: the server's value, or the field's default
// when the server leaves it out (an omitted field is the default, not a change to write back).
export const shown = (saved, group, field) => {
  const v = get(saved?.[group.section], field.path);
  return v === undefined || v === null ? field.def : v;
};

// Reads the whitelisted sections. `management` reads leaf by leaf: a missing leaf is the
// server default (false), not an error.
export async function readSettings(client, cx, key) {
  const routing = await client.request(cx, key, "GET", "/config/routing");
  const observability = await client.request(cx, key, "GET", "/config/observability");
  const leaf = async (path, fallback) => {
    try { return await client.request(cx, key, "GET", `/config/management/${path}`); }
    catch (e) { if (e && e.status === 404) return fallback; throw e; }
  };
  const allowRemote = await leaf("allow-remote", false), panel = await leaf("disable-control-panel", false);
  return {
    routing: (routing && typeof routing === "object") ? routing : {},
    observability: (observability && typeof observability === "object") ? observability : {},
    management: { "allow-remote": allowRemote === true, "disable-control-panel": panel === true },
  };
}

const DURATION = /^(\d+h)?(\d+m)?(\d+s)?$/;

// Types the typed fields (ints, durations) into `draft`, validating them. Returns
// { draft, problems } with problems keyed by field id. A value equal to the default of a
// field the server omits stays omitted: nothing to write, nothing to lay down explicitly.
export function applyInputs(saved, draft, inputs) {
  const problems = {};
  for (const group of GROUPS) {
    for (const field of group.fields) {
      if (field.kind !== "int" && field.kind !== "duration") continue;
      const id = fieldId(group, field), text = String(inputs[id]?.value() ?? "").trim();
      let value;
      if (field.kind === "int") {
        if (!/^\d+$/.test(text)) { problems[id] = "a whole number, 0 or more"; continue; }
        value = Number(text);
        if (field.min !== undefined && value < field.min) { problems[id] = `${field.min} or more`; continue; }
      } else {
        if (!DURATION.test(text) || !/[hms]/.test(text)) { problems[id] = "like 30m or 1h30m"; continue; }
        value = text;
      }
      const present = get(saved[group.section], field.path) !== undefined;
    if (!present && value === field.def) continue; // equal to the server's default: leave it out, nothing to write
      draft = set(draft, `${group.section}.${field.path}`, value);
    }
  }
  return { draft, problems };
}

// The writes a save performs, changed groups only. A field counts as changed against the
// value the server's own omission implies (shown() on both sides), so a clean draft writes
// nothing and a default never lands explicitly. Routing and observability are sent as the
// server's own object with the changed leaves replaced (safe whether the server merges or
// replaces); management is sent as its two leaves, so its secret is never read or sent.
export function writesFor(saved, draft) {
  const writes = []
  for (const group of GROUPS) {
    const changed = group.fields.filter((f) => shown(draft, group, f) !== shown(saved, group, f));
    if (!changed.length) continue;
    if (group.leaves) {
      const body = {};
      for (const f of changed) body[f.path] = shown(draft, group, f);
      writes.push({ path: group.patch, body, label: group.title });
    } else {
      let body = clone(saved[group.section] ?? {});
      for (const f of changed) body = set(body, f.path, shown(draft, group, f));
      writes.push({ path: group.patch, body, label: group.title });
    }
  }
  return writes;
}
