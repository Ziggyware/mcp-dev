// src/router.js — minimal in-process version of routeInference, no circuit
// breaker / SQLite state.
import { getProviderArray } from "./providers.js";

// Improvement 9: per-provider request timeout via AbortController. A hung
// provider connection previously blocked the entire fallback chain
// indefinitely -- no per-provider bound existed, so a single unresponsive
// endpoint could stall `ask`/session chat forever rather than falling
// through to the next configured provider within a bounded window.
const PROVIDER_TIMEOUT_MS = 20000;

export async function routeChat(messages, tools, { timeoutMs = PROVIDER_TIMEOUT_MS } = {}) {
  const providers = getProviderArray();
  if (providers.length === 0) throw new Error("No provider API keys set in environment.");

  let lastErr;
  for (const p of providers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${p.name} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetch(`${p.base}/chat/completions`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${process.env[p.keyEnv]}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: p.fallbackModel,
          messages,
          tools: tools?.length ? tools : undefined,
          tool_choice: tools?.length ? "auto" : undefined,
          temperature: 0,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      if (!json.choices?.[0]?.message) throw new Error(`${p.name}: malformed response`);
      return { message: json.choices[0].message, provider: p.name, model: p.fallbackModel };
    } catch (err) {
      lastErr = err;
      console.error(`[fallback] ${p.name} failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`All providers exhausted. Last: ${lastErr?.message}`);
}