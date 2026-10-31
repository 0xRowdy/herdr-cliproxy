// OAuth sign-in, as the Management Center runs it: GET /oauth/auth-url gives a link and a
// state, the person signs in, GET /oauth/status says wait / ok / error. Browser sign-ins
// redirect to a loopback address; when the server is on another machine that page doesn't
// load here, so its address is pasted back and POSTed to /oauth/callback. Device sign-ins
// show a code to type instead. Devin, Vertex and plugin sign-ins stay in the Management Center.

export const SIGN_INS = [
  { id: "claude", name: "Claude", flow: "browser" },
  { id: "codex", name: "Codex", flow: "browser" },
  { id: "xai", name: "xAI", flow: "browser" },
  { id: "antigravity", name: "Antigravity", flow: "browser" },
  { id: "kimi", name: "Kimi (kimi.com)", flow: "device" },
  { id: "kimi-ai", name: "Kimi (kimi.ai)", flow: "device" },
  { id: "meta", name: "Muse (Meta)", flow: "device" },
];
export const signInFor = (provider) => SIGN_INS.find((s) => s.id === provider) ?? null;
export const SIGN_IN_POLL = 3000, SIGN_IN_LIMIT = 15 * 60000;

export function authUrlPath(signIn, authIndex) {
  const q = [`provider=${encodeURIComponent(signIn.id)}`];
  if (signIn.flow === "browser") q.push("is_webui=true");
  // Targets that account: the server refuses a different one rather than overwrite it.
  if (authIndex) q.push(`auth_index=${encodeURIComponent(authIndex)}`);
  return `/oauth/auth-url?${q.join("&")}`;
}

const decode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
const XAI_CALLBACK = "http://127.0.0.1:56121/callback";

// What to POST as redirect_url. Grok sometimes shows only a code (or a bare query) instead of
// redirecting: rebuild its loopback address with this sign-in's state. Others go as pasted.
export function callbackUrl(provider, input, state) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  if (provider !== "xai" || /^https?:\/\//i.test(text)) return text;
  const at = text.indexOf("?") >= 0 ? text.indexOf("?") : text.indexOf("#");
  const raw = at >= 0 ? text.slice(at + 1) : text, params = {};
  if (/(^|[&#?])(code|state|error)=/i.test(raw)) {
    for (const part of raw.replace(/^[?#]/, "").split("&")) {
      const [k, ...v] = part.split("=");
      if (k) params[decode(k)] = decode(v.join("=")).trim();
    }
  } else params.code = (/\bcode\s*[:=]\s*([^\s&]+)/i.exec(text)?.[1] ?? text).trim();
  params.state = params.state || state;
  if (!params.state || (!params.code && !params.error)) return null;
  return `${XAI_CALLBACK}?${["state", "code", "error", "error_description"].filter((k) => params[k]).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&")}`;
}

// The server's strategy names, for people.
const STRATEGIES = { "round-robin": "round-robin", "weighted-round-robin": "weighted round-robin", "fill-first": "fill-first" };

// GET /config/routing gives only what the config sets (no keys in it): show only that.
export function routingLine(r) {
  if (!r || typeof r !== "object") return null;
  const parts = [];
  if (typeof r.strategy === "string" && r.strategy) parts.push(STRATEGIES[r.strategy] ?? r.strategy);
  if (typeof r["session-affinity"] === "boolean") parts.push(`session affinity ${r["session-affinity"] ? "on" : "off"}`);
  const retry = r.retry?.["request-retry"];
  if (typeof retry === "number") parts.push(`${retry} ${retry === 1 ? "retry" : "retries"}`);
  return parts.length ? parts.join(" · ") : null;
}
