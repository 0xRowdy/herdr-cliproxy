// Live quota from each provider's own usage endpoint, as the Management Center reads it:
// POST /requests/api-call with the account's auth_index, and the server puts the account's
// token where "$TOKEN$" is. Only the fixed GETs below are ever sent, and only the fields
// read here are kept (the profile replies carry names and IDs: they're dropped).
import { HttpError, parseTime, num, claudeWindows, codexQuota } from "./api.js";

export const QUOTA_EVERY = 5 * 60000, PLAN_EVERY = 60 * 60000;
export const LIVE = new Set(["claude", "codex", "xai"]);

const CLAUDE = { "User-Agent": "claude-cli/2.1.280 (external, cli)", Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" };
const CODEX = { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)" };
const XAI = { Authorization: "Bearer $TOKEN$", "x-xai-token-auth": "xai-grok-cli", "x-grok-client-version": "1.0.46", accept: "*/*", "user-agent": "grok-pager/1.0.46 grok-shell/1.0.46 (macos; aarch64)" };

async function get(client, cx, key, authIndex, url, header) {
  const r = await client.request(cx, key, "POST", "/requests/api-call", { body: { auth_index: authIndex, method: "GET", url, header }, ms: 20000 });
  const status = Number(r?.status_code) || 0;
  let body = null;
  try { body = r?.body ? JSON.parse(r.body) : null; } catch {}
  if (status < 200 || status >= 300) {
    const said = body?.error?.message ?? body?.error ?? body?.message ?? body?.detail;
    throw new HttpError(status, typeof said === "string" ? said.slice(0, 160) : `the provider answered ${status}`);
  }
  if (!body || typeof body !== "object") throw new Error("the provider's reply wasn't JSON");
  return body;
}

// A bar is { id, label, used (0–100), reset (ms), binds, status }; the view shows 100 − used.
const bar = (id, label, used, reset, extra = {}) => ({ id, label, used: Math.max(0, Math.min(100, used)), reset, binds: false, status: null, ...extra });

function windowLabel(seconds) {
  const m = Math.round(seconds / 60);
  if (m === 10080) return "Weekly";
  if (m === 1440) return "Daily";
  if (m % 1440 === 0) return `${m / 1440}-day`;
  if (m % 60 === 0) return `${m / 60}-hour`;
  return `${m}-min`;
}
const money = (amount, currency = "USD") => `${currency === "USD" ? "$" : `${currency} `}${amount.toFixed(2)}`;

// ── Claude ──────────────────────────────────────────────────────────────

const CLAUDE_WINDOWS = [
  ["five_hour", "5-hour", "session"], ["seven_day", "7-day", "weekly_all"],
  ["seven_day_opus", "7-day Opus"], ["seven_day_sonnet", "7-day Sonnet"],
  ["seven_day_oauth_apps", "7-day OAuth apps"], ["seven_day_cowork", "7-day Cowork"],
];

export function claudePlan(profile) {
  const org = profile?.organization ?? {}, acct = profile?.account ?? {};
  const tier = String(org.rate_limit_tier ?? org.rateLimitTier ?? "").toLowerCase();
  if (String(org.organization_type ?? "").toLowerCase() === "claude_team" && String(org.subscription_status ?? "").toLowerCase() === "active") return "Team";
  if (tier.endsWith("claude_max_20x")) return "Max 20x";
  if (tier.endsWith("claude_max_5x")) return "Max 5x";
  if (acct.has_claude_max === true) return "Max";
  if (acct.has_claude_pro === true) return "Pro";
  if (acct.has_claude_max === false && acct.has_claude_pro === false) return "Free";
  return null;
}

export function claudeQuota(u) {
  const limits = Array.isArray(u?.limits) ? u.limits : [];
  const active = limits.find((l) => l?.is_active === true)?.kind ?? null;
  const severity = (kind) => { const s = limits.find((l) => l?.kind === kind)?.severity; return s && s !== "normal" ? s : null; };
  const bars = [];
  for (const [key, label, kind] of CLAUDE_WINDOWS) {
    const w = u?.[key], used = num(w?.utilization);
    if (used === null) continue;
    bars.push(bar(key, label, used, parseTime(w.resets_at), { binds: Boolean(kind) && kind === active, status: kind ? severity(kind) : null }));
  }
  // Per-model weekly limits (Fable, …), unless a named window above already covers that model.
  for (const l of limits) {
    const model = l?.kind === "weekly_scoped" ? String(l?.scope?.model?.display_name ?? "").trim() : "";
    const used = num(l?.percent);
    if (!model || used === null || bars.some((b) => b.label.toLowerCase() === `7-day ${model}`.toLowerCase())) continue;
    bars.push(bar(`scoped-${model}`, `7-day ${model}`, used, parseTime(l.resets_at), { binds: l.is_active === true, status: l.severity && l.severity !== "normal" ? l.severity : null }));
  }
  const lines = [];
  const spend = u?.spend, extra = u?.extra_usage;
  if (spend && typeof spend === "object") {
    const scale = (m) => num(m?.amount_minor) === null ? null : num(m.amount_minor) / 10 ** (num(m.exponent) ?? 2);
    const used = scale(spend.used), limit = scale(spend.limit), currency = spend.used?.currency ?? spend.limit?.currency ?? "USD";
    if (spend.enabled === false) lines.push(["Extra usage", "off"]);
    else if (used !== null && limit !== null) lines.push(["Extra usage", `${money(used, currency)} of ${money(limit, currency)}`, spend.severity && spend.severity !== "normal" ? spend.severity : null]);
  } else if (extra && typeof extra === "object") {
    const d = num(extra.decimal_places) ?? 2, used = num(extra.used_credits), limit = num(extra.monthly_limit);
    if (extra.is_enabled === false) lines.push(["Extra usage", "off"]);
    else if (used !== null && limit !== null) lines.push(["Extra usage", `${money(used / 10 ** d, extra.currency)} of ${money(limit / 10 ** d, extra.currency)}`]);
  }
  const rows = (Array.isArray(u?.seven_day_breakdown?.rows) ? u.seven_day_breakdown.rows : [])
    .filter((r) => num(r?.percent) > 0).map((r) => `${r.display_name} ${Math.round(num(r.percent))}%`);
  if (rows.length) lines.push(["7-day by app", rows.join(" · ")]);
  return { bars, lines };
}

// ── Codex ───────────────────────────────────────────────────────────────

export function codexLive(u) {
  const rl = u?.rate_limit ?? {}, bars = [];
  for (const [id, w] of [["primary", rl.primary_window], ["secondary", rl.secondary_window]]) {
    const used = num(w?.used_percent), seconds = num(w?.limit_window_seconds) ?? 0;
    if (used === null || (id === "secondary" && !(seconds > 0))) continue;
    bars.push(bar(id, seconds > 0 ? windowLabel(seconds) : "Primary", used, parseTime(w.reset_at), { status: rl.limit_reached === true ? "limit reached" : null }));
  }
  const lines = [], c = u?.credits;
  if (c?.unlimited === true) lines.push(["Credits", "unlimited"]);
  else if (num(c?.balance) !== null) lines.push(["Credits", num(c.balance)]);
  const resets = num(u?.rate_limit_reset_credits?.available_count);
  if (resets) lines.push(["Reset credits", String(resets)]);
  const plan = typeof u?.plan_type === "string" && u.plan_type ? u.plan_type.charAt(0).toUpperCase() + u.plan_type.slice(1) : null;
  return { plan, bars, lines };
}

// ── xAI ─────────────────────────────────────────────────────────────────

// "XPremiumPlus" → "X Premium+", "SuperGrokHeavy" → "SuperGrok Heavy".
export const xaiPlan = (tier) => typeof tier === "string" && tier
  ? tier.replace(/Plus$/, "+").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^X(?=[A-Z])/, "X ").replace("Super Grok", "SuperGrok")
  : null;

export function xaiLive(billing) {
  const c = billing?.config ?? {}, lines = [];
  const end = parseTime(c.billingPeriodEnd ?? c.currentPeriod?.end);
  const cap = num(c.onDemandCap?.val);
  if (cap !== null) lines.push(["Pay as you go", cap > 0 ? "on" : "off"]);
  return { bars: [], lines, periodEnd: end, note: "xAI reports no usage percentage" };
}

// ── fetching ────────────────────────────────────────────────────────────

// One account's live quota. `plans` caches each account's plan for PLAN_EVERY.
export async function fetchQuota(client, cx, key, f, plans) {
  const p = plans[f.auth_index], planDue = !p || Date.now() - p.at > PLAN_EVERY;
  const keepPlan = async (fn) => { if (!planDue) return; try { plans[f.auth_index] = { plan: await fn(), at: Date.now() }; } catch {} };
  const ask = (url, header) => get(client, cx, key, f.auth_index, url, header);
  let data;
  if (f.provider === "claude") {
    const [usage] = await Promise.all([
      ask("https://api.anthropic.com/api/oauth/usage", CLAUDE),
      keepPlan(async () => claudePlan(await ask("https://api.anthropic.com/api/oauth/profile", CLAUDE))),
    ]);
    data = claudeQuota(usage);
  } else if (f.provider === "codex") {
    data = codexLive(await ask("https://chatgpt.com/backend-api/wham/usage", CODEX));
  } else if (f.provider === "xai") {
    const [billing] = await Promise.all([
      ask("https://cli-chat-proxy.grok.com/v1/billing?format=credits", XAI),
      keepPlan(async () => xaiPlan((await ask("https://cli-chat-proxy.grok.com/v1/user?include=subscription", XAI))?.subscriptionTier)),
    ]);
    data = xaiLive(billing);
  } else return null;
  return { plan: data.plan ?? plans[f.auth_index]?.plan ?? null, at: Date.now(), source: "live", ...data };
}

// CLI Proxy Lite's reading, from response headers on the account's own traffic, as a fallback.
export function headerQuota(f) {
  let best = null;
  for (const [model, q] of Object.entries(f.model_quotas)) {
    const at = parseTime(q.observed_at) ?? 0;
    if (!best || at > best.at) best = { model, at, signals: q.signals };
  }
  if (!best) return null;
  const s = best.signals, keys = Object.keys(s);
  const from = (b) => bar(b.id, b.label, b.pct, b.reset, { binds: b.binds, status: b.status && String(b.status).toLowerCase() !== "allowed" ? b.status : null });
  if (keys.some((k) => k.startsWith("Anthropic-Ratelimit-Unified-")))
    return { plan: null, at: best.at, source: "headers", model: best.model, bars: claudeWindows(s).map(from), lines: [] };
  if (keys.some((k) => k.startsWith("X-Codex-"))) {
    const c = codexQuota(s);
    return { plan: c.plan ? String(c.plan).charAt(0).toUpperCase() + String(c.plan).slice(1) : null, at: best.at, source: "headers", model: best.model,
      bars: c.bars.map(from), lines: c.credits !== null ? [["Credits", c.credits]] : [] };
  }
  return { plan: null, at: best.at, source: "headers", model: best.model, bars: [], lines: Object.entries(s).map(([k, v]) => [k, String(v)]) };
}
