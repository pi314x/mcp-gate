# mcp-gate

**An MCP server for MCP servers.** It connects to other MCP servers and shows its client only the tools it has decided to enable.

Every MCP server you connect adds its whole tool list to the model's context, whether the task needs it or not. With a few servers that is hundreds of tool definitions, most of them noise, and a model with that much choice picks worse. `mcp-gate` sits in front: it connects to your servers, keeps their catalog to itself, and exposes tools one task at a time.

```
┌────────────┐  6 gate_* tools +       ┌──────────┐   all tools   ┌──────────────────┐
│ MCP client │ ◄─ whatever is enabled ─┤ mcp-gate │ ◄────────────►│ MCP server(s)    │
│ (the model)│ ── call files__read ──► │          │ ── forwards ─►│ files, github …  │
└────────────┘                         └──────────┘               └──────────────────┘
```

At first a client sees only six `gate_*` tools (a seventh, `gate_capsule`, when a skills server is configured: see [below](#a-procedure-and-its-tools-in-one-call-optional)). Tools of the downstream servers appear, named `<server>__<tool>`, once the gate enables them, and the gate sends `notifications/tools/list_changed` so the client re-lists.

## How the gate decides

| Tool | What it does |
|---|---|
| `gate_route(task)` | Ranks the allowed tools for a task and enables the best few that clear a score floor. **Returns nothing when no tool fits**, which means "use what you have". |
| `gate_search_tools(query)` | Searches names and descriptions. Returns names and one-line descriptions, never schemas, and enables nothing. |
| `gate_enable_tools(tools, confirm?)` | Enables tools by name or `*` pattern. The policy of each server has the last word. |
| `gate_disable_tools(tools \| all)` | Switches tools off again, so the tool list stays short. |
| `gate_list_servers()` | Which servers are connected, and how many tools each offers. |
| `gate_status()` | What is enabled for you right now, how often each tool was used, and the limits. |

The decision rests on rules you set, not on a model:

- **Policy per server**: `allow`, `deny` and `confirm` lists of tool names (`*` wildcard). `deny` always wins. A `confirm` tool is enabled only when the caller passes `confirm: true`. A denied tool is never listed, searched, enabled or callable, even through a wildcard.
- **Capacity**: at most `maxEnabled` tools at once. Anything over the limit is reported, not silently dropped.
- **Idleness**: tools unused for `idleTtlSec` are switched off again.
- **Always-on**: `autoEnable` lists tools every session starts with.
- **Routing** is lexical (names weigh three times descriptions, rarer words weigh more), deterministic, with no model call and no network. It scores only metadata, never schemas, and the floor makes "no match" a real answer. A router that always names a best guess applies tools to tasks they were never meant for.

### A procedure and its tools in one call (optional)

A skills server such as [skills-router](https://github.com/pi314x/skills-router) serves *procedures*, and each procedure names the tools it uses. Without help, a model has to ask for the shortlist, fetch the procedure, then enable the tools one by one. Name that server in the configuration and the gate adds a seventh tool that does all three:

```jsonc
"servers": { "skills": { "url": "http://127.0.0.1:8001/mcp" }, "github": { /* ... */ } },
"gate": { "skillsServer": "skills" }
```

`gate_capsule(task)` asks the skills server to route the task (`route_skill`, best match only) and serve that skill (`get_skill`), returns the procedure, and enables the tools it names through the same path as `gate_enable_tools`. A name the skill gives without a server prefix is resolved only when exactly one tool behind the gate has that name; a name that matches none or several is listed as `unresolved` and enables nothing. The tool exists only when `skillsServer` is set, so the default gate keeps its six.

What it will not do:

- **Guess.** When the skills server finds no skill that fits, or scores its best match below `skillsMinScore` (12 by default), it returns none and enables nothing. A lexical router names a best guess for almost any task, so a weak score is treated as no skill. The score scale is the skills server's own and shifts with the size of its catalog, so calibrate the floor on yours with `npm run capsule -- --scores`; a server that reports no score is not held to it.
- **Override policy.** `deny` wins: a denied tool is reported and never enabled, and a tool that needs confirmation stays off until the caller confirms. The gate also refuses to ask a skills server whose own policy denies `route_skill` or `get_skill`.
- **Search code for a task that has no skill.** Code areas (below) are part of a capsule for a skill that matched, never a second route.

**Code areas (optional).** Name a [lean-context](https://github.com/pi314x/lean-context) server too, and a capsule that found a skill also carries the code that matches the task:

```jsonc
"gate": { "skillsServer": "skills", "codeServer": "context" }   // codeBudgetTokens 800, codeMaxResults 4
```

The gate asks `ctx_search` for the task with that small budget and puts its hit list in `codeAreas`, then enables `ctx_symbol` and `ctx_read` so the "Expand:" hints in the hits can be followed. They are advice added to a capsule, never a reason to fail one: a code server that is missing, denied by its policy, failing, or finding nothing leaves them out (with a `note`, except when it simply found nothing). It needs `skillsServer`.

**Measured**, with [`npm run capsule`](scripts/capsule-bench.ts): the real gate over the real skills-router and the real lean-context, on skills-router's two catalogs (11 procedures) and lean-context's bundled fixture repo, with [`bench/capsule.json`](bench/capsule.json) (34 tasks written like a person would ask, including traps that share a word with a skill: *review my holiday photos, triage my inbox, explain what a pull request is*). It needs skills-router and lean-context checked out next to this repository. The tools the skills name (GitHub, Postgres, radar) do not exist there, so a stand-in server offers tools of those names; only the names matter to a capsule. The `final` tasks are the numbers to quote.

| 19 `final` tasks | Right skill served (12 tasks that need one) | Returned none (7 that need none) | Exactly the skill's tools enabled | A right file in the code areas (4 tasks that have one) |
|---|---:|---:|---:|---:|
| no score floor | 12 of 12 | 2 of 7 | 12 of 12 | 4 of 4 |
| `skillsMinScore` 12 (default) | 10 of 12 | 6 of 7 | 10 of 12 | 4 of 4 |

Read the floor as a trade: it fixed four unrelated tasks that were being given a procedure and its tools (*explain how the Python garbage collector works* reached `diagnose-slow-query`, *triage my inbox* reached `triage-alert`), and cost two real ones, both short phrasings that share few words with their skill ("look over PR 412 and tell me whether it is safe to merge", "should I buy this coin now"). The one false positive left is "explain what a pull request is", which a lexical router cannot tell from a request to review one. The floor was chosen by looking at the 15 `tuning` tasks, where every real match scored 15.8 to 41.2 and every unrelated task 7.8 or less, and the gap is wide, but it is one catalog of 11 skills and a score scale that is not this project's. The 4 code tasks in `final` were added after the first run showed the alternating split had put every code task into `tuning`; they are in new wording and nothing was tuned against the tuning code results.

Tokens (the `heuristic-v1` estimate, median per task, against the same information fetched by hand with each tool's defaults: `route_skill` top 3, `get_skill`, one enable, `ctx_search` at 1500 tokens and 6 results):

| Served `final` tasks | Capsule | By hand |
|---|---:|---:|
| 4 with a code topic | 1,279 tokens, 1 call | 1,617 tokens, 4 calls |
| 6 without one | 1,362 tokens, 1 call | 1,105 tokens, 3 calls |

The capsule saves a fifth of the tokens and three calls when the task has a code topic. When it has none, the always-on code search still returns hits for every served task (10 of 10), so the capsule costs about a quarter more tokens than fetching by hand and saves two calls: leave `codeServer` out where tasks are not about code. The calls are counted as one tool call each, not as the model's own words. When ledger accounting is on, each call is written as a `capsule` event with a baseline of `0`, because it replaces a route, a fetch and an enable that have no honest baseline of their own.

### Saying "nothing fits"

A score floor alone does not make "no match" a real answer: "Cancel my gym membership" shares the word *cancel* with `job_cancel` and scores well above any sensible floor. So `gate_route` also asks for **corroboration**. A tool counts only when it shares at least `routeMinMatched` distinct words with the task (2 by default; all of them, for a one-word task) and at least `routeMinCoverage` of the task's distinct words (0.34). Words that no tool knows count against the task, because they are the evidence that it is about something else. Question words and pronouns (*what, how, my, which*) are stop words.

Measured with [`npm run abstain`](scripts/abstain.ts), which runs the real `GateSession.route` over [`bench/abstain.json`](bench/abstain.json): 24 tasks that need an agent-orchestrator tool and 30 that need none, many of them traps that share a word with the catalog (*schedule a dentist, plan a trip, run a marathon*).

| Tasks | Rule | Serves the tasks that need a tool | Abstains on tasks that need none |
|---|---|---:|---:|
| 54 used to choose the rule | one shared word is enough | 21 of 24 (88%) | 4 of 30 (13%) |
| | corroboration (shipped defaults) | 19 of 24 (79%) | 29 of 30 (97%) |
| 26 written afterwards, scored once | one shared word is enough | 12 of 12 (100%) | 2 of 14 (14%) |
| | corroboration (shipped defaults) | 9 of 12 (75%) | 14 of 14 (100%) |

Read it as a trade, not a free win: between a fifth and a quarter of the tasks that do need a tool are not served by `gate_route` (before: none to an eighth), and the model has to fall back on `gate_search_tools` and `gate_enable_tools`. In return, almost every task that needs no tool is no longer given one. The three misses on the later set are a long task with few shared words ("process each of these 20 documents in parallel with the same prompt"), one whose other words the catalog does not know ("how many tokens did each agent burn this week"), and one where the task has the wrong word form and a synonym ("approvals" against `approval_list`, "person" against *human*). The thresholds sit on an edge: two shared words out of six pass at `routeMinCoverage` 0.33 and fail at 0.34. The first rule picked on half of the tasks was too strict on the other half, which is why the final set exists. This is one server's tool list and 80 tasks; check your own catalog before trusting the defaults, and lower `routeMinCoverage` if `gate_route` abstains too often.

## Token savings

Without a gate, a client sends the full tool list of every connected server to the model on every request. With it, the client sends six small `gate_*` definitions and then only the tools a task needs. The numbers below are measured, not derived from a formula: [`scripts/token-report.ts`](scripts/token-report.ts) runs the real gate (policy, `gate_route`, `tools/list`) in memory over tool lists captured from a real MCP server and counts what a model would be sent.

<!-- token-report:start -->
Measured on **agent-orchestrator, standard profile (its default)**: 37 tools. Tokens a model is sent for tool use, per request.

**Before any task is known** (gate idle: six `gate_*` tools plus the gate's instructions):

| Model | Counted as | Without gate | With gate | Saved | Saved % |
|---|---|---:|---:|---:|---:|
| Claude Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5 | estimate: o200k_base x 1.2 | 7,387 | 754 | 6,633 | 89.8% |
| GPT-6 Astra, Sol, Terra, Luna | o200k_base (assumed for GPT-6) | 6,341 | 660 | 5,681 | 89.6% |
| GPT-5.5 | o200k_base | 6,341 | 660 | 5,681 | 89.6% |

**After `gate_route` for one task** (median of 15 tasks; counts the enabled tools and `gate_route`'s own result):

| Model | Counted as | Without gate | With gate (median) | Saved | Saved % |
|---|---|---:|---:|---:|---:|
| Claude Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5 | estimate: o200k_base x 1.2 | 7,387 | 1,810 | 5,577 | 75.5% |
| GPT-6 Astra, Sol, Terra, Luna | o200k_base (assumed for GPT-6) | 6,341 | 1,550 | 4,791 | 75.6% |
| GPT-5.5 | o200k_base | 6,341 | 1,550 | 4,791 | 75.6% |

The right tools were enabled for **13 of 15** tasks (11 of 13 that need tools; 2 of 2 where no tool fits and the gate enabled none).

Not served:

- "Show what is waiting for a human to approve, then approve one": needed agent-orchestrator__approval_list, agent-orchestrator__approval_resolve; enabled agent-orchestrator__approval_list
- "Save a note to shared memory and search it again later": needed agent-orchestrator__memory_write, agent-orchestrator__memory_search; enabled agent-orchestrator__memory_search, agent-orchestrator__memory_read

**The saving grows with the tool list** (counted as GPT-5.5, o200k_base):

| Tools behind the gate | Without gate | Gate idle | Idle saved | After one task (median) | Saved |
|---:|---:|---:|---:|---:|---:|
| 11 (core) | 2,148 | 660 | 69.3% | 1,144 | 46.7% |
| 37 (standard) | 6,341 | 660 | 89.6% | 1,550 | 75.6% |
| 80 (full) | 11,847 | 660 | 94.4% | 1,796 | 84.8% |

Claude rows use a factor of 1.2 on the o200k_base count; see `scripts/counters.ts`.
<!-- token-report:end -->

How to read this:

- **One real server, not a typical stack.** The tool lists are agent-orchestrator's `tools/list` at its three profiles (11, 37 and 80 tools), read from that project's committed test snapshot. A real setup connects several servers, so its list is longer and the saving larger, but that is not measured here. Capture your own servers with [`scripts/capture-tools.ts`](scripts/capture-tools.ts) and list them in [`bench/stacks.json`](bench/stacks.json).
- **Small tool lists gain little.** The gate adds six definitions and a `gate_route` result of its own, so the saving after routing is small for a short list and grows quickly with the list (last table).
- **A saving only counts if the right tools are reachable.** Each of the [tasks](bench/tasks.json) names the tools it needs, and the report says how many were served. The tasks are phrased in plain words, not copied from tool descriptions, so the lexical router gets no help. For tasks where no tool fits, the gate should enable nothing; the "Not served" list shows where it did not.
- **Tokens, not dollars.** Cached tool definitions are cheaper to resend, so with prompt caching the bill shrinks by less than the token count, while the context window and the model's choice among tools still benefit. Hosts that already defer or search tools (for example Claude Code's tool search) capture part of this saving themselves.
- **How the counts are made.** Tool definitions are counted as the JSON each API takes; providers re-encode them internally, so billed counts differ somewhat. The percentage is the portable result. OpenAI counts use `o200k_base`, which is exact for that encoding; whether the GPT-6 family uses it is not confirmed, so those rows say "assumed". Claude counts are an **estimate** (`o200k_base` × 1.2, because OpenAI tokenizers undercount Claude by roughly 15–20%), since exact Claude counts need Anthropic's `count_tokens` endpoint and an API key; the percentage does not depend on the factor. OpenAI model names come from third-party listings checked on 2026-11-24 and may change.

Reproduce, or refresh the tables:

```bash
npm install --no-save gpt-tokenizer         # once; leaves package.json alone
npx tsx scripts/token-report.ts --write     # re-measure and rewrite the tables above
```

## Sharing the accounting (optional)

Set `CTX_LEDGER_FILE=<path>` and the gate appends one line per event to a [ctx-ledger](https://github.com/pi314x/ctx-ledger) file, so its saving can be summed with that of [lean-context](https://github.com/pi314x/lean-context) and the others:

- `tools_list`, once per listing: `sent` is the gate's own tools, the enabled ones and its instructions; `baseline` is every tool the policy lets through, which is what a client would be sent without a gate. Tools the policy denies are left out of the baseline, so the saving is not inflated by tools nobody could use. It is one listing, not one model request: a client that resends the list pays that amount on each request until it changes.
- `route`, once per `gate_route` call: the size of the answer, with a baseline of `0`, because the answer is extra cost on top of the listing.
- `capsule`, once per `gate_capsule` call: likewise, with a baseline of `0`.

Lines hold counts and ids only, never a task or a tool name, and a ledger that cannot be written never fails a request. Tokens are counted with the same `heuristic-v1` estimate as lean-context, not with a model tokenizer. It is off unless the file is set. `src/ledger.ts` and `src/ledger-tokens.ts` are byte-identical copies from ctx-ledger's `canonical/`, and its tests fail if they drift.

## Quick start

Requires Node 20 or later.

```bash
npm install
npm run build
cp mcp-gate.config.example.json mcp-gate.config.json   # then edit it
node dist/index.js --check                             # connects to every server and prints what it found
```

### As a stdio server (Claude Code, Claude Desktop, any host that spawns it)

```bash
claude mcp add mcp-gate -- node /absolute/path/to/mcp-gate/dist/index.js --config /absolute/path/to/mcp-gate.config.json
```

### As a Streamable HTTP server

```bash
node dist/index.js --http                     # http://127.0.0.1:3737/mcp
claude mcp add --transport http mcp-gate http://127.0.0.1:3737/mcp
```

`--port` and `--host` change the address (`MCP_GATE_PORT`, `MCP_GATE_HOST`). `/healthz` answers health checks.

## Configuration

One JSON file (`--config`, `MCP_GATE_CONFIG`, or `./mcp-gate.config.json`). See [`mcp-gate.config.example.json`](mcp-gate.config.example.json).

```jsonc
{
  "servers": {
    // A server the gate starts itself (stdio) …
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/folder"],
      "policy": { "deny": ["write_*", "edit_*", "move_*"] }
    },
    // … or one it reaches over Streamable HTTP.
    "github": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" },
      "policy": { "allow": ["get_*", "list_*", "create_issue"], "confirm": ["create_issue"] }
    }
  },
  "gate": {
    "maxEnabled": 25,     // most tools enabled at once, per session
    "idleTtlSec": 900,    // switch off tools unused this long (0 = never)
    "routeFloor": 1,      // minimum score for gate_route to enable a tool
    "routeMinMatched": 2, // distinct words a tool must share with the task (all of them, for a shorter task)
    "routeMinCoverage": 0.34, // and this fraction of the task's distinct words; unknown words count against it
    "routeTopK": 5,       // most tools gate_route enables for one task
    "autoEnable": [],     // tools every session starts with, e.g. ["filesystem__read_file"]
    "skillsServer": "skills", // optional: a configured server that serves skills; adds gate_capsule
    "skillsMinScore": 12,     // the skills server's score a best match needs (its own scale; calibrate with npm run capsule -- --scores)
    "codeServer": "context"   // optional, needs skillsServer: a lean-context server; a capsule then carries code areas
  }
}
```

- Server names are lowercase letters, digits and single hyphens. They become the tool prefix.
- `${NAME}` in any string is replaced from the environment, so secrets stay out of the file. A missing variable is an error that names the variable, never a value.
- A server that cannot connect is reported (`gate_list_servers`, `--check`) and skipped. It never stops the gate.

## Two transports, and what each means for state

Which tools are enabled is state, so how a client is recognised matters.

| Transport | A client is | Change notification |
|---|---|---|
| **stdio** | the process: one process, one session | `tools/list_changed` |
| **Streamable HTTP, 2025-era client** | its `Mcp-Session-Id` (a real session per client) | `tools/list_changed` on the session's event stream |
| **Streamable HTTP, 2026-07-28 client** | stateless, so a scope: the authenticated client id, else the `x-mcp-gate-scope` header, else one shared scope | delivered to clients that opened a `subscriptions/listen` stream |

The HTTP endpoint serves both eras on one URL. Without a scope header or authentication, all stateless clients share one set of enabled tools. That suits a single user on loopback. When several clients share an endpoint, give each its own `x-mcp-gate-scope` or put authentication in front.

## Security

- The HTTP endpoint binds to `127.0.0.1` and validates the `Host` and `Origin` headers (DNS-rebinding protection). Name extra hosts with `MCP_GATE_ALLOWED_HOSTS` when a reverse proxy fronts it.
- `MCP_GATE_TOKEN` makes every request carry `Authorization: Bearer <token>` (compared in constant time).
- The gate forwards a tool call only for a tool that is enabled in the caller's session and still allowed by policy.
- Policy limits what a client can enable. It does not sandbox a downstream server: a tool you allow runs with that server's own permissions. Deny what you would not want a model to call.
- Diagnostics go to stderr only, because on stdio stdout is the protocol channel. Configuration values are never logged.

## What this does not do

- **Routing is not understanding.** Lexical ranking finds tools whose words match the task. A paraphrase with no shared words matches nothing, and the answer is then "none", not a guess. Use `gate_search_tools` or enable by name.
- **A client must honour `tools/list_changed`.** A client that ignores the notification keeps its old tool list until it re-lists on its own.
- **Tool calls are passed through.** The gate does not validate arguments, it forwards them and returns the downstream result as is.
- **No resources or prompts yet.** Only tools are proxied.

## Development

```bash
npm test            # 42 tests; in-memory downstream servers, one real stdio process end to end
npm run typecheck
npm run dev -- --check
```

Built on the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 2.x (`@modelcontextprotocol/server`, `client`, `node`).

| Path | Role |
|---|---|
| `src/gate.ts` | `Gate` (servers, catalog, policy) and `GateSession` (what one client may use; the decisions) |
| `src/server.ts` | The MCP server a client talks to: `gate_*` tools plus the enabled tools |
| `src/downstream.ts` | Connections to the downstream servers (stdio and Streamable HTTP) |
| `src/stdio.ts`, `src/http.ts` | The two serving transports |
| `src/policy.ts`, `src/catalog.ts`, `src/config.ts`, `src/glob.ts` | Policy, search ranking, configuration, wildcards |
| `tests/` | Unit tests, gate behaviour, transports |
| `scripts/` | `token-report.ts` (the savings measurement), `capture-tools.ts` (record a real server's tool list), `counters.ts` (token counting) |
| `bench/` | Captured tool lists (`fixtures/`), the tasks with the tools each needs, the stacks the report runs |

## License

MIT. See [LICENSE](LICENSE).
