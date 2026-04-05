# Contributing to Pocketex

Contributions are welcome.

If you want to help make Pocketex better, open an issue, send a PR, and keep changes tight, local-first, and easy to review.

## Before You Open a PR

- Open an issue first for anything non-trivial.
- Keep the scope narrow. One fix or feature per PR.
- Explain what changed and why.
- If you touch UI, include screenshots or a short video.
- Do not reintroduce hosted-service assumptions, production domains, or remote-only flows.

## Preferred Contributions

- Focused bug fixes
- Reliability improvements
- Documentation fixes
- Small performance improvements
- Local-first UX polish

## Avoid

- Large drive-by refactors
- Unrelated cleanup mixed into feature work
- Hosted-service defaults in source
- Regressions to QR pairing, trusted reconnect, or local project routing

## Local Development Setup

### Prerequisites

- Node.js 18+
- [Codex CLI](https://github.com/openai/codex) installed and working
- Tailscale installed and active on your Mac
- Tailscale installed and active on your iPhone
- Xcode 16+
- macOS for the built-in bridge service and desktop integration

### Clone the Repo

```sh
git clone https://github.com/AliUraish/PocketX.git
cd PocketX
```

### Build the iOS App

```sh
cd CodexMobile
open CodexMobile.xcodeproj
```

In Xcode:

1. Select your Apple Developer team in Signing & Capabilities.
2. Choose your iPhone as the run target.
3. Build and run the app.

The app target is iOS 18.6 and the project is a standalone Xcode project.

### Start the Local Bridge and Relay

From the repo root:

```sh
./run-local-pocketex.sh
```

This launcher:

1. Installs bridge and relay dependencies if needed.
2. Starts a local relay.
3. Points the bridge at a Tailscale-reachable host.
4. Starts `pocketex up`.
5. Prints a QR code for first-time pairing or recovery.

### Bridge Only

```sh
cd phodex-bridge
npm install
POCKETEX_RELAY="ws://localhost:9000/relay" npm start
```

That runs `pocketex up`.

### Full Local Test Flow

1. Start `./run-local-pocketex.sh`.
2. Open the iOS app.
3. Scan the QR code from inside the app.
4. Create a thread and send a message.
5. Verify live responses stream to the phone.
6. Try git actions from the phone.
7. Reopen the app and verify trusted reconnect still works.

## Useful Commands

```sh
# Start Pocketex
pocketex up

# Run the bridge in the foreground
pocketex run

# macOS service controls
pocketex start
pocketex restart
pocketex stop
pocketex status

# Pairing and thread helpers
pocketex reset-pairing
pocketex resume
pocketex watch
pocketex --version
```

## Environment Variables

```sh
# Connect to an existing Codex runtime
POCKETEX_CODEX_ENDPOINT=ws://localhost:8080 pocketex up

# Point at your own relay
POCKETEX_RELAY="ws://localhost:9000/relay" pocketex up

# Enable Codex.app refresh workaround
POCKETEX_REFRESH_ENABLED=true pocketex up
```

## Project Structure

```text
PocketX/
├── CodexMobile/             # iOS app, tests, and build support
├── phodex-bridge/           # Node.js bridge CLI
├── relay/                   # Self-hosted relay and optional push service
├── Docs/                    # Extra project docs
├── SELF_HOSTING_MODEL.md    # Public repo / self-hosting model
└── run-local-pocketex.sh    # Local launcher for relay + bridge
```

## Code Style

- Bridge code is CommonJS with no transpilation.
- iOS code is SwiftUI with async/await and MainActor-oriented patterns.
- Match the existing style in the surrounding files.
- Keep shared logic in services or coordinators instead of duplicating it in views.

## Guardrails

- Keep the repo local-first.
- Do not hardcode hosted relay URLs or production domains.
- Preserve QR pairing, trusted reconnect, and per-project local context switching.
- Do not reintroduce repo filtering in the sidebar/content flows.
- Prefer small, reviewable changes over broad rewrites.
