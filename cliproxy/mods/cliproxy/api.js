// The CLIProxyAPI management API: requests, and the few fields the panel may show.
// The key comes from the key file (or memory, when not remembered); it never reaches
// the UI, logs, props or localStorage. Never call /config, /config.yaml or /credentials/download.
import net from "net";
import { readTextFile, writeTextFile, exec, home, appHome } from "herdr";

const DEFAULT_PORT = 8317, TIMEOUT = Symbol("timeout");
export const webUI = (base) => `${base}/management.html`;
export const keyDir = () => `${home()}/.config/cliproxyapi`;
export const keyPath = () => `${keyDir()}/mgmt.key`;
const configPath = () => `${appHome()}/cliproxy.json`;

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export class Unreachable extends Error {}
export const refused = (e) => e instanceof HttpError && (e.status === 401 || e.status === 403);

// "http://host:8317/management.html" → "http://host:8317"; a bare host ("proxy") gets http and 8317.
export function normalizeUrl(text) {
  let s = String(text ?? "").trim();
  if (!s) return null;
  const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (bare) s = `http://${s}`;
  const m = /^(https?):\/\/([^/?#\s@]+)(?:[/?#].*)?$/i.exec(s);
  if (!m) return null;
  const host = m[2].toLowerCase();
  return `${m[1].toLowerCase()}://${bare && !/:\d+$/.test(host) ? `${host}:${DEFAULT_PORT}` : host}`;
}

// { url, fallback? } from cliproxy.json, or null when it's missing or unusable.
export async function readConfig() {
  const text = await readTextFile(configPath()).catch(() => null);
  if (!text) return null;
  try {
    const c = JSON.parse(text), url = normalizeUrl(c?.url), fallback = normalizeUrl(c?.fallback);
    return url ? { url, ...(fallback && fallback !== url ? { fallback } : {}) } : null;
  } catch { return null; }
}
export async function writeConfig(config) {
  const current = await readTextFile(configPath()).catch(() => null);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  if (text !== current) await writeTextFile(configPath(), text, current);
}
export const bases = (config) => config ? [config.url, ...(config.fallback ? [config.fallback] : [])] : [];

export async function readKey() {
  const text = await readTextFile(keyPath()).catch(() => null);
  return text?.trim() || null;
}

// New files come out world-readable: the folder is 700 and the file 600 before it counts as saved.
async function run(cmd, args) {
  const r = await exec(cmd, args);
  if (r.code !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
}
export async function saveKey(key) {
  await run("mkdir", ["-p", "-m", "700", keyDir()]);
  await run("chmod", ["700", keyDir()]);
  const current = await readTextFile(keyPath()).catch(() => null);
  if (current?.trim() !== key) await writeTextFile(keyPath(), `${key}\n`, current);
  await run("chmod", ["600", keyPath()]);
}
export const forgetKey = () => run("rm", ["-f", keyPath()]);

function header(r, name) {
  const h = r.headers;
  if (!h) return null;
  if (typeof h.get === "function") return h.get(name) ?? null;
  const k = Object.keys(h).find((k) => k.toLowerCase() === name);
  return k ? h[k] : null;
}

function message(raw, status) {
  try { const j = JSON.parse(raw); if (j?.error || j?.message) return String(j.error || j.message).slice(0, 200); } catch {}
  return raw.trim().slice(0, 200) || `HTTP ${status}`;
}

export class Client {
  constructor(bases) { this.bases = bases; this.at = 0; this.version = null; }
  get base() { return this.bases[this.at]; }

  // A request that never reached the server tries the fallback URL; an action that timed
  // out doesn't (it may have landed). `ms` is the per-request limit.
  async request(cx, key, method, path, { body, ms = 15000, text = false } = {}) {
    let last;
    for (let i = 0; i < this.bases.length; i++) {
      const at = (this.at + i) % this.bases.length;
      const options = { method, headers: { Authorization: `Bearer ${key}` } };
      if (body !== undefined) { options.headers["Content-Type"] = "application/json"; options.body = JSON.stringify(body); }
      const pending = fetch(`${this.bases[at]}/v8/management${path}`, options);
      pending.catch(() => {});
      let r;
      try { r = await Promise.race([pending, cx.sleep(ms).then(() => TIMEOUT)]); }
      catch (e) { last = e?.message ?? String(e); continue; }
      if (r === TIMEOUT) {
        last = `no answer in ${Math.round(ms / 1000)} s`;
        if (method === "GET") continue;
        throw new Unreachable(last);
      }
      this.at = at;
      const version = header(r, "x-cpa-version") ?? header(r, "x-server-version");
      if (version) this.version = version;
      const raw = await r.text();
      if (!r.ok) throw new HttpError(r.status, message(raw, r.status));
      return text ? raw : raw ? JSON.parse(raw) : {};
    }
    throw new Unreachable(last ?? "no answer");
  }

  // The server's version is only in response headers, which this fetch doesn't expose:
  // ask over a plain socket and read the head (plain http only).
  async probeVersion(cx, key) {
    const m = /^http:\/\/(\[[^\]]+\]|[^:/]+):(\d+)$/i.exec(this.base ?? "");
    if (!m) return;
    const host = m[1].replace(/^\[|\]$/g, ""), port = Number(m[2]);
    const work = (async () => {
      const socket = await net.connect(host, port);
      try {
        await socket.write(`GET /v8/management/server/latest-version HTTP/1.1\r\nHost: ${m[1]}:${port}\r\nAuthorization: Bearer ${key}\r\nConnection: close\r\n\r\n`);
        let head = "";
        while (!head.includes("\r\n\r\n") && head.length < 65536) {
          const chunk = await socket.read(4096);
          if (!chunk) break;
          head += String.fromCharCode(...chunk);
        }
        return /^x-(?:cpa|server)-version:[ \t]*(\S+)/im.exec(head)?.[1] ?? null;
      } finally { socket.close(); }
    })();
    work.catch(() => {});
    const version = await Promise.race([work, cx.sleep(15000).then(() => null)]);
    if (version) this.version = version;
  }
}

export const describe = (e) => e instanceof HttpError ? `${e.status}: ${e.message}` : String(e?.message ?? e);

// Only what the panel shows or acts with: never id_token, path or the rest.
export function cleanFile(f) {
  const quotas = {};
  for (const [model, q] of Object.entries(f?.model_quotas ?? {}))
    if (q?.signals && typeof q.signals === "object") quotas[model] = { observed_at: q.observed_at, signals: q.signals };
  return {
    name: String(f?.name ?? ""), auth_index: String(f?.auth_index ?? ""), provider: String(f?.provider ?? f?.type ?? ""),
    email: f?.email ?? null, label: f?.label ?? null, status: f?.status ?? null, status_message: f?.status_message ?? "",
    disabled: f?.disabled === true, unavailable: f?.unavailable === true,
    success: Number(f?.success) || 0, failed: Number(f?.failed) || 0, last_refresh: f?.last_refresh ?? null,
    cooldowns: Array.isArray(f?.cooldowns) ? f.cooldowns.map(cleanCooldown).filter(Boolean) : [],
    model_quotas: quotas,
    recent: buckets(f?.recent_requests),
  };
}

// [{time:"HH:MM-HH:MM", success, failed}], the last 20 ten-minute buckets.
const buckets = (list) => (Array.isArray(list) ? list : []).slice(-20)
  .map((b) => ({ time: String(b?.time ?? ""), success: Number(b?.success) || 0, failed: Number(b?.failed) || 0 }));

function cleanCooldown(c) {
  if (!c || typeof c !== "object") return null;
  const retry = parseTime(c.retry_at), left = Number(c.remaining_seconds);
  return { scope: c.scope ?? null, model: c.model_key ?? null, reason: c.reason ?? null,
    until: retry ?? (Number.isFinite(left) ? Date.now() + left * 1000 : null) };
}

// "<base-url>|<hash>": the host only, never the hash (or any userinfo).
export function usageRows(data) {
  const rows = [];
  for (const [provider, upstreams] of Object.entries(data ?? {})) {
    for (const [id, u] of Object.entries(upstreams ?? {})) {
      const base = id.split("|")[0], host = (/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(base)?.[1] ?? base).split("@").pop();
      rows.push({ provider, host, success: Number(u?.success) || 0, failed: Number(u?.failed) || 0, buckets: buckets(u?.recent_requests) });
    }
  }
  return rows;
}

export const errorFiles = (data) => (Array.isArray(data?.files) ? data.files : [])
  .filter((f) => typeof f?.name === "string" && f.name)
  .map((f) => ({ name: f.name, size: Number(f.size) || 0, modified: parseTime(f.modified) }))
  .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)).slice(0, 10);

// Error logs carry request headers; never show credentials from them.
export const redact = (text) => text
  .replace(/^(\s*(?:proxy-)?authorization|\s*x-api-key|\s*api-key|\s*x-goog-api-key|\s*x-management-key|\s*cookie|\s*set-cookie)(\s*:).*$/gim, "$1$2 [redacted]")
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]")
  .replace(/("(?:api[_-]?key|access_token|refresh_token|id_token|token|secret|password)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
  .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1[redacted]");

// Times: unix seconds, ms, or ISO (with nanoseconds, which Date.parse refuses).
export function parseTime(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const ms = Date.parse(String(v).replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(ms) ? ms : null;
}

function span(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : "<1m";
}
export const ago = (ms, now = Date.now()) => ms === null ? "never" : now - ms < 60000 ? "just now" : `${span((now - ms) / 1000)} ago`;
export const until = (ms, now = Date.now()) => ms === null ? null : ms <= now ? null : `in ${span((ms - now) / 1000)}`;

export const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
export const grouped = (n) => {
  const [whole, frac] = (Math.round(n * 100) / 100).toString().split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
};

const parts = (v) => String(v ?? "").replace(/^v/i, "").split(/[.-]/).map((p) => parseInt(p, 10) || 0);
export function newer(latest, current) {
  if (!latest || !current) return false;
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

// The newest reading across models: the windows are the account's, so it's the truest.
export function latestQuota(file) {
  let best = null;
  for (const [model, q] of Object.entries(file.model_quotas)) {
    const at = parseTime(q.observed_at) ?? 0;
    if (!best || at > best.at) best = { model, at, signals: q.signals };
  }
  return best;
}

// "ok" up to 70 %, "warn" to 90 %, "error" past that or when the window isn't allowed.
export const level = (pct, status) => (status && String(status).toLowerCase() !== "allowed") || pct > 90 ? "error" : pct >= 70 ? "warn" : "ok";

const CLAUDE = "Anthropic-Ratelimit-Unified-";
const CLAIMS = { "5h": "five_hour", "7d": "seven_day" };
function claudeLabel(id) {
  const [head, ...rest] = id.split("_");
  const base = head === "5h" ? "5-hour" : head === "7d" ? "7-day" : head.charAt(0).toUpperCase() + head.slice(1).toLowerCase();
  return [base, ...rest].join(" ");
}
const claudeRank = (id) => id.startsWith("5h") ? 0 : id.startsWith("7d") ? 1 : id.toLowerCase() === "overage" ? 3 : 2;

export function claudeWindows(s) {
  const claim = String(s[`${CLAUDE}Representative-Claim`] ?? "").toLowerCase(), out = [];
  for (const key of Object.keys(s)) {
    if (!key.startsWith(CLAUDE) || !key.endsWith("-Utilization")) continue;
    const id = key.slice(CLAUDE.length, -"-Utilization".length), used = num(s[key]);
    if (used === null || (id.toLowerCase() === "overage" && !(used > 0))) continue;
    const [head, ...rest] = id.split("_"), claimName = [CLAIMS[head] ?? head.toLowerCase(), ...rest].join("_");
    out.push({ id, label: claudeLabel(id), pct: used * 100, status: s[`${CLAUDE}${id}-Status`] ?? null,
      reset: parseTime(s[`${CLAUDE}${id}-Reset`]), binds: claim === claimName });
  }
  return out.sort((a, b) => claudeRank(a.id) - claudeRank(b.id) || a.id.localeCompare(b.id));
}

function windowLabel(minutes) {
  if (minutes === 10080) return "Weekly";
  if (minutes === 1440) return "Daily";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-min`;
}

export function codexQuota(s) {
  const get = (k) => s[`X-Codex-${k}`], bars = [];
  for (const which of ["Primary", "Secondary"]) {
    const minutes = num(get(`${which}-Window-Minutes`)) ?? 0, pct = num(get(`${which}-Used-Percent`));
    if (pct === null || (which === "Secondary" && !(minutes > 0))) continue;
    bars.push({ id: which.toLowerCase(), label: minutes > 0 ? windowLabel(minutes) : which, pct, status: null,
      reset: parseTime(get(`${which}-Reset-At`)), binds: false });
  }
  const unlimited = String(get("Credits-Unlimited") ?? "").toLowerCase() === "true";
  return { plan: get("Plan-Type") ?? null, bars, credits: unlimited ? null : num(get("Credits-Balance")) };
}
