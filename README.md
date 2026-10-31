# CLI Proxy for Herdr

[Herdr](https://herdr.dev) mods for a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server. Each folder is one mod, laid out like `~/.config/herdr-app`, with a `RECIPE.md` (the brief to build it from an empty folder), a `preview.png` and a `keys.json` snippet.

| Mod | |
| --- | --- |
| [CLI Proxy](cliproxy/) | a floating window with what the Management Center shows day to day: a health verdict and throughput, live quota from each provider (plan, % left, extra usage, credits), each account's recent requests, signing accounts in, and a routing summary, plus the everyday account actions |
| [CLI Proxy Lite](cliproxy-lite/) | a smaller window with each account's status and quota from response headers, usage and error logs, and the everyday account actions |

## Requirements

Both mods are a window onto a CLIProxyAPI server: they need one running, and do nothing without it.

- A [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server, version 8 or later (the mods use its `/v8/management` API; tested with 8.0.32), with at least one account on it. CLI Proxy can sign accounts in itself; Lite can't.
- Its management API turned on: set `management.secret-key` in the server's `config.yaml` (an empty key turns the API off). That key is what you enter in the mod's login.
- If Herdr runs on another machine than the server: `management.allow-remote: true`, and a network path to the server's port (8317 by default), such as Tailscale. Older configs call the section `remote-management`.
- Optional: the [Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center), which the server serves at `/management.html` unless `management.disable-control-panel` is true. The mods' Open web UI button opens it.
- [Herdr](https://herdr.dev); built and tested with the app's 0.1.10 release on macOS.

## Install

Install one or the other: both open with Ctrl+Shift+X and share one login. CLI Proxy also asks Anthropic, OpenAI and xAI for each account's usage, through your server.

To add one, ask your Herdr agent: *"Read ~/.config/herdr-app/AGENTS.md, then add this mod: github.com/0xRowdy/herdr-cliproxy/tree/main/cliproxy"* (or `cliproxy-lite`).

Rare admin work (config, routing tiers, plugins, and sign-ins in Lite) stays in the server's own [Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center).
