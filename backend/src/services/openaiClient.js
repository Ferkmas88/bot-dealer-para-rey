import OpenAI from "openai";

const openaiApiKey = process.env.OPENAI_API_KEY || "";
const cerebrasApiKey = process.env.CEREBRAS_API_KEY || "";
const geminiApiKey = process.env.GEMINI_API_KEY || "";

const hasOpenAI = Boolean(openaiApiKey && openaiApiKey !== "tu_api_key");
const hasCerebras = Boolean(cerebrasApiKey && cerebrasApiKey !== "tu_api_key");
const hasGemini = Boolean(geminiApiKey && geminiApiKey !== "tu_api_key");

if (!hasOpenAI) {
  console.warn("OPENAI_API_KEY is not configured or invalid.");
}
if (!hasCerebras) {
  console.warn("CEREBRAS_API_KEY is not configured or invalid.");
}
if (!hasGemini) {
  console.warn("GEMINI_API_KEY is not configured or invalid.");
}

const openaiClient = hasOpenAI ? new OpenAI({ apiKey: openaiApiKey }) : null;
const cerebrasClient = hasCerebras
  ? new OpenAI({
      apiKey: cerebrasApiKey,
      baseURL: "https://api.cerebras.ai/v1"
    })
  : null;
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 9000);

function toFlatPrompt(messages = []) {
  return messages
    .map((m) => `${(m.role || "user").toUpperCase()}: ${m.content || ""}`)
    .join("\n\n");
}

async function generateWithOpenAI(messages) {
  if (!openaiClient) throw new Error("OpenAI client unavailable");

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const completion = await openaiClient.chat.completions.create({
    model,
    messages,
    temperature: 0.4,
    timeout: LLM_TIMEOUT_MS
  });

  return completion.choices?.[0]?.message?.content?.trim() || "";
}

async function generateWithCerebras(messages) {
  if (!cerebrasClient) throw new Error("Cerebras client unavailable");

  const model = process.env.CEREBRAS_MODEL || "llama3.1-8b";
  const completion = await cerebrasClient.chat.completions.create({
    model,
    messages,
    temperature: 0.4
  });

  return completion.choices?.[0]?.message?.content?.trim() || "";
}

async function generateWithGemini(messages) {
  if (!hasGemini) throw new Error("Gemini client unavailable");

  const configured = process.env.GEMINI_MODEL || "";
  const modelCandidates = configured
    ? [configured]
    : ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
  const prompt = toFlatPrompt(messages);
  let lastErr = "Gemini request failed";

  for (const model of modelCandidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4 }
        })
      });

      if (!response.ok) {
        const body = await response.text();
        lastErr = `Gemini model ${model} error ${response.status}: ${body}`;
        continue;
      }

      const data = await response.json();
      const text =
        data?.candidates?.[0]?.content?.parts
          ?.map((p) => p?.text || "")
          .join("")
          .trim() || "";

      if (text) return text;
      lastErr = `Gemini model ${model} returned empty text`;
    } catch (error) {
      lastErr = `Gemini model ${model} failed: ${error?.message || "unknown error"}`;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(lastErr);
}

export async function generateChatCompletionWithMeta(messages) {
  const errors = [];

  if (hasOpenAI) {
    try {
      const text = await generateWithOpenAI(messages);
      if (text) return { text, provider: "openai" };
    } catch (err) {
      errors.push(`openai: ${err?.message || "unknown error"}`);
    }
  }

  if (hasCerebras) {
    try {
      const text = await generateWithCerebras(messages);
      if (text) return { text, provider: "cerebras" };
    } catch (err) {
      errors.push(`cerebras: ${err?.message || "unknown error"}`);
    }
  }

  if (hasGemini) {
    try {
      const text = await generateWithGemini(messages);
      if (text) return { text, provider: "gemini" };
    } catch (err) {
      errors.push(`gemini: ${err?.message || "unknown error"}`);
    }
  }

  throw new Error(errors.length ? errors.join(" | ") : "No LLM provider configured");
}

export async function generateChatCompletion(messages) {
  const result = await generateChatCompletionWithMeta(messages);
  return result.text;
}

export async function checkLlmConnection() {
  try {
    const result = await generateChatCompletionWithMeta([{ role: "user", content: "Reply only with: ok" }]);
    return { connected: true, provider: result.provider };
  } catch (error) {
    return {
      connected: false,
      provider: null,
      reason: error?.message || "LLM check failed"
    };
  }
}
