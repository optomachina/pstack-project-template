/**
 * Optional advisory Jev client (ported from OverDrafter's TypeSafe System One
 * client). Jev is a fast semantic screen; it sizes review and never authorizes,
 * accepts, or filters anything.
 *
 * Inert unless configured. Nothing in the repository names an endpoint or a
 * credential. Configure through the environment (CI secrets or a local shell):
 *   JEV_ENDPOINT  https URL of a System One compatible endpoint (required to enable)
 *   JEV_API_KEY   optional bearer token; never logged, printed, or placed in a result
 *   JEV_MODEL     optional expected model id; responses for another model are rejected
 * Without JEV_ENDPOINT every call returns {ok: false, reason: "not_configured"}
 * immediately and makes no network request, so callers fall back to the
 * deterministic tier (which treats a missing screen as "normal", never "low").
 *
 * Protocol: POST {state, model?, questions} -> {model, answers: {<id>: answer}}
 * where a "choice" answer is {type: "choice", choice, confidence} and a "noul"
 * answer is {type: "noul", noul} (a probability). Every call returns a result
 * object and never throws. Node fetch honors HTTPS_PROXY only with
 * NODE_USE_ENV_PROXY=1.
 *
 * Smoke: JEV_ENDPOINT=... node scripts/jev-client.mjs --smoke
 */
import { invokedAsScript } from "./lib/sensitive-paths.mjs";

export const NOT_CONFIGURED = "not_configured";

/** The Jev settings from an environment, or null when no endpoint is configured. */
export function jevConfig(env = process.env) {
  const endpoint = env.JEV_ENDPOINT?.trim();
  if (!endpoint) return null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
  return { endpoint: url.toString(), model: env.JEV_MODEL?.trim() || null, apiKey: env.JEV_API_KEY?.trim() || null };
}

export const isJevConfigured = (env = process.env) => jevConfig(env) !== null;

/** Bound a service- or caller-supplied value to a short printable token (null when not a string). */
export function sanitizeToken(value, env = process.env) {
  if (typeof value !== "string") return null;
  const key = env.JEV_API_KEY?.trim();
  if (key && (value.includes(key) || value.replace(/[^\w.-]/g, "_").includes(key.replace(/[^\w.-]/g, "_")))) return "redacted";
  return value.replace(/[^\w.-]/g, "_").slice(0, 64);
}

const isProbability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** True when `answer` is a well-formed answer of the type and options that `question` asked for. */
export function isValidAnswer(question, answer) {
  if (!answer || typeof answer !== "object" || answer.type !== question?.type) return false;
  if (question.type === "noul") return isProbability(answer.noul);
  if (question.type === "choice") {
    const criteria = question.criteria && typeof question.criteria === "object" ? question.criteria : {};
    return isProbability(answer.confidence) && typeof answer.choice === "string" && Object.hasOwn(criteria, answer.choice);
  }
  return true;
}

function networkReason(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  return `network_${sanitizeToken(String(error?.cause?.code ?? error?.name ?? "error"))}`;
}

/**
 * Ask Jev the questions about state. options: {env, fetch, timeoutMs}. Returns
 * {ok: true, model, answers, usage, latencyMs} or {ok: false, reason, latencyMs}.
 */
export async function askJev(state, questions, options = {}) {
  const { env = process.env, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = options;
  const config = jevConfig(env);
  if (!config) return { ok: false, reason: NOT_CONFIGURED, latencyMs: 0 };
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  let payload;
  try {
    payload = JSON.stringify({ state, ...(config.model ? { model: config.model } : {}), questions });
  } catch {
    // A BigInt or circular input is a caller error, not a network failure; never sent.
    return { ok: false, reason: "invalid_request", latencyMs: latency() };
  }
  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  try {
    const response = await fetchImpl(config.endpoint, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `http_${response.status}`, latencyMs: latency() };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, reason: "malformed_response", latencyMs: latency() };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "malformed_response", latencyMs: latency() };
    if (config.model && body.model !== config.model) return { ok: false, reason: "unexpected_model_version", model: sanitizeToken(body.model, env), latencyMs: latency() };
    for (const id of Object.keys(questions ?? {})) {
      if (!isValidAnswer(questions[id], body.answers?.[id])) return { ok: false, reason: "malformed_response", latencyMs: latency() };
    }
    return { ok: true, model: sanitizeToken(body.model, env), answers: body.answers, usage: body.usage ?? null, latencyMs: latency() };
  } catch (error) {
    return { ok: false, reason: networkReason(error), latencyMs: latency() };
  }
}

/** Accept a choice answer only at or above a confidence floor; otherwise report uncertainty or failure. */
export function gatedChoice(result, id, minConfidence = 0.5) {
  if (!result?.ok) return { status: result?.reason === NOT_CONFIGURED ? NOT_CONFIGURED : "failed", reason: result?.reason ?? "no_result" };
  const answer = result.answers?.[id];
  if (!answer || typeof answer.choice !== "string" || !isProbability(answer.confidence)) return { status: "failed", reason: "malformed_answer" };
  if (answer.confidence < minConfidence) return { status: "uncertain", choice: answer.choice, confidence: answer.confidence };
  return { status: "accepted", choice: answer.choice, confidence: answer.confidence };
}

/** One synthetic routing question; prints the gated answer and timing, never headers or credentials. */
export async function smoke() {
  const questions = {
    role: {
      type: "choice",
      instructions: "Which worker role should own `task`?",
      criteria: {
        implementer: "Writes or changes source code and tests for a bounded change.",
        verifier: "Runs deterministic checks, tests, and acceptance evidence for a given revision.",
      },
    },
  };
  const result = await askJev({ task: "Run the unit tests on commit abc123 and record results" }, questions);
  const gate = gatedChoice(result, "role");
  const summary = {
    configured: isJevConfigured(),
    ok: result.ok === true,
    reason: result.ok ? null : sanitizeToken(String(result.reason ?? "unknown")),
    latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
    gate: { status: gate.status, choice: Object.keys(questions.role.criteria).find((k) => k === gate.choice) ?? null },
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (invokedAsScript(import.meta.url) && process.argv.includes("--smoke")) {
  const summary = await smoke();
  process.exitCode = summary.ok ? 0 : 1;
}
