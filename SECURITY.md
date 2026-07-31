# Security

## Local-only design
- The local control API binds to `127.0.0.1` (loopback only).
- Requests are rejected unless the client is loopback (`127.0.0.1`/`::1`).
- Auth uses a local bearer token stored at `~/.agentify-desktop/token.txt` (permissions `0600`).
- The chosen port is written to `~/.agentify-desktop/state.json`.

## CAPTCHA policy
- Agentify Desktop does **not** automate CAPTCHA solving.
- When a verification challenge appears, automation pauses and requires manual user intervention.

## Session data
- Electron cookies/localStorage are stored in `~/.agentify-desktop/electron-user-data/`.
- Anyone with local access to the machine may be able to access the signed-in session.

## Strict review transport state
- Stable ChatGPT conversation/model bindings, exact prompt/response hashes, message identities, completion snapshots, and review receipts are stored locally in `~/.agentify-desktop/review-transport.json` with mode `0600` where supported.
- A durable send intent is written before the single UI send action. After an uncertain submission, recovery is observe-only and never submits the request again automatically.
- The strict review path does not click Continue, Retry, ResponseRetry, or Answer now and does not accept unrestricted page text as a response identity.

## Dependency audit baseline
- The 2026-07-31 production audit reports 11 advisories: 6 moderate, 5 high, and 0 critical.
- The direct `@modelcontextprotocol/sdk` dependency is reported high through transitive packages and currently has no upstream fix available. This fork remains local/loopback-only and does not treat that absence as a reason to weaken bearer-token or strict-review checks.

