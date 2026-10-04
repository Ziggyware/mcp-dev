// Minimal stdio MCP server used by the integration tests. It exposes tools
// that are cheap, deterministic, and cover the argument-form shapes: string,
// number, enum, boolean, array, and object.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "1.0.0" });

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

server.registerTool(
  "echo",
  {
    description: "Echo the provided text",
    inputSchema: { text: z.string().describe("text to echo back"), times: z.number().int().min(1).optional() },
  },
  async ({ text: value, times = 1 }) => text(Array.from({ length: times }, () => value).join(" "))
);

server.registerTool(
  "list_dir",
  {
    description: "List a directory (fixture: returns the path it was given)",
    inputSchema: { path: z.string().describe("directory path") },
  },
  async ({ path: target }) => text({ path: target, entries: [{ name: "a.txt", size: 12 }, { name: "b", type: "directory" }] })
);

server.registerTool(
  "shape",
  {
    description: "Exercise every argument shape",
    inputSchema: {
      label: z.string(),
      mode: z.enum(["fast", "slow"]),
      verbose: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      options: z.object({ limit: z.number().optional() }).optional(),
    },
  },
  async (args) => text(args)
);

server.registerTool(
  "boom",
  { description: "Always fails, to exercise error rendering", inputSchema: {} },
  async () => ({ isError: true, content: [{ type: "text", text: "expected failure" }] })
);

await server.connect(new StdioServerTransport());
