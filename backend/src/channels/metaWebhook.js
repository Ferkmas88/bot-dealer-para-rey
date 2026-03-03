import express from "express";
import { processDealerSessionMessageWithLLM } from "../services/dealerSalesAssistant.js";
import { getDealerSession, getLearningState, saveDealerTurn } from "../services/dealerSessionStore.js";
import {
  createAppointment,
  getConversationSettings,
  getLatestOpenAppointmentForLead,
  persistIncomingUserMessage,
  upsertLeadProfile,
  updateAppointment,
  updateLeadStatus
} from "../services/sqliteLeadStore.js";
import { sendAppointmentConfirmedOwnerEmail } from "../services/ownerNotifications.js";

export const metaWebhookRouter = express.Router();

function detectLanguage(text) {
  if (/[¿¡]|(hola|cita|carro|quiero|manana|direccion)/i.test(text || "")) return "es";
  return "en";
}

function inferLeadStatus(text) {
  if (/(appointment|cita|agendar|agendo|test drive)/i.test(text || "")) return "APPT_PENDING";
  if (/(precio|carro|auto|pickup|suv|sedan|quiero|interesa)/i.test(text || "")) return "QUALIFYING";
  return "NEW";
}

function isHotLead(text) {
  return /(voy hoy|hoy mismo|direccion|llamame|call me|down|enganche|ahora|urgent|urgente)/i.test(text || "");
}

function buildNextAppointmentOptions() {
  const now = new Date();
  const option1 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  option1.setHours(11, 0, 0, 0);
  const option2 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  option2.setHours(16, 0, 0, 0);
  return [option1.toISOString(), option2.toISOString()];
}

function formatOptionLine(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function handleAppointmentFlow({ sessionId, incomingText }) {
  const text = String(incomingText || "").trim().toLowerCase();
  const openAppt = await getLatestOpenAppointmentForLead(sessionId);

  if (openAppt && /^\s*1\s*$/.test(text) && openAppt.confirmation_state === "AWAITING_CONFIRMATION") {
    const confirmed = await updateAppointment(openAppt.id, {
      status: "CONFIRMED",
      confirmation_state: "CONFIRMED",
      confirmed_at: new Date().toISOString()
    });
    const lead = await updateLeadStatus(sessionId, "BOOKED");
    await sendAppointmentConfirmedOwnerEmail({
      to: process.env.OWNER_NOTIFICATION_EMAIL || "rey1309ltu@gmail.com",
      appointment: confirmed,
      lead
    });
    return { handled: true, reply: "Perfecto, cita confirmada. Te esperamos. Si necesitas cambiar horario, responde 2." };
  }

  if (openAppt && /^\s*2\s*$/.test(text)) {
    const options = buildNextAppointmentOptions();
    await updateAppointment(openAppt.id, {
      status: "RESCHEDULED",
      confirmation_state: "AWAITING_CONFIRMATION",
      proposal_options: options
    });
    return {
      handled: true,
      reply: `Claro, te doy dos horarios nuevos:\n1) ${formatOptionLine(options[0])}\n2) ${formatOptionLine(options[1])}\nResponde 1 o 2.`
    };
  }

  if (/agendar|cita|appointment|test drive|visita/i.test(text) && !openAppt) {
    const options = buildNextAppointmentOptions();
    await createAppointment({
      lead_session_id: sessionId,
      scheduled_at: options[0],
      status: "PENDING",
      confirmation_state: "AWAITING_CONFIRMATION",
      proposal_options: options
    });
    await updateLeadStatus(sessionId, "APPT_PENDING");
    return {
      handled: true,
      reply: `Te propongo:\n1) ${formatOptionLine(options[0])}\n2) ${formatOptionLine(options[1])}\nElige una opcion y luego te envio confirmacion final.`
    };
  }

  return { handled: false };
}

function getMetaConfig() {
  return {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION || "v21.0"
  };
}

function extractIncomingMessages(payload) {
  const incoming = [];

  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const messages = Array.isArray(value?.messages) ? value.messages : [];

      for (const message of messages) {
        const from = message?.from;
        const msgType = message?.type;

        if (!from) continue;

        let body = "";
        if (msgType === "text") {
          body = message?.text?.body || "";
        } else if (msgType === "button") {
          body = message?.button?.text || "";
        } else if (msgType === "interactive") {
          body = message?.interactive?.button_reply?.title || message?.interactive?.list_reply?.title || "";
        }

        if (!body.trim()) continue;

        incoming.push({
          from,
          body,
          profileName: value?.contacts?.[0]?.profile?.name || null,
          messageId: message?.id || null
        });
      }
    }
  }

  return incoming;
}

async function sendWhatsAppText({ to, text }) {
  const cfg = getMetaConfig();

  if (!cfg.accessToken || !cfg.phoneNumberId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is missing");
  }

  const url = `https://graph.facebook.com/${cfg.graphApiVersion}/${cfg.phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body: text }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meta send failed (${response.status}): ${errorText}`);
  }
}

metaWebhookRouter.get("/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const cfg = getMetaConfig();

  if (mode === "subscribe" && token && token === cfg.verifyToken) {
    return res.status(200).send(challenge);
  }

  return res.status(403).send("Verification failed");
});

metaWebhookRouter.post("/whatsapp", async (req, res) => {
  const incoming = extractIncomingMessages(req.body);

  if (!incoming.length) {
    return res.status(200).json({ ok: true, processed: 0 });
  }

  try {
    for (const msg of incoming) {
      const sessionId = `wa_meta:${msg.from}`;
      const settings = await getConversationSettings(sessionId);
      const botEnabled = Number(settings?.bot_enabled ?? 1) === 1;
      await upsertLeadProfile({
        sessionId,
        phone: `+${msg.from}`,
        name: msg.profileName || null,
        source: "whatsapp",
        language: detectLanguage(msg.body),
        status: inferLeadStatus(msg.body),
        priority: isHotLead(msg.body) ? "HIGH" : "NORMAL",
        mode: botEnabled ? "BOT" : "HUMAN",
        lastMessageAt: new Date().toISOString()
      });

      const appointmentFlow = await handleAppointmentFlow({ sessionId, incomingText: msg.body });
      if (appointmentFlow.handled) {
        await sendWhatsAppText({
          to: msg.from,
          text: appointmentFlow.reply
        });
        continue;
      }

      if (!botEnabled) {
        await persistIncomingUserMessage({
          sessionId,
          userMessage: msg.body,
          source: "bot-disabled"
        });
        continue;
      }

      const session = getDealerSession(sessionId);
      const learningState = getLearningState(sessionId);

      const aiResult = await processDealerSessionMessageWithLLM(msg.body, session.context, learningState);

      await saveDealerTurn({
        sessionId,
        userMessage: msg.body,
        aiResult
      });

      await sendWhatsAppText({
        to: msg.from,
        text: aiResult.reply
      });
    }

    return res.status(200).json({ ok: true, processed: incoming.length });
  } catch (error) {
    console.error("Meta WhatsApp webhook error:", error);
    return res.status(500).json({ ok: false, error: "Webhook processing failed" });
  }
});
