import { Router } from "express";
import { z } from "zod";
import { applyFirstTouchPolicy, processDealerSessionMessage, processDealerSessionMessageWithLLM } from "../services/dealerSalesAssistant.js";
import { checkLlmConnection } from "../services/openaiClient.js";
import {
  getDealerSession,
  getDealerSessionSummary,
  getLearningState,
  saveDealerFeedback,
  saveDealerTurn
} from "../services/dealerSessionStore.js";
import { getStorageHealth, listInventory } from "../services/sqliteLeadStore.js";

const payloadSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().min(1)
});

const feedbackSchema = z.object({
  sessionId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z.string().optional(),
  reply: z.string().optional()
});

export const dealerAiRouter = Router();

function isInventoryOrBrandRequest(message = "") {
  return /(inventario|disponible|disponibles|stock|unidad|unidades|muestr|ensena|mostrar|que tienes|tienes|marca|modelo|precio|nissan|toyota|honda|ford|chevrolet|hyundai|kia|mazda|bmw|audi|camry|corolla|civic|altima|sentra)/i.test(
    message
  );
}

function buildLiveInventorySummaryReply(rows = []) {
  const available = (rows || []).filter((row) => String(row.status || "").toLowerCase() === "available");
  if (!available.length) {
    return "Ahora mismo no tengo unidades disponibles en sistema. Si quieres, te aviso cuando entren carros nuevos.";
  }

  const byMakeMap = new Map();
  for (const row of available) {
    const make = String(row.make || "").trim() || "Otro";
    byMakeMap.set(make, (byMakeMap.get(make) || 0) + 1);
  }
  const byMake = [...byMakeMap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([make, count]) => `${make} (${count})`)
    .join(", ");

  return `Tengo ${available.length} unidades disponibles: ${byMake}. Buscas sedan, pickup o SUV?`;
}

dealerAiRouter.post("/dealer/ai", async (req, res) => {
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid payload",
      details: parsed.error.flatten()
    });
  }

  const { message, sessionId } = parsed.data;
  const session = getDealerSession(sessionId);
  const learningState = getLearningState(sessionId);

  let aiResult;
  if (isInventoryOrBrandRequest(message)) {
    try {
      const rows = await listInventory();
      aiResult = {
        reply: buildLiveInventorySummaryReply(rows),
        intent: "buying_interest",
        entities: {
          model: null,
          budget: null,
          date: null,
          contact: { email: null, phone: null }
        },
        suggestions: [
          "Solicitar presupuesto objetivo y forma de pago (contado/financiamiento)",
          "Ofrecer test drive esta semana",
          "Proponer 2-3 horarios de cita para acelerar cierre",
          "Pedir telefono o email para seguimiento"
        ],
        skill: {
          stage: "discover",
          nextObjective: "Identificar marca/modelo ideal",
          confidence: 0.9
        },
        source: "inventory-live-db",
        mediaUrl: null
      };
    } catch {
      aiResult = await processDealerSessionMessage(message, session.context, learningState);
    }
  } else {
    aiResult = await processDealerSessionMessageWithLLM(message, session.context, learningState);
  }

  applyFirstTouchPolicy({ message, context: session.context, aiResult });

  await saveDealerTurn({
    sessionId,
    userMessage: message,
    aiResult
  });

  return res.json({
    reply: aiResult.reply,
    intent: aiResult.intent,
    entities: aiResult.entities,
    suggestions: aiResult.suggestions,
    skill: aiResult.skill || null,
    source: aiResult.source || "fallback",
    mediaUrl: aiResult.mediaUrl || null
  });
});

dealerAiRouter.get("/dealer/ai/connection", async (_req, res) => {
  const status = await checkLlmConnection();
  const openaiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const cerebrasModel = process.env.CEREBRAS_MODEL || "llama3.1-8b";
  const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  if (status.connected) {
    return res.json({
      connected: true,
      provider: status.provider,
      openaiModel,
      cerebrasModel,
      geminiModel
    });
  }

  return res.status(500).json({
    connected: false,
    provider: null,
    openaiModel,
    cerebrasModel,
    geminiModel,
    reason: status.reason
  });
});

dealerAiRouter.post("/dealer/ai/feedback", async (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid feedback payload",
      details: parsed.error.flatten()
    });
  }

  await saveDealerFeedback(parsed.data);
  return res.json({ ok: true });
});

dealerAiRouter.get("/dealer/ai/session/:sessionId", (req, res) => {
  const summary = getDealerSessionSummary(req.params.sessionId);
  return res.json(summary);
});

dealerAiRouter.get("/dealer/ai/storage", async (_req, res) => {
  const storage = await getStorageHealth();
  const status = storage.ok ? 200 : 500;
  return res.status(status).json({ storage });
});
