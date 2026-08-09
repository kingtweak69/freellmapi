# FreeLLMAPI Desktop

Lean Electron menu-bar app for [freellmapi](https://github.com/tashfeenahmed/freellmapi):
runs the whole router locally on `127.0.0.1:31415`, with a dark-glass tray
popover (live 24h request chart, quick stats, copy URL/key) and the full
dashboard in a native-feeling window.

The app lives in the main repo (`desktop/`) and builds against the server and
client sources in the same checkout — no extra setup, no published binaries:
**you build it yourself** (a few minutes, commands below).

## Prerequisites

- Node.js 20+
- A native build toolchain for `better-sqlite3`:
  - **macOS** — Xcode Command Line Tools (`xcode-select --install`)
  - **Windows** — Visual Studio Build Tools ("Desktop development with C++")

## Build it yourself

From the **repo root** (one-time client build + package):

```bash
npm install
npm install --prefix desktop  # install desktop dependencies
npm run desktop:dist          # macOS → desktop/dist-electron/FreeLLMAPI-…-arm64.dmg
npm run desktop:dist:win      # Windows → desktop/dist-electron/FreeLLMAPI-…-x64 installer
```

> Locally built apps don't carry the macOS quarantine attribute or Windows
> Mark-of-the-Web, so they launch without Gatekeeper/SmartScreen warnings —
> no code signing needed.
>
> The Windows build is config-complete but largely untested — issues and PRs
> welcome.

## Develop

```bash
cd desktop
npm install
npm run rebuild:native   # better-sqlite3 against Electron's ABI (dev loop only)
npm run dev              # bundle + launch
```

The dev run serves the repo's own `client/dist` — build it first
(`npm run build -w client` from the root) or use `npm run desktop:dev` from
the root, which does both. `FREEAPI_REPO=/path/to/checkout` overrides the
client/server source location if you ever need a different one.

UI iteration helpers (dev only): `FREEAPI_SHOT=1 npx electron .` captures the
popover + dashboard to /tmp and quits; `FREEAPI_SHOT=hold` pins the popover
open for real-screen captures.

## Notes

- DB + config live in `~/Library/Application Support/FreeLLMAPI/` (macOS) /
  `%APPDATA%/FreeLLMAPI/` (Windows).
- The server binds loopback only; default port 31415, scan-up on conflict,
  resolved port persisted.
- Do not run plain `npm rebuild` here — it rebuilds better-sqlite3 for the
  system Node ABI and breaks the Electron dev loop (`npm run rebuild:native`
  fixes it). Packaging rebuilds natives itself.

## GitHub OAuth for a public Tailscale Funnel

The desktop app can expose a **GitHub-OAuth-only** browser gateway without
putting an account password in the dashboard. It runs locally on `31416` and
proxies an authenticated browser session to the embedded app on `31415`.
OpenAI SDK clients still use their normal unified API key — interactive OAuth
cannot authenticate a non-browser `/v1` request.

1. Create a GitHub OAuth App and set its callback URL to
   `https://YOUR-TAILSCALE-HOST:10000/oauth/github/callback`.
2. Copy `desktop/oauth.example.json` into
   `%APPDATA%/FreeLLMAPI/config.json` (or merge the `githubOAuth` object into
   the existing config file). Keep the client secret on the host machine only.
3. Restart FreeLLMAPI, then point the existing `:10000` Funnel at
   `http://127.0.0.1:31416`.

Only names listed in `allowedGitHubUsers` can sign in. The public dashboard
has no password/change-password UI; GitHub controls sign-in and sign-out.

## Publishing desktop updates

This fork publishes Windows desktop releases from Git tags through
`.github/workflows/release-desktop.yml`. Tagging `v0.6.10`, for example,
builds and attaches the installer, `latest.yml`, and blockmap to a GitHub
Release. The dashboard's **Check for updates** link now points to this fork's
release feed, never upstream.
