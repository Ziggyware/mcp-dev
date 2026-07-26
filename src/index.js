#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { Command } from "commander";
import inquirer from "inquirer";
import { addServer, removeServer, listServers, getServer, CONFIG_PATH_EXPORT } from "./config.js";
import {
  connectServer,
  connectServerWithRetry,
  listTools,
  callTool,
  closeAllClients,
  closeClient,
  withCancellation,
  withTimeout,
} from "./mcpClient.js";
import { promptForArgs, runAgentTurn, CANCELLED } from "./suggest.js";
import { startSession } from "./session.js";
import { colors, style } from "./colors.js";
import { generateCompletionScript } from "./completion.js";

const program = new Command();
program.name("mcp-dev").description("Local CLI agent for calling your registered MCP servers").version("0.1.0");

function withCleanup(action) {
  return async (...args) => {
    try {
      await action(...args);
    } catch (err) {
      console.error(err.message ?? String(err));
      await closeAllClients();
      process.exit(1);
    }
  };
}

program
  .command("register <name>")
  .description("Register a new MCP server (stdio or HTTP)")
  .action(async (name) => {
    // Improvement 4: reject duplicate registration up front instead of
    // silently overwriting. [derived: follows from addServer previously
    // doing an unconditional `cfg.servers[name] = entry`] Overwriting a
    // working server config with a typo'd re-registration was previously
    // unrecoverable except by remembering the old values. Now requires
    // explicit --force or interactive confirm.
    const existing = getServer(name);
    if (existing) {
      const { overwrite } = await inquirer.prompt([
        { type: "confirm", name: "overwrite", message: `"${name}" is already registered. Overwrite?`, default: false },
      ]);
      if (!overwrite) {
        console.log(style.muted("Cancelled."));
        return;
      }
    }

    const { transport } = await inquirer.prompt([
      { type: "list", name: "transport", message: "Transport:", choices: ["stdio", "http"] },
    ]);

    if (transport === "http") {
      const { url, root } = await inquirer.prompt([
        { type: "input", name: "url", message: "Server URL:" },
        { type: "input", name: "root", message: "Filesystem root to advertise via MCP roots (blank = none):", default: "" },
      ]);
      addServer(name, { url, root: root.trim() || undefined });
    } else {
      const { command, args, cwd, root, envVars, inheritEnv } = await inquirer.prompt([
        { type: "input", name: "command", message: "Command to launch server (e.g. node, python3, npx):" },
        { type: "input", name: "args", message: "Arguments (space-separated):", default: "" },
        { type: "input", name: "cwd", message: "Working directory (blank = current):", default: "" },
        { type: "input", name: "root", message: "Filesystem root to advertise via MCP roots (blank = cwd):", default: "" },
        { type: "input", name: "envVars", message: "Extra env vars (KEY=VALUE, comma-separated, blank = none):", default: "" },
        { type: "confirm", name: "inheritEnv", message: "Inherit your full shell environment? (exposes it to the server process)", default: false },
      ]);

      const env = {};
      for (const pair of envVars.split(",").map((s) => s.trim()).filter(Boolean)) {
        const eq = pair.indexOf("=");
        if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }

      addServer(name, {
        command,
        args: args.trim() ? args.trim().split(/\s+/) : [],
        cwd: cwd.trim() || undefined,
        root: root.trim() || undefined,
        env: Object.keys(env).length ? env : undefined,
        inheritEnv,
      });
    }
    console.log(`Registered "${name}". Config: ${CONFIG_PATH_EXPORT}`);
  });

program
  .command("unregister <name>")
  .description("Remove a registered server")
  .action((name) => {
    const existing = getServer(name);
    if (!existing) {
      console.error(style.error(`No server named "${name}".`));
      process.exitCode = 1;
      return;
    }
    removeServer(name);
    console.log(`Removed "${name}".`);
  });

program
  .command("list")
  .description("List registered servers")
  .option("--plain", "print one server name per line, for scripting/completion")
  .action((opts) => {
    const servers = listServers();
    const names = Object.keys(servers);

    if (opts.plain) {
      for (const n of names) console.log(n);
      return;
    }

    if (names.length === 0) {
      console.log(style.muted("No servers registered. Use `mcp-dev register <name>`."));
      return;
    }
    for (const n of names) {
      const e = servers[n];
      console.log(`${style.serverName(n)}: ${style.muted(e.url ?? `${e.command} ${(e.args ?? []).join(" ")}`)}`);
    }
  });

program
  .command("tools <server>")
  .description("List available tools + parameter schemas on a registered server")
  .action(withCleanup(async (server) => {
    const entry = getServer(server);
    if (!entry) return fail(`No server named "${server}". Run \`mcp-dev list\`.`);
    const client = await connectServerWithRetry(server, entry);
    const tools = await listTools(client);
    for (const t of tools) {
      console.log(`\n${style.toolName(t.name)}${t.description ? " " + style.muted("- " + t.description) : ""}`);
      const props = t.inputSchema?.properties ?? {};
      const required = new Set(t.inputSchema?.required ?? []);
      for (const [k, s] of Object.entries(props)) {
        const marker = required.has(k) ? style.required("*") : "";
        console.log(`  - ${colors.cyan(k)}${marker}: ${style.muted(s.type ?? "any")}${s.description ? style.muted(" - " + s.description) : ""}`);
      }
    }
    await closeAllClients();
    process.exit(0);
  }));

program
  .command("call <server> <tool>")
  .description("Call a tool, with prompts guiding you through its parameters")
  .action(withCleanup(async (server, toolName) => {
    const entry = getServer(server);
    if (!entry) return fail(`No server named "${server}". Run \`mcp-dev list\`.`);
    const client = await connectServerWithRetry(server, entry);
    const tools = await listTools(client);
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      await closeAllClients();
      return fail(`No tool "${toolName}" on "${server}". Run \`mcp-dev tools ${server}\`.`);
    }

    const args = await promptForArgs(tool.inputSchema);
    if (args === CANCELLED) {
      await closeAllClients();
      return process.exit(1);
    }
    if (!(await confirm(toolName, args))) {
      await closeAllClients();
      return process.exit(0);
    }

    const result = await withCancellation((signal) => callTool(client, toolName, args, { signal }))();
    printResult(result);
    await closeAllClients();
    process.exit(0);
  }));

program
  .command("ask <query...>")
  .description("Describe what you want in plain language; an LLM drives a multi-step tool loop, confirming each call, until it has a final answer. Requires ANTHROPIC_API_KEY.")
  .option("-s, --server <name>", "restrict to one registered server")
  .action(withCleanup(async (queryParts, opts) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return fail("Set ANTHROPIC_API_KEY to use `ask`. Use `mcp-dev call` for schema-guided prompts without it.");

    const query = queryParts.join(" ");
    const servers = opts.server ? { [opts.server]: getServer(opts.server) } : listServers();
    if (opts.server && !servers[opts.server]) return fail(`No server named "${opts.server}".`);

    const clients = {};
    let allTools = [];
    // Improvement 5: partial-connect tolerance. Previously a single
    // unreachable server in `ask` (no -s restriction) aborted the entire
    // command via withCleanup's catch, even though N-1 other servers had
    // already connected successfully. Now: connection failures are
    // collected and reported, and the agent loop proceeds with whatever
    // tool set is actually available.
    const connectErrors = [];
    for (const [name, entry] of Object.entries(servers)) {
      try {
        const client = await connectServerWithRetry(name, entry);
        clients[name] = client;
        const tools = await listTools(client);
        allTools.push(...tools.map((t) => ({ ...t, __server: name })));
      } catch (err) {
        connectErrors.push(`${name}: ${err.message}`);
      }
    }
    if (connectErrors.length > 0) {
      console.error(style.warning(`Some servers failed to connect:\n  ${connectErrors.join("\n  ")}`));
    }
    if (allTools.length === 0) {
      await closeAllClients();
      return fail("No tools available across registered servers.");
    }

    allTools.sort((a, b) => a.__server.localeCompare(b.__server) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    
    const result = await runAgentTurn({
      messages: [],
      tools: allTools,
      apiKey,
      userQuery: query,
      confirmTool: async (serverName, toolName, args) => {
        console.log(`\nModel wants to call ${toolName} on "${serverName}" with:`);
        console.log(JSON.stringify(args, null, 2));
        const { ok } = await inquirer.prompt([{ type: "confirm", name: "ok", message: "Allow?", default: true }]);
        return ok;
      },
      executeTool: async (serverName, toolName, args, { signal } = {}) => callTool(clients[serverName], toolName, args, { signal }),
    });

    console.log();
    if (result.text.startsWith("[stopped after")) console.log(style.warning(result.text));
    await closeAllClients();
    process.exit(0);
  }));

program
  .command("session")
  .description("Start an interactive session: connections and `ask` conversation history persist across commands until you exit")
  .action(withCleanup(async () => {
    await startSession();
    process.exit(0);
  }));

program
  .command("doctor")
  .description("Connect to every registered server, count its tools, and disconnect -- without executing any tool")
  .option("-t, --timeout <ms>", "per-server connect/listTools timeout in milliseconds", "5000")
  .action(withCleanup(async (opts) => {
    const timeoutMs = Number(opts.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fail(`Invalid --timeout "${opts.timeout}"`);

    const servers = listServers();
    const names = Object.keys(servers);
    if (names.length === 0) {
      console.log(style.muted("No servers registered."));
      return process.exit(0);
    }

    let anyFailed = false;
    for (const name of names) {
      const entry = servers[name];
      const start = performance.now();
      const connectPromise = connectServer(name, entry);
      try {
        const client = await withTimeout(connectPromise, timeoutMs, `connect timed out after ${timeoutMs}ms`);
        const tools = await withTimeout(listTools(client), timeoutMs, `listTools timed out after ${timeoutMs}ms`);
        const elapsedMs = Math.round(performance.now() - start);
        await closeClient(client);
        console.log(`${style.success("✓")} ${name.padEnd(20)} ${String(tools.length).padStart(3)} tool(s)   ${elapsedMs}ms`);
      } catch (err) {
        anyFailed = true;
        const elapsedMs = Math.round(performance.now() - start);
        connectPromise.then((c) => closeClient(c)).catch(() => {});
        console.log(`${style.error("✗")} ${name.padEnd(20)}             ${elapsedMs}ms   ${err.message}`);
      }
    }
    // Improvement 6: non-zero exit code when any server fails doctor
    // checks. Previously `doctor` always exited 0 regardless of failures,
    // making it unusable as a CI/script health gate -- failure was only
    // visible by parsing colored text output.
    process.exit(anyFailed ? 1 : 0);
  }));

program
  .command("completion <shell>")
  .description("Generate a shell completion script (bash, zsh, or pwsh) — dynamic server names are resolved at completion time via `mcp-dev list --plain`, not baked in here")
  .action(withCleanup(async (shell) => {
    process.stdout.write(generateCompletionScript(shell));
  }));

function printResult(result) {
  const text = (result.content ?? [])
    .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
    .join("\n");
  console.log(`\n${style.heading("--- result ---")}`);
  console.log(text || style.muted(JSON.stringify(result, null, 2)));
}

async function confirm(toolName, args) {
  console.log(`\n${style.heading("About to call")} ${style.toolName(toolName)} ${style.muted("with")}`);
  console.log(style.muted(JSON.stringify(args, null, 2)));
  const { ok } = await inquirer.prompt([{ type: "confirm", name: "ok", message: "Proceed?", default: true }]);
  return ok;
}

function fail(msg) {
  console.error(style.error(msg));
  closeAllClients().finally(() => process.exit(1));
}

program.parseAsync(process.argv);