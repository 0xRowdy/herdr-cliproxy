# CLI Proxy for Herdr

[Herdr](https://herdr.dev) mods for a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server. Each folder is one mod, laid out like `~/.config/herdr-app`, with a `RECIPE.md` (the brief to build it from an empty folder), a `preview.png` and a `keys.json` snippet.

| Mod | |
| --- | --- |
| [CLI Proxy](cliproxy/) | a floating window with what the Management Center shows day to day: a health verdict and throughput, live quota from each provider (plan, % left, extra usage, credits), each account's recent requests, signing accounts in, and a routing summary, plus the everyday account actions |
| [CLI Proxy Lite](cliproxy-lite/) | a smaller window with each account's status and quota from response headers, usage and error logs, and the everyday account actions |

Install one or the other: both open with Ctrl+Shift+X and share one login. CLI Proxy also asks Anthropic, OpenAI and xAI for each account's usage, through your server.

To add one, ask your Herdr agent: *"Read ~/.config/herdr-app/AGENTS.md, then add this mod: github.com/&lt;owner&gt;/herdr-cliproxy/tree/main/cliproxy"* (or `cliproxy-lite`).

Rare admin work (config, routing tiers, plugins, and sign-ins in Lite) stays in the server's own [Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center).
