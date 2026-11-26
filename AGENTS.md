# AGENTS.md

Guidance for agents (and humans) working in this repo.

## What this is

`mcp-gate` is an MCP server for MCP servers. It connects to downstream MCP servers and exposes only the tools it decides to enable. A client sees six `gate_*` tools first; downstream tools appear as `<server>__<tool>` once enabled. TypeScript, MCP SDK 2.x, Node 20+.

## Commands

```bash
npm install
npm test             # all tests; offline, no network
npm run typecheck
npm run build        # tsc to dist/
npm run dev -- --check
```

## Layout

- `src/gate.ts`: `Gate` (downstream servers, catalog, policy lookup) and `GateSession` (per-client enabled set: enable, disable, search, route, sweep). All decisions live here.
- `src/server.ts`: the upstream-facing low-level `Server`: `tools/list` (gate tools + enabled tools) and `tools/call`.
- `src/downstream.ts`: `Downstream` (one connection, lazy connect, one reconnect on a dead link) and `connectorFor` (stdio or Streamable HTTP).
- `src/stdio.ts`, `src/http.ts`: serving. HTTP serves both protocol eras on one URL.
- `src/policy.ts`, `src/catalog.ts`, `src/config.ts`, `src/glob.ts`: pure logic, no SDK imports. Keep it that way.
- `src/ledger.ts`, `src/ledger-tokens.ts`: **byte-identical copies** of `ctx-ledger/canonical/` (opt-in accounting via `CTX_LEDGER_FILE`). Never edit them here: change the canonical file, copy it out, and run ctx-ledger's tests, which fail on drift. `recordListing` and the `gate_route` case in `src/server.ts` are the only writers.
- `tests/helpers.ts`: in-memory fake downstream servers and a `rig()` that wires a real MCP client to a gate session.

## Rules that protect the design

- **Deny wins.** A tool that policy denies must never be listed, searched, routed, enabled or called, including through `*` patterns. Any new path that enables or calls a tool goes through `Gate.decisionFor`.
- **Routing may return nothing.** `gate_route` returns an empty match list when nothing clears `routeFloor` and corroboration (`routeMinMatched`, `routeMinCoverage`), and never enables a guess. Do not add a fallback that names a "best effort" tool.
- **A routing change is judged on `npm run abstain`.** Choose a rule on the `tuning` tasks, then write new `final` tasks and score them once; a rule picked and judged on the same tasks has only been fitted to them. Quote the `final` numbers, and quote the recall lost along with the abstention gained.
- **`gate_capsule` is optional and follows the same rules.** It exists only when `gate.skillsServer` names a configured server (the default gate keeps exactly six `gate_*` tools, and tests count them). `GateSession.capsule` must refuse a skills server whose policy does not `allow` `route_skill` and `get_skill`, enable only through `enable` (so deny, confirm and capacity apply), return no skill and enable nothing when none fits, and never guess an unqualified tool name that is ambiguous.
- **Rank metadata only**, never schemas or argument descriptions.
- **The ledger holds counts and ids, and never decides.** A denied tool stays out of the `tools_list` baseline, an answer that adds cost is written with a baseline of `0`, and a ledger that cannot be written never fails a request.
- **State is per session.** stdio: per process. HTTP 2025-era: per `Mcp-Session-Id`. HTTP stateless era: per scope (auth client id, `x-mcp-gate-scope`, else shared). A per-request server instance must not dispose a scope session it does not own (`ownsSession: false`).
- **stdout is the protocol channel on stdio.** Log to stderr only (`src/log.ts`). Never log configuration values, headers or tokens.
- **Secrets stay out of config files.** Use `${NAME}` interpolation. An error about a missing variable names the variable, never a value.

## Conventions

- Tests stay offline: no network, no real credentials. Downstream servers in tests are in-memory (`fakeServer`) or the local fixture `tests/fixtures/downstream.ts`.
- A behaviour that protects security or the design needs a test that fails when the behaviour is removed. Check it by breaking the code once.
- No comments that explain what code does, only why, for a non-obvious constraint.
- No new abstractions, flags or error handling for cases that cannot happen.
- Commits, docs and markdown are written in English.
- Never commit secrets: `mcp-gate.config.json` and `.env*` are ignored; only the `*.example.*` files are tracked.

## SDK 2.x notes

- `createMcpHandler(factory)` builds a fresh server per HTTP request and keeps nothing between requests. State therefore lives in `Gate`/`GateSession`, not on the server instance.
- Change notifications on the stateless era reach only `subscriptions/listen` streams: publish through `handler.notify.toolsChanged()`. On stdio and on sessions, `server.sendToolListChanged()` does it.
- A low-level `Server` needs `capabilities: { tools: { listChanged: true } }` declared up front, and `tools/call` handlers should pass results through `server.projectCallToolResult(...)`.
