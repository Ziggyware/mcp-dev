#!/usr/bin/env node
import { fastHelpRequest, renderHelp, VERSION } from "./help.js";
import { installRuntimeGuards } from "./runtime.js";

installRuntimeGuards();

// Help and version are intentionally handled before importing Commander, the
// MCP SDK, prompt rendering, or provider clients. This keeps `--help` nearly
// instant, including on a fresh shell with many registered servers.
const quick = fastHelpRequest(process.argv.slice(2));
if (quick?.type === "version") {
  process.stdout.write(`${VERSION}\n`);
} else if (quick?.type === "help") {
  process.stdout.write(`${renderHelp(quick.topic)}\n`);
} else {
  try {
    const { runCli } = await import("./cli.js");
    await runCli(process.argv);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
