// src/router.js — minimal in-process version of router.tsx's routeInference,
// no circuit breaker / SQLite state (T=heur, C=0.6: dropping the breaker is
// a scope call, not a correctness requirement — a long-running session
// process might genuinely benefit from it, a one-shot CLI invocation mostly
// won't hit the same provider enough times in one run for OPEN-state to
// matter). Flagging as self-imposed simplification per rule 21, not
// something you asked me to drop.
import { getProviderArray } from "./providers.js";

export async function routeChat(messages, tools) {
  const providers = getProviderArray();
  if (providers.length === 0) throw new Error("No provider API keys set in environment.");

  let lastErr;
  for (const p of providers) {
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
      });
      if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      if (!json.choices?.[0]?.message) throw new Error(`${p.name}: malformed response`);
      return { message: json.choices[0].message, provider: p.name, model: p.fallbackModel };
    } catch (err) {
      lastErr = err;
      console.error(`[fallback] ${p.name} failed: ${err.message}`);
    }
  }
  throw new Error(`All providers exhausted. Last: ${lastErr?.message}`);
}