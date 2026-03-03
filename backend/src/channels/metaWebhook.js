import express from "express";
import { processDealerSessionMessageWithLLM } from "../services/dealerSalesAssistant.js";
import { getDealerSession, getLearningState, saveDealerTurn } from "../services/dealerSessionStore.js";
import {
  createAppointment,
  getConversationSettings,
  getLeadBySessionId,
  getLatestOpenAppointmentForLead,
  persistIncomingUserMessage,
  persistOutgoingAssistantMessage,
  upsertLeadProfile,
  updateAppointment,
  updateLeadStatus
} from "../services/sqliteLeadStore.js";
import { sendAppointmentConfirmedOwnerEmail, sendHotLeadHandoffOwnerEmail } from "../services/ownerNotifications.js";

export const metaWebhookRouter = express.Router();
const BOT_HELPER_PREFIX = "Soy el bot asistente de Empire Rey y te estoy ayudando 24/7.";
const FIRST_CONTACT_MESSAGE =
  "Hola. Soy el asistente automatico de Empire Rey Auto Sales. Estoy aqui 24/7 para ayudarte.\n\n" +
  "Puedo ayudarte a:\n" +
  "- Buscar el carro que estas necesitando\n" +
  "- Agendar tu cita en el dealer\n" +
  "- Ponerte en contacto directo con Rey\n" +
  "- Conectarte con nuestro mecanico para servicio o preguntas\n" +
  "- Responder dudas sobre down payment, credito o requisitos\n\n" +
  "3510 Dixie Hwy, Louisville, KY 40216\n" +
  "502-576-8116 | 502-780-1096\n\n" +
  "Dime que estas buscando (SUV, sedan o pickup) y cuanto tienes para down, y empezamos ahora mismo.\n\n" +
  "Si prefieres atencion directa, te conecto con el equipo ahora mismo.";
const inboundMessageCache = new Map();
const INBOUND_DEDUP_TTL_MS = 10 * 60 * 1000;

function detectLanguage(text) {
  if (/[¿¡]|(hola|cita|carro|quiero|manana|direccion)/i.test(text || "")) return "es";
  return "en";
}

function isGreetingOnlyMessage(text) {
  return /^(hola+|hello+|hi+|buenas|buenos dias|buenas tardes|buenas noches)\s*$/i.test(String(text || "").trim());
}

function inferLeadStatus(text) {
  if (/(appointment|cita|agendar|agendo|test drive)/i.test(text || "")) return "APPT_PENDING";
  if (/(precio|carro|auto|pickup|suv|sedan|quiero|interesa)/i.test(text || "")) return "QUALIFYING";
  return "NEW";
}

function isHotLead(text) {
  return /(voy hoy|hoy mismo|direccion|llamame|call me|down|enganche|ahora|urgent|urgente)/i.test(text || "");
}

function requestsHuman(text) {
  return /(humano|asesor|agent|agente|persona|representante|equipo|team|alguien|atencion directa|persona real)/i.test(
    text || ""
  );
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

function isOneChoice(text) {
  return /^\s*1\s*$/.test(text) || /^(opcion|option)\s*1\b/i.test(text);
}

function isTwoChoice(text) {
  return /^\s*2\s*$/.test(text) || /^(opcion|option)\s*2\b/i.test(text);
}

function isConfirmAction(text) {
  return /^(confirmar|confirm|confirmo|confirmed|si confirmo|ok confirmo)\b/i.test(text);
}

function isRescheduleAction(text) {
  return /^(reprogramar|reagendar|cambiar|change|reschedule)\b/i.test(text);
}

function isCancelAction(text) {
  return /^(cancelar|cancela|cancel|no puedo|no podre|can'?t make it|cannot make it)\b/i.test(text);
}

async function handleAppointmentFlow({ sessionId, incomingText }) {
  const text = String(incomingText || "").trim().toLowerCase();
  const openAppt = await getLatestOpenAppointmentForLead(sessionId);

  if (openAppt && isCancelAction(text)) {
    await updateAppointment(openAppt.id, {
      status: "CANCELLED",
      confirmation_state: "CANCELLED",
      cancelled_at: new Date().toISOString()
    });
    await updateLeadStatus(sessionId, "NO_RESPONSE");
    return {
      handled: true,
      reply: `${BOT_HELPER_PREFIX}\nEntendido, cita cancelada. Cuando quieras reagendar, te comparto nuevas opciones.`
    };
  }

  if (openAppt && isOneChoice(text) && openAppt.confirmation_state === "PROPOSED") {
    const options = Array.isArray(openAppt.proposal_options) ? openAppt.proposal_options : [];
    const selectedAt = options[0] || openAppt.scheduled_at;
    await updateAppointment(openAppt.id, {
      scheduled_at: selectedAt,
      status: "PENDING",
      confirmation_state: "AWAITING_CONFIRMATION"
    });
    return {
      handled: true,
      reply: `${BOT_HELPER_PREFIX}\nResumen de tu cita:\nFecha/Hora: ${formatOptionLine(selectedAt)}\nResponde:\n1 confirmar\n2 cambiar`
    };
  }

  if (openAppt && isTwoChoice(text) && openAppt.confirmation_state === "PROPOSED") {
    const options = Array.isArray(openAppt.proposal_options) ? openAppt.proposal_options : [];
    const selectedAt = options[1] || options[0] || openAppt.scheduled_at;
    await updateAppointment(openAppt.id, {
      scheduled_at: selectedAt,
      status: "PENDING",
      confirmation_state: "AWAITING_CONFIRMATION"
    });
    return {
      handled: true,
      reply: `${BOT_HELPER_PREFIX}\nResumen de tu cita:\nFecha/Hora: ${formatOptionLine(selectedAt)}\nResponde:\n1 confirmar\n2 cambiar`
    };
  }

  if (openAppt && (isConfirmAction(text) || isOneChoice(text)) && openAppt.confirmation_state === "AWAITING_CONFIRMATION") {
    const confirmed = await updateAppointment(openAppt.id, {
      status: "CONFIRMED",
      confirmation_state: "CONFIRMED",
      confirmed_at: new Date().toISOString()
    });
    const lead = await updateLeadStatus(sessionId, "BOOKED");
    await sendAppointmentConfirmedOwnerEmail({
      to: process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com",
      appointment: confirmed,
      lead
    });
    return { handled: true, reply: `${BOT_HELPER_PREFIX}\nPerfecto, cita confirmada. Te esperamos. Si necesitas cambiar horario, responde 2.` };
  }

  if (openAppt && (isRescheduleAction(text) || isTwoChoice(text))) {
    const options = buildNextAppointmentOptions();
    await updateAppointment(openAppt.id, {
      status: "RESCHEDULED",
      confirmation_state: "PROPOSED",
      proposal_options: options
    });
    return {
      handled: true,
      reply: `${BOT_HELPER_PREFIX}\nClaro, te doy dos horarios nuevos:\n1) ${formatOptionLine(options[0])}\n2) ${formatOptionLine(options[1])}\nElige 1 o 2 y luego te pido confirmacion final.`
    };
  }

  if (openAppt && isConfirmAction(text) && openAppt.confirmation_state === "CONFIRMED") {
    return {
      handled: true,
      reply: `${BOT_HELPER_PREFIX}\nTu cita ya esta confirmada. Si quieres cambiarla, responde reprogramar.`
    };
  }

  if (/agendar|cita|appointment|test drive|visita/i.test(text) && !openAppt) {
    const options = buildNextAppointmentOptions();
    await createAppointment({
      lead_session_id: sessionId,
      scheduled_at: options[0],
      status: "PENDING",
      confirmation_state: "PROPOSED",
      proposal_options: options
    });
    await updateLeadStatus(sessionId, "APPT_PENDING");
    return {
      handled: true,
      reply: `${BOT_HELPER_PREFIX}\nTe propongo:\n1) ${formatOptionLine(options[0])}\n2) ${formatOptionLine(options[1])}\nElige una opcion y luego te envio confirmacion final.`
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

function isDuplicateInboundMessage(messageId) {
  const key = String(messageId || "").trim();
  if (!key) return false;
  const now = Date.now();
  const prev = inboundMessageCache.get(key);
  if (prev && now - prev < INBOUND_DEDUP_TTL_MS) return true;
  inboundMessageCache.set(key, now);
  if (inboundMessageCache.size > 3000) {
    for (const [id, ts] of inboundMessageCache.entries()) {
      if (now - ts > INBOUND_DEDUP_TTL_MS) inboundMessageCache.delete(id);
    }
  }
  return false;
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
      if (isDuplicateInboundMessage(msg.messageId)) {
        continue;
      }
      const sessionId = `wa_meta:${msg.from}`;
      const existingLead = await getLeadBySessionId(sessionId);
      const settings = await getConversationSettings(sessionId);
      const botEnabled = Number(settings?.bot_enabled ?? 1) === 1;
      const hotLead = isHotLead(msg.body);
      const wantsHuman = requestsHuman(msg.body);
      const handoffToHuman = hotLead || wantsHuman;
      const inferredStatus = inferLeadStatus(msg.body);
      await upsertLeadProfile({
        sessionId,
        phone: `+${msg.from}`,
        name: msg.profileName || null,
        source: "whatsapp",
        language: detectLanguage(msg.body),
        status: inferredStatus,
        priority: handoffToHuman ? "HIGH" : "NORMAL",
        mode: botEnabled && !handoffToHuman ? "BOT" : "HUMAN",
        lastMessageAt: new Date().toISOString()
      });

      if (isGreetingOnlyMessage(msg.body)) {
        await persistIncomingUserMessage({
          sessionId,
          userMessage: msg.body,
          source: "greeting-fastpath"
        });
        await sendWhatsAppText({
          to: msg.from,
          text: FIRST_CONTACT_MESSAGE
        });
        await persistOutgoingAssistantMessage({
          sessionId,
          assistantMessage: FIRST_CONTACT_MESSAGE,
          source: "greeting-fastpath",
          intent: "welcome"
        });
        continue;
      }

      if (handoffToHuman) {
        await persistIncomingUserMessage({
          sessionId,
          userMessage: msg.body,
          source: wantsHuman ? "requested-human" : "hot-lead-handoff"
        });

        const updatedLead = await updateLeadStatus(
          sessionId,
          inferredStatus === "APPT_PENDING" ? "APPT_PENDING" : "QUALIFIED",
          {
            priority: "HIGH",
            mode: "HUMAN"
          }
        );

        const handoffReply = wantsHuman
          ? "Claro. Si quieres hablar con alguien del equipo, contacta directo a Rey:\n+1 (502) 576-8116\nEmpire Rey"
          : "Veo interes urgente. Te conecto con un asesor humano ahora mismo para atenderte mas rapido.";

        await sendWhatsAppText({
          to: msg.from,
          text: handoffReply
        });
        await persistOutgoingAssistantMessage({
          sessionId,
          assistantMessage: handoffReply,
          source: "human-handoff",
          intent: "handoff"
        });

        const shouldNotifyOwner =
          String(existingLead?.mode || "BOT").toUpperCase() !== "HUMAN" ||
          String(existingLead?.priority || "NORMAL").toUpperCase() !== "HIGH";
        if (shouldNotifyOwner) {
          const openAppt = await getLatestOpenAppointmentForLead(sessionId);
          sendHotLeadHandoffOwnerEmail({
            to: process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com",
            lead: updatedLead,
            appointment: openAppt,
            lastMessage: msg.body
          }).catch(() => {});
        }

        continue;
      }

      const appointmentFlow = await handleAppointmentFlow({ sessionId, incomingText: msg.body });
      if (appointmentFlow.handled) {
        await persistIncomingUserMessage({
          sessionId,
          userMessage: msg.body,
          source: "appointment-flow"
        });
        await sendWhatsAppText({
          to: msg.from,
          text: appointmentFlow.reply
        });
        await persistOutgoingAssistantMessage({
          sessionId,
          assistantMessage: appointmentFlow.reply,
          source: "appointment-flow",
          intent: "appointment_flow"
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
      if (!existingLead) {
        aiResult.reply = `${FIRST_CONTACT_MESSAGE}\n\n${aiResult.reply}`;
      }

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
