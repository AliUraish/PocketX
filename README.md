<p align="center">
  <img src="CodexMobile/CodexMobile/Assets.xcassets/three.imageset/pocketex_start.png" alt="Pocketex" />
</p>

# Pocketex

[![npm version](https://img.shields.io/npm/v/pocketex)](https://www.npmjs.com/package/pocketex)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[Follow on X](https://x.com/emanueledpt)

Control [Codex](https://openai.com/index/codex/) from your iPhone. Pocketex is a local-first open-source bridge + iOS app that keeps the Codex runtime on your Mac and lets your phone connect through a paired secure session.

## Key App Features

- End-to-end encrypted pairing and chats between your iPhone and Mac
- Fast mode for lower-latency turns
- Plan mode for structured planning before execution
- Subagents from iPhone with the `/subagents` command
- Steer active runs without starting over
- Queue follow-up prompts while a turn is still running
- In-app notifications when turns finish or need attention
- Git actions from your phone, including commit, push, pull, and branch switching
- Reasoning controls to tune how much thinking Codex uses
- Access controls with On-Request or Full access
- Photo attachments from camera or library
- One-time QR bootstrap with trusted Mac reconnects
- macOS-only background bridge service via `launchd`
- Live streaming on your phone while Codex runs on your Mac
- Shared thread history with Codex on your Mac

The repo stays local-first and self-host friendly: the iOS app source does not embed a public hosted endpoint, and the transport layer remains inspectable for anyone who wants to run their own setup.

Today, the background daemon / trusted auto-reconnect flow is implemented for macOS. Self-hosted relay setups still work on other OSes, but they currently use the foreground bridge flow instead of the macOS `launchd` service path.

## Get the App

Pocketex is not on the App Store.

To use it, clone this repository, build the iOS app in Xcode, install it on your iPhone, and run the Mac bridge locally.

Tailscale is required on both your Mac and your iPhone for the supported setup in this repo.

If you scan the pairing QR with a generic camera or QR reader before installing the app, your device may treat the QR payload as plain text and open a web search instead of pairing.

## Architecture

```
┌──────────────┐       paired session    ┌──────────────┐       paired session    ┌───────────────┐       JSON-RPC        ┌─────────────┐
│  Pocketex iOS │ ◄────────────────────► │  relay       │ ◄──────────────────────► │ pocketex (Mac) │ ◄──────────────────► │ codex       │
│  app         │    over Tailscale      │  self-hosted │     over Tailscale       │ bridge        │                      │ app-server  │
└──────────────┘                        └──────────────┘                          └───────────────┘                      └─────────────┘
                                                                                         │                                         │
                                                                                         │  handoff / refresh                       │ JSONL rollout
                                                                                         ▼                                         ▼
                                                                                  ┌─────────────┐                           ┌─────────────┐
                                                                                  │  Codex.app  │ ◄─── reads from ──────── │  ~/.codex/  │
                                                                                  │  (desktop)  │      disk on navigate     │  sessions   │
                                                                                  └─────────────┘                           └─────────────┘
```

1. Clone this repo and build the iOS app with Xcode
2. Join the same Tailscale network on both your Mac and your iPhone
3. Run `./run-local-pocketex.sh` or `pocketex up` on your Mac
4. The bridge connects to the relay and prints a QR for first-time pairing or recovery
5. Scan the QR once with the Pocketex iOS app to trust that Mac
6. Your phone sends instructions to Codex through the relay and bridge and receives responses in real time
7. `Codex.app` can read the same thread history from disk, but it is not a true live mirror unless you enable the optional refresh workaround

## Repository Structure

This repo contains the iOS app, the Mac bridge, the relay, and their supporting files:

```
├── CodexMobile/                  # Xcode project root
│   ├── CodexMobile/              # App source target
│   │   ├── Assets.xcassets/      # App artwork, screenshots, icons, and assets
│   │   ├── Models/               # RPC, thread, message, and UI models
│   │   ├── Resources/            # Embedded resources
│   │   ├── Services/             # Connection, sync, pairing, git, and persistence logic
│   │   └── Views/                # SwiftUI screens, onboarding, timeline, and sidebar
│   ├── CodexMobileTests/         # Unit tests
│   ├── CodexMobileUITests/       # UI tests
│   └── BuildSupport/             # Info.plist, xcconfig defaults, and local override templates
├── phodex-bridge/                # Node.js bridge package used by `pocketex`
│   ├── bin/                      # CLI entrypoints
│   ├── scripts/                  # Packaging helpers
│   ├── src/                      # Bridge runtime, git/workspace handlers, refresh helpers
│   └── test/                     # Bridge tests
├── relay/                        # Self-hosted relay and optional push service
│   ├── server.js                 # HTTP + WebSocket server entrypoint
│   ├── relay.js                  # Session routing logic
│   └── push-service.js           # Optional push endpoints
├── Docs/                         # Extra project docs
├── SELF_HOSTING_MODEL.md         # Public repo / self-hosting model
└── run-local-pocketex.sh         # Local launcher for relay + bridge
```

## Prerequisites

- **Node.js** v18+
- **[Codex CLI](https://github.com/openai/codex)** installed and in your PATH
- **Tailscale** installed and signed in on your Mac
- **Tailscale** installed and signed in on your iPhone
- **Xcode 16+**
- **macOS** for the built-in bridge service and desktop integration
- **A signed Pocketex iOS build** installed on your iPhone before scanning the pairing QR

## Quick Start

Clone the repo first:

```sh
git clone https://github.com/AliUraish/PocketX.git
cd PocketX
```

Build and install the iOS app:

```sh
cd CodexMobile
open CodexMobile.xcodeproj
```

In Xcode:

1. Select your Apple Developer team in Signing & Capabilities
2. Choose your iPhone as the run target
3. Build and run the app on your iPhone

Back in the repo root, start the local setup:

```sh
cd /path/to/PocketX
./run-local-pocketex.sh
```

On first connect, open the Pocketex app on your iPhone, follow the onboarding flow, then scan the QR code from inside the app.

After that first scan:

- the iPhone saves the Mac as a trusted device
- the Mac bridge keeps its identity locally
- the app tries trusted reconnect automatically on later launches
- the QR remains available as a recovery path if trust changes or the relay cannot resolve the live session

For now, the daemon-backed trusted reconnect path is macOS-only. If you self-host on Linux or Windows, pairing still works, but the bridge runs in the foreground unless you set up your own OS-specific service wrapper.

## Run Locally

```sh
git clone https://github.com/AliUraish/PocketX.git
cd PocketX
./run-local-pocketex.sh
```

That launcher starts a local relay, points the bridge at your Tailscale-reachable host, and prints the pairing QR for the iPhone app.

Options:

- `./run-local-pocketex.sh --hostname <tailscale-hostname-or-ip>`
- `./run-local-pocketex.sh --bind-host 127.0.0.1 --port 9100`

Tailscale should be active on both devices before you start the launcher.

## Custom Relay Endpoint

For a full public self-hosting walkthrough, see [`Docs/self-hosting.md`](Docs/self-hosting.md).

If you want the npm bridge to point at your own setup instead of the package default, override `POCKETEX_RELAY` explicitly:

```sh
POCKETEX_RELAY="ws://localhost:9000/relay" pocketex up
```

For self-hosted iPhone usage in this repo, use a relay URL reachable over Tailscale. A common private setup looks like this:

1. Run the relay on your Mac, a mini server, or a VPS you control
2. Put that machine on Tailscale
3. Put your iPhone on the same Tailscale network
4. Set `POCKETEX_RELAY` to the Tailscale-reachable `ws://` or `wss://` relay URL
5. Pair once with QR
6. Let the iPhone reconnect to the same trusted Mac over that relay later

If that relay is fronting a Mac bridge, the macOS daemon can keep the bridge alive for hands-free reconnects. If you self-host against a non-macOS bridge, the same relay path still works, but automatic background service management is not built in yet.

Reverse-proxy subpaths work too, so a hosted relay behind Traefik can live under the same domain as other APIs:

```sh
POCKETEX_RELAY="wss://api.example.com/pocketex/relay" pocketex up
```

In that setup, the public endpoints can look like this:

- `wss://api.example.com/pocketex/relay`
- `https://api.example.com/pocketex/v1/push/session/register-device`
- `https://api.example.com/pocketex/v1/push/session/notify-completion`

Have the proxy strip `/pocketex` before forwarding so the relay still receives `/relay/...` and `/v1/push/...`.

If you point `POCKETEX_RELAY` at your own self-hosted relay, managed push stays off unless you also set `POCKETEX_PUSH_SERVICE_URL` on the bridge and explicitly enable push on the relay.

## Commands

### `pocketex up`

Starts Pocketex.

On macOS, `pocketex up` is the friendly entrypoint for the background bridge service:

- Writes the daemon config used by the `launchd` service
- Starts or restarts the background bridge service
- Waits for a pairing payload and prints a QR for first-time trust or recovery
- Keeps the bridge alive even if you close the terminal later

On non-macOS platforms, `pocketex up` runs the bridge in the foreground.

In both cases the bridge:

- Spawns `codex app-server` (or connects to an existing endpoint)
- Connects the Mac bridge to the configured relay
- Forwards JSON-RPC messages bidirectionally
- Handles git commands from the phone
- Persists the active thread for later resumption

### `pocketex run`

Runs the bridge directly in the foreground without the macOS service wrapper.

### `pocketex start`

macOS only. Starts the background bridge service without waiting for or printing a QR in the current terminal.
If the service is already loaded, this path refreshes it in place.

### `pocketex restart`

macOS only. Explicitly restarts the background bridge service without waiting for or printing a QR in the current terminal.

### `pocketex stop`

macOS only. Stops the background bridge service and clears its transient runtime status.

### `pocketex status`

macOS only. Prints the current `launchd` / bridge status, including whether the service is loaded and whether a recent pairing payload exists.

### `pocketex run-service`

macOS only. Internal service entrypoint used by `launchd`. You normally do not run this manually.

### `pocketex --version`

Prints the installed Pocketex CLI version.

```sh
pocketex --version
```

### `pocketex reset-pairing`

Clears the saved bridge pairing state so the next trusted connection requires a fresh QR bootstrap again.
You normally do not need this for corrupted local state anymore: recent Pocketex builds auto-repair unreadable pairing files/mirrors on startup.

```sh
pocketex reset-pairing
# => [pocketex] Cleared the saved pairing state. Run `pocketex up` to pair again.
```

### `pocketex resume`

Reopens the last active thread in Codex.app on your Mac.

```sh
pocketex resume
# => [pocketex] Opened last active thread: abc-123 (phone)
```

### `pocketex watch [threadId]`

Tails the event log for a thread in real-time.

```sh
pocketex watch
# => [14:32:01] Phone: "Fix the login bug in auth.ts"
# => [14:32:05] Codex: "I'll look at auth.ts and fix the login..."
# => [14:32:18] Task started
# => [14:33:42] Task complete
```

## Environment Variables

`POCKETEX_RELAY` is optional, but the default depends on how you got Pocketex:

- public GitHub/source checkouts stay open-source and self-host friendly, so they do not ship with a hosted relay baked in
- official published packages may include a default relay at publish time
- if you are running from source, assume you should use `./run-local-pocketex.sh` or set `POCKETEX_RELAY` yourself

| Variable | Default | Description |
|----------|---------|-------------|
| `POCKETEX_RELAY` | empty in source checkouts; optional in published packages | Session base URL used for QR bootstrap, trusted-session resolve, and phone/Mac session routing |
| `POCKETEX_PUSH_SERVICE_URL` | disabled by default | Optional HTTP base URL for managed push registration/completion |
| `POCKETEX_CODEX_ENDPOINT` | — | Connect to an existing Codex WebSocket instead of spawning a local `codex app-server` |
| `POCKETEX_REFRESH_ENABLED` | `false` | Auto-refresh Codex.app when phone activity is detected (`true` enables it explicitly) |
| `POCKETEX_REFRESH_DEBOUNCE_MS` | `1200` | Debounce window (ms) for coalescing refresh events |
| `POCKETEX_REFRESH_COMMAND` | — | Custom shell command to run instead of the built-in AppleScript refresh |
| `POCKETEX_CODEX_BUNDLE_ID` | `com.openai.codex` | macOS bundle ID of the Codex app |
| `CODEX_HOME` | `~/.codex` | Codex data directory (used here for `sessions/` rollout files) |

```sh
# Enable desktop refresh explicitly
POCKETEX_REFRESH_ENABLED=true pocketex up

# Connect to an existing Codex instance
POCKETEX_CODEX_ENDPOINT=ws://localhost:8080 pocketex up

# Use a custom self-hosted relay endpoint (`ws://` is unencrypted)
POCKETEX_RELAY="ws://localhost:9000/relay" pocketex up

# Enable managed push only if your self-hosted relay also exposes a configured APNs push service
POCKETEX_RELAY="wss://relay.example/relay" \
POCKETEX_PUSH_SERVICE_URL="https://relay.example" \
pocketex up
```

On the relay/VPS side, keep push disabled until you actually want it. The HTTP push endpoints are off by default and only turn on when you set `POCKETEX_ENABLE_PUSH_SERVICE=true`.

## Pairing and Safety

- Pocketex is local-first: Codex, git operations, and workspace actions run on your Mac, while the iPhone acts as a paired remote control.
- Tailscale should be active on both the Mac and the iPhone for the supported setup in this repo.
- On iPhone, use a Tailscale-reachable relay instead of relying on plain LAN routing.
- The pairing QR carries the connection URL, the session ID, and the bridge identity key used to bootstrap end-to-end encryption. After a successful first scan, the iPhone stores a trusted Mac record in Keychain and the bridge persists its trusted phone identity locally on the Mac.
- On macOS, the bridge can keep running as a lightweight `launchd` service, so the phone can resolve the Mac's current live relay session and reconnect without scanning a new QR every time.
- The QR is still the recovery path when trust changes, the bridge identity rotates, or the relay cannot resolve the current live session.
- The bridge state lives canonically in `~/.pocketex/device-state.json` with local-only permissions. On macOS the bridge also mirrors that state to Keychain as best-effort backup/migration data, and recent builds auto-repair unreadable local state on startup instead of requiring manual cleanup.
- The CLI no longer prints the connection URL in plain text below the QR.
- Set `POCKETEX_RELAY` only when you want to self-host or test locally against your own setup.
- Leave `POCKETEX_TRUST_PROXY` unset for direct/self-hosted installs. Turn it on only when a trusted reverse proxy such as Traefik, Nginx, or Caddy is forwarding the relay traffic.
- The transport implementation is public in [`relay/`](relay/), but your real deployed hostname and credentials should stay private.
- On the iPhone, the default agent permission mode is `On-Request`. Switching the app to `Full access` auto-approves runtime approval prompts from the agent.

## Security and Privacy

Pocketex now uses an authenticated end-to-end encrypted channel between the paired iPhone and the bridge running on your Mac. The transport layer still carries the WebSocket traffic, but it does not get the plaintext contents of prompts, tool calls, Codex responses, git output, or workspace RPC payloads once the secure session is established.

The secure channel is built in these steps:

1. The bridge generates and persists a long-term device identity keypair on the Mac.
2. The pairing QR shares the connection URL, session ID, bridge device ID, bridge identity public key, and a short expiry window.
3. During pairing, the iPhone and bridge exchange fresh X25519 ephemeral keys and nonces.
4. The bridge signs the handshake transcript with its Ed25519 identity key, and the iPhone verifies that signature against the public key from the QR code or the previously trusted Mac record.
5. The iPhone signs a client-auth transcript with its own Ed25519 identity key, and the bridge verifies that before accepting the session.
6. Both sides derive directional AES-256-GCM keys with HKDF-SHA256 and then wrap application messages in encrypted envelopes with monotonic counters for replay protection.

Privacy notes:

- The transport layer can still see connection metadata and the plaintext secure control messages used to set up the encrypted session, including session IDs, device IDs, public keys, nonces, and handshake result codes.
- The transport layer does not see decrypted application payloads after the secure handshake succeeds.
- A fresh QR scan can replace the previously trusted iPhone automatically. Use `pocketex reset-pairing` only when you intentionally want to wipe the remembered pairing state yourself.
- On-device message history is also encrypted at rest on iPhone using a Keychain-backed AES key.

## Git Integration

The bridge intercepts `git/*` JSON-RPC calls from the phone and executes them locally:

| Command | Description |
|---------|-------------|
| `git/status` | Branch, tracking info, dirty state, file list, and diff |
| `git/commit` | Commit staged changes with an optional message |
| `git/push` | Push to remote |
| `git/pull` | Pull from remote (auto-aborts on conflict) |
| `git/branches` | List all branches with current/default markers |
| `git/checkout` | Switch branches |
| `git/createBranch` | Create and switch to a new branch |
| `git/log` | Recent commit history |
| `git/stash` | Stash working changes |
| `git/stashPop` | Pop the latest stash |
| `git/resetToRemote` | Hard reset to remote (requires confirmation) |
| `git/remoteUrl` | Get the remote URL and owner/repo |

## Workspace Integration

The bridge also handles local workspace-scoped revert operations for the assistant revert flow:

| Command | Description |
|---------|-------------|
| `workspace/revertPatchPreview` | Checks whether a reverse patch can be applied cleanly in the local repo |
| `workspace/revertPatchApply` | Applies the reverse patch locally when the preview succeeds |

## Codex Desktop App Integration

Pocketex works with both the Codex CLI and the Codex desktop app (`Codex.app`). Under the hood, the bridge spawns a `codex app-server` process — the same JSON-RPC interface that powers the desktop app and IDE extensions. Conversations are persisted as JSONL rollout files under `~/.codex/sessions`, so threads started from your phone show up in the desktop app too.

What is live today:

- The iPhone conversation is live while the bridge session is connected.
- The Mac-side Codex runtime is the real runtime doing the work.

What is not fully live today:

- `Codex.app` does not act like a second live subscriber to the active run by default.
- The desktop app catches up from the persisted session files and can be nudged with the optional refresh workaround below.
- True phone-to-desktop live sync in the `Codex.app` GUI is not supported today.

To make that limitation more practical, Pocketex also includes a hand-off button in the iPhone app. It lets you explicitly continue the current chat on your Mac by opening the matching thread in `Codex.app` when you are ready to switch devices.

**Known limitation**: The Codex desktop app does not live-reload when an external `app-server` process writes new data to disk. Threads created or updated from your phone won't appear in the desktop app until it remounts that route. Pocketex keeps desktop refresh off by default for now because the current deep-link bounce is still disruptive. You can still enable it manually if you want the old remount workaround.

```sh
# Enable the old deep-link refresh workaround manually
POCKETEX_REFRESH_ENABLED=true pocketex up
```

This triggers a debounced deep-link bounce (`codex://settings` → `codex://threads/<id>`) that forces the desktop app to remount the current thread without interrupting any running tasks. While a turn is running, Pocketex also watches the persisted rollout for that thread and issues occasional throttled refreshes so long responses become visible on Mac without a full app relaunch. If the local desktop path is unavailable, the bridge self-disables desktop refresh for the rest of that run instead of retrying noisily forever.

## Connection Resilience

- **Auto-reconnect**: If the session connection drops, the bridge reconnects with exponential backoff (1 s → 5 s max)
- **Secure catch-up**: The bridge keeps a bounded local outbound buffer and re-sends missed encrypted messages after a secure reconnect
- **Codex persistence**: The Codex process stays alive across transient session reconnects during the current bridge run
- **Graceful shutdown**: SIGINT/SIGTERM cleanly close all connections

## Building the iOS App

```sh
cd CodexMobile
open CodexMobile.xcodeproj
```

Build and run on a physical device or simulator with Xcode. The app uses SwiftUI and the current project target is iOS 18.6.

## Contributing

Contributions are most welcome.

If you want to help make Pocketex better, open an issue, send a PR, and please star the repo:

[https://github.com/AliUraish/PocketX](https://github.com/AliUraish/PocketX)

## FAQ

**Do I need an OpenAI API key?**
Not for Pocketex itself. You need Codex CLI set up and working independently.

**Does this work on Linux/Windows?**
The core bridge client (Codex forwarding + git) works on any OS. Desktop refresh (AppleScript) is macOS-only, and the built-in daemon / trusted auto-reconnect service path is currently macOS-only too.

**What happens if I close the terminal?**
On macOS, the bridge can keep running in the background through `launchd`, so closing the terminal does not stop the trusted reconnect path. On other OSes, the foreground bridge stops when the terminal stops.

**How do I force a fresh QR pairing?**
Run `pocketex reset-pairing`, then start the bridge again with `pocketex up`. You should only need this when you intentionally want to replace the paired iPhone or wipe the remembered pairing.

**Can I connect to a remote Codex instance?**
Yes — set `POCKETEX_CODEX_ENDPOINT=ws://host:port` to skip spawning a local `codex app-server`.

**Why don't my phone threads show up in the Codex desktop app immediately?**
The desktop app reads session data from disk (`~/.codex/sessions`) but doesn't live-reload when an external process writes new data. Your phone still gets the live stream; it is the desktop GUI that lags unless you explicitly enable the refresh workaround with `POCKETEX_REFRESH_ENABLED=true`.

**Does Pocketex support true live sync between phone and `Codex.app`?**
No. The phone session is live, but the `Codex.app` GUI is not a true live mirror of the active run. To help with that, the iPhone app includes a `Hand off to Mac app` button so you can explicitly continue the same thread on your Mac.

**Can I self-host the relay?**
Yes. That is the intended forking path. The transport and push-service code are in [`relay/`](relay/); point `POCKETEX_RELAY` at the instance you run.

**Can I use Tailscale?**
Yes. In this repo's supported setup, Tailscale should be installed and active on both your Mac and your iPhone. Run your relay somewhere reachable over Tailscale, set `POCKETEX_RELAY` to that relay URL, pair once with QR, then let the app reconnect to the trusted Mac through the same relay.

**Is the transport layer safe for sensitive work?**
It is much stronger than a plain text proxy: traffic can be protected in transit with TLS, application payloads are end-to-end encrypted after the secure handshake, and all Codex execution still happens on your Mac. The transport can still observe connection metadata and handshake control messages, so the tightest trust model is to run it yourself.

## License

[ISC](LICENSE)
