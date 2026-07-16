# mcp-agent

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
- [Session Commands Reference](#session-commands-reference)
- [Design Decisions](#design-decisions)
- [Platform Notes](#platform-notes)
- [Security Model](#security-model)
- [Known Limitations](#known-limitations)
- [Development](#development)

## Overview

`mcp-agent` connects to MCP servers over either `stdio` (a locally spawned process) or `http` (a remote streamable-HTTP endpoint), discovers their tools via the standard MCP `listTools`/`callTool` protocol, and exposes three ways to invoke those tools:

1. **`call`** — you pick the tool, the CLI walks its JSON Schema and prompts you field-by-field.
2. **`ask`** — you describe what you want in natural language; Claude selects tools, drafts arguments, and the CLI executes them with your explicit approval on each call, looping until it has a final answer.
3. **`session`** — an interactive REPL wrapping both of the above, where server connections and `ask` conversation history persist across commands instead of resetting on every invocation.

## Architecture

```
src/
  config.js      Registered-server persistence (~/.mcp-agent/servers.json)
  mcpClient.js    MCP transport handling: connect, list tools, call tools, teardown
  suggest.js      JSON Schema -> interactive prompt walker; LLM agent-loop driver
  session.js      Interactive REPL: persistent connections + persistent conversation
  index.js        Commander CLI entrypoint wiring the above into subcommands
```

**Data flow for `ask`:**

```
user query
   -> runAgentTurn() appends to shared `messages` history
   -> Anthropic API call with full tool set + full message history
   -> model returns text and/or tool_use blocks
   -> for each tool_use: confirmTool() gates execution, executeTool() runs it via MCP
   -> results appended as tool_result blocks, loop repeats
   -> terminates when model returns a turn with no tool_use blocks,
      or after MAX_AGENT_STEPS (8) steps, whichever comes first
```

This is a standard Anthropic tool-use loop, not a single "pick one tool and stop" call — the model can chain multiple tool calls (read a file, then act on its contents) within one `ask`, and in `session` mode it retains memory of prior `ask` turns in the same run.

## Installation

Requires Node.js 18+.

```bash
mkdir mcp-agent && cd mcp-agent
# place src/config.js, src/mcpClient.js, src/suggest.js, src/session.js, src/index.js
```

**`package.json`:**

```json
{
  "name": "mcp-agent",
  "version": "0.1.0",
  "description": "Local CLI agent for calling registered MCP servers",
  "type": "module",
  "bin": {
    "mcp-agent": "./src/index.js"
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

`"type": "module"` is required — every file uses ES module `import`/`export` syntax. `inquirer` must be v9 or later (pure ESM); older CommonJS versions have a different default-export shape than what this code assumes.

```bash
npm install
npm link          # exposes `mcp-agent` as a global command
```

To remove the global link later:

```bash
cd mcp-agent
npm unlink -g
# or, if that doesn't take:
npm uninstall -g mcp-agent
```

## Configuration

Registered servers are stored as plain JSON at:

```
~/.mcp-agent/servers.json
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
      "env": { "API_KEY": "..." },
      "inheritEnv": false
    }
  }
}
```

This file is not encrypted. If any `env` entry contains a secret, treat this file with the same care as a credentials file — see [Security Model](#security-model).

## Commands

### `register <name>`

Interactively registers a new server. Prompts for transport (`stdio` or `http`), then transport-specific fields:

- **http**: server URL.
- **stdio**: command, space-separated arguments, working directory, extra environment variables (`KEY=VALUE`, comma-separated), and whether to inherit your full shell environment.

```bash
mcp-agent register fs_tools
```

### `unregister <name>`

Removes a server from the config file.

```bash
mcp-agent unregister fs_tools
```

### `list`

Lists all registered servers and their launch command or URL.

```bash
mcp-agent list
```

### `tools <server>`

Connects to a server and prints every tool it exposes, along with its parameters, required/optional status, and types, derived from each tool's JSON Schema.

```bash
mcp-agent tools fs_tools
```

### `call <server> <tool>`

Connects, walks the target tool's input schema, prompting for each parameter (respecting `enum`, `boolean`, `number`/`integer`, and required/optional fields), shows you the assembled arguments, and asks for confirmation before executing.

```bash
mcp-agent call fs_tools read_file
```

### `ask <query...>`

Natural-language dispatch. Connects to every registered server (or one, with `-s <name>`), gives Claude the full combined tool set, and runs the agent loop described in [Architecture](#architecture). Requires `ANTHROPIC_API_KEY` in the environment.

```bash
mcp-agent ask "list the files in the temp directory and tell me the largest one"
mcp-agent ask -s fs_tools "clean up any .tmp files"
```

Every tool call the model proposes is printed with its full arguments and requires an explicit `y`/`n` before execution — the loop does not run tools autonomously.

### `session`

Starts an interactive REPL. Connections opened with `connect` (or lazily by `tools`/`call`/`ask`) stay open across commands, and `ask`'s conversation history accumulates for the lifetime of the session instead of resetting per call — enabling follow-up queries like *"now delete the one you just summarized"* that depend on a prior turn.

```bash
mcp-agent session
```

## Session Commands Reference

| Command | Description |
|---|---|
| `connect <server>` | Opens (or reuses) a connection to a registered server |
| `disconnect <server>` | Closes a specific connection |
| `servers` | Lists registered servers, marking which are currently connected |
| `tools <server>` | Lists a server's tools (auto-connects if needed) |
| `call <server> <tool>` | Schema-guided tool call, same prompting as the top-level `call` command |
| `ask <query>` | Runs the agent loop against the shared conversation history |
| `history` | Prints the raw `ask` message history as JSON |
| `clear` | Wipes conversation history without closing connections |
| `exit` / `quit` | Closes all connections and ends the session |

## Design Decisions

**Human confirmation on every tool call, in both `ask` and `session ask`.**
The agent loop can chain multiple tool invocations per query. Autonomous execution without per-call approval was deliberately rejected — a registered server can have destructive tools (e.g. file deletion), and a multi-step loop compounds that risk with every additional step. `confirmTool` is called before every single tool execution, not once per query.

**`MAX_AGENT_STEPS = 8`.**
Bounds the tool-call loop so a model that gets stuck re-invoking a tool (e.g. misinterpreting a result and retrying indefinitely) cannot run unbounded. If the cap is hit, the loop returns an explicit "stopped after N steps" message rather than either looping forever or failing silently.

**`tool_choice: "auto"`, not `"any"`.**
An earlier iteration forced the model to always select some tool, even for queries that didn't clearly need one. `"auto"` lets the model return plain text when no tool call is warranted.

**Explicit `env` allowlist rather than full environment inheritance by default.**
Spawned stdio servers get a minimal, deliberately chosen set of environment variables (`PATH`, `HOME`/`USERPROFILE`, temp dirs, shell/command-processor variables) unless `inheritEnv: true` is set on that server's registration. Full inheritance is opt-in per server, not global, since it exposes whatever is in the invoking shell (API keys, tokens, etc.) to every spawned child process.

**Explicit client teardown, not reliance on process exit.**
Every command path — success, early failure, and unhandled throw (via the `withCleanup` wrapper) — calls `closeAllClients()` before exiting. Letting `process.exit()` implicitly kill spawned children is not reliable across platforms, particularly Windows (see below).

## Platform Notes

**Windows `stdio` command resolution.** The MCP SDK's `StdioClientTransport` spawns processes without a shell layer. Windows resolves commands like `npx`, `npm`, or `pnpm` to `.cmd` shims via `PATHEXT`, which a shell-less `CreateProcess` call cannot do — it throws `ENOENT`. `mcp-agent` detects `process.platform === "win32"` and, for any command that isn't already a path or doesn't already carry an executable extension (`.exe`/`.cmd`/`.bat`/`.com`), routes the launch through `cmd.exe /d /s /c <command> <args...>` to restore normal shim resolution.

This routing is not a general-purpose shell-injection-safe quoting layer — arguments containing embedded double quotes or `&`/`|`/`^` can still be misparsed by `cmd.exe`'s own quoting rules. For typical MCP server arguments (flags, file paths) this does not come up; it is a known residual limitation, not an oversight.

**Windows child process cleanup.** Unlike POSIX, where a child often exits on `SIGPIPE` when its parent's stdin closes, Windows gives no such guarantee. Every command explicitly calls `client.close()` (via `closeAllClients()`) before exiting rather than relying on this behavior.

## Security Model

- `~/.mcp-agent/servers.json` is **plaintext**. Any `env` values you register (API keys, tokens) are stored and read unencrypted. No permission-hardening is applied to the file beyond your OS's default umask.
- `inheritEnv: true` passes your **entire** shell environment to the spawned server process. Only enable it for servers you trust with everything currently in your environment.
- Every tool call proposed by the LLM in `ask`/`session ask` requires explicit interactive confirmation, showing the exact tool name, server, and arguments before execution. There is no `--yes`/auto-approve flag; this is intentional.
- `ANTHROPIC_API_KEY` is read from the environment only — it is never written to the config file or logged.

## Known Limitations

- **`promptForArgs` has no branch for `array`- or `object`-typed schema properties.** Tool parameters of these types fall through to a plain string prompt, so a tool expecting a list or nested object will receive a raw string unless you supply valid JSON by hand. Scalar types (`string`, `number`, `integer`, `boolean`, `enum`) are fully handled, including required-field defaults and enum-choice prompting.
- **No retry/reconnect logic.** One live connection per server per process (or per `session` run); a server that crashes mid-session must be reconnected manually with `connect <server>`.
- **No validation beyond type coercion.** Schema constraints like `minimum`/`maximum`/`pattern` are not enforced client-side; a rejected value will surface as an MCP server-side error rather than being caught earlier.

## Development

```bash
npm link          # develop against the global `mcp-agent` command
npm unlink -g      # remove when done
```

There is no bundler or build step — `src/index.js` runs directly via its `#!/usr/bin/env node` shebang (POSIX) or the `.cmd` shim `npm link` generates (Windows).