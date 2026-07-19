# mcp-dev

A local CLI for registering Model Context Protocol (MCP) servers and interacting with their tools — either directly via schema-guided prompts, or through an LLM-driven agentic loop with human confirmation on every tool call.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
  - [`register`](#register-name)
  - [`unregister`](#unregister-name)
  - [`list`](#list)
  - [`tools`](#tools-server)
  - [`call`](#call-server-tool)
  - [`ask`](#ask-query)
  - [`session`](#session)
  - [`doctor`](#doctor)
- [Session Commands Reference](#session-commands-reference)
- [Result Reuse (`!N` back-references)](#result-reuse-n-back-references)
- [Design Decisions](#design-decisions)
- [Platform Notes](#platform-notes)
- [Security Model](#security-model)
- [Known Limitations](#known-limitations)
- [Development](#development)

## Overview

`mcp-dev` connects to MCP servers over either `stdio` (a locally spawned process) or `http` (a remote streamable-HTTP endpoint), discovers their tools via the standard MCP `listTools`/`callTool` protocol, and exposes three ways to invoke those tools:

1. **`call`** — you pick the tool, the CLI walks its JSON Schema and prompts you field-by-field.
2. **`ask`** — you describe what you want in natural language; Claude selects tools, drafts arguments, and the CLI executes them with your explicit approval on each call, looping until it has a final answer.
3. **`session`** — an interactive REPL wrapping both of the above, where server connections, `ask` conversation history, and cached tool results (see [Result Reuse](#result-reuse-n-back-references)) all persist across commands instead of resetting on every invocation.

## Architecture

```
src/
  config.js        Registered-server persistence (~/.mcp-dev/servers.json)
  mcpClient.js      MCP transport handling: connect, list tools, call tools, teardown,
                     env-var interpolation for stdio server secrets
  suggest.js        JSON Schema -> interactive prompt walker; LLM agent-loop driver
  render.js         Result formatting: JSON pretty-print, auto-table for flat arrays
                     of objects, pager fallback for long output
  resultBuffer.js   Session-scoped cache of tool results + "!N" back-reference resolver
  session.js        Interactive REPL: persistent connections + persistent conversation
                     + persistent result buffer
  index.js          Commander CLI entrypoint wiring the above into subcommands
```

**Data flow for `ask`:**

```
user query
   -> runAgentTurn() appends to shared `messages` history
   -> Anthropic API call with full tool set + full message history
   -> model returns text and/or tool_use blocks
   -> for each tool_use: confirmTool() gates execution, executeTool() runs it via MCP
   -> results appended as tool_result blocks (and, in `session`, cached in the
      result buffer alongside palette-driven calls), loop repeats
   -> terminates when model returns a turn with no tool_use blocks,
      or after MAX_AGENT_STEPS (8) steps, whichever comes first
```

This is a standard Anthropic tool-use loop, not a single "pick one tool and stop" call — the model can chain multiple tool calls (read a file, then act on its contents) within one `ask`, and in `session` mode it retains memory of prior `ask` turns in the same run.

## Installation

Requires Node.js 18+.

```bash
mkdir mcp-dev && cd mcp-dev
# place src/config.js, src/mcpClient.js, src/suggest.js, src/render.js,
# src/resultBuffer.js, src/session.js, src/index.js
```

**`package.json`:**

```json
{
  "name": "mcp-dev",
  "version": "0.1.0",
  "description": "Local CLI agent for calling registered MCP servers",
  "type": "module",
  "bin": {
    "mcp-dev": "./src/index.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "commander": "^12.1.0",
    "inquirer": "^12.0.0"
  }
}
```

`"type": "module"` is required — every file uses ES module `import`/`export` syntax. `inquirer` must be v9 or later (pure ESM); older CommonJS versions have a different default-export shape than what this code assumes. The array/object argument editor (see [Known Limitations](#known-limitations)) uses `editor` from `@inquirer/prompts`, already a transitive dependency of `inquirer@12` — no new package is required.

```bash
npm install
npm link          # exposes `mcp-dev` as a global command
```

To remove the global link later:

```bash
cd mcp-dev
npm unlink -g
# or, if that doesn't take:
npm uninstall -g mcp-dev
```

## Configuration

Registered servers are stored as plain JSON at:

```
~/.mcp-dev/servers.json
```

Created automatically on first use. Structure:

```json
{
  "servers": {
    "my-http-server": { "url": "https://example.com/mcp" },
    "my-stdio-server": {
      "command": "node",
      "args": ["server.js"],
      "cwd": "/path/to/server",
      "env": { "API_KEY": "${MY_API_KEY}" },
      "inheritEnv": false
    }
  }
}
```

An `env` value of exactly `${VAR_NAME}` is resolved from your shell environment at connect time instead of being read literally — see [Security Model](#security-model). Values that don't match that exact pattern are used as-is, so existing configs with literal secret values keep working unchanged.

## Commands

### `register <name>`

Interactively registers a new server. Prompts for transport (`stdio` or `http`), then transport-specific fields:

- **http**: server URL.
- **stdio**: command, space-separated arguments, working directory, extra environment variables (`KEY=VALUE`, comma-separated — use `KEY=${SHELL_VAR}` to store a reference instead of a literal secret), and whether to inherit your full shell environment.

```bash
mcp-dev register fs_tools
```

### `unregister <name>`

Removes a server from the config file.

```bash
mcp-dev unregister fs_tools
```

### `list`

Lists all registered servers and their launch command or URL.

```bash
mcp-dev list
```

### `tools <server>`

Connects to a server and prints every tool it exposes, along with its parameters, required/optional status, and types, derived from each tool's JSON Schema.

```bash
mcp-dev tools fs_tools
mcp-dev tools fs_tools --json   # raw tool definitions, for piping into jq etc.
```

### `call <server> <tool>`

Connects, walks the target tool's input schema, prompting for each parameter (respecting `enum`, `boolean`, `number`/`integer`, `array`/`object`, and required/optional fields), shows you the assembled arguments, and asks for confirmation before executing. Results are rendered as a colorized/tabular view by default, or as raw JSON with `--json`.

```bash
mcp-dev call fs_tools read_file
mcp-dev call fs_tools list_dir --json   # confirmation prompt still applies — see Security Model
```

### `ask <query...>`

Natural-language dispatch. Connects to every registered server (or one, with `-s <name>`), gives Claude the full combined tool set, and runs the agent loop described in [Architecture](#architecture). Requires `ANTHROPIC_API_KEY` in the environment.

```bash
mcp-dev ask "list the files in the temp directory and tell me the largest one"
mcp-dev ask -s fs_tools "clean up any .tmp files"
```

Every tool call the model proposes is printed with its full arguments and requires an explicit `y`/`n` before execution — the loop does not run tools autonomously.

### `session`

Starts an interactive REPL. Connections opened with `connect` (or lazily by `tools`/`call`/`ask`) stay open across commands, `ask`'s conversation history accumulates for the lifetime of the session instead of resetting per call, and every tool result — from a palette-driven call or from the agent loop — is cached and reusable via `!N` (see [Result Reuse](#result-reuse-n-back-references)).

```bash
mcp-dev session
```

### `doctor`

Connects to every registered server, counts its tools, times the connection, and disconnects — without executing any tool. Useful to catch a broken registration (bad command, missing env var, unreachable URL) before starting a session, or as a pre-flight check in CI.

```bash
mcp-dev doctor
```

```
✓ fs_tools    6 tool(s)   142ms
✗ broken_srv              8ms   Server "broken_srv": env var "API_KEY" references ${MISSING_VAR}, which is not set in your shell.
```

Disclosed limitation: there is no per-server timeout. A server that connects but hangs on `listTools()` will make `doctor` hang on that entry rather than reporting a timeout for it.

## Session Commands Reference

| Command | Description |
|---|---|
| `connect <server>` | Opens (or reuses) a connection to a registered server |
| `disconnect <server>` | Closes a specific connection |
| `servers` | Lists registered servers, marking which are currently connected |
| `tools <server>` | Lists a server's tools (auto-connects if needed) |
| `call <server> <tool>` | Schema-guided tool call, same prompting as the top-level `call` command |
| `ask <query>` | Runs the agent loop against the shared conversation history |
| `results` | Lists cached tool results and their `!N` index (see below) |
| `save <n> <path>` | Writes cached result `#n`'s raw text to a file on disk |
| `history` | Prints the raw `ask` message history as JSON |
| `clear` | Wipes conversation history without closing connections or clearing cached results |
| `exit` / `quit` | Closes all connections and ends the session |

## Result Reuse (`!N` back-references)

Every tool call inside a `session` — whether picked from the `/` palette or run by the agent loop during `ask` — is cached in an in-memory ring buffer (last 20 results). The index shown after each call (`[cached as #7]`) can be substituted directly into a later argument prompt instead of re-typing or copy-pasting a value:

- `!!` — the most recent result's full text.
- `!7` — result #7's full text.
- `!7.items[0].id` — a single field extracted from result #7, if it parsed as JSON. Supports dotted keys and `[n]` array indices only — no wildcards, filters, or slices.

```
> fs_tools/list_dir
[cached as #1 — reference with !1 or !!]
...
> fs_tools/read_file
path (required): !1.entries[0].path
```

For `array`/`object`-typed parameters, the same `!N`/`!N.path` syntax works on the parameter's one-line prompt; leaving it blank opens your `$EDITOR` (falls back to `notepad` on Windows, `vim` elsewhere) pre-filled with a JSON skeleton — see [Known Limitations](#known-limitations).

Disclosed failure mode: a literal argument value that itself starts with `!` followed by `!` or digits (a shell-command string, an actual ticket ID like `!123`) will be misread as a back-reference. There's no escape syntax for this yet — route around it via the editor path if it collides with a specific tool's argument values.

The buffer is in-memory only and is not persisted — it's cleared when the session exits. `save <n> <path>` is the explicit, one-result-at-a-time way to persist a value to disk.

## Design Decisions

**Human confirmation on every tool call, in both `ask` and `session ask`.**
The agent loop can chain multiple tool invocations per query. Autonomous execution without per-call approval was deliberately rejected — a registered server can have destructive tools (e.g. file deletion), and a multi-step loop compounds that risk with every additional step. `confirmTool` is called before every single tool execution, not once per query. `call --json` and `tools --json` only change output *formatting*; neither adds a way to skip this gate.

**`MAX_AGENT_STEPS = 8`.**
Bounds the tool-call loop so a model that gets stuck re-invoking a tool (e.g. misinterpreting a result and retrying indefinitely) cannot run unbounded. If the cap is hit, the loop returns an explicit "stopped after N steps" message rather than either looping forever or failing silently.

**`tool_choice: "auto"`, not `"any"`.**
An earlier iteration forced the model to always select some tool, even for queries that didn't clearly need one. `"auto"` lets the model return plain text when no tool call is warranted.

**Explicit `env` allowlist rather than full environment inheritance by default.**
Spawned stdio servers get a minimal, deliberately chosen set of environment variables (`PATH`, `HOME`/`USERPROFILE`, temp dirs, shell/command-processor variables) unless `inheritEnv: true` is set on that server's registration. Full inheritance is opt-in per server, not global, since it exposes whatever is in the invoking shell (API keys, tokens, etc.) to every spawned child process.

**`${VAR_NAME}` env interpolation is exact-match, not substring interpolation.**
`env: { "API_KEY": "${MY_KEY}" }` resolves; `env: { "URL": "https://x/${MY_KEY}/y" }` does not (the whole value must match the pattern). This keeps the resolution rule simple to reason about and audit, at the cost of not supporting partial-value templating — a deliberate scope limit, not an oversight.

**Explicit client teardown, not reliance on process exit.**
Every command path — success, early failure, and unhandled throw (via the `withCleanup` wrapper) — calls `closeAllClients()` before exiting. Letting `process.exit()` implicitly kill spawned children is not reliable across platforms, particularly Windows (see below).

**Result buffer is in-memory and session-scoped, not persisted by default.**
A tool result can contain data the user never asked to have written to disk. `save <n> <path>` is opt-in per result; nothing is written automatically.

## Platform Notes

**Windows `stdio` command resolution.** The MCP SDK's `StdioClientTransport` spawns processes without a shell layer. Windows resolves commands like `npx`, `npm`, or `pnpm` to `.cmd` shims via `PATHEXT`, which a shell-less `CreateProcess` call cannot do — it throws `ENOENT`. `mcp-dev` detects `process.platform === "win32"` and, for any command that isn't already a path or doesn't already carry an executable extension (`.exe`/`.cmd`/`.bat`/`.com`), routes the launch through `cmd.exe /d /s /c <command> <args...>` to restore normal shim resolution.

This routing is not a general-purpose shell-injection-safe quoting layer — arguments containing embedded double quotes or `&`/`|`/`^` can still be misparsed by `cmd.exe`'s own quoting rules. For typical MCP server arguments (flags, file paths) this does not come up; it is a known residual limitation, not an oversight.

**Windows child process cleanup.** Unlike POSIX, where a child often exits on `SIGPIPE` when its parent's stdin closes, Windows gives no such guarantee. Every command explicitly calls `client.close()` (via `closeAllClients()`) before exiting rather than relying on this behavior.

**Result pager (`less`).** Long, non-JSON-parseable results are piped through `less -R -F` when stdout is a TTY. `less` ships by default on macOS/Linux. On a bare Windows `cmd.exe`/PowerShell host without Git-for-Windows or WSL, `less` may be absent — this is not confirmed either way on every Windows configuration; if the pager binary is missing, output falls back to a plain, unpaginated `console.log` with a one-time notice rather than failing the command.

## Security Model

- `~/.mcp-dev/servers.json` is **plaintext**. Any `env` values you register as literal strings (API keys, tokens) are stored and read unencrypted. No permission-hardening is applied to the file beyond your OS's default umask. Using `${VAR_NAME}` instead of a literal value (see [Configuration](#configuration)) keeps the secret itself out of this file — only the variable *name* is stored — but this does not encrypt or otherwise protect entries that are still literal.
- A `${VAR_NAME}` reference to an unset shell variable throws a clear, per-server error at connect time rather than silently passing an empty string to the spawned process.
- `inheritEnv: true` passes your **entire** shell environment to the spawned server process. Only enable it for servers you trust with everything currently in your environment.
- Every tool call proposed by the LLM in `ask`/`session ask`, and every tool call made via `call`/`session call` (`--json` included), requires explicit interactive confirmation, showing the exact tool name, server, and arguments before execution. There is no `--yes`/auto-approve flag; this is intentional, and `--json` deliberately does not add one — it only changes how the *result* is printed after you've already confirmed.
- `ANTHROPIC_API_KEY` is read from the environment only — it is never written to the config file or logged.
- The result buffer (`session` only) lives in process memory and is never written to disk unless you explicitly run `save <n> <path>`.

## Known Limitations

- **`array`/`object`-typed schema properties open an external editor (`$EDITOR`/`$VISUAL`, falling back to `notepad` on Windows or `vim` elsewhere), pre-filled with a JSON skeleton, `!N` back-reference, or your last invalid attempt.** This replaces the previous plain-string fallback, but the scope is deliberately narrow: it makes producing valid JSON easier, it does not add field-by-field sub-schema prompting for nested object shapes. A tool with a deeply nested required object still requires hand-written JSON, just in a real editor instead of a single-line terminal prompt.
- **No retry/reconnect logic.** One live connection per server per process (or per `session` run); a server that crashes mid-session must be reconnected manually with `connect <server>`.
- **No validation beyond type coercion.** Schema constraints like `minimum`/`maximum`/`pattern` are not enforced client-side; a rejected value will surface as an MCP server-side error rather than being caught earlier.
- **`!N` back-reference syntax can collide with literal argument values** that start with `!` followed by digits or `!` (see [Result Reuse](#result-reuse-n-back-references)).
- **`doctor` has no per-server timeout**; a hung server hangs the whole `doctor` run at that entry.
- **The result buffer is not shared between `session` and one-shot `call`/`ask` invocations** — each one-shot process starts with an empty buffer, since there is no persistent process for it to live in.

## Development

```bash
npm link          # develop against the global `mcp-dev` command
npm unlink -g      # remove when done
```

There is no bundler or build step — `src/index.js` runs directly via its `#!/usr/bin/env node` shebang (POSIX) or the `.cmd` shim `npm link` generates (Windows).