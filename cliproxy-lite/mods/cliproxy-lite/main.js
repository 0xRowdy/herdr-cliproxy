import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { exec, run, notify, closeOverlay, theme, settings, focused, props, window as appWindow } from "herdr";
import {
  Client, HttpError, Unreachable, refused, readConfig, writeConfig, bases, normalizeUrl, readKey, saveKey, forgetKey,
  webUI, describe, cleanFile, usageRows, errorFiles, redact,
  parseTime, ago, until, grouped, newer, latestQuota, level, claudeWindows, codexQuota,
} from "./api.js";

const POLL = 60000, LATEST_EVERY = 30 * 60000, REFRESH_ALL_MS = 300000;
const KEY_FILE = "~/.config/cliproxyapi/mgmt.key";
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ICONS = { claude: "claude", codex: "codex", gemini: "gemini", grok: "grok", xai: "grok", kimi: "kimi", antigravity: "antigravity" };
const TINTED = new Set(["grok"]); // one-color glyphs (currentColor): drawn in the text color
const NAMES = { claude: "Claude", codex: "Codex", gemini: "Gemini", grok: "Grok", xai: "xAI", kimi: "Kimi", antigravity: "Antigravity", vertex: "Vertex", qwen: "Qwen", iflow: "iFlow" };
const providerName = (p) => NAMES[p] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : "Account");
const tone = (t, l) => l === "error" ? t.ansi1 : l === "warn" ? t.blocked : t.accent;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));

export default class CLIProxyLite extends View {
  // The mod's machines, so their rules live in one head:
  // · phase() decides the view: a log-pane copy, the login form, or the panel, over
  //   this.state = loading → ok | unreachable | error; a refused key holds out until the
  //   key changes or Retry.
  // · the login form: connecting → saved | formProblem; only a working URL and key are kept.
  // · every action is busy[id] while it runs, and the data refreshes after it ends.
  // · server settings live in the CLI Proxy mod and the web UI, never here.
  init(_props, cx) {
    this.log = props()?.log ?? null;
    if (this.log) return this.loadLog(cx);
    this.files = []; this.usage = []; this.errors = []; this.busy = {};
    this.state = "loading"; this.problem = null;
    this.config = null; this.client = null;
    this.memKey = null;    // a key used without Remember: this copy's memory only
    this.keySaved = false; this.setupNeeded = false; this.editing = false; this.changingUrl = false;
    this.remember = true; this.reveal = false; this.connecting = false; this.formProblem = null;
    this.urlInput = InputState.new({ placeholder: "http://host:8317" });
    this.fallbackInput = InputState.new({ placeholder: "http://100.x.y.z:8317" });
    this.keyInput = InputState.new({ placeholder: "Enter the management key" });
    this.keyInput.set_masked(true);
    for (const [name, input] of [["url", this.urlInput], ["fallback", this.fallbackInput], ["key", this.keyInput]]) {
      input.on("focus", (_e, cx) => { this.typing = name; cx.notify(); });
      input.on("blur", (_e, cx) => { if (this.typing === name) this.typing = null; cx.notify(); });
      input.on("submit", (_e, cx) => this.connect(cx));
    }
    this.refresh(cx);
    cx.timer.every(POLL, (cx) => this.refresh(cx));
  }

  async close() {
    this.code?.release();
    for (const input of [this.urlInput, this.fallbackInput, this.keyInput]) input?.release();
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
    } catch (e) {
      this.problem = e instanceof Unreachable ? `Proxy unreachable · ${e.message}` : refused(e) ? "Management key refused" : `Proxy error · ${describe(e)}`;
      this.state = e instanceof Unreachable ? "unreachable" : "error";
      if (refused(e)) this.refused = key;
      return;
    }
    const checkLatest = !this.latestAt || Date.now() - this.latestAt > LATEST_EVERY;
    const [usage, errors, latest] = await Promise.all([
      settle(this.client.request(cx, key, "GET", "/observability/usage/api-keys")),
      settle(this.client.request(cx, key, "GET", "/observability/logs/errors")),
      checkLatest ? settle(this.client.request(cx, key, "GET", "/server/latest-version")) : null,
      checkLatest || !this.client.version ? settle(this.client.probeVersion(cx, key)) : null,
    ]);
    if (usage.error) this.usageProblem = describe(usage.error); else { this.usage = usageRows(usage.value); this.usageProblem = null; }
    // Logging to file can be off on the server: then the section goes.
    this.errorsHidden = errors.error instanceof HttpError && errors.error.status === 400;
    if (errors.error) this.errorsProblem = this.errorsHidden ? null : describe(errors.error);
    else { this.errors = errorFiles(errors.value); this.errorsProblem = null; }
    if (latest && !latest.error) { this.latest = latest.value?.["latest-version"] ?? null; this.latestAt = Date.now(); }
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
      catch (e) { notify({ title: "CLI Proxy Lite", body: `Couldn't remove the saved key · ${describe(e)}`, level: "error" }); return; }
      this.memKey = null; this.keySaved = false; this.refused = null; this.setupNeeded = true; this.editing = false;
      this.files = []; this.usage = []; this.errors = []; this.fetchedAt = undefined; this.state = "loading"; this.problem = null;
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
        notify({ title: "CLI Proxy Lite", body: describe(e), level: "error" });
      } finally {
        delete this.busy[id];
        this.refresh(cx, { force: true });
      }
    });
  }

  openWebUI(cx) {
    const base = this.client?.base ?? this.config?.url;
    if (!base) return;
    const url = webUI(base), platform = appWindow().platform;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(platform === "macos" ? "open" : "xdg-open", [url]);
        if (r.code !== 0) cx.open_url(url);
      } catch { cx.open_url(url); }
    });
  }

  openLog(name) {
    const args = { mod: "cliproxy-lite", props: { log: name } };
    if (focused()?.pane) run("pane.split", { direction: "right", pane: focused().pane, ...args });
    else run("tab.new", { name: "error log", ...args });
  }

  // The log pane is its own copy: it reads the saved settings (a key kept in memory isn't shared).
  loadLog(cx) {
    cx.spawn(async (cx) => {
      try {
        const config = await readConfig(), key = await readKey();
        if (!config) { this.logProblem = "Log in to CLI Proxy Lite first"; return; }
        if (!key) { this.logProblem = "Turn on Remember key in CLI Proxy Lite to open logs in a pane"; return; }
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

  iconButton(id, icon, tip, t, onClick, spinning = false) {
    return div().id(id).size(26).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick)
      .child(svg(`mods/cliproxy-lite/${icon}.svg`).size(14).when(spinning, (e) => e.spin(900)));
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

  bar(b, t, now) {
    const l = level(b.pct, b.status), color = tone(t, l), pct = Math.max(0, Math.min(100, b.pct));
    const reset = until(b.reset, now), stale = b.reset !== null && !reset;
    const allowed = !b.status || String(b.status).toLowerCase() === "allowed";
    return v_flex().gap(4).opacity(stale ? 0.55 : 1)
      .child(h_flex().gap(6).items_center().text_size(12)
        .child(div().text_color(t.foreground).child(b.label))
        .when(b.binds, (e) => e.child(this.chip("binds", t.accent)))
        .when(!allowed, (e) => e.child(this.chip(String(b.status), t.ansi1)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(stale ? "window reset since" : reset ? `resets ${reset}` : ""))
        .child(div().w(34).flex_none().text_right().font_semibold().text_color(l === "ok" ? t.foreground : color).child(`${Math.round(b.pct)}%`)))
      .child(div().h(5).w_full().rounded(3).bg(t.raised).overflow_hidden()
        .child(div().h_full().w(`${pct.toFixed(1)}%`).rounded(3).bg(color)));
  }

  quota(f, t, now) {
    const q = latestQuota(f);
    if (!q) return div().text_size(11).text_color(t.dim).child("No quota reading yet");
    const meta = (extra) => h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
      .when(Boolean(extra), (e) => e.child(extra)).child(div().flex_1().min_w(0).truncate().child(`${q.model} · as of ${ago(q.at, now)}`));
    if (f.provider === "claude" || Object.keys(q.signals).some((k) => k.startsWith("Anthropic-Ratelimit-Unified-"))) {
      const windows = claudeWindows(q.signals);
      return v_flex().gap(8).child(meta()).children(windows.map((b) => this.bar(b, t, now)));
    }
    if (f.provider === "codex" || Object.keys(q.signals).some((k) => k.startsWith("X-Codex-"))) {
      const c = codexQuota(q.signals);
      return v_flex().gap(8).child(meta(c.plan ? this.chip(String(c.plan).toUpperCase(), t.muted) : null))
        .children(c.bars.map((b) => this.bar(b, t, now)))
        .when(c.credits !== null, (e) => e.child(h_flex().text_size(12).child(div().text_color(t.muted).child("Credits")).child(div().flex_1())
          .child(div().font_semibold().child(grouped(c.credits)))));
    }
    return v_flex().gap(3).child(meta()).children(Object.entries(q.signals).map(([k, v]) =>
      h_flex().gap(8).text_size(11).child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(k)).child(div().max_w(140).truncate().child(String(v)))));
  }

  account(f, t, now) {
    const cooling = f.cooldowns.filter((c) => c.until === null || c.until > now);
    const longest = cooling.reduce((m, c) => Math.max(m, c.until ?? 0), 0);
    const refreshId = `refresh-${f.auth_index}`, cooldownId = `cooldown-${f.auth_index}`;
    const active = String(f.status ?? "").toLowerCase() === "active";
    return v_flex().id(`card-${f.auth_index}`).p(10).gap(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(ICONS[f.provider] ? (TINTED.has(ICONS[f.provider]) ? svg(`icons/${ICONS[f.provider]}.svg`).text_color(t.foreground) : image(`icons/${ICONS[f.provider]}.svg`)).size(18).flex_none()
          : div().size(18).flex_none().rounded(4).bg(t.raised).flex().items_center().justify_center().text_size(10).font_semibold().child(providerName(f.provider).charAt(0)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().font_semibold().child(providerName(f.provider)))
          .child(div().text_size(11).text_color(t.dim).truncate().child(f.label || f.email || "")))
        .child(this.toggle(f, t)))
      .child(h_flex().gap(5).items_center().flex_wrap()
        .when(Boolean(f.status), (e) => e.child(this.chip(String(f.status), active ? t.ansi2 : t.blocked)))
        .when(f.disabled, (e) => e.child(this.chip("disabled", t.muted)))
        .when(f.unavailable, (e) => e.child(this.chip("unavailable", t.ansi1)))
        .when(cooling.length > 0, (e) => e.child(this.chip(`cooling${longest ? " " + (until(longest, now) ?? "").replace(/^in /, "") : ""}`, t.blocked,
          `cool-${f.auth_index}`, cooling.map((c) => [c.model, c.reason].filter(Boolean).join(": ") || "cooldown").join("\n"))))
        .when(Boolean(f.status_message), (e) => e.child(div().text_size(11).text_color(t.muted).child(f.status_message))))
      .child(div().text_size(11).text_color(t.dim).child(
        `${grouped(f.success)} ok · ${grouped(f.failed)} failed · refreshed ${ago(parseTime(f.last_refresh), now)}`))
      .child(this.quota(f, t, now))
      .child(h_flex().gap(6)
        .child(this.button(refreshId, "Refresh token", t, (_e, cx) => this.act(refreshId, "POST", "/credentials/refresh", { name: f.name, auth_index: f.auth_index }, cx),
          { busy: Boolean(this.busy[refreshId]), busyLabel: "Refreshing…" }))
        .when(cooling.length > 0, (e) => e.child(this.button(cooldownId, "Reset cooldown", t,
          (_e, cx) => this.act(cooldownId, "POST", "/routing/cooldown/reset", { auth_index: f.auth_index }, cx),
          { busy: Boolean(this.busy[cooldownId]), busyLabel: "Resetting…" }))));
  }

  usageRow(u, i, t) {
    const total = u.success + u.failed, rate = total ? u.failed / total * 100 : 0;
    const max = Math.max(1, ...u.buckets.map((b) => b.success + b.failed)), H = 26;
    const rateColor = rate >= 50 ? t.ansi1 : rate >= 10 ? t.blocked : t.muted;
    return v_flex().gap(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(6).items_center()
        .child(div().font_semibold().flex_none().child(u.provider))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).text_ellipsis_middle().whitespace_nowrap().overflow_hidden().child(u.host)))
      .child(h_flex().gap(6).text_size(11).text_color(t.dim)
        .child(`${grouped(u.success)} ok · ${grouped(u.failed)} failed`).child(div().flex_1())
        .child(div().font_semibold().text_color(rateColor).child(total ? `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}% failed` : "no requests")))
      .child(h_flex().h(H).gap(2).items_end().children(u.buckets.map((b, j) => {
        const sh = Math.round(b.success / max * H), fh = Math.round(b.failed / max * H);
        return v_flex().id(`spark-${i}-${j}`).flex_1().h_full().justify_end().tooltip(`${b.time.replace("-", "–")} · ${b.success} ok · ${b.failed} failed`)
          .when(fh > 0, (e) => e.child(div().h(Math.max(2, fh)).bg(t.ansi1).rounded_t(1)))
          .when(sh > 0, (e) => e.child(div().h(Math.max(2, sh)).bg(t.ansi2).when(fh === 0, (e) => e.rounded_t(1))))
          .when(sh + fh === 0, (e) => e.child(div().h(1).bg(t.border)));
      })))
      .when(u.buckets.length > 0, (e) => e.child(h_flex().text_size(10).text_color(t.dim)
        .child(u.buckets[0].time.split("-")[0]).child(div().flex_1()).child(u.buckets[u.buckets.length - 1].time.split("-").pop())));
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
      .when(this.remember, (e) => e.child(svg("mods/cliproxy-lite/check.svg").size(11).text_color(t.solid_foreground)));
    return v_flex().id("cliproxy-setup").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(16)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(v_flex().gap(4)
        .child(div().text_size(16).font_semibold().child("Log in to CLI Proxy Lite"))
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
          .child(div().text_size(11).text_color(t.dim).child(this.remember ? `Saved to ${KEY_FILE}, readable only by you` : "Kept in memory until Herdr restarts; a saved key is removed"))))
      .when(Boolean(this.formProblem), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.formProblem)))
      .child(h_flex().id("cliproxy-connect").h(34).gap(6).items_center().justify_center().rounded(8).text_size(13).font_semibold()
        .bg(this.connecting ? t.raised : t.solid).text_color(this.connecting ? t.dim : t.solid_foreground)
        .when(!this.connecting, (e) => e.cursor_pointer().on_click((_e, cx) => this.connect(cx)))
        .when(this.connecting, (e) => e.child(div().w(9).frames(SPIN, 80).child(SPIN[0])))
        .child(this.connecting ? "Logging in…" : "Log in"))
      .when(canCancel, (e) => e.child(div().id("cliproxy-cancel").self_center().px(8).py(2).rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.editing = false; this.changingUrl = false; this.formProblem = null; cx.notify(); }).child("Cancel")));
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
      .child(div().font_semibold().child("CLI Proxy Lite"))
      .when(Boolean(version) && !form, (e) => e.child(div().ml(4).text_size(11).text_color(t.dim).child(`v${String(version).replace(/^v/, "")}`)))
      .child(div().flex_1())
      .when(!form, (e) => e.child(this.iconButton("cliproxy-refresh", "refresh", "Refresh", t, (_e, cx) => this.refresh(cx, { force: true }), this.loading)))
      .when(Boolean(this.config), (e) => e.child(this.iconButton("cliproxy-web", "external", "Open web UI", t, (_e, cx) => this.openWebUI(cx))))
      .when(Boolean(props()?.overlay), (e) => e.child(this.iconButton("cliproxy-close", "x", "Close", t, () => closeOverlay(props().overlay))));

    const root = v_flex().id("cliproxy").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).child(head);
    if (form) return root.child(this.renderForm(t));

    const banner = !ok && this.state !== "loading" ? h_flex().flex_none().px(12).py(8).gap(6).items_center().bg(t.ansi1 + "18").border_b(1).border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.ansi1).truncate().child(this.problem ?? "Proxy unreachable"))
      .child(this.refused ? this.button("cliproxy-change-key", "Change key", t, (_e, cx) => this.edit(cx))
        : this.button("cliproxy-change-url", "Change URL", t, (_e, cx) => this.edit(cx, { url: true })))
      .child(this.button("cliproxy-retry", "Retry", t, (_e, cx) => this.refresh(cx, { force: true }), { busy: this.loading, busyLabel: "Retrying…" })) : null;

    const accounts = v_flex().gap(8)
      .child(this.section("Accounts", this.files.length, t, this.files.length ? this.button("refresh-all", "Refresh all", t,
        (_e, cx) => this.act("all", "POST", "/credentials/refresh", { all: true }, cx, REFRESH_ALL_MS), { busy: refreshingAll, busyLabel: "Refreshing all…" }) : null))
      .children(this.files.map((f) => this.account(f, t, now)))
      .when(!this.files.length, (e) => e.child(div().text_size(12).text_color(t.dim).child("No accounts")));

    const usage = v_flex().gap(8).child(this.section("Usage", null, t))
      .children(this.usage.map((u, i) => this.usageRow(u, i, t)))
      .when(Boolean(this.usageProblem), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.usageProblem)))
      .when(!this.usage.length && !this.usageProblem, (e) => e.child(div().text_size(12).text_color(t.dim).child("No upstream usage yet")));

    const errors = this.errorsHidden ? null : v_flex().gap(2).child(this.section("Errors", this.errors.length, t))
      .children(this.errors.map((f) => this.errorRow(f, t, now)))
      .when(Boolean(this.errorsProblem), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.errorsProblem)))
      .when(!this.errors.length && !this.errorsProblem, (e) => e.child(div().text_size(12).text_color(t.dim).child("No error logs")));

    const top = root.when(Boolean(banner), (e) => e.child(banner));
    if (!hasData) return top.child(div().p(14).text_size(12).text_color(t.dim).child(this.state === "loading" ? "Connecting…" : "No data yet"));
    return top
      .when(Boolean(update), (e) => e.child(h_flex().id("cliproxy-update").flex_none().px(12).h(28).gap(6).items_center().cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .bg(t.accent + "18").border_b(1).border_color(t.border).text_size(11).text_color(t.accent).hover((s) => s.bg(t.accent + "28"))
        .tooltip("Open the web UI").on_click((_e, cx) => this.openWebUI(cx)).child(`Update ${update} available`)))
      .child(v_flex().id("cliproxy-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(16).opacity(ok ? 1 : 0.45)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(accounts).child(usage).when(Boolean(errors), (e) => e.child(errors))
        .child(v_flex().gap(4).items_center().text_size(10).text_color(t.dim)
          .child(h_flex().gap(5).items_center().max_w_full()
            .child(div().min_w(0).truncate().child(`Connected to ${(this.client?.base ?? "").replace(/^https?:\/\//, "")}`))
            .child(div().flex_none().child("·"))
            .child(div().id("cliproxy-logout").flex_none().px(2).rounded(3).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
              .tooltip("Forgets the management key; the server URL stays").on_click((_e, cx) => this.logout(cx)).child("Log out")))
          .child(div().child(`Updated ${ago(this.fetchedAt, now)} · every minute`))));
  }
}
