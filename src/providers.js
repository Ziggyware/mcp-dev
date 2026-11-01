// src/providers.js
//
// OpenAI-compatible inference endpoints usable as the agent brain or as the
// chat/compression backend. The nokey-router (Ziggyware) is integrated as a
// first-class, always-available provider: it is a free OpenAI-compatible mesh
// router, so it needs no API key ("nokey") and can be selected with
// MCP_DEV_BRAIN=nokey or used automatically when no other provider is set.

const DEFAULT_NOKEY_URL = "https://nokey-router.ziggyware.deno.net/v1";

/**
 * Every known OpenAI-compatible endpoint, regardless of key availability.
 * getProviderArray() filters this to the usable subset.
 */
export function getProviderCatalog() {
  return [
    {
      name: "nokey_router",
      base: process.env.NOKEY_ROUTER_URL || DEFAULT_NOKEY_URL,
      keyEnv: "NOKEY_ROUTER_API_KEY",
      defaultKey: "nokey",
      fallbackModel: process.env.NOKEY_ROUTER_MODEL || "free:smart",
      priority: 0,
      alwaysAvailable: true,
      description: "nokey-router (Ziggyware free mesh; zero-key)",
    },
    { name: "groq", base: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", fallbackModel: "llama-3.3-70b-versatile", priority: 1 },
    { name: "openrouter_free", base: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", fallbackModel: "meta-llama/llama-3.3-8b-instruct:free", priority: 2 },
    { name: "cerebras", base: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", fallbackModel: "llama3.3-70b", priority: 3 },
    { name: "sambanova", base: "https://api.sambanova.ai/v1", keyEnv: "SAMBANOVA_API_KEY", fallbackModel: "Meta-Llama-3.3-70B-Instruct", priority: 4 },
    { name: "mistral", base: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", fallbackModel: "mistral-large-latest", priority: 5 },
    { name: "deepinfra", base: "https://api.deepinfra.com/v1/openai", keyEnv: "DEEPINFRA_API_KEY", fallbackModel: "meta-llama/Meta-Llama-3.3-70B-Instruct", priority: 8 },
    { name: "github_models", base: "https://models.inference.ai.azure.com", keyEnv: "GITHUB_TOKEN", fallbackModel: "Llama-3.3-8B-Instruct", priority: 6 },
    { name: "gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai/", keyEnv: "GEMINI_API_KEY", fallbackModel: "gemini-2.5-flash-lite", priority: -7 },
    { name: "nvidia_nim", base: "https://integrate.api.nvidia.com/v1", keyEnv: "NVIDIA_API_KEY", fallbackModel: "meta/llama-3.1-405b-instruct", priority: -6 },
    { name: "huggingface", base: "https://router.huggingface.co/v1", keyEnv: "HF_TOKEN", fallbackModel: "meta-llama/Llama-3.1-8B-Instruct", priority: -5 },
    { name: "siliconflow", base: "https://api.siliconflow.cn/v1", keyEnv: "SILICONFLOW_API_KEY", fallbackModel: "Qwen/Qwen3-8B", priority: -3 },
    { name: "zai", base: "https://open.bigmodel.cn/api/paas/v4", keyEnv: "ZAI_API_KEY", fallbackModel: "GLM-4.7-Flash", priority: -2 },
  ].sort((a, b) => a.priority - b.priority);
}

/** True when a catalog provider can actually be used right now. */
export function isProviderAvailable(provider) {
  return Boolean(provider.alwaysAvailable || process.env[provider.keyEnv]);
}

/** Resolve the bearer token for a provider: env key first, then default. */
export function providerKey(provider) {
  return process.env[provider.keyEnv] ?? provider.defaultKey;
}

/** Available providers only — the chat fallback chain. */
export function getProviderArray() {
  return getProviderCatalog().filter(isProviderAvailable);
}

/** Look up one provider by canonical name from the full catalog. */
export function resolveProvider(name) {
  return getProviderCatalog().find((provider) => provider.name === name) ?? null;
}
