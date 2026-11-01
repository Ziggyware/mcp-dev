// src/brain.js
//
// Which LLM endpoint powers `mcp-dev ask` and session chat. The nokey-router
// (https://nokey-router.ziggyware.deno.net) is always available: it is a free,
// OpenAI-compatible mesh router that needs no API key, so the agent works with
// zero configuration. Set ANTHROPIC_API_KEY (or any provider key) to prefer a
// different brain, or force one explicitly:
//
//   MCP_DEV_BRAIN=nokey      force the nokey-router
//   MCP_DEV_BRAIN=anthropic  force Anthropic
//   MCP_DEV_BRAIN=<provider> force any OpenAI-compatible provider by name
//   NOKEY_ROUTER_MODEL=...   pick the routed model (free:auto|fast|smart|code|reasoning)
//   NOKEY_ROUTER_URL=...     point at a different router deployment

import { getProviderArray, providerKey, resolveProvider } from "./providers.js";

export const NOKEY_PROVIDER_NAME = "nokey_router";

/**
 * Decide the brain once per command/session so every surface reports the same
 * choice. Returns null only when the forced brain is unavailable — the caller
 * turns that into a friendly message.
 */
export function selectBrain(env = process.env) {
  const forced = String(env.MCP_DEV_BRAIN ?? "").trim().toLowerCase();
  const providers = getProviderArray();
  const nokey = providers.find((provider) => provider.name === NOKEY_PROVIDER_NAME) ?? resolveProvider(NOKEY_PROVIDER_NAME);

  const anthropicKey = env.ANTHROPIC_API_KEY;
  const anthropicBrain = anthropicKey
    ? {
        kind: "anthropic",
        apiKey: anthropicKey,
        model: env.MCP_DEV_MODEL || "claude-sonnet-4-6",
        label: `anthropic:${env.MCP_DEV_MODEL || "claude-sonnet-4-6"}`,
      }
    : null;

  const openAiBrainFor = (provider) => ({
    kind: "openai",
    provider: provider.name,
    base: provider.base,
    apiKey: providerKey(provider),
    model: provider.fallbackModel,
    label: `${provider.name === NOKEY_PROVIDER_NAME ? "nokey-router" : provider.name}:${provider.fallbackModel}`,
  });

  const nokeyBrain = nokey ? openAiBrainFor(nokey) : null;

  if (forced === "anthropic") {
    if (!anthropicBrain) throw new Error("MCP_DEV_BRAIN=anthropic but ANTHROPIC_API_KEY is not set.");
    return anthropicBrain;
  }
  if (forced === "nokey" || forced === NOKEY_PROVIDER_NAME) {
    if (!nokeyBrain) throw new Error("The nokey-router brain is not configured (unexpected).");
    return nokeyBrain;
  }
  if (forced) {
    const provider = resolveProvider(forced);
    if (!provider) {
      throw new Error(`MCP_DEV_BRAIN="${forced}" is not a brain. Use "anthropic", "nokey", or a configured provider name.`);
    }
    return openAiBrainFor(provider);
  }
  // Default: a configured Anthropic key wins (deterministic quality); the
  // nokey-router keeps the agent usable with zero keys at all.
  return anthropicBrain ?? nokeyBrain;
}

/** One-line human description for status bars and greetings. */
export function describeBrain(brain) {
  if (!brain) return "chat off";
  const pretty = brain.provider === NOKEY_PROVIDER_NAME ? "nokey-router" : (brain.provider ?? brain.kind);
  return `${pretty} · ${brain.model}`;
}
