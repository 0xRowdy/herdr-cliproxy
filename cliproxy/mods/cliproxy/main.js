import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { exec, run, notify, closeOverlay, theme, settings, focused, props, window as appWindow } from "herdr";
import {
  Client, HttpError, Unreachable, refused, readConfig, writeConfig, bases, normalizeUrl, readKey, saveKey, forgetKey,
  webUI, describe, cleanFile, usageRows, errorFiles, redact, parseTime, ago, until, grouped, newer,
} from "./api.js";
import { LIVE, QUOTA_EVERY, fetchQuota, headerQuota } from "./quota.js";
import { SIGN_INS, SIGN_IN_POLL, SIGN_IN_LIMIT, signInFor, authUrlPath, callbackUrl, routingLine } from "./signin.js";
import { GROUPS, FIELDS, fieldId, shown, readSettings, applyInputs, typedChanged, writesFor, clone, get, set } from "./settings.js";

const POLL = 60000, LATEST_EVERY = 30 * 60000, REFRESH_ALL_MS = 300000;
const KEY_FILE = "~/.config/cliproxyapi/mgmt.key";
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ICONS = { claude: "claude", codex: "codex", gemini: "gemini", grok: "grok", xai: "grok", kimi: "kimi", antigravity: "antigravity" };
const TINTED = new Set(["grok"]); // one-color glyphs (currentColor): drawn in the text color
const NAMES = { claude: "Claude", codex: "Codex", gemini: "Gemini", grok: "Grok", xai: "xAI", kimi: "Kimi", antigravity: "Antigravity", vertex: "Vertex", qwen: "Qwen", iflow: "iFlow" };
const providerName = (p) => NAMES[p] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : "Account");
const tone = (t, l) => l === "error" ? t.ansi1 : l === "warn" ? t.blocked : t.accent;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
// From the used share: up to 70% used is fine, to 90% a warning, past that (or a provider's
// "critical" / "limit reached") an error.
const level = (b) => b.status === "critical" || b.status === "limit reached" || b.used > 90 ? "error" : b.status === "warning" || b.used >= 70 ? "warn" : "ok";
// The Management Center's dashboard verdict, from the success rate over the buckets.
const verdict = (rate) => rate === null ? ["Quiet for now", "dim"] : rate >= 95 ? ["All systems steady", "ansi2"] : rate >= 80 ? ["Minor turbulence", "blocked"] : ["Needs attention", "ansi1"];
const span = (buckets) => { const m = buckets * 10; return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`; };
const sum = (list, k) => list.reduce((n, b) => n + b[k], 0);
// localStorage can be missing or throw; folding still works for this session then.
const recall = (k) => { try { return JSON.parse(localStorage.getItem(k) ?? "null"); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export default class CLIProxy extends View {
  // The mod's machines, so their rules live in one head:
  // · phase() decides the view: a log-pane copy, the login form, or the panel, over
  //   this.state = loading → ok | unreachable | error; a refused key holds out until the
  //   key changes or Retry.
  // · the login form: connecting → saved | formProblem; only a working URL and key are kept.
  // · one sign-in at a time: flow.status starting → waiting → (sending → waiting) → ok | error,
  //   and flowGen drops replies from a run that was replaced or cancelled.
  // · each account's quota: live[auth_index] {busy, tried, data, error}, at most every 5 min.
  // · every action is busy[id] while it runs, and the data refreshes after it ends.
  // · the server settings view: this.settings is closed (null) → loading → ready ⇄ dirty →
  //   saving → ready; what may be read and written lives in settings.js.
  init(_props, cx) {
    this.log = props()?.log ?? null;
    if (this.log) return this.loadLog(cx);
    this.files = []; this.usage = []; this.errors = []; this.busy = {};
    this.live = {};       // auth_index → { data, error, busy }: live quota from the providers
    this.plans = {};       // auth_index → { plan, at }: plans change rarely, asked hourly
    this.collapsed = new Set(Array.isArray(recall("collapsed")) ? recall("collapsed") : []);
    this.errorsOpen = recall("errorsOpen") === true;
    this.state = "loading"; this.problem = null;
    this.config = null; this.client = null;
    this.memKey = null;    // a key used without Remember: this copy's memory only
    this.keySaved = false; this.setupNeeded = false; this.editing = false; this.changingUrl = false;
    this.remember = true; this.reveal = false; this.connecting = false; this.formProblem = null;
    this.urlInput = InputState.new({ placeholder: "http://host:8317" });
    this.fallbackInput = InputState.new({ placeholder: "http://100.x.y.z:8317" });
    this.keyInput = InputState.new({ placeholder: "Enter the management key" });
    this.keyInput.set_masked(true);
    this.callbackInput = InputState.new({ placeholder: "http://localhost:…/callback?code=…" });
    this.flow = null;      // the sign-in running now, if any: one at a time
    this.picking = false;  // the Add account provider list is open
    this.settings = null;  // the server settings view: null is closed, openSettings opens it
    for (const [name, input] of [["url", this.urlInput], ["fallback", this.fallbackInput], ["key", this.keyInput], ["callback", this.callbackInput]]) {
      input.on("focus", (_e, cx) => { this.typing = name; cx.notify(); });
      input.on("blur", (_e, cx) => { if (this.typing === name) this.typing = null; cx.notify(); });
      input.on("submit", (_e, cx) => name === "callback" ? this.submitCallback(cx) : this.connect(cx));
    }
    this.refresh(cx);
    cx.timer.every(POLL, (cx) => this.refresh(cx));
  }

  async close() {
    this.code?.release();
    for (const input of [this.urlInput, this.fallbackInput, this.keyInput, this.callbackInput]) input?.release();
    for (const input of Object.values(this.settings?.inputs ?? {})) input?.release();
  }

  refresh(cx, { force = false } = {}) {
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await this.load(cx, force); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) this.refresh(cx);
      }
    });
  }

  // The one decision the render branches on: which of the three views shows. Every flag
  // change (a log pane, the setup and edit flags, the server's own state) funnels through
  // here, so no render branch re-derives it.
  phase() {
    if (this.log) return "log";
    if (this.setupNeeded || this.editing) return "form";
    return this.state;
  }

  useConfig(config) {
    if (JSON.stringify(config) === JSON.stringify(this.config)) return;
    if (this.config && config?.url !== this.config.url) {
      this.files = []; this.usage = []; this.errors = []; this.fetchedAt = undefined; this.latest = null; this.latestAt = 0; this.state = "loading";
      this.live = {}; this.plans = {}; this.flow = null; this.flowGen = (this.flowGen ?? 0) + 1; this.picking = false;
      this.closeSettings();
    }
    this.config = config; this.client = config ? new Client(bases(config)) : null;
  }

  async load(cx, force) {
    const config = await readConfig(), saved = await readKey(), key = saved ?? this.memKey;
    this.useConfig(config);
    this.keySaved = Boolean(saved);
    this.setupNeeded = !config || !key;
    if (this.setupNeeded) {
      if (!this.prefilled) { this.prefill(config); this.changingUrl = !config; this.prefilled = true; }
      return;
    }
    // A refused key stays refused until it changes or Retry: repeated bad keys get an IP banned.
    if (key === this.refused && !force) return;
    try {
      const creds = await this.client.request(cx, key, "GET", "/credentials");
      this.files = (Array.isArray(creds?.files) ? creds.files : []).map(cleanFile);
      this.state = "ok"; this.problem = null; this.refused = null; this.fetchedAt = Date.now();
      this.loadQuota(cx, key, force);
    } catch (e) {
      this.problem = e instanceof Unreachable ? `Proxy unreachable · ${e.message}` : refused(e) ? "Management key refused" : `Proxy error · ${describe(e)}`;
      this.state = e instanceof Unreachable ? "unreachable" : "error";
      if (refused(e)) this.refused = key;
      return;
    }
    const checkLatest = !this.latestAt || Date.now() - this.latestAt > LATEST_EVERY;
    const [usage, errors, routing, latest] = await Promise.all([
      settle(this.client.request(cx, key, "GET", "/observability/usage/api-keys")),
      settle(this.client.request(cx, key, "GET", "/observability/logs/errors")),
      // The routing part of the config only: it holds no keys. Never GET /config itself.
      settle(this.client.request(cx, key, "GET", "/config/routing")),
      checkLatest ? settle(this.client.request(cx, key, "GET", "/server/latest-version")) : null,
      checkLatest || !this.client.version ? settle(this.client.probeVersion(cx, key)) : null,
    ]);
    if (usage.error) this.usageProblem = describe(usage.error); else { this.usage = usageRows(usage.value); this.usageProblem = null; }
    // Logging to file can be off on the server: then the section goes.
    this.errorsHidden = errors.error instanceof HttpError && errors.error.status === 400;
    if (errors.error) this.errorsProblem = this.errorsHidden ? null : describe(errors.error);
    else { this.errors = errorFiles(errors.value); this.errorsProblem = null; }
    if (latest && !latest.error) { this.latest = latest.value?.["latest-version"] ?? null; this.latestAt = Date.now(); }
    this.routing = routing.error ? null : routingLine(routing.value);
  }

  // Each enabled Claude, Codex or xAI account, every QUOTA_EVERY (or now, on Refresh), in its own
  // task: the cards show first and their quota fills in. A failure keeps the last reading.
  loadQuota(cx, key, force) {
    const client = this.client, now = Date.now();
    for (const f of this.files) {
      const q = this.live[f.auth_index] ?? (this.live[f.auth_index] = {});
      if (!LIVE.has(f.provider) || f.disabled || q.busy || (!force && q.tried && now - q.tried < QUOTA_EVERY)) continue;
      q.busy = true; q.tried = now;
      cx.spawn(async (cx) => {
        try { q.data = await fetchQuota(client, cx, key, f, this.plans); q.error = null; }
        catch (e) { q.error = describe(e); }
        finally { q.busy = false; cx.notify(); }
      });
    }
  }

  // ── setup ─────────────────────────────────────────────────────────────

  prefill(config) {
    this.urlInput.set_value(config?.url ?? ""); this.fallbackInput.set_value(config?.fallback ?? "");
    this.keyInput.set_value(""); this.keyInput.set_masked(true); this.reveal = false; this.formProblem = null;
  }

  // From the banner: a refused key or an unreachable server. Cancel goes back.
  edit(cx, { url = false } = {}) {
    this.prefill(this.config);
    this.editing = true; this.changingUrl = url || !this.config; this.remember = this.keySaved || !this.memKey;
    cx.notify();
  }

  // As the web UI: forget the key (saved and in memory), keep the server, show the login.
  logout(cx) {
    cx.spawn(async (cx) => {
      try { await forgetKey(); }
      catch (e) { notify({ title: "CLI Proxy", body: `Couldn't remove the saved key · ${describe(e)}`, level: "error" }); return; }
      this.memKey = null; this.keySaved = false; this.refused = null; this.setupNeeded = true; this.editing = false;
      this.files = []; this.usage = []; this.errors = []; this.fetchedAt = undefined; this.state = "loading"; this.problem = null;
      this.live = {}; this.plans = {}; this.flow = null; this.flowGen = (this.flowGen ?? 0) + 1; this.picking = false;
      this.closeSettings();
      this.prefill(this.config); this.changingUrl = !this.config; this.remember = true;
      cx.notify();
    });
  }

  // Tries the URL and key first; only a working pair is saved.
  connect(cx) {
    if (this.connecting) return;
    const typedUrl = this.changingUrl || !this.config;
    const url = typedUrl ? normalizeUrl(this.urlInput.value()) : this.config.url;
    const fallbackText = typedUrl ? this.fallbackInput.value().trim() : this.config.fallback ?? "";
    const fallback = fallbackText ? normalizeUrl(fallbackText) : null, typed = this.keyInput.value().trim(), remember = this.remember;
    this.formProblem = !url ? "Enter the server's URL, like http://host:8317" : fallbackText && !fallback ? "The fallback URL should look like http://host:8317" : null;
    if (this.formProblem) return cx.notify();
    this.connecting = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const key = typed || (await readKey()) || this.memKey;
        if (!key) { this.formProblem = "Enter the management key"; return; }
        const config = { url, ...(fallback && fallback !== url ? { fallback } : {}) };
        try { await new Client(bases(config)).request(cx, key, "GET", "/credentials"); }
        catch (e) {
          this.formProblem = refused(e) ? "The server refused that key" : e instanceof Unreachable ? `Can't reach ${url} · ${e.message}` : `The server said ${describe(e)}`;
          return;
        }
        await writeConfig(config);
        if (remember) await saveKey(key); else await forgetKey();
        this.useConfig(config);
        this.memKey = remember ? null : key; this.keySaved = remember; this.refused = null;
        this.editing = false; this.setupNeeded = false; this.changingUrl = false; this.formProblem = null;
        this.keyInput.set_value("");
        this.refresh(cx, { force: true });
      } catch (e) { this.formProblem = `Couldn't save the settings · ${describe(e)}`; }
      finally { this.connecting = false; cx.notify(); }
    });
  }

  // ── actions ───────────────────────────────────────────────────────────

  act(id, method, path, body, cx, ms) {
    if (this.busy[id] || !this.client) return;
    this.busy[id] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const key = (await readKey()) ?? this.memKey;
        if (!key) { this.setupNeeded = true; return; }
        await this.client.request(cx, key, method, path, { body, ms });
      } catch (e) {
        notify({ title: "CLI Proxy", body: describe(e), level: "error" });
      } finally {
        delete this.busy[id];
        this.refresh(cx, { force: true });
      }
    });
  }

  openWebUI(cx) {
    const base = this.client?.base ?? this.config?.url;
    if (base) this.openUrl(webUI(base), cx);
  }

  // Only http(s): sign-in links come from the server, and `open` would hand any scheme to its app.
  openUrl(url, cx) {
    if (!/^https?:\/\//i.test(String(url ?? ""))) return;
    const platform = appWindow().platform;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(platform === "macos" ? "open" : "xdg-open", [url]);
        if (r.code !== 0) cx.open_url(url);
      } catch { cx.open_url(url); }
    });
  }

  // ── settings ──────────────────────────────────────────────────────────

  // The gear: closed → loading → ready, or straight back to closed. Each open is its own
  // session: a read that finishes after a close, reopen or server change is dropped.
  openSettings(cx) {
    if (this.settings) { this.closeSettings(); cx.notify(); return; }
    const s = this.settings = { phase: "loading", problem: null, saved: null, draft: null, inputs: {}, fieldProblems: {}, saving: false, savedAt: null };
    const client = this.client, current = () => this.settings === s && this.client === client;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const key = (await readKey()) ?? this.memKey;
        if (!key) { if (current()) { this.closeSettings(); this.setupNeeded = true; } return; }
        const saved = await readSettings(client, cx, key);
        if (!current()) return;
        s.saved = saved;
        s.draft = clone(saved);
        for (const [name, { g, f }] of FIELDS) {
          if (f.kind !== "int" && f.kind !== "duration") continue;
          const input = InputState.new({ placeholder: String(f.def ?? "") });
          input.set_value(String(shown(saved, g, f) ?? ""));
          input.on("focus", (_e, cx) => { this.typing = name; cx.notify(); });
          input.on("blur", (_e, cx) => { if (this.typing === name) this.typing = null; cx.notify(); });
          s.inputs[name] = input;
        }
        s.phase = "ready";
      } catch (e) {
        if (!current()) return;
        s.phase = "error";
        s.problem = describe(e);
      } finally { cx.notify(); }
    });
  }

  closeSettings() {
    for (const input of Object.values(this.settings?.inputs ?? {})) input?.release();
    this.settings = null;
  }

  // Save: the typed fields are validated first, then each changed group goes as one PATCH;
  // what the server kept is read back, so the view shows its truth. The save belongs to its
  // session and server: if either changes, the remaining PATCHes are not sent. A failure
  // after some groups landed re-reads the server so the next Save sends only what is left.
  saveSettings(cx) {
    const s = this.settings;
    if (!s || s.phase !== "ready" || s.saving) return;
    const { draft, problems } = applyInputs(s.saved, s.draft, s.inputs);
    s.draft = draft; s.fieldProblems = problems;
    const writes = writesFor(s.saved, s.draft);
    if (Object.keys(problems).length || !writes.length) return cx.notify();
    const client = this.client, current = () => this.settings === s && this.client === client;
    const sent = Object.fromEntries(Object.entries(s.inputs).map(([name, input]) => [name, input.value().trim()]));
    s.saving = true; s.problem = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const applied = [];
      try {
        const key = (await readKey()) ?? this.memKey;
        if (!key) { if (current()) { this.closeSettings(); this.setupNeeded = true; } return; }
        for (const w of writes) {
          if (!current()) return;
          await client.request(cx, key, "PATCH", w.path, { body: w.body });
          applied.push(w);
        }
        const saved = await readSettings(client, cx, key);
        if (!current()) return;
        s.saved = saved;
        s.draft = clone(saved);
        s.fieldProblems = {};
        this.refillInputs(saved, sent);
        s.savedAt = Date.now();
        s.saving = false;
        notify({ title: "CLI Proxy", body: `Saved ${writes.map((w) => w.label.toLowerCase()).join(", ")}`, level: "success", timeout: 3000 });
        this.refresh(cx, { force: true });   // the routing line and the error list follow
      } catch (e) {
        if (!current()) return;
        if (applied.length) {
          try { s.saved = await readSettings(client, cx, (await readKey()) ?? this.memKey); }
          catch {
            for (const w of applied) {
              const group = GROUPS.find((g) => g.patch === w.path);
              s.saved = { ...s.saved, [group.section]: group.leaves ? { ...s.saved[group.section], ...w.body } : clone(w.body) };
            }
          }
          if (!current()) return;
        }
        s.saving = false;
        const done = applied.length ? `Saved ${applied.map((w) => w.label.toLowerCase()).join(", ")}; the rest didn't save · ` : "Couldn't save · ";
        s.problem = `${done}${describe(e)}`;
        notify({ title: "CLI Proxy", body: s.problem, level: "error" });
      } finally { cx.notify(); }
    });
  }

  revertSettings(cx) {
    const s = this.settings;
    if (!s || s.phase !== "ready" || !s.saved) return;
    s.draft = clone(s.saved);
    s.fieldProblems = {}; s.problem = null;
    this.refillInputs(s.saved);
    cx.notify();
  }

  // Retypes the typed fields from `saved`, except any the person changed since `sent` (a
  // save in flight): those stay as unsaved edits.
  refillInputs(saved, sent) {
    for (const [name, input] of Object.entries(this.settings?.inputs ?? {})) {
      const spot = FIELDS.get(name);
      if (!spot || (sent && input.value().trim() !== sent[name])) continue;
      input.set_value(String(shown(saved, spot.g, spot.f) ?? ""));
    }
  }

  setDraft(group, field, value, cx) {
    const s = this.settings;
    if (!s || s.phase !== "ready" || s.saving) return;
    s.draft = set(s.draft, `${group.section}.${field.path}`, value);
    cx.notify();
  }

  // ── sign-in ───────────────────────────────────────────────────────────

  // A new account (target null), or this account again (`target` is its file entry).
  startSignIn(signIn, target, cx) {
    this.cancelSignIn(cx);
    const gen = this.flowGen = (this.flowGen ?? 0) + 1, client = this.client;
    this.picking = false; this.callbackInput.set_value("");
    this.flow = { gen, signIn, target: target ? { auth_index: target.auth_index, who: target.label || target.email || "" } : null, status: "starting" };
    if (target) this.collapsed.delete(target.auth_index);
    cx.notify();
    const current = () => this.flow?.gen === gen ? this.flow : null;
    cx.spawn(async (cx) => {
      try {
        const key = (await readKey()) ?? this.memKey;
        if (!key) { this.setupNeeded = true; this.flow = null; return; }
        const res = await client.request(cx, key, "GET", authUrlPath(signIn, target?.auth_index));
        const f = current();
        if (!f) return;
        if (!res?.url || !res?.state) throw new Error("the server gave no sign-in link");
        Object.assign(f, { url: res.url, state: res.state, code: res.user_code ?? null, status: "waiting",
          until: Date.now() + (Number(res.expires_in) > 0 ? Number(res.expires_in) * 1000 : SIGN_IN_LIMIT) });
        this.openUrl(res.url, cx);
        cx.notify();
        while (current()?.status === "waiting" || current()?.status === "sending") {
          await cx.sleep(SIGN_IN_POLL);
          const f = current();
          if (!f) return;
          if (Date.now() > f.until) { f.status = "error"; f.error = "The sign-in expired. Start it again."; break; }
          let r;
          try { r = await client.request(cx, key, "GET", `/oauth/status?state=${encodeURIComponent(f.state)}`); }
          catch (e) { if (e instanceof Unreachable) continue; throw e; }
          if (current() !== f) return;
          if (r?.status === "ok") { f.status = "ok"; break; }
          if (r?.status === "error") { f.status = "error"; f.error = String(r.error || "The provider refused the sign-in").slice(0, 240); break; }
        }
        const f2 = current();
        if (f2?.status === "ok") {
          this.refresh(cx, { force: true });
          cx.timer.after(5000, (cx) => { if (current() === f2) { this.flow = null; cx.notify(); } });
        }
      } catch (e) {
        const f = current();
        if (f) { f.status = "error"; f.error = describe(e); }
      } finally { cx.notify(); }
    });
  }

  // The address the browser ended on, for when its loopback page doesn't load here.
  submitCallback(cx) {
    const f = this.flow;
    if (!f || f.status !== "waiting" || f.signIn.flow !== "browser") return;
    const url = callbackUrl(f.signIn.id, this.callbackInput.value(), f.state);
    f.inputProblem = url ? null : "Paste the whole address from the browser's address bar";
    if (!url) return cx.notify();
    f.status = "sending";
    cx.notify();
    const client = this.client;
    cx.spawn(async (cx) => {
      try {
        const key = (await readKey()) ?? this.memKey;
        await client.request(cx, key, "POST", "/oauth/callback", { body: { provider: f.signIn.id, redirect_url: url } });
        if (this.flow === f && f.status === "sending") { f.status = "waiting"; this.callbackInput.set_value(""); f.sent = true; }
      } catch (e) {
        if (this.flow === f && f.status === "sending") { f.status = "waiting"; f.inputProblem = `The server didn't take it · ${describe(e)}`; }
      } finally { cx.notify(); }
    });
  }

  // Ends the pending sign-in on the server too (DELETE /oauth/session only cancels it).
  cancelSignIn(cx) {
    const f = this.flow;
    this.flow = null; this.flowGen = (this.flowGen ?? 0) + 1;
    if (!f?.state || !["waiting", "sending"].includes(f.status)) return;
    const client = this.client;
    cx.spawn(async (cx) => {
      try { const key = (await readKey()) ?? this.memKey; if (key) await client.request(cx, key, "DELETE", `/oauth/session?state=${encodeURIComponent(f.state)}`); }
      catch {}
    });
  }

  openLog(name) {
    const args = { mod: "cliproxy", props: { log: name } };
    if (focused()?.pane) run("pane.split", { direction: "right", pane: focused().pane, ...args });
    else run("tab.new", { name: "error log", ...args });
  }

  // The log pane is its own copy: it reads the saved settings (a key kept in memory isn't shared).
  loadLog(cx) {
    cx.spawn(async (cx) => {
      try {
        const config = await readConfig(), key = await readKey();
        if (!config) { this.logProblem = "Log in to CLI Proxy first"; return; }
        if (!key) { this.logProblem = "Turn on Remember key in CLI Proxy to open logs in a pane"; return; }
        const text = redact(await new Client(bases(config)).request(cx, key, "GET", `/observability/logs/errors/${encodeURIComponent(this.log)}`, { text: true }));
        const t = theme();
        this.code = EditorState.new({ language: "log", readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (log truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch (e) { this.logProblem = `Cannot open this log · ${describe(e)}`; }
      finally { cx.notify(); }
    });
  }

  // ── pieces ────────────────────────────────────────────────────────────

  button(id, label, t, onClick, { busy = false, busyLabel } = {}) {
    return h_flex().id(id).h(24).px(8).gap(5).items_center().flex_none().rounded(6).border_1().border_color(t.border).text_size(11)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .text_color(busy ? t.dim : t.muted)
      .when(!busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick))
      .when(busy, (e) => e.child(div().w(9).frames(SPIN, 80).child(SPIN[0])))
      .child(busy ? busyLabel ?? label : label);
  }

  iconButton(id, icon, tip, t, onClick, spinning = false, active = false) {
    return div().id(id).size(26).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer().text_color(active ? t.accent : t.muted)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick)
      .child(svg(`mods/cliproxy/${icon}.svg`).size(14).when(spinning, (e) => e.spin(900)));
  }

  chip(text, color, id, tip) {
    return div().when(Boolean(id), (e) => e.id(id)).when(Boolean(tip), (e) => e.tooltip(tip))
      .px(5).h(17).flex().items_center().flex_none().rounded(4).bg(color + "22").text_color(color).text_size(10).font_semibold().child(text);
  }

  section(title, count, t, action) {
    return h_flex().h(24).items_center().gap(6)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(title))
      .when(count !== null, (e) => e.child(div().text_size(11).text_color(t.dim).child(String(count))))
      .child(div().flex_1()).when(Boolean(action), (e) => e.child(action));
  }

  field(name, label, input, t, { hint, note, trailing } = {}) {
    return v_flex().gap(6)
      .child(h_flex().gap(8).items_center().text_size(12)
        .child(div().text_color(t.muted).child(label)).child(div().flex_1())
        .when(Boolean(hint), (e) => e.child(div().text_size(11).text_color(t.dim).child(hint))))
      .child(h_flex().id(`field-${name}`).h(34).pl(10).pr(trailing ? 4 : 10).gap(6).items_center().rounded(8).cursor_text()
        .bg(t.surface).border_1().border_color(this.typing === name ? t.accent : t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(input).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
        .when(Boolean(trailing), (e) => e.child(trailing)))
      .when(Boolean(note), (e) => e.child(div().text_size(11).text_color(t.dim).child(note)));
  }

  toggle(f, t) {
    const id = `toggle-${f.auth_index}`, on = !f.disabled, busy = Boolean(this.busy[id]);
    return div().id(id).w(30).h(17).flex_none().rounded(9).relative().cursor_pointer()
      .bg(on ? t.ansi2 : t.raised).border_1().border_color(on ? t.ansi2 : t.input).opacity(busy ? 0.5 : 1)
      .tooltip(on ? "Enabled · click to disable" : "Disabled · click to enable")
      .on_click((_e, cx) => this.act(id, "PATCH", "/credentials/status", { name: f.name, disabled: on, auth_index: f.auth_index }, cx))
      .child(div().absolute().top(1).left(on ? 14 : 1).size(13).rounded(7).bg(on ? "#ffffff" : t.muted).transition("left", 120));
  }

  // A window as the Management Center shows it: what's left, the bar shrinking as it's used.
  bar(b, t, now) {
    const l = level(b), color = tone(t, l), left = 100 - b.used;
    const reset = until(b.reset, now), stale = b.reset !== null && !reset;
    return v_flex().gap(4).opacity(stale ? 0.55 : 1)
      .child(h_flex().gap(6).items_center().text_size(12)
        .child(div().text_color(t.foreground).child(b.label))
        .when(b.binds, (e) => e.child(this.chip("binds", t.accent, `binds-${b.id}`, "The window that limits this account now")))
        .when(Boolean(b.status), (e) => e.child(this.chip(String(b.status), l === "error" ? t.ansi1 : t.blocked)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(stale ? "window reset since" : reset ? `resets ${reset}` : ""))
        .child(h_flex().flex_none().items_baseline().gap(3)
          .child(div().font_semibold().text_color(l === "ok" ? t.foreground : color).child(`${Math.round(left)}%`))
          .child(div().text_size(10).text_color(t.dim).child("left"))))
      .child(div().h(5).w_full().rounded(3).bg(t.raised).overflow_hidden()
        .child(div().h_full().w(`${left.toFixed(1)}%`).rounded(3).bg(color)));
  }

  // Live from the provider; else CLI Proxy Lite's reading from response headers.
  quota(f, t, now) {
    const live = this.live[f.auth_index] ?? {}, q = live.data ?? headerQuota(f);
    const failed = live.error ? div().text_size(11).text_color(t.blocked).child(`Live quota unavailable · ${live.error}`) : null;
    if (!q) return v_flex().gap(4).when(Boolean(failed), (e) => e.child(failed))
      .child(div().text_size(11).text_color(t.dim).child(live.busy ? "Loading quota…" : f.disabled ? "Quota not checked while disabled" : "No quota reading yet"));
    const source = q.source === "live" ? `as of ${ago(q.at, now)}` : `${q.model} · from traffic ${ago(q.at, now)}`;
    return v_flex().gap(8)
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .when(Boolean(q.plan), (e) => e.child(this.chip(q.plan, t.muted)))
        .child(div().flex_1().min_w(0).truncate().child(source))
        .when(Boolean(live.busy), (e) => e.child(div().flex_none().frames(SPIN, 80).child(SPIN[0]))))
      .when(Boolean(failed), (e) => e.child(failed))
      .when(Boolean(q.periodEnd) && Boolean(until(q.periodEnd, now)), (e) => e.child(h_flex().text_size(12)
        .child(div().text_color(t.muted).child("Period")).child(div().flex_1()).child(div().text_size(11).text_color(t.dim).child(`resets ${until(q.periodEnd, now)}`))))
      .children(q.bars.map((b) => this.bar(b, t, now)))
      .children(q.lines.map(([label, value, severity]) => h_flex().gap(8).text_size(12)
        .child(div().flex_none().text_color(t.muted).child(label)).child(div().flex_1())
        .child(div().min_w(0).truncate().font_semibold().text_color(severity ? t.blocked : t.foreground).child(typeof value === "number" ? grouped(value) : String(value)))))
      .when(Boolean(q.note) && !q.bars.length, (e) => e.child(div().text_size(11).text_color(t.dim).child(q.note)));
  }

  // The last 20 ten-minute buckets, one segment each, and the window's success rate.
  strip(f, t) {
    const ok = sum(f.recent, "success"), bad = sum(f.recent, "failed"), total = ok + bad;
    return h_flex().gap(8).items_center()
      .child(h_flex().flex_1().h(10).gap(2).children(f.recent.map((b, j) => div().id(`seg-${f.auth_index}-${j}`).flex_1().h_full().rounded(2)
        .bg(b.success + b.failed === 0 ? t.raised : t[verdict(b.success / (b.success + b.failed) * 100)[1]])
        .tooltip(`${b.time.replace("-", "–")} · ${b.success} ok · ${b.failed} failed`))))
      .child(div().w(40).flex_none().text_right().text_size(11).font_semibold().text_color(total ? t[verdict(ok / total * 100)[1]] : t.dim)
        .child(total ? `${(ok / total * 100).toFixed(ok === total ? 0 : 1)}%` : "—"));
  }

  account(f, t, now) {
    const cooling = f.cooldowns.filter((c) => c.until === null || c.until > now);
    const longest = cooling.reduce((m, c) => Math.max(m, c.until ?? 0), 0);
    const refreshId = `refresh-${f.auth_index}`, cooldownId = `cooldown-${f.auth_index}`;
    const active = String(f.status ?? "").toLowerCase() === "active", open = !this.collapsed.has(f.auth_index);
    return v_flex().id(`card-${f.auth_index}`).p(10).gap(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        // The chevron, icon and name fold the card; the switch stays its own control.
        .child(h_flex().id(`fold-${f.auth_index}`).flex_1().min_w(0).gap(8).items_center().cursor_pointer()
          .tooltip(open ? "Collapse" : "Expand").on_click((_e, cx) => this.fold(f.auth_index, cx))
          .child(svg(`mods/cliproxy/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
          .child(ICONS[f.provider] ? (TINTED.has(ICONS[f.provider]) ? svg(`icons/${ICONS[f.provider]}.svg`).text_color(t.foreground) : image(`icons/${ICONS[f.provider]}.svg`)).size(18).flex_none()
            : div().size(18).flex_none().rounded(4).bg(t.raised).flex().items_center().justify_center().text_size(10).font_semibold().child(providerName(f.provider).charAt(0)))
          .child(v_flex().flex_1().min_w(0)
            .child(div().font_semibold().child(providerName(f.provider)))
            .child(div().text_size(11).text_color(t.dim).truncate().child(f.label || f.email || ""))))
        .child(this.toggle(f, t)))
      .child(h_flex().gap(5).items_center().flex_wrap()
        .when(Boolean(f.status), (e) => e.child(this.chip(String(f.status), active ? t.ansi2 : t.blocked)))
        .when(f.disabled, (e) => e.child(this.chip("disabled", t.muted)))
        .when(f.unavailable, (e) => e.child(this.chip("unavailable", t.ansi1)))
        .when(cooling.length > 0, (e) => e.child(this.chip(`cooling${longest ? " " + (until(longest, now) ?? "").replace(/^in /, "") : ""}`, t.blocked,
          `cool-${f.auth_index}`, cooling.map((c) => [c.model, c.reason].filter(Boolean).join(": ") || "cooldown").join("\n"))))
        .when(Boolean(f.status_message), (e) => e.child(div().text_size(11).text_color(t.muted).child(f.status_message))))
      .child(v_flex().gap(4)
        .child(this.strip(f, t))
        .child(div().text_size(11).text_color(t.dim).child(
          `${grouped(f.success)} ok · ${grouped(f.failed)} failed · refreshed ${ago(parseTime(f.last_refresh), now)}`)))
      .when(open, (e) => e.child(this.quota(f, t, now))
        .child(h_flex().gap(6)
          .child(this.button(refreshId, "Refresh token", t, (_e, cx) => this.act(refreshId, "POST", "/credentials/refresh", { name: f.name, auth_index: f.auth_index }, cx),
            { busy: Boolean(this.busy[refreshId]), busyLabel: "Refreshing…" }))
          .when(Boolean(signInFor(f.provider)), (e) => e.child(this.button(`signin-${f.auth_index}`, "Sign in again", t,
            (_e, cx) => this.startSignIn(signInFor(f.provider), f, cx), { busy: this.flow?.target?.auth_index === f.auth_index, busyLabel: "Signing in…" })))
          .when(cooling.length > 0, (e) => e.child(this.button(cooldownId, "Reset cooldown", t,
            (_e, cx) => this.act(cooldownId, "POST", "/routing/cooldown/reset", { auth_index: f.auth_index }, cx),
            { busy: Boolean(this.busy[cooldownId]), busyLabel: "Resetting…" })))));
  }

  // Add account: the providers the console can sign in to. The rest are in the Management Center.
  picker(t) {
    return v_flex().gap(8).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().items_center()
        .child(div().text_size(12).font_semibold().child("Add an account")).child(div().flex_1())
        .child(this.button("pick-cancel", "Cancel", t, (_e, cx) => { this.picking = false; cx.notify(); })))
      .child(h_flex().gap(6).flex_wrap().children(SIGN_INS.map((s) =>
        this.button(`pick-${s.id}`, s.name, t, (_e, cx) => this.startSignIn(s, null, cx)))))
      .child(div().text_size(11).text_color(t.dim).child("Devin, Vertex and plugin sign-ins are in the web UI."));
  }

  signInCard(t) {
    const f = this.flow, s = f.signIn, waiting = f.status === "waiting" || f.status === "sending";
    const title = f.target ? `Sign in to ${s.name} again` : `Add a ${s.name} account`;
    const status = (color, text, spin) => h_flex().gap(6).items_center().text_size(12).text_color(color)
      .when(Boolean(spin), (e) => e.child(div().w(9).frames(SPIN, 80).child(SPIN[0]))).child(text);
    return v_flex().id("signin").gap(10).p(10).rounded(8).border_1().border_color(f.status === "error" ? t.ansi1 : t.accent).bg(t.surface)
      .child(h_flex().items_center().gap(8)
        .child(v_flex().flex_1().min_w(0)
          .child(div().font_semibold().child(title))
          .when(Boolean(f.target?.who), (e) => e.child(div().text_size(11).text_color(t.dim).truncate()
            .child(`as ${f.target.who} · another account is refused`))))
        .when(f.status !== "ok", (e) => e.child(this.button("signin-cancel", f.status === "error" ? "Close" : "Cancel", t, (_e, cx) => { this.cancelSignIn(cx); cx.notify(); }))))
      .when(f.status === "starting", (e) => e.child(status(t.muted, "Starting sign-in…", true)))
      .when(waiting && s.flow === "device", (e) => e
        .child(div().text_size(12).text_color(t.muted).child("Your browser opened the provider's page. Enter this code there:"))
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(18).font_semibold().font_family(settings().font_family ?? "JetBrains Mono").child(f.code ?? "—"))
          .child(div().flex_1())
          .when(Boolean(f.code), (e) => e.child(this.button("signin-copy-code", "Copy code", t, (_e, cx) => { cx.write_to_clipboard(f.code); notify({ title: "CLI Proxy", body: "Code copied", level: "success", timeout: 2000 }); })))))
      .when(waiting && s.flow === "browser", (e) => e
        .child(div().text_size(12).text_color(t.muted).child("Finish signing in in your browser. If it ends on a page that won't load, copy that page's address and paste it here."))
        .child(h_flex().gap(6).items_center()
          .child(h_flex().id("field-callback").flex_1().min_w(0).h(30).px(8).items_center().rounded(6).cursor_text()
            .bg(t.background).border_1().border_color(this.typing === "callback" ? t.accent : t.border)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(this.callbackInput).flex_1().min_w(0).h_full().text_size(11).text_color(t.foreground)))
          .child(this.button("signin-send", "Send", t, (_e, cx) => this.submitCallback(cx), { busy: f.status === "sending", busyLabel: "Sending…" })))
        .when(Boolean(f.inputProblem), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(f.inputProblem)))
        .when(Boolean(f.sent) && !f.inputProblem, (e) => e.child(div().text_size(11).text_color(t.dim).child("Address sent; finishing the sign-in…"))))
      .when(waiting, (e) => e.child(h_flex().gap(6).items_center()
        .child(status(t.dim, "Waiting for the sign-in", true)).child(div().flex_1())
        .child(this.button("signin-open", "Open page again", t, (_e, cx) => this.openUrl(f.url, cx)))
        .child(this.button("signin-copy", "Copy link", t, (_e, cx) => { cx.write_to_clipboard(f.url); notify({ title: "CLI Proxy", body: "Link copied", level: "success", timeout: 2000 }); }))))
      .when(f.status === "ok", (e) => e.child(status(t.ansi2, f.target ? "Signed in again. The account is refreshing." : "Signed in. The new account will appear below.")))
      .when(f.status === "error", (e) => e.child(div().text_size(12).text_color(t.ansi1).child(f.error ?? "The sign-in failed"))
        .child(h_flex().child(this.button("signin-retry", "Try again", t, (_e, cx) => this.startSignIn(s, f.target ? this.files.find((x) => x.auth_index === f.target.auth_index) ?? null : null, cx)))));
  }

  // Folded cards and the Errors section are remembered in this window's localStorage.
  fold(id, cx) {
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    store("collapsed", [...this.collapsed]);
    cx.notify();
  }

  // Failed stacked on success per bucket, with the first and last times under it.
  spark(id, buckets, t, H) {
    const max = Math.max(1, ...buckets.map((b) => b.success + b.failed));
    return v_flex().gap(4)
      .child(h_flex().h(H).gap(2).items_end().children(buckets.map((b, j) => {
        const sh = Math.round(b.success / max * H), fh = Math.round(b.failed / max * H);
        return v_flex().id(`${id}-${j}`).flex_1().h_full().justify_end().tooltip(`${b.time.replace("-", "–")} · ${b.success} ok · ${b.failed} failed`)
          .when(fh > 0, (e) => e.child(div().h(Math.max(2, fh)).bg(t.ansi1).rounded_t(1)))
          .when(sh > 0, (e) => e.child(div().h(Math.max(2, sh)).bg(t.ansi2).when(fh === 0, (e) => e.rounded_t(1))))
          .when(sh + fh === 0, (e) => e.child(div().h(1).bg(t.border)));
      })))
      .when(buckets.length > 0, (e) => e.child(h_flex().text_size(10).text_color(t.dim)
        .child(buckets[0].time.split("-")[0]).child(div().flex_1()).child(buckets[buckets.length - 1].time.split("-").pop())));
  }

  usageRow(u, i, t) {
    const total = u.success + u.failed, rate = total ? u.failed / total * 100 : 0;
    const rateColor = rate >= 50 ? t.ansi1 : rate >= 10 ? t.blocked : t.muted;
    return v_flex().gap(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(6).items_center()
        .child(div().font_semibold().flex_none().child(u.provider))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).text_ellipsis_middle().whitespace_nowrap().overflow_hidden().child(u.host)))
      .child(h_flex().gap(6).text_size(11).text_color(t.dim)
        .child(`${grouped(u.success)} ok · ${grouped(u.failed)} failed`).child(div().flex_1())
        .child(div().font_semibold().text_color(rateColor).child(total ? `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}% failed` : "no requests")))
      .child(this.spark(`spark-${i}`, u.buckets, t, 26));
  }

  // The dashboard's top line: a verdict from the success rate over the buckets of every account
  // and API-key upstream, the throughput, and how many accounts are serving.
  health(t) {
    const series = [...this.files.map((f) => f.recent), ...this.usage.map((u) => u.buckets)].filter((s) => s.length);
    const n = Math.max(0, ...series.map((s) => s.length));
    const merged = Array.from({ length: n }, (_, j) => {
      const at = series.map((s) => s[s.length - n + j]).filter(Boolean);
      return { time: at[0]?.time ?? "", success: sum(at, "success"), failed: sum(at, "failed") };
    });
    const ok = sum(merged, "success"), bad = sum(merged, "failed"), total = ok + bad, rate = total ? ok / total * 100 : null;
    const [said, color] = verdict(rate);
    const off = this.files.filter((f) => f.disabled).length, down = this.files.filter((f) => !f.disabled && f.unavailable).length;
    const counts = [[this.files.length - off - down, "active", t.ansi2], [down, "unavailable", t.blocked], [off, "disabled", t.dim]];
    return v_flex().gap(8).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).flex_none().rounded(4).bg(t[color]).when(total > 0, (e) => e.loop("opacity", { from: 0.45, to: 1, period: 2400 })))
        .child(div().text_size(14).font_semibold().child(said)))
      .child(h_flex().gap(6).text_size(11).text_color(t.dim)
        .child(div().font_semibold().text_color(rate === null ? t.dim : t[color]).child(rate === null ? "—" : `${rate.toFixed(rate === 100 ? 0 : 1)}%`))
        .child(`success · ${grouped(total)} requests in ${span(n)}`))
      .when(n > 0, (e) => e.child(this.spark("health", merged, t, 30)))
      .child(h_flex().gap(10).text_size(11).text_color(t.dim).children(counts.map(([count, label, c]) =>
        h_flex().gap(4).items_center().child(div().size(6).rounded(3).bg(count ? c : t.raised)).child(`${count} ${label}`))))
      .when(Boolean(this.routing), (e) => e.child(h_flex().gap(6).text_size(11).text_color(t.dim)
        .child(div().flex_none().text_color(t.muted).child("Routing")).child(div().min_w(0).truncate().child(this.routing))));
  }

  errorRow(f, t, now) {
    return h_flex().id(`log-${f.name}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(`${f.name} · ${grouped(f.size)} bytes`).on_click(() => this.openLog(f.name))
      .child(div().flex_1().min_w(0).text_size(12).text_ellipsis_middle().whitespace_nowrap().overflow_hidden().child(f.name.replace(/\.log$/, "")))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(f.modified, now)));
  }

  // ── views ─────────────────────────────────────────────────────────────

  renderLog(t) {
    return v_flex().id("cliproxy-log").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().flex_none().child("Error log"))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).text_ellipsis_middle().whitespace_nowrap().overflow_hidden().child(this.log)))
      .child(this.code ? Editor.new(this.code).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.logProblem ?? "Loading log…"));
  }

  // The server as the web UI's login shows it: the current URL with Change, or the fields.
  serverFields(t) {
    if (this.changingUrl || !this.config) return v_flex().gap(16)
      .child(this.field("url", "Server URL", this.urlInput, t))
      .child(this.field("fallback", "Fallback URL", this.fallbackInput, t, { hint: "optional" }));
    return v_flex().gap(6)
      .child(h_flex().items_center().text_size(12)
        .child(div().text_color(t.muted).child("Current URL")).child(div().flex_1())
        .child(div().id("cliproxy-change-url").px(4).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.changingUrl = true; this.urlInput.set_value(this.config.url); this.fallbackInput.set_value(this.config.fallback ?? ""); cx.notify(); })
          .child("Change")))
      .child(div().h(34).px(10).flex().items_center().rounded(8).bg(t.raised).text_size(12).text_color(t.muted).child(div().min_w(0).truncate().child(this.config.url)))
      .when(Boolean(this.config.fallback), (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(`Fallback ${this.config.fallback}`)));
  }

  renderForm(t) {
    const canCancel = !this.setupNeeded;
    const check = div().size(16).flex_none().rounded(4).border_1().flex().items_center().justify_center()
      .border_color(this.remember ? t.solid : t.input).bg(this.remember ? t.solid : t.surface)
      .when(this.remember, (e) => e.child(svg("mods/cliproxy/check.svg").size(11).text_color(t.solid_foreground)));
    return v_flex().id("cliproxy-setup").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(16)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(v_flex().gap(4)
        .child(div().text_size(16).font_semibold().child("Log in to CLI Proxy"))
        .child(div().text_size(12).text_color(t.muted).child("The CLIProxyAPI server this panel watches, and its management key.")))
      .child(this.serverFields(t))
      .child(this.field("key", "Management key", this.keyInput, t, {
        note: (this.keySaved || this.memKey) && !this.refused ? "A key is already saved. Leave this empty to use it." : null,
        trailing: this.iconButton("cliproxy-reveal", this.reveal ? "eye-off" : "eye", this.reveal ? "Hide key" : "Show key", t, (_e, cx) => {
          this.reveal = !this.reveal; this.keyInput.set_masked(!this.reveal); cx.notify();
        }) }))
      .child(h_flex().id("cliproxy-remember").gap(10).items_start().cursor_pointer()
        .on_click((_e, cx) => { this.remember = !this.remember; cx.notify(); })
        .child(div().pt(1).child(check))
        .child(v_flex().gap(2).min_w(0)
          .child(div().text_size(12).child("Remember key"))
          .child(div().text_size(11).text_color(t.dim).child(this.remember ? `Saved to ${KEY_FILE}, readable only by you` : "Kept in memory until this view closes; a saved key is removed"))))
      .when(Boolean(this.formProblem), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.formProblem)))
      .child(h_flex().id("cliproxy-connect").h(34).gap(6).items_center().justify_center().rounded(8).text_size(13).font_semibold()
        .bg(this.connecting ? t.raised : t.solid).text_color(this.connecting ? t.dim : t.solid_foreground)
        .when(!this.connecting, (e) => e.cursor_pointer().on_click((_e, cx) => this.connect(cx)))
        .when(this.connecting, (e) => e.child(div().w(9).frames(SPIN, 80).child(SPIN[0])))
        .child(this.connecting ? "Logging in…" : "Log in"))
      .when(canCancel, (e) => e.child(div().id("cliproxy-cancel").self_center().px(8).py(2).rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.editing = false; this.changingUrl = false; this.formProblem = null; cx.notify(); }).child("Cancel")));
  }

  // ── settings view ─────────────────────────────────────────────────────

  draftSwitch(id, on, tip, t, onClick) {
    return div().id(id).w(30).h(17).flex_none().rounded(9).relative().cursor_pointer()
      .bg(on ? t.ansi2 : t.raised).border_1().border_color(on ? t.ansi2 : t.input)
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(div().absolute().top(1).left(on ? 14 : 1).size(13).rounded(7).bg(on ? "#ffffff" : t.muted).transition("left", 120));
  }

  settingRow(group, field, t) {
    const s = this.settings, id = fieldId(group, field), problem = s.fieldProblems?.[id];
    const value = get(s.draft[group.section], field.path);
    const label = v_flex().min_w(0).flex_1().gap(2)
      .child(div().text_size(12).child(field.label))
      .when(Boolean(field.hint), (e) => e.child(div().text_size(11).text_color(t.dim).child(field.hint)))
      .when(Boolean(field.warn) && value === false, (e) => e.child(div().text_size(11).text_color(t.blocked).child(field.warn)));
    let control;
    if (field.kind === "bool") {
      control = this.draftSwitch(`set-${id}`, value === true, value === true ? "On · click to turn off" : "Off · click to turn on", t,
        (cx) => this.setDraft(group, field, !(value === true), cx));
    } else if (field.kind === "choice") {
      control = h_flex().gap(6).flex_wrap()
        .children(field.choices.map((c) => {
          const active = c.value === value;
          return div().id(`set-${id}-${c.value}`).h(24).px(8).flex().flex_none().items_center().rounded(6).cursor_pointer()
            .border_1().border_color(active ? t.accent : t.border)
            .bg(active ? t.accent + "18" : "transparent")
            .text_size(11).font_semibold().text_color(active ? t.accent : t.muted)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .hover((st) => st.text_color(active ? t.accent : t.foreground))
            .tooltip(c.hint)
            .on_click((_e, cx) => this.setDraft(group, field, c.value, cx))
            .child(c.label);
        }));
    } else {
      control = h_flex().flex_none().w(field.kind === "int" ? 86 : 96).h(28).px(8).gap(4).items_center().rounded(6).cursor_text()
        .bg(t.background).border_1().border_color(problem ? t.ansi1 : this.typing === id ? t.accent : t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(s.inputs[id]).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
        .when(Boolean(field.unit), (e) => e.child(div().text_size(11).text_color(t.dim).child(field.unit)));
    }
    return v_flex().id(`row-${id}`).py(4).gap(6)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(field.kind === "choice" ? label : h_flex().gap(10).items_center().child(label).child(control))
      .when(field.kind === "choice", (e) => e.child(control))
      .when(Boolean(problem), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(problem)));
  }

  renderSettings(t) {
    const s = this.settings;
    if (s.phase === "loading") return v_flex().id("cliproxy-settings").flex_1().min_h(0).justify_center().items_center()
      .child(h_flex().gap(8).items_center().text_size(12).text_color(t.dim)
        .child(div().w(9).frames(SPIN, 80).child(SPIN[0])).child("Loading settings…"));
    if (s.phase === "error") return v_flex().id("cliproxy-settings").flex_1().min_h(0).p(14).gap(10)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().text_size(12).text_color(t.ansi1).child(`Couldn't read the server's settings · ${s.problem}`))
      .child(h_flex().gap(6)
        .child(this.button("settings-back", "Back", t, (_e, cx) => { this.closeSettings(); cx.notify(); }))
        .child(this.button("settings-retry", "Try again", t, (_e, cx) => { this.closeSettings(); this.openSettings(cx); })));

    const writes = writesFor(s.saved, s.draft), dirty = writes.length > 0 || typedChanged(s.saved, s.inputs);
    const save = h_flex().id("settings-save").h(24).px(8).gap(5).items_center().flex_none().rounded(6).border_1()
      .border_color(dirty && !s.saving ? t.solid : t.border)
      .bg(dirty && !s.saving ? t.solid : "transparent")
      .text_size(11).font_semibold().text_color(dirty && !s.saving ? t.solid_foreground : t.dim)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(dirty && !s.saving, (e) => e.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.saveSettings(cx)))
      .when(s.saving, (e) => e.child(div().w(9).frames(SPIN, 80).child(SPIN[0])))
      .child(s.saving ? "Saving…" : dirty ? `Save${writes.length > 1 ? ` (${writes.length})` : ""}` : "Up to date");
    const head = h_flex().h(36).flex_none().px(10).gap(6).items_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.button("settings-back", "Back", t, (_e, cx) => { this.closeSettings(); cx.notify(); }))
      .child(div().text_size(12).font_semibold().child("Server settings"))
      .when(Boolean(s.savedAt), (e) => e.child(div().text_size(11).text_color(t.dim).child(`saved ${ago(s.savedAt)}`)))
      .child(div().flex_1())
      .when(dirty && !s.saving, (e) => e.child(this.button("settings-revert", "Revert", t, (_e, cx) => this.revertSettings(cx))))
      .child(save);
    const body = v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(16)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children(GROUPS.map((g) => v_flex().gap(8)
        .child(this.section(g.title, null, t))
        .child(v_flex().gap(2).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
          .children(g.fields.map((f) => this.settingRow(g, f, t))))))
      .when(Boolean(s.problem), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(s.problem)))
      .child(v_flex().gap(4).items_center().text_size(11).text_color(t.dim)
        .child(div().child("Keys, routing tiers, plugins and TLS stay in the web UI."))
        .child(div().id("settings-web").text_color(t.muted).cursor_pointer()
          .hover((st) => st.text_color(t.foreground)).on_click((_e, cx) => this.openWebUI(cx)).child("Open web UI")));
    return v_flex().id("cliproxy-settings").flex_1().min_h(0).child(head).child(body);
  }

  render(cx) {
    const t = theme(), now = Date.now();
    if (this.log) return this.renderLog(t);
    const phase = this.phase(), form = phase === "form", ok = phase === "ok", version = this.client?.version;
    const update = newer(this.latest, version) ? this.latest : null, refreshingAll = Boolean(this.busy.all);
    const hasData = this.fetchedAt !== undefined;

    const reachable = this.state === "ok" && !this.setupNeeded;
    const head = h_flex().h(42).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().id("cliproxy-dot").size(8).mr(4).flex_none().rounded(4).bg(reachable ? t.ansi2 : this.state === "loading" || this.setupNeeded ? t.dim : t.ansi1)
        .tooltip(reachable ? "Reachable" : this.setupNeeded ? "Not set up" : this.problem ?? "Connecting…"))
      .child(div().font_semibold().child("CLI Proxy"))
      .when(Boolean(version) && !form, (e) => e.child(div().ml(4).text_size(11).text_color(t.dim).child(`v${String(version).replace(/^v/, "")}`)))
      .child(div().flex_1())
      .when(!form, (e) => e.child(this.iconButton("cliproxy-refresh", "refresh", "Refresh", t, (_e, cx) => this.refresh(cx, { force: true }), this.loading)))
      .when(!form, (e) => e.child(this.iconButton("cliproxy-settings", "sliders", this.settings ? "Close settings" : "Server settings", t, (_e, cx) => this.openSettings(cx), false, Boolean(this.settings))))
      .when(Boolean(this.config), (e) => e.child(this.iconButton("cliproxy-web", "external", "Open web UI", t, (_e, cx) => this.openWebUI(cx))))
      .when(Boolean(props()?.overlay), (e) => e.child(this.iconButton("cliproxy-close", "x", "Close", t, () => closeOverlay(props().overlay))));

    const root = v_flex().id("cliproxy").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).child(head);
    if (form) return root.child(this.renderForm(t));
    if (this.settings) return root.child(this.renderSettings(t));

    const banner = !ok && this.state !== "loading" ? h_flex().flex_none().px(12).py(8).gap(6).items_center().bg(t.ansi1 + "18").border_b(1).border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.ansi1).truncate().child(this.problem ?? "Proxy unreachable"))
      .child(this.refused ? this.button("cliproxy-change-key", "Change key", t, (_e, cx) => this.edit(cx))
        : this.button("cliproxy-change-url", "Change URL", t, (_e, cx) => this.edit(cx, { url: true })))
      .child(this.button("cliproxy-retry", "Retry", t, (_e, cx) => this.refresh(cx, { force: true }), { busy: this.loading, busyLabel: "Retrying…" })) : null;

    const accounts = v_flex().gap(8)
      .child(this.section("Accounts", this.files.length, t, h_flex().gap(6)
        .when(!this.flow && !this.picking, (e) => e.child(this.button("add-account", "Add account", t, (_e, cx) => { this.picking = true; cx.notify(); })))
        .when(this.files.length > 0, (e) => e.child(this.button("refresh-all", "Refresh all", t,
          (_e, cx) => this.act("all", "POST", "/credentials/refresh", { all: true }, cx, REFRESH_ALL_MS), { busy: refreshingAll, busyLabel: "Refreshing all…" })))))
      .when(this.picking && !this.flow, (e) => e.child(this.picker(t)))
      .when(Boolean(this.flow), (e) => e.child(this.signInCard(t)))
      .children(this.files.map((f) => this.account(f, t, now)))
      .when(!this.files.length, (e) => e.child(div().text_size(12).text_color(t.dim).child("No accounts")));

    const usage = v_flex().gap(8).child(this.section("API-key upstreams", this.usage.length, t))
      .children(this.usage.map((u, i) => this.usageRow(u, i, t)))
      .when(Boolean(this.usageProblem), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.usageProblem)))
      .when(!this.usage.length && !this.usageProblem, (e) => e.child(div().text_size(12).text_color(t.dim).child("No upstream usage yet")));

    const errorsHead = h_flex().id("errors-fold").h(24).gap(6).items_center().cursor_pointer()
      .tooltip(this.errorsOpen ? "Collapse" : "Expand")
      .on_click((_e, cx) => { this.errorsOpen = !this.errorsOpen; store("errorsOpen", this.errorsOpen); cx.notify(); })
      .child(svg(`mods/cliproxy/chevron-${this.errorsOpen ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child("Errors"))
      .child(div().text_size(11).text_color(t.dim).child(String(this.errors.length)))
      .child(div().flex_1())
      .when(!this.errorsOpen && this.errors.length > 0, (e) => e.child(div().text_size(11).text_color(t.dim).child(`newest ${ago(this.errors[0].modified, now)}`)));
    const errors = this.errorsHidden ? null : v_flex().gap(2).child(errorsHead)
      .when(Boolean(this.errorsProblem), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.errorsProblem)))
      .when(this.errorsOpen, (e) => e.children(this.errors.map((f) => this.errorRow(f, t, now)))
        .when(!this.errors.length && !this.errorsProblem, (e) => e.child(div().text_size(12).text_color(t.dim).child("No error logs"))));

    const top = root.when(Boolean(banner), (e) => e.child(banner));
    if (!hasData) return top.child(div().p(14).text_size(12).text_color(t.dim).child(this.state === "loading" ? "Connecting…" : "No data yet"));
    return top
      .when(Boolean(update), (e) => e.child(h_flex().id("cliproxy-update").flex_none().px(12).h(28).gap(6).items_center().cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .bg(t.accent + "18").border_b(1).border_color(t.border).text_size(11).text_color(t.accent).hover((s) => s.bg(t.accent + "28"))
        .tooltip("Open the web UI").on_click((_e, cx) => this.openWebUI(cx)).child(`Update ${update} available`)))
      .child(v_flex().id("cliproxy-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(16).opacity(ok ? 1 : 0.45)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(this.health(t)).child(accounts).when(this.usage.length > 0 || Boolean(this.usageProblem), (e) => e.child(usage)).when(Boolean(errors), (e) => e.child(errors))
        .child(v_flex().gap(4).items_center().text_size(10).text_color(t.dim)
          .child(h_flex().gap(5).items_center().max_w_full()
            .child(div().min_w(0).truncate().child(`Connected to ${(this.client?.base ?? "").replace(/^https?:\/\//, "")}`))
            .child(div().flex_none().child("·"))
            .child(div().id("cliproxy-logout").flex_none().px(2).rounded(3).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
              .tooltip("Forgets the management key; the server URL stays").on_click((_e, cx) => this.logout(cx)).child("Log out")))
          .child(div().child(`Updated ${ago(this.fetchedAt, now)} · every minute, quota every 5`))));
  }
}
