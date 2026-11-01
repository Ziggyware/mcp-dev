// src/agentHooks.js
//
// The AI-facing MCP service layer: 20 hooks that expose every registered MCP
// service to the model through progressive disclosure instead of one giant
// tool dump.
//
//   Level 1  mcp_services            every service by name
//   Level 2  mcp_tools               every call of one service
//   Level 3  mcp_schema              every parameter + response of one call
//   Execute  mcp_call / mcp_batch    approval-gated invocation
//   Assist   search/suggest/draft/…  the rest of the toolkit
//
// Etiquette: the model discloses the least detail that answers the question,
// never guesses parameter names, and every execution passes the same approval
// gate as a human-typed call. Hooks never bypass it.

import { rankByFuzzy } from "./fuzzy.js";
import { validateArguments } from "./schema.js";

const MAX_HOOK_TEXT = 12_000;
const MAX_BATCH_CALLS = 10;
const MAX_SEARCH_RESULTS = 12;

export const HOOK_PREAMBLE = [
  "You operate MCP services through progressive-disclosure hooks.",
  "Protocol: (1) mcp_services lists every service by name; (2) mcp_tools lists the calls of one service;",
  "(3) mcp_schema shows the full parameters and response of one call. Then execute with mcp_call.",
  "Disclose the least detail that answers the question — start at level 1 and zoom in only as needed.",
  "Never invent service names, call names, or parameter names: fetch the schema when unsure.",
  "Prefer mcp_search/mcp_suggest to jump straight to a candidate, then mcp_validate or mcp_draft before calling.",
  "Reuse prior outputs via mcp_results instead of re-calling services. Every execution asks the user for approval;",
  "a declined call is final — adjust the arguments, explain, or move on.",
].join(" ");

function clip(text, max = MAX_HOOK_TEXT) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [truncated ${value.length - max} characters]`;
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function asName(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`"${label}" is required.`);
  return text;
}

function paramNames(schema) {
  return Object.keys(schema?.properties ?? {});
}

function oneLine(text, max = 110) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolLine(tool) {
  const params = paramNames(tool.inputSchema);
  const hint = params.length ? ` [${params.join(", ")}]` : "";
  const description = tool.description ? ` — ${oneLine(tool.description, 96)}` : "";
  return `${tool.name}${description}${hint}`;
}

function serviceNameMatches(name, needle) {
  return name === needle || name.toLowerCase() === String(needle).toLowerCase();
}

function draftFromSchema(schema, { includeOptional = false } = {}, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 6) return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (Array.isArray(schema.examples) && schema.examples.length) return structuredClone(schema.examples[0]);

  const type = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== "null") ?? schema.type[0] : schema.type;
  if (type === "object" || schema.properties) {
    const out = {};
    const required = new Set(schema.required ?? []);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (!includeOptional && !required.has(name)) continue;
      const value = draftFromSchema(child, { includeOptional }, depth + 1);
      if (value !== null) out[name] = value;
    }
    return out;
  }
  if (type === "array") {
    const item = draftFromSchema(schema.items ?? {}, { includeOptional }, depth + 1);
    return item === null ? [] : [item];
  }
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") {
    if (schema.minimum !== undefined) return schema.minimum;
    if (schema.maximum !== undefined) return schema.maximum;
    return type === "integer" ? 1 : 1.0;
  }
  if (type === "string") {
    if (schema.format === "uri") return "https://example.test/";
    if (schema.format === "date-time") return new Date().toISOString();
    if (schema.format === "date") return new Date().toISOString().slice(0, 10);
    if (schema.format === "email") return "user@example.test";
    if (schema.pattern) return `matches ${schema.pattern}`;
    return "string";
  }
  return null;
}

function schemaPlaceholders(schema, depth = 0) {
  const notes = [];
  if (!schema || depth > 4) return notes;
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const required = (schema.required ?? []).includes(name);
    if (child?.pattern) notes.push(`${name}: must match ${child.pattern}${required ? " (required)" : ""}`);
    if (child?.minLength && child.minLength > String(draftFromSchema(child) ?? "").length) {
      notes.push(`${name}: needs at least ${child.minLength} characters${required ? " (required)" : ""}`);
    }
    notes.push(...schemaPlaceholders(child, depth + 1).map((note) => `${name}.${note}`));
  }
  return notes;
}

function responseEnvelopeNote(tool) {
  if (tool.outputSchema && typeof tool.outputSchema === "object") {
    return `Response schema (outputSchema):\n${clip(JSON.stringify(tool.outputSchema, null, 2), 3500)}`;
  }
  return [
    "Response: this call declares no outputSchema. MCP results arrive as a content envelope:",
    '  { "content": [ { "type": "text", "text": … } | { "type": "resource", … } | … ], "isError"?: true }',
    "Concatenate the text blocks for the payload. Call the tool once (approved) or read a cached",
    "outcome via mcp_results to see the concrete shape.",
  ].join("\n");
}

// --------------------------------------------------------------------- factory

/**
 * Build the 20 MCP hooks over a backend context.
 *
 * @param {object} context
 * @param {() => Record<string, object>} context.servers        registered entries by name
 * @param {(name: string) => Promise<Array>} context.ensureTools  lazily connect + return live/cached tools
 * @param {(server: string, tool: string, args: object, o?: {signal?: AbortSignal}) => Promise<object>} context.callToolFn
 * @param {(server: string, tool: string, args: object) => Promise<boolean>} context.confirm  approval gate
 * @param {(name: string) => Promise<Array>} [context.refresh]  force re-discovery
 * @param {object} [context.resultBuffer]                       session result buffer (backrefs)
 * @param {Array} [context.callLog]                             agent call journal
 * @param {() => Array} [context.history]                       conversation messages
 * @param {(server: string) => Promise<Array>} [context.listResources]
 * @param {(server: string, uri: string) => Promise<object>} [context.readResource]
 * @param {(server: string) => Promise<Array>} [context.listPrompts]
 * @param {(server: string, prompt: string, args?: object) => Promise<object>} [context.getPrompt]
 */
export function createMcpHooks(context) {
  const callLog = context.callLog ?? null;

  async function toolsFor(service) {
    const servers = context.servers();
    const entry = Object.keys(servers).find((name) => serviceNameMatches(name, service));
    if (!entry) {
      const available = Object.keys(servers).join(", ") || "(none registered)";
      throw new Error(`No MCP service named "${service}". Registered: ${available}. Call mcp_services for level-1 names.`);
    }
    const tools = await context.ensureTools(entry);
    if (!tools || !tools.length) throw new Error(`"${entry}" is reachable but reports no calls (tools).`);
    return { server: entry, entry: servers[entry], tools };
  }

  // Cached-first etiquette: when the host exposes a no-connect cache
  // (context.peekTools), discovery surfaces use it and never open a
  // connection just to count or search. Without a cache (one-shot contexts)
  // they fall back to ensureTools, which may connect.
  async function enumerateTools(name, { live = false } = {}) {
    if (!live && context.peekTools) {
      const cached = await context.peekTools(name);
      if (cached?.length) return { tools: cached, cached: true };
    }
    return { tools: (await context.ensureTools(name)) ?? [], cached: false };
  }

  async function resolveTool(service, call) {
    const { server, entry, tools } = await toolsFor(service);
    const tool = tools.find((item) => item.name === String(call ?? "").trim());
    if (!tool) {
      const names = tools.map((item) => item.name).join(", ");
      throw new Error(`No call "${call}" on service "${server}". Available: ${names}. Use mcp_tools for descriptions.`);
    }
    return { server, entry, tools, tool };
  }

  async function executeCall(server, tool, args, { signal } = {}) {
    const started = Date.now();
    let ok = true;
    let error = null;
    try {
      const result = await context.callToolFn(server, tool, args, { signal });
      const index = context.resultBuffer?.push?.({ server, tool, args, mcpResult: result });
      return { result, index };
    } catch (caught) {
      ok = false;
      error = caught;
      throw caught;
    } finally {
      callLog?.push({ at: new Date().toISOString(), server, tool, args, ok, ms: Date.now() - started, error: error?.message });
    }
  }

  const hooks = [];

  // ------------------------------------------------------- level 1: services
  hooks.push({
    name: "mcp_services",
    level: 1,
    description: "LEVEL 1 — list every MCP service by name, with a one-line purpose and call count. Start here; zoom in with mcp_tools.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const servers = context.servers();
      const names = Object.keys(servers);
      if (!names.length) return "No MCP services are registered. Ask the user to run `mcp-dev register <name> …`.";
      const lines = [`MCP services (${names.length}) — level 1:`, ""];
      for (const name of names) {
        const entry = servers[name];
        let detail;
        if (context.peekTools) {
          // A cache is available: level 1 must stay free — never connect for a count.
          const cached = await context.peekTools(name);
          detail = cached ? `${cached.length} calls (cached)` : "not loaded — mcp_tools { service } will load it";
        } else {
          try {
            const tools = await context.ensureTools(name);
            detail = `${tools?.length ?? 0} calls`;
          } catch {
            detail = "unreachable";
          }
        }
        lines.push(`  ${name} — ${oneLine(entry.description ?? "no description", 78)} · ${detail}`);
      }
      lines.push("", "Next: mcp_tools { service } lists one service's calls (level 2).");
      return lines.join("\n");
    },
  });

  // ---------------------------------------------------------- level 2: calls
  hooks.push({
    name: "mcp_tools",
    level: 2,
    description: "LEVEL 2 — list every call (tool) of one MCP service: name, one-line purpose, parameter names. No schemas.",
    input_schema: {
      type: "object",
      properties: { service: { type: "string", description: "service name from mcp_services" } },
      required: ["service"],
      additionalProperties: false,
    },
    async handler(input) {
      const { server, tools } = await toolsFor(asName(input.service, "service"));
      const lines = [`Calls on "${server}" (${tools.length}) — level 2:`, ""];
      for (const tool of tools) lines.push(`  ${toolLine(tool)}`);
      lines.push("", "Next: mcp_schema { service, call } for parameters and responses (level 3).");
      return lines.join("\n");
    },
  });

  // ------------------------------------------- level 3: parameters/responses
  hooks.push({
    name: "mcp_schema",
    level: 3,
    description: "LEVEL 3 — full detail of one call: every parameter (type, required, default, constraints) and the response shape.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "service name" },
        call: { type: "string", description: "call (tool) name from mcp_tools" },
      },
      required: ["service", "call"],
      additionalProperties: false,
    },
    async handler(input) {
      const { server, tool } = await resolveTool(asName(input.service, "service"), asName(input.call, "call"));
      const required = tool.inputSchema?.required ?? [];
      const params = paramNames(tool.inputSchema);
      const lines = [`${server}/${tool.name} — level 3:`, ""];
      lines.push(`Purpose: ${oneLine(tool.description ?? "no description", 200)}`);
      if (params.length) {
        lines.push(`Parameters (${params.length}, required: ${required.length ? required.join(", ") : "none"}):`);
        lines.push(clip(JSON.stringify(tool.inputSchema, null, 2), 6000));
      } else {
        lines.push("Parameters: none — call it with an empty object {}.");
      }
      if (tool.title) lines.push(`Title: ${tool.title}`);
      if (tool.deprecated) lines.push("⚠ deprecated — prefer another call if one exists.");
      lines.push("", responseEnvelopeNote(tool));
      lines.push("", "Next: mcp_validate or mcp_draft the arguments, then mcp_call { service, call, arguments }.");
      return lines.join("\n");
    },
  });

  // -------------------------------------------------------------- execution
  hooks.push({
    name: "mcp_call",
    level: "exec",
    description: "Execute one MCP call. Shown to the user with exact arguments and approval-gated — a declined call must not be retried unchanged.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "service name" },
        call: { type: "string", description: "call (tool) name" },
        arguments: { type: "object", description: "arguments matching the level-3 schema" },
      },
      required: ["service", "call"],
      additionalProperties: false,
    },
    async handler(input, { signal } = {}) {
      const { server, tool } = await resolveTool(asName(input.service, "service"), asName(input.call, "call"));
      const args = asObject(input.arguments);
      const validation = validateArguments(tool.inputSchema, args);
      if (!validation.valid) {
        return {
          content: clip([
            `Arguments for ${server}/${tool.name} fail schema validation — not executed. Fix and re-submit:`,
            ...validation.errors.map((error) => `  - ${error}`),
            "Tip: mcp_draft { service, call } produces a valid skeleton.",
          ].join("\n"), 4000),
          is_error: true,
        };
      }
      const approved = await context.confirm(server, tool.name, args);
      if (!approved) return { content: `The user declined ${server}/${tool.name}. Do not retry it unchanged; adjust the plan or stop.`, is_error: true };
      const { result, index } = await executeCall(server, tool.name, args, { signal });
      const text = (result.content ?? []).map((block) => (block.type === "text" ? block.text : JSON.stringify(block))).join("\n") || JSON.stringify(result);
      const header = `${server}/${tool.name} executed${index ? ` — cached as result #${index} (reuse via mcp_results)` : ""}${result.isError ? " — the call reported isError" : ""}`;
      return { content: clip(`${header}\n\n${text}`), is_error: Boolean(result.isError) };
    },
  });

  hooks.push({
    name: "mcp_batch",
    level: "exec",
    description: `Execute up to ${MAX_BATCH_CALLS} MCP calls in one approved pass. Each call is still shown and approval-gated individually.`,
    input_schema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          minItems: 1,
          maxItems: MAX_BATCH_CALLS,
          items: {
            type: "object",
            properties: {
              service: { type: "string" },
              call: { type: "string" },
              arguments: { type: "object" },
            },
            required: ["service", "call"],
            additionalProperties: false,
          },
          description: "ordered calls; earlier outputs are NOT fed into later arguments — use mcp_call for dependent chains",
        },
        parallel: { type: "boolean", description: "execute approved calls concurrently after all approvals (default: sequential)" },
      },
      required: ["calls"],
      additionalProperties: false,
    },
    async handler(input, { signal } = {}) {
      const calls = Array.isArray(input.calls) ? input.calls : [];
      if (!calls.length) return { content: "mcp_batch needs at least one call.", is_error: true };
      if (calls.length > MAX_BATCH_CALLS) {
        return { content: `mcp_batch accepts at most ${MAX_BATCH_CALLS} calls (received ${calls.length}). Split into batches.`, is_error: true };
      }
      // Approvals are always asked sequentially (the user sees one screen at a
      // time); only execution can be concurrent, and only after every call in
      // the batch has been individually approved.
      const report = new Array(calls.length).fill(null);
      const prepared = [];
      for (const [index, entry] of calls.entries()) {
        const label = `batch[${index}]`;
        try {
          const resolved = await resolveTool(asName(entry.service, `${label}.service`), asName(entry.call, `${label}.call`));
          const args = asObject(entry.arguments);
          const validation = validateArguments(resolved.tool.inputSchema, args);
          if (!validation.valid) {
            report[index] = `${label} ${resolved.server}/${resolved.tool.name}: INVALID — ${validation.errors[0] ?? "schema mismatch"} (skipped)`;
            continue;
          }
          const approved = await context.confirm(resolved.server, resolved.tool.name, args);
          if (!approved) {
            report[index] = `${label} ${resolved.server}/${resolved.tool.name}: declined by the user (skipped)`;
            continue;
          }
          prepared.push({ index, label, server: resolved.server, tool: resolved.tool, args });
        } catch (error) {
          report[index] = `${label}: ${error.message}`;
        }
      }
      const runOne = async (item) => {
        try {
          const { result } = await executeCall(item.server, item.tool.name, item.args, { signal });
          const text = (result.content ?? []).map((block) => (block.type === "text" ? block.text : JSON.stringify(block))).join("\n");
          report[item.index] = `${item.label} ${item.server}/${item.tool.name}: ${result.isError ? "ERROR — " : "ok — "}${oneLine(text, 400)}`;
        } catch (error) {
          report[item.index] = `${item.label} ${item.server}/${item.tool.name}: ${error.message}`;
        }
      };
      if (input.parallel) await Promise.all(prepared.map(runOne));
      else for (const item of prepared) await runOne(item);
      return { content: clip(`Batch report:\n${report.map((line) => `  ${line ?? "skipped"}`).join("\n")}`) };
    },
  });

  // ------------------------------------------------------------- discovery +
  hooks.push({
    name: "mcp_search",
    level: "assist",
    description: "Fuzzy-search every call across all MCP services by name, purpose, or parameter — the fastest route from a keyword to service/call.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "keyword, e.g. \"embed\", \"read file\", \"search\"" },
        limit: { type: "integer", description: `max results (default ${Math.min(8, MAX_SEARCH_RESULTS)})` },
        live: { type: "boolean", description: "force fresh discovery from every service instead of the local cache" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async handler(input) {
      const query = asName(input.query, "query");
      const limit = Math.min(Number(input.limit) || Math.min(8, MAX_SEARCH_RESULTS), MAX_SEARCH_RESULTS);
      const live = Boolean(input.live);
      const servers = context.servers();
      const items = [];
      let cachedHits = 0;
      let serviceCount = 0;
      for (const name of Object.keys(servers)) {
        let tools = [];
        try {
          const enumerated = await enumerateTools(name, { live });
          tools = enumerated.tools;
          if (enumerated.cached) cachedHits += 1;
          if (tools.length) serviceCount += 1;
        } catch {
          continue;
        }
        for (const tool of tools) {
          items.push({
            server: name,
            tool,
            searchText: `${name} ${tool.name} ${tool.description ?? ""} ${paramNames(tool.inputSchema).join(" ")}`,
          });
        }
      }
      if (!items.length) {
        return "No calls are discoverable right now (no reachable or loaded services). Try mcp_services, or ask the user to register one.";
      }
      const ranked = rankByFuzzy(items, query, { key: "searchText", limit }).map(({ item, score }) => ({ item, score }));
      if (!ranked.length) return `No call matches "${query}". Try broader keywords or mcp_services first.`;
      const lines = [`Top ${ranked.length} of ${items.length} calls on ${serviceCount} service${serviceCount === 1 ? "" : "s"} for "${query}"${live ? " (live)" : cachedHits ? " (cached)" : ""}:`, ""];
      for (const { item, score } of ranked) {
        lines.push(`  ${item.server}/${item.tool.name} — ${oneLine(item.tool.description ?? "", 88)} (score ${score})`);
      }
      lines.push("", "Next: mcp_schema { service, call } on a candidate.");
      return lines.join("\n");
    },
  });

  hooks.push({
    name: "mcp_suggest",
    level: "assist",
    description: "Given a goal in plain language, rank the most relevant service/call candidates and say why — use before writing any arguments.",
    input_schema: {
      type: "object",
      properties: { goal: { type: "string", description: "what you want to accomplish" } },
      required: ["goal"],
      additionalProperties: false,
    },
    async handler(input) {
      const goal = asName(input.goal, "goal");
      const words = goal.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
      const servers = context.servers();
      const scored = new Map();
      for (const name of Object.keys(servers)) {
        let tools = [];
        try {
          tools = (await enumerateTools(name)).tools;
        } catch {
          continue;
        }
        for (const tool of tools) {
          const haystack = `${name} ${tool.name} ${tool.description ?? ""} ${paramNames(tool.inputSchema).join(" ")}`.toLowerCase();
          let score = 0;
          const hits = [];
          for (const word of words) {
            if (haystack.includes(word)) {
              score += word.length >= 4 ? 3 : 2;
              hits.push(word);
            } else if (haystack.includes(word.slice(0, Math.max(3, word.length - 2)))) {
              score += 1;
            }
          }
          if (score > 0) scored.set(`${name}/${tool.name}`, { server: name, tool, score, hits });
        }
      }
      const ranked = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, 5);
      if (!ranked.length) return `No registered call matches "${goal}". Report the gap honestly — do not fake an execution.`;
      const lines = [`Best candidates for "${goal}":`, ""];
      for (const { server, tool, score, hits } of ranked) {
        lines.push(`  ${server}/${tool.name} (relevance ${score}${hits.length ? `; matched: ${hits.join(", ")}` : ""})`);
        if (tool.description) lines.push(`    ${oneLine(tool.description, 100)}`);
      }
      lines.push("", "Next: mcp_describe or mcp_schema the top candidate, then mcp_draft and mcp_call.");
      return lines.join("\n");
    },
  });

  hooks.push({
    name: "mcp_describe",
    level: "assist",
    description: "Plain-language briefing for one call: purpose, parameter table with types/defaults, response envelope, and risk notes.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        call: { type: "string" },
      },
      required: ["service", "call"],
      additionalProperties: false,
    },
    async handler(input) {
      const { server, tool } = await resolveTool(asName(input.service, "service"), asName(input.call, "call"));
      const schema = tool.inputSchema ?? {};
      const required = new Set(schema.required ?? []);
      const lines = [`${server}/${tool.name}`, ""];
      lines.push(`What it does: ${oneLine(tool.description ?? "no description given by the service", 220)}`);
      const properties = schema.properties ?? {};
      const names = Object.keys(properties);
      if (!names.length) {
        lines.push("Parameters: none (empty arguments {}).");
      } else {
        lines.push("Parameters:");
        for (const name of names) {
          const child = properties[name] ?? {};
          const type = Array.isArray(child.type) ? child.type.join("|") : child.type ?? "any";
          const marks = [required.has(name) ? "required" : "optional"];
          if (child.default !== undefined) marks.push(`default ${JSON.stringify(child.default)}`);
          if (Array.isArray(child.enum)) marks.push(`one of ${child.enum.map((value) => JSON.stringify(value)).join("|")}`);
          lines.push(`  - ${name} (${type}, ${marks.join(", ")})${child.description ? `: ${oneLine(child.description, 110)}` : ""}`);
        }
      }
      const destructive = /delete|remove|write|create|update|drop|kill|restart/i.test(`${tool.name} ${tool.description ?? ""}`);
      if (destructive) lines.push("", "⚠ This call looks mutating/destructive — expect the user to scrutinize the approval.");
      lines.push("", responseEnvelopeNote(tool));
      return lines.join("\n");
    },
  });

  hooks.push({
    name: "mcp_validate",
    level: "assist",
    description: "Dry-run validation: check draft arguments against a call's JSON schema without executing. Always cheaper than a failed call.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        call: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["service", "call", "arguments"],
      additionalProperties: false,
    },
    async handler(input) {
      const { server, tool } = await resolveTool(asName(input.service, "service"), asName(input.call, "call"));
      const args = asObject(input.arguments);
      const validation = validateArguments(tool.inputSchema, args);
      if (validation.valid) {
        return `✓ arguments satisfy the schema of ${server}/${tool.name}. Ready for mcp_call.`;
      }
      return {
        content: clip([
          `✗ arguments fail the schema of ${server}/${tool.name}:`,
          ...validation.errors.map((error) => `  - ${error}`),
          "Fix these or use mcp_draft for a valid skeleton.",
        ].join("\n"), 4000),
        is_error: true,
      };
    },
  });

  hooks.push({
    name: "mcp_draft",
    level: "assist",
    description: "Synthesize a valid argument skeleton for one call from its schema (defaults, enums, examples filled; placeholders marked) — edit before calling.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        call: { type: "string" },
        includeOptional: { type: "boolean", description: "also draft optional parameters (default: required only)" },
      },
      required: ["service", "call"],
      additionalProperties: false,
    },
    async handler(input) {
      const { server, tool } = await resolveTool(asName(input.service, "service"), asName(input.call, "call"));
      const draft = draftFromSchema(tool.inputSchema ?? {}, { includeOptional: Boolean(input.includeOptional) }) ?? {};
      const validation = validateArguments(tool.inputSchema, draft);
      const lines = [`Draft arguments for ${server}/${tool.name}:`, "", clip(JSON.stringify(draft, null, 2), 4000), ""];
      lines.push(validation.valid ? "✓ the draft passes schema validation." : `✗ the draft itself fails validation (schema is unusual): ${validation.errors.join("; ")}`);
      const notes = schemaPlaceholders(tool.inputSchema).slice(0, 10);
      if (notes.length) {
        lines.push("", "Placeholders to replace with real values:");
        for (const note of notes) lines.push(`  - ${note}`);
      }
      lines.push("", "Next: replace placeholders, mcp_validate, then mcp_call.");
      return lines.join("\n");
    },
  });

  hooks.push({
    name: "mcp_examples",
    level: "assist",
    description: "Generate up to three example invocations of one call: minimal, typical (optionals included), and a documented full form.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        call: { type: "string" },
      },
      required: ["service", "call"],
      additionalProperties: false,
    },
    async handler(input) {
      const { server, tool } = await resolveTool(asName(input.service, "service"), asName(input.call, "call"));
      const minimal = draftFromSchema(tool.inputSchema ?? {}, { includeOptional: false }) ?? {};
      const full = draftFromSchema(tool.inputSchema ?? {}, { includeOptional: true }) ?? {};
      const examples = [
        ["minimal (required only)", minimal],
        ["typical (optionals drafted)", full],
      ];
      const declared = Array.isArray(tool.inputSchema?.examples) ? tool.inputSchema.examples : null;
      const lines = [`Examples for ${server}/${tool.name}:`, ""];
      for (const [label, args] of examples) {
        lines.push(`${label}:`);
        lines.push(clip(JSON.stringify(args, null, 2), 2500));
        lines.push("");
      }
      if (declared) {
        lines.push("Service-declared examples:", clip(JSON.stringify(declared, null, 2), 2500), "");
      }
      lines.push("Replace placeholder values (\"string\", example.test, …) with real ones before mcp_call.");
      return lines.join("\n");
    },
  });

  hooks.push({
    name: "mcp_plan",
    level: "assist",
    description: "Turn a goal into a draft multi-step plan: ordered service/call candidates with the schema you still need — structure before you execute.",
    input_schema: {
      type: "object",
      properties: { goal: { type: "string", description: "the end state you want to reach" } },
      required: ["goal"],
      additionalProperties: false,
    },
    async handler(input) {
      const goal = asName(input.goal, "goal");
      const words = goal.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
      const candidates = [];
      for (const name of Object.keys(context.servers())) {
        let tools = [];
        try {
          tools = (await enumerateTools(name)).tools;
        } catch {
          continue;
        }
        for (const tool of tools) {
          const haystack = `${name} ${tool.name} ${tool.description ?? ""} ${paramNames(tool.inputSchema).join(" ")}`.toLowerCase();
          const score = words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
          if (score > 0) candidates.push({ server: name, tool, score });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      const top = candidates.slice(0, 6);
      const lines = [`Draft plan for: ${goal}`, ""];
      if (!top.length) {
        lines.push("No registered call obviously serves this goal. Tell the user what is missing instead of improvising.");
        return lines.join("\n");
      }
      for (const [index, candidate] of top.entries()) {
        lines.push(`Step ${index + 1} candidate: ${candidate.server}/${candidate.tool.name}`);
        lines.push(`  ${oneLine(candidate.tool.description ?? "", 110)}`);
        const params = paramNames(candidate.tool.inputSchema);
        if (params.length) lines.push(`  needs: ${params.join(", ")}`);
      }
      lines.push("", "Refine the order yourself (outputs of earlier steps may feed later arguments), fetch each mcp_schema, then execute stepwise with mcp_call.");
      return lines.join("\n");
    },
  });

  // -------------------------------------------------------------- memory +
  hooks.push({
    name: "mcp_results",
    level: "assist",
    description: "List cached tool results (with their #index) or print one, so earlier outputs can be reused instead of re-calling services.",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "integer", description: "show only this result (#n)" },
      },
      additionalProperties: false,
    },
    async handler(input) {
      const buffer = context.resultBuffer;
      if (!buffer) return "Result memory is not available in this context.";
      const entries = buffer.list();
      if (!entries.length) return "No cached results yet. Every approved execution lands here automatically.";
      if (input.index !== undefined) {
        const entry = buffer.get(Number(input.index));
        if (!entry) return `No cached result #${input.index}. Call mcp_results without arguments to list what exists.`;
        return clip(`#${entry.index} ${entry.server}/${entry.tool}\n\n${entry.text}`);
      }
      const lines = [`Cached results (${entries.length}) — reuse instead of re-calling:`, ""];
      for (const entry of [...entries].reverse()) {
        lines.push(`  #${entry.index} ${entry.server}/${entry.tool} — ${oneLine(entry.text, 90)}`);
      }
      lines.push("", "Pass index to read one in full.");
      return lines.join("\n");
    },
  });

  hooks.push({
    name: "mcp_history",
    level: "assist",
    description: "Show what you already executed this session: service/call, arguments digest, outcome, duration — avoid duplicate work.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "how many recent entries (default 10)" } },
      additionalProperties: false,
    },
    async handler(input) {
      const log = callLog ?? [];
      if (!log.length) return "No MCP calls have been executed in this session yet.";
      const limit = Math.min(Number(input.limit) || 10, 50);
      const lines = [`Recent executions (${Math.min(limit, log.length)} of ${log.length}):`, ""];
      for (const entry of log.slice(-limit).reverse()) {
        const args = JSON.stringify(entry.args ?? {});
        lines.push(`  ${entry.at.slice(11, 19)} ${entry.server}/${entry.tool} ${oneLine(args, 80)} → ${entry.ok ? "ok" : `FAILED (${oneLine(entry.error ?? "", 60)})`} ${entry.ms}ms`);
      }
      return lines.join("\n");
    },
  });

  hooks.push({
    name: "mcp_explain",
    level: "assist",
    description: "Explain one cached result: structure, notable fields, and ready-to-use references for feeding it into the next call.",
    input_schema: {
      type: "object",
      properties: { index: { type: "integer", description: "cached result #n" } },
      required: ["index"],
      additionalProperties: false,
    },
    async handler(input) {
      const buffer = context.resultBuffer;
      const entry = buffer?.get(Number(input.index));
      if (!entry) return `No cached result #${input.index}. Use mcp_results to list indices.`;
      const lines = [`#${entry.index} ${entry.server}/${entry.tool} — result explanation:`, ""];
      let parsed;
      try {
        parsed = JSON.parse(entry.text);
      } catch {
        lines.push(`Plain text, ${entry.text.length} characters:`);
        lines.push(clip(entry.text, 2500));
        return lines.join("\n");
      }
      const shape = (value, prefix, depth) => {
        if (depth > 2) return;
        if (Array.isArray(value)) {
          lines.push(`  ${prefix}: array[${value.length}]`);
          if (value.length) shape(value[0], `${prefix}[0]`, depth + 1);
          return;
        }
        if (value && typeof value === "object") {
          for (const [key, child] of Object.entries(value).slice(0, 12)) {
            const type = Array.isArray(child) ? `array[${child.length}]` : child === null ? "null" : typeof child;
            lines.push(`  ${prefix}.${key}: ${type}${typeof child === "string" ? ` = ${oneLine(child, 48)}` : ""}`);
            if (child && typeof child === "object") shape(child, `${prefix}.${key}`, depth + 1);
          }
          return;
        }
      };
      lines.push("Structure:");
      shape(parsed, "root", 0);
      lines.push("", `Reuse in an argument: reference #${entry.index}.field (session backrefs) or copy values from the structure above.`);
      return clip(lines.join("\n"));
    },
  });

  // ------------------------------------------------------------ fleet health
  hooks.push({
    name: "mcp_health",
    level: "assist",
    description: "Connectivity and latency for every MCP service (non-destructive): reachable, call count, connect time. Diagnose before blaming arguments.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const servers = context.servers();
      const names = Object.keys(servers);
      if (!names.length) return "No MCP services are registered.";
      const lines = ["Service health:", ""];
      // Checked concurrently: one slow or dead service must not stretch the
      // whole report by its timeout.
      const outcomes = await Promise.all(names.map(async (name) => {
        const started = Date.now();
        try {
          const tools = await context.ensureTools(name);
          return `  ✓ ${name} — ${tools?.length ?? 0} calls, ${Date.now() - started}ms`;
        } catch (error) {
          return `  ✗ ${name} — ${oneLine(error.message, 90)}`;
        }
      }));
      lines.push(...outcomes);
      return lines.join("\n");
    },
  });

  hooks.push({
    name: "mcp_refresh",
    level: "assist",
    description: "Force re-discovery of one service's calls and report what changed (added/removed) — use when a call unexpectedly 'no longer exists'.",
    input_schema: {
      type: "object",
      properties: { service: { type: "string" } },
      required: ["service"],
      additionalProperties: false,
    },
    async handler(input) {
      const service = asName(input.service, "service");
      const servers = context.servers();
      const entry = Object.keys(servers).find((name) => serviceNameMatches(name, service));
      if (!entry) throw new Error(`No MCP service named "${service}".`);
      if (!context.refresh) throw new Error("Refresh is not available in this context; reconnect happens automatically on next use.");
      const before = new Map((await context.ensureTools(entry).catch(() => []))?.map((tool) => [tool.name, tool]) ?? []);
      const tools = await context.refresh(entry);
      const after = new Map((tools ?? []).map((tool) => [tool.name, tool]));
      const added = [...after.keys()].filter((name) => !before.has(name));
      const removed = [...before.keys()].filter((name) => !after.has(name));
      const lines = [`"${entry}" refreshed — ${after.size} calls.`];
      if (added.length) lines.push(`  added: ${added.join(", ")}`);
      if (removed.length) lines.push(`  removed: ${removed.join(", ")}`);
      if (!added.length && !removed.length) lines.push("  no changes.");
      return lines.join("\n");
    },
  });

  // ------------------------------------------------- resources and prompts +
  hooks.push({
    name: "mcp_resources",
    level: "assist",
    description: "List the MCP resources (files, documents, data URIs) a service exposes — often cheaper than calling a read tool.",
    input_schema: {
      type: "object",
      properties: { service: { type: "string" } },
      required: ["service"],
      additionalProperties: false,
    },
    async handler(input) {
      const service = asName(input.service, "service");
      const servers = context.servers();
      const server = Object.keys(servers).find((name) => serviceNameMatches(name, service));
      if (!server) throw new Error(`No MCP service named "${service}". Call mcp_services for level-1 names.`);
      if (!context.listResources) throw new Error("Resources are not available in this context.");
      const resources = await context.listResources(server);
      if (!resources?.length) return `"${server}" exposes no resources.`;
      const lines = [`Resources on "${server}" (${resources.length}):`, ""];
      for (const resource of resources.slice(0, 50)) {
        lines.push(`  ${resource.uri} — ${oneLine(resource.name ?? "", 60)}${resource.mimeType ? ` (${resource.mimeType})` : ""}`);
      }
      lines.push("", "Read one with mcp_read { service, uri }.");
      return lines.join("\n");
    },
  });

  hooks.push({
    name: "mcp_read",
    level: "assist",
    description: "Read one MCP resource by URI and return its text contents (bounded).",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        uri: { type: "string" },
      },
      required: ["service", "uri"],
      additionalProperties: false,
    },
    async handler(input) {
      const service = asName(input.service, "service");
      const uri = asName(input.uri, "uri");
      const servers = context.servers();
      const server = Object.keys(servers).find((name) => serviceNameMatches(name, service));
      if (!server) throw new Error(`No MCP service named "${service}". Call mcp_services for level-1 names.`);
      if (!context.readResource) throw new Error("Resources are not available in this context.");
      const result = await context.readResource(server, uri);
      const contents = result?.contents ?? [];
      if (!contents.length) return `"${uri}" returned no contents.`;
      const parts = contents.map((item) => item.text ?? (item.blob ? `[binary ${item.mimeType ?? "data"}, ${item.blob.length} base64 chars]` : ""));
      return clip(parts.join("\n\n"));
    },
  });

  hooks.push({
    name: "mcp_prompts",
    level: "assist",
    description: "List a service's MCP prompt templates, or render one with arguments — reusable service-authored workflows.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        prompt: { type: "string", description: "omit to list; pass a name to render it" },
        arguments: { type: "object", description: "template arguments when rendering" },
      },
      required: ["service"],
      additionalProperties: false,
    },
    async handler(input) {
      const service = asName(input.service, "service");
      const servers = context.servers();
      const server = Object.keys(servers).find((name) => serviceNameMatches(name, service));
      if (!server) throw new Error(`No MCP service named "${service}". Call mcp_services for level-1 names.`);
      if (!context.listPrompts) throw new Error("Prompts are not available in this context.");
      if (!input.prompt) {
        const prompts = await context.listPrompts(server);
        if (!prompts?.length) return `"${server}" exposes no prompt templates.`;
        const lines = [`Prompt templates on "${server}" (${prompts.length}):`, ""];
        for (const prompt of prompts.slice(0, 50)) {
          lines.push(`  ${prompt.name} — ${oneLine(prompt.description ?? "", 80)}`);
        }
        lines.push("", "Render one with mcp_prompts { service, prompt, arguments }.");
        return lines.join("\n");
      }
      if (!context.getPrompt) throw new Error("Prompts are not available in this context.");
      const rendered = await context.getPrompt(server, String(input.prompt), asObject(input.arguments));
      const messages = (rendered?.messages ?? []).map((message) => {
        const content = message.content ?? {};
        return `${message.role}: ${typeof content === "string" ? content : content.text ?? JSON.stringify(content)}`;
      });
      return clip(messages.join("\n\n") || "(empty prompt)");
    },
  });

  // The twenty hooks are the complete toolkit: 3 disclosure levels, 2
  // execution forms, and 15 assist/discovery/memory/health surfaces.
  if (hooks.length !== 20) {
    throw new Error(`agent hooks: expected 20 hooks, found ${hooks.length}`);
  }
  const defs = hooks;

  const byName = new Map(defs.map((hook) => [hook.name, hook]));

  return {
    defs: defs.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    levels: Object.fromEntries(defs.map((hook) => [hook.name, hook.level])),
    names: defs.map((hook) => hook.name),
    resolve: (name) => byName.get(name) ?? null,
    async run(name, input, { signal } = {}) {
      const hook = byName.get(name);
      if (!hook) {
        return {
          content: `Unknown hook "${name}". Available: ${defs.map((hook) => hook.name).join(", ")}`,
          is_error: true,
        };
      }
      const started = Date.now();
      try {
        const content = await hook.handler(asObject(input), { signal });
        callLog?.push({ at: new Date().toISOString(), hook: name, ms: Date.now() - started });
        const text = typeof content === "string" ? content : content.content;
        return typeof content === "string" ? { content: text } : content;
      } catch (error) {
        return { content: `Error: ${error.message}`, is_error: true };
      }
    },
  };
}
