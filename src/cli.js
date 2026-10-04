import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { Command } from "commander";
import { parseCommandArguments, parseEnvAssignments, parseJson } from "./args.js";
import { style } from "./colors.js";
import { generateCompletionScript } from "./completion.js";
import { renderHelp, VERSION } from "./help.js";
import { confirm, select, textInput } from "./prompts.js";
import { errorMessage, isPromptExit } from "./runtime.js";
import { formatDuration, isInteractive, redactUrl } from "./terminal.js";
import { cacheTools, getCachedTools, invalidateToolCache } from "./toolCache.js";
import { formatTools, toolNames } from "./toolDisplay.js";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 8_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_ARGS_FILE_BYTES = 1024 * 1024;

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be a positive integer, received "${value}".`);
  }
  return parsed;
}

function collect(value, previous = []) {
  return [...previous, value];
}

function compactTarget(entry) {
  if (entry.url) return redactUrl(entry.url);
  const count = entry.args?.length ?? 0;
  return `${entry.command}${count ? ` (${count} arg${count === 1 ? "" : "s"})` : ""}`;
}

function serverSummary(name, entry) {
  return {
    name,
    transport: entry.url ? "http" : "stdio",
    target: entry.url ? redactUrl(entry.url) : entry.command,
    args: entry.url ? undefined : entry.args?.length ?? 0,
    cwd: entry.cwd,
    root: entry.root,
    description: entry.description,
    allowSampling: Boolean(entry.allowSampling),
  };
}

async function closeClientsQuietly() {
  try {
    const { closeAllClients } = await import("./mcpClient.js");
    await closeAllClients();
  } catch { /* Preserve the original command failure. */ }
}

function withCleanup(action) {
  return async (...args) => {
    try {
      return await action(...args);
    } catch (error) {
      if (isPromptExit(error)) {
        console.error(style.muted("Cancelled."));
      } else {
        console.error(style.error(errorMessage(error)));
      }
      await closeClientsQuietly();
      process.exitCode = 1;
      return undefined;
    }
  };
}

function assertOneOf(opts, keys) {
  const present = keys.filter((key) => opts[key] !== undefined && opts[key] !== false);
  if (present.length > 1) throw new Error(`Use only one of ${present.map((key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`).join(", ")}.`);
}

function mergeAssignments(values = []) {
  return Object.assign({}, ...values.map((value) => parseEnvAssignments(value)));
}

function trimOptional(value) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

async function confirmCall(server, tool, args) {
  console.log(`\n${style.heading("About to call")} ${style.serverName(server)}/${style.toolName(tool)}`);
  console.log(style.muted(JSON.stringify(args, null, 2)));
  return confirm({ message: "Proceed?", default: true });
}

async function withAbortableTimeout(action, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  const onSigint = () => controller.abort(new Error("Cancelled by user (SIGINT)"));
  process.once("SIGINT", onSigint);
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", onSigint);
  }
}

function parseArgumentsObject(text, label) {
  const parsed = parseJson(text, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function readArgumentsFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Arguments file "${filePath}" is not a regular file.`);
  if (stat.size > MAX_ARGS_FILE_BYTES) throw new Error(`Arguments file is larger than ${MAX_ARGS_FILE_BYTES / 1024} KiB.`);
  return parseArgumentsObject(fs.readFileSync(filePath, "utf8"), `Arguments file "${filePath}"`);
}

async function interactiveRegistration(name) {
  const transport = await select({
    message: "Transport:",
    choices: [
      { value: "stdio", name: "stdio — launch a local process" },
      { value: "http", name: "http — connect to a Streamable HTTP endpoint" },
    ],
  });
  const description = trimOptional(await textInput({ message: "Short description (optional):" }));

  if (transport === "http") {
    const url = await textInput({ message: "Server URL:", validate: (value) => /^https?:\/\//i.test(value.trim()) ? true : "Enter an http:// or https:// URL." });
    const root = trimOptional(await textInput({ message: "Filesystem root to advertise (optional):" }));
    const headersInput = trimOptional(await textInput({ message: "Extra headers, KEY=VALUE comma-separated (optional):" }));
    const allowSampling = await confirm({
      message: "Allow this server to request model sampling? (may send server-provided content to your configured provider)",
      default: false,
    });
    return { url: url.trim(), root, description, headers: headersInput ? parseEnvAssignments(headersInput) : undefined, allowSampling };
  }

  const command = await textInput({ message: "Command to launch server:", validate: (value) => value.trim() ? true : "A command is required." });
  const argsText = await textInput({ message: "Arguments (quotes supported):" });
  const cwd = trimOptional(await textInput({ message: "Working directory (optional):" }));
  const root = trimOptional(await textInput({ message: "Filesystem root to advertise (optional):" }));
  const envInput = trimOptional(await textInput({ message: "Extra env, KEY=VALUE comma-separated (optional):" }));
  const inheritEnv = await confirm({ message: "Inherit your full shell environment?", default: false });
  const allowSampling = await confirm({
    message: "Allow this server to request model sampling? (may send server-provided content to your configured provider)",
    default: false,
  });
  return {
    command: command.trim(),
    args: parseCommandArguments(argsText),
    cwd,
    root,
    description,
    env: envInput ? parseEnvAssignments(envInput) : undefined,
    inheritEnv,
    allowSampling,
  };
}

async function registrationFromOptions(opts) {
  const hasUrl = Boolean(opts.url);
  const hasCommand = Boolean(opts.command);
  if (hasUrl && hasCommand) throw new Error("Choose either --url or --command, not both.");
  if (!hasUrl && !hasCommand) return null;

  if (hasUrl) {
    if ((opts.arg?.length ?? 0) || opts.args || opts.cwd || opts.env?.length || opts.inheritEnv) {
      throw new Error("stdio-only options (--arg, --args, --cwd, --env, --inherit-env) cannot be used with --url.");
    }
    return {
      url: opts.url,
      root: trimOptional(opts.root),
      description: trimOptional(opts.description),
      headers: Object.keys(mergeAssignments(opts.header)).length ? mergeAssignments(opts.header) : undefined,
      allowSampling: Boolean(opts.allowSampling),
    };
  }

  if (opts.header?.length) throw new Error("--header is only valid with --url.");
  const parsedArgs = opts.args ? parseCommandArguments(opts.args) : [];
  return {
    command: opts.command,
    args: [...(opts.arg ?? []), ...parsedArgs],
    cwd: trimOptional(opts.cwd),
    root: trimOptional(opts.root),
    description: trimOptional(opts.description),
    env: Object.keys(mergeAssignments(opts.env)).length ? mergeAssignments(opts.env) : undefined,
    inheritEnv: Boolean(opts.inheritEnv),
    allowSampling: Boolean(opts.allowSampling),
  };
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      try {
        results[index] = { status: "fulfilled", value: await mapper(values[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runCli(argv = process.argv) {
  const program = new Command();
  program
    .name("mcp-dev")
    .description("Fast, approval-first CLI for registered MCP servers")
    .version(VERSION)
    .showSuggestionAfterError();

  program
    .command("register <name>")
    .description("Register a stdio or Streamable HTTP server")
    .option("--url <url>", "Streamable HTTP endpoint")
    .option("--command <command>", "stdio command")
    .option("--arg <value>", "one stdio argument (repeatable)", collect, [])
    .option("--args <text>", "quoted stdio arguments")
    .option("--cwd <path>", "stdio working directory")
    .option("--root <path>", "MCP filesystem root")
    .option("--env <KEY=VALUE>", "environment assignment (repeatable)", collect, [])
    .option("--header <KEY=VALUE>", "HTTP header (repeatable)", collect, [])
    .option("--description <text>", "short description")
    .option("--inherit-env", "inherit the full shell environment")
    .option("--allow-sampling", "allow server-initiated model sampling")
    .option("--force", "replace an existing registration")
    .action(withCleanup(async (name, opts) => {
      const { addServer, CONFIG_PATH_EXPORT, getServer } = await import("./config.js");
      const { invalidateToolCache } = await import("./toolCache.js");
      const existing = getServer(name);
      if (existing && !opts.force) {
        if (!isInteractive()) throw new Error(`"${name}" is already registered. Re-run with --force to replace it.`);
        if (!(await confirm({ message: `"${name}" is already registered. Replace it?`, default: false }))) {
          console.log(style.muted("Cancelled."));
          return;
        }
      }
      const supplied = await registrationFromOptions(opts);
      if (!supplied && !isInteractive()) {
        throw new Error("Non-interactive registration requires --url or --command. Run `mcp-dev help register` for examples.");
      }
      const entry = supplied ?? await interactiveRegistration(name);
      addServer(name, entry);
      invalidateToolCache(name);
      console.log(style.success(`Registered "${name}".`));
      console.log(style.muted(`Config: ${CONFIG_PATH_EXPORT}`));
    }));

  program
    .command("unregister <name>")
    .description("Remove a registered server")
    .option("--force", "do not ask for confirmation")
    .action(withCleanup(async (name, opts) => {
      const { getServer, removeServer } = await import("./config.js");
      const { invalidateToolCache } = await import("./toolCache.js");
      if (!getServer(name)) throw new Error(`No server named "${name}". Run \`mcp-dev list\`.`);
      if (!opts.force) {
        if (!isInteractive()) throw new Error("Refusing to delete non-interactively without --force.");
        if (!(await confirm({ message: `Remove "${name}"?`, default: false }))) {
          console.log(style.muted("Cancelled."));
          return;
        }
      }
      removeServer(name);
      invalidateToolCache(name);
      console.log(style.success(`Removed "${name}".`));
    }));

  program
    .command("list")
    .description("List registered servers")
    .option("--plain", "print one server name per line")
    .option("--json", "print a machine-readable safe summary")
    .action(withCleanup(async (opts) => {
      assertOneOf(opts, ["plain", "json"]);
      const { listServers } = await import("./config.js");
      const servers = listServers();
      const entries = Object.entries(servers);
      if (opts.plain) {
        for (const [name] of entries) console.log(name);
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(entries.map(([name, entry]) => serverSummary(name, entry)), null, 2));
        return;
      }
      if (!entries.length) {
        console.log(style.muted("No servers registered. Start with `mcp-dev register <name>`."));
        return;
      }
      for (const [name, entry] of entries) {
        console.log(`${style.serverName(name)}  ${style.muted(compactTarget(entry))}${entry.description ? style.muted(` — ${entry.description}`) : ""}${entry.allowSampling ? ` ${style.warning("[sampling]")}` : ""}`);
      }
    }));

  program
    .command("tools <server>")
    .description("List tools and readable input schemas")
    .option("--json", "print raw MCP tool definitions")
    .option("--plain", "print only tool names")
    .option("--cached", "read local metadata only; do not connect")
    .option("-t, --timeout <ms>", "connection/list timeout in milliseconds", String(DEFAULT_DISCOVERY_TIMEOUT_MS))
    .action(withCleanup(async (server, opts) => {
      assertOneOf(opts, ["json", "plain"]);
      const timeoutMs = positiveNumber(opts.timeout, "--timeout");
      const { getServer } = await import("./config.js");
      const entry = getServer(server);
      if (!entry) throw new Error(`No server named "${server}". Run \`mcp-dev list\`.`);

      let tools;
      if (opts.cached) {
        const cached = getCachedTools(server, entry, { allowStale: true });
        if (!cached) throw new Error(`No cached tools for "${server}". Run \`mcp-dev tools ${server}\` once to fetch them.`);
        tools = cached.tools;
        if (!opts.plain && !opts.json) console.log(style.muted(`Using ${cached.stale ? "stale " : ""}cached metadata (${formatDuration(cached.ageMs)} old).`));
      } else {
        const { closeClient, connectServerWithRetry, listTools, withTimeout } = await import("./mcpClient.js");
        let client;
        try {
          client = await connectServerWithRetry(server, entry, { timeoutMs });
          tools = await withTimeout(
            listTools(client, { timeout: timeoutMs, maxTotalTimeout: timeoutMs }),
            timeoutMs,
            `Listing tools for "${server}" timed out after ${timeoutMs}ms`
          );
          cacheTools(server, entry, tools);
        } finally {
          await closeClient(client).catch(() => {});
        }
      }

      if (opts.plain) process.stdout.write(toolNames(tools));
      else if (opts.json) console.log(JSON.stringify(tools, null, 2));
      else console.log(formatTools(tools));
    }));

  program
    .command("call <server> <tool>")
    .description("Call one tool with guided arguments and approval")
    .option("--args <json>", "complete JSON arguments object")
    .option("--args-file <path>", "file containing complete JSON arguments")
    .option("--json", "print raw MCP result")
    .option("--dry-run", "validate and display arguments without calling")
    .option("--no-pager", "never page long result output")
    .option("-t, --timeout <ms>", "tool request timeout in milliseconds", String(DEFAULT_CALL_TIMEOUT_MS))
    .action(withCleanup(async (server, toolName, opts) => {
      assertOneOf(opts, ["args", "argsFile"]);
      const timeoutMs = positiveNumber(opts.timeout, "--timeout");
      const [{ getServer }, { closeClient, connectServerWithRetry, listTools }, { promptForArgs, CANCELLED, validateArguments }, { renderResult }] = await Promise.all([
        import("./config.js"),
        import("./mcpClient.js"),
        import("./suggest.js"),
        import("./render.js"),
      ]);
      const entry = getServer(server);
      if (!entry) throw new Error(`No server named "${server}". Run \`mcp-dev list\`.`);
      let client;
      try {
        client = await connectServerWithRetry(server, entry, { timeoutMs });
        const tools = await withAbortableTimeout(
          (signal) => listTools(client, { signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs }),
          timeoutMs,
          `Tool discovery for "${server}"`
        );
        cacheTools(server, entry, tools);
        const tool = tools.find((item) => item.name === toolName);
        if (!tool) throw new Error(`No tool "${toolName}" on "${server}". Run \`mcp-dev tools ${server}\`.`);

        let args;
        if (opts.args !== undefined) args = parseArgumentsObject(opts.args, "--args");
        else if (opts.argsFile !== undefined) args = readArgumentsFile(opts.argsFile);
        else args = await promptForArgs(tool.inputSchema);
        if (args === CANCELLED) {
          console.log(style.muted("Cancelled."));
          return;
        }
        const validation = validateArguments(tool.inputSchema, args);
        if (!validation.valid) throw new Error(`Arguments fail schema validation:\n${validation.errors.map((error) => `  ${error}`).join("\n")}`);

        if (opts.dryRun) {
          console.log(style.heading("Validated tool call (dry run)"));
          console.log(JSON.stringify({ server, tool: toolName, arguments: args }, null, 2));
          return;
        }
        if (!(await confirmCall(server, toolName, args))) {
          console.log(style.muted("Cancelled."));
          return;
        }
        const result = await withAbortableTimeout(
          (signal) => client.callTool({ name: toolName, arguments: args }, undefined, {
            signal,
            timeout: timeoutMs,
            maxTotalTimeout: timeoutMs,
          }),
          timeoutMs,
          `Tool call ${server}/${toolName}`
        );
        renderResult(result, { json: opts.json, pager: opts.pager });
        if (result.isError) process.exitCode = 1;
      } finally {
        await closeClient(client).catch(() => {});
      }
    }));

  program
    .command("ask <query...>")
    .description("Ask an approval-gated agent to use server tools")
    .option("-s, --server <name>", "restrict to one server")
    .action(withCleanup(async (queryParts, opts) => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY to use `ask`. Use `mcp-dev call` for direct tool prompts.");
      const [{ getServer, listServers }, { callTool, closeAllClients, connectServerWithRetry, listTools, withTimeout }, { runAgentTurn }] = await Promise.all([
        import("./config.js"),
        import("./mcpClient.js"),
        import("./suggest.js"),
      ]);
      const registered = opts.server ? { [opts.server]: getServer(opts.server) } : listServers();
      if (opts.server && !registered[opts.server]) throw new Error(`No server named "${opts.server}".`);
      const clients = new Map();
      const failures = [];
      const allTools = [];
      try {
        await Promise.all(Object.entries(registered).map(async ([name, entry]) => {
          try {
            const client = await connectServerWithRetry(name, entry, { timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS });
            clients.set(name, client);
            const tools = await withTimeout(
              listTools(client, { timeout: DEFAULT_DISCOVERY_TIMEOUT_MS, maxTotalTimeout: DEFAULT_DISCOVERY_TIMEOUT_MS }),
              DEFAULT_DISCOVERY_TIMEOUT_MS,
              `Listing tools for "${name}" timed out`
            );
            cacheTools(name, entry, tools);
            allTools.push(...tools.map((tool) => ({ ...tool, __server: name })));
          } catch (error) {
            failures.push({ name, message: error.message });
          }
        }));
        if (failures.length) {
          console.error(style.warning(`Some servers were skipped:\n${failures.sort((a, b) => a.name.localeCompare(b.name)).map((failure) => `  ${failure.name}: ${failure.message}`).join("\n")}`));
        }
        if (!allTools.length) throw new Error("No tools are available across registered servers.");
        allTools.sort((a, b) => a.__server.localeCompare(b.__server) || a.name.localeCompare(b.name, undefined, { numeric: true }));
        const result = await runAgentTurn({
          messages: [],
          tools: allTools,
          apiKey,
          userQuery: queryParts.join(" "),
          confirmTool: (server, tool, args) => confirmCall(server, tool, args),
          executeTool: (server, tool, args, { signal } = {}) => callTool(clients.get(server), tool, args, {
            signal,
            timeout: DEFAULT_CALL_TIMEOUT_MS,
            maxTotalTimeout: DEFAULT_CALL_TIMEOUT_MS,
          }),
        });
        if (result.text.startsWith("[stopped after")) console.log(style.warning(result.text));
      } finally {
        await closeAllClients();
      }
    }));

  program
    .command("session")
    .description("Start a persistent, lazy-loading interactive workspace")
    .option("--warm", "pre-connect and refresh every server")
    .action(withCleanup(async (opts) => {
      const { startSession } = await import("./session.js");
      await startSession({ warm: Boolean(opts.warm) });
    }));

  program
    .command("doctor")
    .description("Health-check every server without calling tools")
    .option("-t, --timeout <ms>", "per-server timeout in milliseconds", "5000")
    .option("-j, --concurrency <count>", "parallel server checks", "4")
    .option("--json", "print a machine-readable report")
    .action(withCleanup(async (opts) => {
      const timeoutMs = positiveNumber(opts.timeout, "--timeout");
      const concurrency = positiveNumber(opts.concurrency, "--concurrency");
      const [{ listServers }, { closeClient, connectServer, listTools, withTimeout }] = await Promise.all([
        import("./config.js"),
        import("./mcpClient.js"),
      ]);
      const servers = listServers();
      const names = Object.keys(servers);
      if (!names.length) {
        if (opts.json) console.log("[]");
        else console.log(style.muted("No servers registered."));
        return;
      }
      const outcomes = await mapWithConcurrency(names, concurrency, async (name) => {
        const started = performance.now();
        let client;
        try {
          client = await connectServer(name, servers[name], { timeoutMs });
          const tools = await withTimeout(
            listTools(client, { timeout: timeoutMs, maxTotalTimeout: timeoutMs }),
            timeoutMs,
            `Listing tools timed out after ${timeoutMs}ms`
          );
          cacheTools(name, servers[name], tools);
          return { name, ok: true, tools: tools.length, elapsedMs: Math.round(performance.now() - started) };
        } catch (error) {
          return { name, ok: false, tools: 0, elapsedMs: Math.round(performance.now() - started), error: error.message };
        } finally {
          await closeClient(client).catch(() => {});
        }
      });
      const report = outcomes.map((outcome, index) => outcome.status === "fulfilled"
        ? outcome.value
        : { name: names[index], ok: false, tools: 0, elapsedMs: 0, error: outcome.reason?.message ?? String(outcome.reason) });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        for (const item of report) {
          const prefix = item.ok ? style.success("✓") : style.error("✗");
          const count = item.ok ? `${String(item.tools).padStart(3)} tool${item.tools === 1 ? " " : "s"}` : "       ";
          console.log(`${prefix} ${item.name.padEnd(24)} ${count}  ${formatDuration(item.elapsedMs)}${item.error ? `  ${style.muted(item.error)}` : ""}`);
        }
      }
      if (report.some((item) => !item.ok)) process.exitCode = 1;
    }));

  program
    .command("completion <shell>")
    .description("Generate bash, zsh, or PowerShell completion")
    .action(withCleanup(async (shell) => {
      process.stdout.write(generateCompletionScript(shell));
    }));

  program
    .command("help [command]")
    .description("Show focused help without loading MCP clients")
    .action((command) => {
      process.stdout.write(`${renderHelp(command)}\n`);
    });

  await program.parseAsync(argv);
}
