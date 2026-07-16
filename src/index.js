#!/usr/bin/env node
import { Command } from "commander";
import inquirer from "inquirer";
import { addServer, removeServer, listServers, getServer, CONFIG_PATH_EXPORT } from "./config.js";
import { connectServer, listTools, callTool, closeAllClients } from "./mcpClient.js";
import { promptForArgs, runAgentTurn } from "./suggest.js";
import { startSession } from "./session.js";
import { colors, style } from "./colors.js";

const program = new Command();
program.name("mcp-agent").description("Local CLI agent for calling your registered MCP servers").version("0.1.0");

// Wraps a command action so any thrown error (e.g. connectServer failing
// after earlier servers in the same command already connected) still closes
// every client opened this run before the process exits non-zero. Without
// this, an uncaught throw skips closeAllClients() entirely and any
// stdio-spawned child processes from earlier successful connects are
// orphaned.
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
    const { transport } = await inquirer.prompt([
      { type: "list", name: "transport", message: "Transport:", choices: ["stdio", "http"] },
    ]);

    if (transport === "http") {
      const { url } = await inquirer.prompt([{ type: "input", name: "url", message: "Server URL:" }]);
      addServer(name, { url });
    } else {
      const { command, args, cwd, envVars, inheritEnv } = await inquirer.prompt([
        { type: "input", name: "command", message: "Command to launch server (e.g. node, python3, npx):" },
        { type: "input", name: "args", message: "Arguments (space-separated):", default: "" },
        { type: "input", name: "cwd", message: "Working directory (blank = current):", default: "" },
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
    removeServer(name);
    console.log(`Removed "${name}".`);
  });

program
  .command("list")
  .description("List registered servers")
  .action(() => {
    const servers = listServers();
    const names = Object.keys(servers);
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
    const client = await connectServer(server, entry);
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
    if (!entry) return fail(`No server named "${server}". Run \`mcp-agent list\`.`);
    const client = await connectServer(server, entry);
    const tools = await listTools(client);
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      await closeAllClients();
      return fail(`No tool "${toolName}" on "${server}". Run \`mcp-agent tools ${server}\`.`);
    }

    const args = await promptForArgs(tool.inputSchema);
    if (!(await confirm(toolName, args))) {
      await closeAllClients();
      return process.exit(0);
    }

    const result = await callTool(client, toolName, args);
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
    if (!apiKey) return fail("Set ANTHROPIC_API_KEY to use `ask`. Use `mcp-agent call` for schema-guided prompts without it.");

    const query = queryParts.join(" ");
    const servers = opts.server ? { [opts.server]: getServer(opts.server) } : listServers();
    if (opts.server && !servers[opts.server]) return fail(`No server named "${opts.server}".`);

    const clients = {};
    let allTools = [];
    for (const [name, entry] of Object.entries(servers)) {
      const client = await connectServer(name, entry);
      clients[name] = client;
      const tools = await listTools(client);
      allTools.push(...tools.map((t) => ({ ...t, __server: name })));
    }
    if (allTools.length === 0) {
      await closeAllClients();
      return fail("No tools available across registered servers.");
    }

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
      executeTool: async (serverName, toolName, args) => callTool(clients[serverName], toolName, args),
    });

    console.log(`\n${result.text}`);
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