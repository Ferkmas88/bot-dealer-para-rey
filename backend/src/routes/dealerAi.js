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
import { getLatestOpenAppointmentForLead, getStorageHealth, listInventory } from "../services/sqliteLeadStore.js";

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
  return /(inventario|disponible|disponibles|stock|unidad|unidades|muestr|ensena|mostrar|que tienes|tienes|marca|modelo|precio|barato|barata|economico|economica|menos de|por debajo de|nissan|toyota|honda|ford|chevrolet|hyundai|kia|mazda|bmw|audi|ram|camry|corolla|civic|altima|sentra|rogue|silverado|1500)/i.test(
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

function normalizeText(value = "") {
  return String(value || "").trim().toLowerCase();
}

function formatUnitLine(row) {
  return `${row.year} ${row.make} ${row.model} - $${Number(row.price || 0).toLocaleString("en-US")} - ${Number(row.mileage || 0).toLocaleString("en-US")} mi`;
}

function buildInventoryReplyForMessage(message, rows = []) {
  const text = normalizeText(message);
  const available = rows.filter((row) => normalizeText(row.status) === "available");
  const reserved = rows.filter((row) => normalizeText(row.status) === "reserved");
  const sold = rows.filter((row) => normalizeText(row.status) === "sold");

  const asksCheapest = /(mas barato|m[aá]s barato|precio mas bajo|precio minimo|precio m[ií]nimo)/i.test(text);
  const asksPriceMileageList = /(precio y millaje|precio y millas|con precio|con millaje|dame opciones|mostrar opciones)/i.test(text);
  const asksSuv = /\bsuvs?\b|camioneta/i.test(text);
  const asksPickup = /pickup|pick[\s-]*up|truck/i.test(text);
  const asksSedan = /\bsedan(es)?\b/i.test(text);

  const matchingByName = rows.filter((row) => {
    const make = normalizeText(row.make);
    const model = normalizeText(row.model);
    return (
      (make && text.includes(make)) ||
      (model && text.includes(model)) ||
      (make && model && text.includes(`${make} ${model}`))
    );
  });

  if (matchingByName.length) {
    const exactAvailable = matchingByName.filter((row) => normalizeText(row.status) === "available");
    if (exactAvailable.length) {
      const lines = exactAvailable.slice(0, 2).map((row) => `- ${formatUnitLine(row)}`).join("\n");
      return `Si, aqui tienes opciones disponibles:\n${lines}\nQuieres que te agende cita para verlas?`;
    }
    const lines = matchingByName.slice(0, 2).map((row) => `- ${formatUnitLine(row)} (${row.status})`).join("\n");
    return `De ese modelo/marca no tengo disponible ahora. En sistema aparece asi:\n${lines}\nSi quieres te aviso cuando entre disponible.`;
  }

  if (asksCheapest) {
    if (!available.length) return "Ahora mismo no tengo unidades disponibles en sistema.";
    const underSix = available
      .filter((row) => Number(row.price || 0) < 6000)
      .sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
    if (underSix.length) {
      const lines = underSix.slice(0, 2).map((row) => `- ${formatUnitLine(row)}`).join("\n");
      return `Si, tengo opciones por debajo de $6,000:\n${lines}\nQuieres que te agende cita para verlas?`;
    }

    const cheapest = [...available].sort((a, b) => Number(a.price || 0) - Number(b.price || 0))[0];
    return `Ahora mismo no tengo unidades por debajo de $6,000. La mas barata disponible es:\n- ${formatUnitLine(cheapest)}\nQuieres que te agende cita para verla?`;
  }

  if (asksSuv || asksPickup || asksSedan) {
    const filtered = available.filter((row) => {
      const type = normalizeText(row.vehicle_type);
      if (asksSuv) return type === "suv";
      if (asksPickup) return type === "pickup";
      if (asksSedan) return type === "sedan";
      return true;
    });
    if (!filtered.length) {
      return "No tengo match exacto con ese tipo en disponibles ahora. Si quieres te muestro alternativas disponibles.";
    }
    const lines = filtered.slice(0, 2).map((row) => `- ${formatUnitLine(row)}`).join("\n");
    return `Te comparto opciones disponibles:\n${lines}\nSi quieres, te agendo cita para venir a verlas.`;
  }

  if (asksPriceMileageList) {
    if (!available.length) return "Ahora mismo no tengo unidades disponibles en sistema.";
    const lines = available.slice(0, 3).map((row) => `- ${formatUnitLine(row)}`).join("\n");
    return `Opciones disponibles con precio y millaje:\n${lines}\nQuieres que te agende cita para verlas?`;
  }

  const total = rows.length;
  return `${buildLiveInventorySummaryReply(rows)} (Inventario total: ${total}, disponibles: ${available.length}, reservados: ${reserved.length}, vendidos: ${sold.length}).`;
}

function asksOwnAppointment(message = "") {
  return /(mi cita|tengo cita|ya tengo cita|cuando es mi cita|a que hora es mi cita|hora de mi cita)/i.test(String(message || ""));
}

dealerAiRouter.post("/dealer/ai", async (req, res) => {
  try {
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
    if (asksOwnAppointment(message)) {
      const appointment = await getLatestOpenAppointmentForLead(sessionId);
      if (appointment) {
        const when = new Date(appointment.scheduled_at);
        const whenText = Number.isNaN(when.getTime())
          ? String(appointment.scheduled_at)
          : when.toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        aiResult = {
          reply: `Si, tienes una cita registrada para ${whenText}. Si quieres, te ayudo a confirmar, reprogramar o cancelar.`,
          intent: "appointment_flow",
          entities: {
            model: null,
            budget: null,
            date: appointment.scheduled_at,
            contact: { email: null, phone: null }
          },
          suggestions: ["Confirmar cita", "Reprogramar cita", "Cancelar cita"],
          skill: {
            stage: "appointment",
            nextObjective: "Gestionar cita existente",
            confidence: 0.95
          },
          source: "appointment-lookup",
          mediaUrl: null
        };
      } else {
        aiResult = {
          reply: "No veo una cita activa con este numero. Si quieres te la agendo ahora, dime dia y hora.",
          intent: "appointment_flow",
          entities: {
            model: null,
            budget: null,
            date: null,
            contact: { email: null, phone: null }
          },
          suggestions: ["Agendar para manana", "Agendar este fin de semana"],
          skill: {
            stage: "appointment",
            nextObjective: "Crear cita nueva",
            confidence: 0.9
          },
          source: "appointment-lookup",
          mediaUrl: null
        };
      }
    } else if (isInventoryOrBrandRequest(message)) {
      try {
        const rows = await listInventory();
        aiResult = {
          reply: buildInventoryReplyForMessage(message, rows),
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
      } catch (error) {
        console.error("inventory-live-db failed:", error?.message || error);
        aiResult = {
          reply: "Tuve un problema temporal consultando inventario. Intenta de nuevo en unos segundos o te ayudo a agendar cita.",
          intent: "buying_interest",
          entities: {
            model: null,
            budget: null,
            date: null,
            contact: { email: null, phone: null }
          },
          suggestions: [
            "Quieres que te pase opciones por tipo (sedan/SUV/pickup)?",
            "Te agendo cita para ver unidades en persona?"
          ],
          skill: {
            stage: "discover",
            nextObjective: "Recuperar consulta de inventario",
            confidence: 0.7
          },
          source: "inventory-live-db-fallback",
          mediaUrl: null
        };
      }
    } else {
      aiResult = await processDealerSessionMessageWithLLM(message, session.context, learningState);
    }

    applyFirstTouchPolicy({ message, context: session.context, aiResult });

    try {
      await saveDealerTurn({
        sessionId,
        userMessage: message,
        aiResult
      });
    } catch (error) {
      console.error("saveDealerTurn failed:", error?.message || error);
    }

    return res.json({
      reply: aiResult.reply,
      intent: aiResult.intent,
      entities: aiResult.entities,
      suggestions: aiResult.suggestions,
      skill: aiResult.skill || null,
      source: aiResult.source || "fallback",
      mediaUrl: aiResult.mediaUrl || null
    });
  } catch (error) {
    console.error("POST /dealer/ai failed:", error?.message || error);
    return res.status(200).json({
      reply: "Hubo un problema temporal. Te puedo ayudar a buscar carro y agendar cita en un momento.",
      intent: "question",
      entities: { model: null, budget: null, date: null, contact: { email: null, phone: null } },
      suggestions: [
        "Que tipo de carro buscas?",
        "Cual es tu presupuesto aproximado?",
        "Quieres agendar una cita?"
      ],
      skill: null,
      source: "route-fallback",
      mediaUrl: null
    });
  }
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
