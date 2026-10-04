# mcp-dev

`mcp-dev` is a fast, approval-first command-line client for [Model Context Protocol](https://modelcontextprotocol.io/) servers. Register local stdio processes or Streamable HTTP endpoints, inspect their tools, run one tool with guided arguments, or work in a persistent interactive session.

It is designed to make the safe path quick: **every tool call is shown with its exact arguments and requires approval**. `--args`, `--args-file`, JSON output, agent mode, and the session UI do not bypass that gate.

> This release aims for a particularly capable and dependable MCP CLI; “better than every existing client” is not an objectively testable claim. The concrete reliability and usability work is listed in [Twenty improvements](#twenty-concrete-improvements).

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Interactive session](#interactive-session)
- [Configuration](#configuration)
- [Connect the local .NET servers](#connect-the-local-net-servers)
- [Tool metadata cache and startup speed](#tool-metadata-cache-and-startup-speed)
- [Result reuse](#result-reuse)
- [Security](#security)
- [Twenty concrete improvements](#twenty-concrete-improvements)
- [Development](#development)

## Install

Requires Node.js 18 or newer.

```bash
npm install
npm link
mcp-dev --help
```

The CLI has no build step. `mcp-dev --help` and `mcp-dev help <command>` intentionally avoid loading the MCP SDK, prompt engine, or configured servers, so help is available immediately even in a cold shell.

## Quick start

### Register a local server

```bash
mcp-dev register files \
  --command npx \
  --arg -y \
  --arg @modelcontextprotocol/server-filesystem \
  --arg "$HOME/work"
```

Or use the guided registration flow:

```bash
mcp-dev register files
```

`--args` understands quoted values without executing a shell:

```bash
mcp-dev register docs --command node --args 'server.mjs --root "~/My Docs"'
```

### Inspect and call it

```bash
mcp-dev list
mcp-dev tools files
mcp-dev call files read_file
```

For reproducible input, pass one complete JSON object. Approval is still required:

```bash
mcp-dev call files read_file --args '{"path":"README.md"}'
mcp-dev call files read_file --args-file request.json --dry-run
```

### Start a session

```bash
mcp-dev session
```

The session starts without connecting to every server. Type `/files/` to lazy-connect and browse a server, or type a normal sentence to chat after setting `ANTHROPIC_API_KEY`.

## Commands

Run `mcp-dev help <command>` for focused examples, options, and keyboard notes.

| Command | What it does |
|---|---|
| `register <name>` | Register a stdio command or Streamable HTTP endpoint; interactive or flag-driven. |
| `unregister <name>` | Remove a registration. Interactive terminals ask first; automation needs `--force`. |
| `list` | List registrations. `--plain` is script-friendly; `--json` is a redacted safe summary. |
| `tools <server>` | Show readable parameter schemas. Supports `--json`, `--plain`, and cache-only `--cached`. |
| `call <server> <tool>` | Guided, schema-validated tool call with confirmation. Supports `--args`, `--args-file`, `--dry-run`, `--json`, and `--no-pager`. |
| `ask <query...>` | Approval-gated multi-step agent loop using `ANTHROPIC_API_KEY`; use `-s <server>` to restrict it. |
| `session [--warm]` | Persistent interactive workspace. `--warm` eagerly refreshes every registration. |
| `doctor` | Parallel non-destructive health check. Supports timeout, concurrency, and JSON output. |
| `completion <shell>` | Generate Bash, Zsh, or PowerShell completion. |

Useful examples:

```bash
mcp-dev tools files --plain
mcp-dev tools files --cached        # never opens a process or network connection
mcp-dev doctor --concurrency 8
mcp-dev doctor --json | jq '.[] | select(.ok == false)'
mcp-dev completion zsh > "${fpath[1]}/_mcp-dev"
```

## Interactive session

The session has three input modes:

| Input | Meaning |
|---|---|
| Plain text | Chat with the assistant. Requires `ANTHROPIC_API_KEY`. |
| `/command` | Run a built-in command, such as `/servers`, `/call`, `/refresh`, or `/help`. |
| `/server/` or `/server/tool` | Lazy-connect, inspect, and select a tool. The legacy `server/tool` spelling also works. |
| `//message` | Send a chat message that literally begins with `/`. |

`/help` displays the full in-session reference. Direct session calls and model-proposed calls both show an approval screen before execution.

### Keyboard behavior

Text fields and fuzzy search prompts support word deletion consistently:

- **Ctrl+Backspace** — delete the previous word in terminals that report that key combination.
- **Alt/Option+Backspace** — supported where the terminal maps it to Meta+Backspace.
- **Ctrl+W** — portable terminal fallback for delete-previous-word.
- **Ctrl+C** — cancel the active prompt or in-flight MCP request.

The implementation normalizes the key event before Node’s readline handler runs, so it avoids the one-character deletion behavior seen in several Windows terminal setups.

## Configuration

By default, registrations are stored at:

```text
~/.mcp-dev/servers.json
```

Use an alternate location for a project, test, or CI job:

```bash
MCP_DEV_CONFIG_DIR=.mcp-dev-local mcp-dev list
# or
MCP_DEV_CONFIG_PATH=/secure/path/servers.json mcp-dev list
```

Example configuration:

```json
{
  "servers": {
    "files": {
      "command": "node",
      "args": ["server.mjs", "--root", "/workspace"],
      "cwd": "/workspace",
      "root": "/workspace",
      "env": { "API_KEY": "${FILES_API_KEY}" },
      "inheritEnv": false,
      "allowSampling": false,
      "description": "workspace filesystem"
    },
    "remote-docs": {
      "url": "https://example.test/mcp",
      "headers": { "Authorization": "${DOCS_AUTH}" },
      "description": "company documentation"
    }
  }
}
```

An `env` or `headers` value that is exactly `${NAME}` is resolved from the current environment only when the server connects. For example, set `DOCS_AUTH` to the full `Bearer …` value and store `"Authorization": "${DOCS_AUTH}"`. Partial interpolation is intentionally not supported. Use `--inherit-env` only for processes you fully trust.

Server-initiated MCP sampling is **off by default**. Set `"allowSampling": true` (or register with `--allow-sampling`) only for a trusted server and a session where sending server-provided sampling content to your configured model provider is acceptable.

Configuration writes use an advisory lock, stale-lock recovery, an atomic rename, and best-effort `0700` directory / `0600` file permissions on POSIX systems. The config remains plaintext; permissions reduce accidental exposure but do not encrypt secrets.

## Connect the local .NET servers

The WordNet/Dolma MCP server and the ONNX `vector_tools` server can be used side by side with `mcp-dev` as two independent stdio servers. No project merge or shared vector index is needed: `mcp-dev` scopes each tool call by server name, even though both servers expose a tool named `embed_search`.

The C# projects and their model/data files are external assets; this repository does not include them. Prepare the target frameworks and data paths first:

- The WordNet project targets .NET 10 and requires an x64 CPU with AVX2, FMA3, and SSE2. It needs a WordNet `dict/` directory and the Dolma `.txt` corpus. In `WordNetMcp/app.config`, replace the sample Windows-only `StartupPath` with an existing, writable runtime/cache directory on this machine. The program changes its working directory to that setting before it starts; the generated `dolma_vectors.bin` is written there. It also accepts the dictionary, corpus, and sorted-index cache paths as application arguments, detected by their `dict`, `.txt`, and `.bin` suffixes. Edit this setting before building, or rebuild afterward so the output config is refreshed.
- `vector_tools` targets .NET 8. It needs a compatible ONNX model and its `vocab.txt`, plus an existing writable directory for its persistent passage index. Its application arguments are model path, vocabulary path, and index root, in that order.
- Install the .NET SDKs/runtimes needed for both target frameworks. Keep the large corpus, dictionary, model, and generated indexes outside this repository.

Build each project separately before registering its DLL. This keeps `dotnet build` output away from the MCP stdio stream:

```bash
dotnet build "/path/to/WordNetMcp/WordNetMcp.csproj" -c Release
dotnet build "/path/to/vector_tools/embedtools.csproj" -c Release
```

Register each built DLL (replace every `/path/to/...` with a real absolute path):

```bash
mcp-dev register wordnet-dolma --command dotnet --args '"/path/to/WordNetMcp/bin/Release/net10.0/WordNetMcp.dll" "/path/to/WordNetMcp/dict" "/path/to/dolma_300_2024_1.2M.100_combined.txt" "/path/to/dolma_sorted_index.bin"' --cwd "/path/to/WordNetMcp"

mcp-dev register vector-tools --command dotnet --args '"/path/to/vector_tools/bin/Release/net8.0/embed-retrieval.dll" "/path/to/model.onnx" "/path/to/vocab.txt" "/path/to/embeddings"' --cwd "/path/to/vector_tools"
```

The quoted `--args` value is parsed into individual arguments without invoking a shell, so paths containing spaces remain intact. An equivalent ready-to-edit JSON template is at [`examples/dotnet-mcp-servers.json`](examples/dotnet-mcp-servers.json); merge its entries into your existing `servers` object rather than replacing registrations you want to keep.

Inspect each server and allow more time on a cold start while .NET initializes or the Dolma cache is built:

```bash
mcp-dev list
mcp-dev tools wordnet-dolma --timeout 120000
mcp-dev tools vector-tools --timeout 120000
mcp-dev doctor --timeout 120000 --json
```

Calls remain approval-gated. For example, these calls are unambiguous because the server name scopes each tool; WordNet lookups work before its embedding index is ready, while ONNX search queries the passage index:

```bash
mcp-dev call wordnet-dolma lemma_lookup --args '{"lemma":"bank"}'
mcp-dev call vector-tools embed_search --args '{"query":"marine mammals","topK":5}'
```

Both servers also expose `embed_search`, but their vectors are different spaces (300 vs. 768 dimensions) and are not interchangeable. WordNet populates its Dolma index in the background. A one-shot `mcp-dev call` starts and closes a fresh server process, so use a persistent session for index-dependent WordNet tools: run `mcp-dev session`, type `/wordnet-dolma/`, select and approve `index_status`, and repeat until it reports `ready: true`. Then call `embed_search` or `semantic_expand_text` in that same session. Otherwise those tools can keep returning `NOT_READY` as each one-shot invocation restarts the background build.

## Tool metadata cache and startup speed

After a successful `tools`, `doctor`, `ask`, or session refresh, tool definitions are cached in `~/.mcp-dev/tools.json` (or next to a custom config file). The cache enables:

- instant session startup without launching every stdio server;
- cached tool names for Bash/Zsh/PowerShell completion;
- `mcp-dev tools server --cached` with no network/process startup;
- graceful reuse of last-known schemas while a server is temporarily unavailable.

The cache is fingerprinted to the meaningful server configuration, bounded in size, and written atomically with restrictive file permissions. It persists tool names, descriptions, and schemas—not tool-call results—so treat it as configuration-adjacent data. A cached selection is always live-refreshed before the session displays its argument form or calls it. MCP `notifications/tools/list_changed` invalidates the cache for that open connection.

Use `mcp-dev session --warm` when you prefer an eager refresh, or `/refresh` inside a session for one server.

## Result reuse

Session results stay in an in-memory ring buffer (20 entries). Use them as subsequent argument values:

```text
!!                         latest result text
!7                         result #7 text
!7.items[0].id             a JSON field
!7["key.with.dots"][0]    a quoted JSON key
!7.rows[*].name            values projected from an array
\!123                      literal !123, not a back-reference
```

`/results` lists cache indices. `/save` writes one selected result after an overwrite confirmation. The buffer clears when the session exits and is never persisted automatically.

## Security

- Every MCP tool invocation requires an explicit confirmation, including agent and session calls.
- Tool errors render visibly and make one-shot `call` return a non-zero status.
- URLs shown by `list` redact credentials and sensitive query keys. The safe `list --json` summary excludes environment values and HTTP headers.
- Stdio servers receive a minimal environment by default. `inheritEnv: true` is an explicit opt-in.
- HTTP header values can use exact `${ENV_VAR}` references to keep tokens out of configuration.
- Server-initiated sampling is not advertised unless `allowSampling` is explicitly enabled for that server.
- Server stderr is captured in a bounded buffer and surfaced on startup failure, making broken stdio registrations diagnosable without flooding output.
- `--dry-run` validates and prints a tool request without invoking it; there is deliberately no `--yes` / auto-approve execution flag.

## Twenty concrete improvements

This release implements the following specific changes, rather than relying on a broad quality claim:

1. **Fixed the Linux-breaking `resultBuffer` filename/import case mismatch** and added a regression-tested result path parser.
2. **Added Ctrl+Backspace, Alt/Option+Backspace, and Ctrl+W word deletion** to text and fuzzy-search prompts.
3. **Made root, command, and version help fast-paths**, avoiding heavy MCP imports for help.
4. **Replaced terse help with contextual command help**, examples, safety notes, and keyboard guidance.
5. **Made sessions lazy by default**, so startup does not serially connect every registration.
6. **Added a bounded, fingerprinted tool-metadata cache** for fast startup and offline inspection.
7. **Revalidate cached schemas before a session call** and invalidate them on MCP tool-list-change notifications.
8. **Deduplicated simultaneous session connections** so one server creates at most one in-flight child process.
9. **Bounded paginated `tools/list` responses** to reject repeated cursors and pathological tool counts.
10. **Added connect/list/call deadlines and jittered transient retries**, so one dead server does not stall the CLI indefinitely.
11. **Made `doctor` concurrent, timed, JSON-capable, and CI-meaningful** with a non-zero status on failure.
12. **Hardened configuration writes** with directory creation before locking, stale-lock recovery, atomic renames, and restrictive permissions.
13. **Added portable config locations** through `MCP_DEV_CONFIG_DIR` and `MCP_DEV_CONFIG_PATH`.
14. **Added shell-like argument parsing and non-interactive registration flags** without running a shell.
15. **Added cached dynamic completion for tool names** so tab completion does not start servers or contact endpoints.
16. **Added `--args`, `--args-file`, and `--dry-run`** for reproducible direct calls while retaining approval.
17. **Improved argument UX and correctness** with direct dependencies, JSON Schema validation, typed enums, optional booleans, constraints, and retries.
18. **Closed the session confirmation gap**: palette and `/call` tool invocations now require the same explicit approval as one-shot calls.
19. **Fixed agent tool namespace dispatch** so encoded model tool IDs resolve back to the original server/tool names; agent results now enter the result buffer.
20. **Added safer remote-server controls**: URL redaction, safe list JSON, `${ENV}` headers, opt-in MCP sampling, and bounded server-stderr diagnostics.

## Development

```bash
npm ci
npm test
npm run check
npm run smoke
```

The test suite covers quoted argument parsing, configuration safety, fast help, Ctrl+word-delete behavior, result back-reference paths, schema validation, agent tool-name dispatch, and bounded tool pagination.
