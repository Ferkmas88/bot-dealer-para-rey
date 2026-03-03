import express from "express";
import twilio from "twilio";
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
import { sendInboundWhatsAppPush } from "../services/pushNotifications.js";
import { sendAppointmentConfirmedOwnerEmail, sendHotLeadHandoffOwnerEmail } from "../services/ownerNotifications.js";

export const twilioWebhookRouter = express.Router();
const cadenceBySession = new Map();
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

function isLowSignalMessage(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return true;
  if (value.length <= 2) return true;
  if (/^[a-z]{3,6}$/.test(value) && !/[aeiou]/.test(value)) return true;
  if (/^(jaja|haha|lol|ok|oki|kk|hmm|mmm|hey)+$/.test(value)) return true;
  return false;
}

function shouldSilenceLowSignalReply(sessionId, text) {
  const now = Date.now();
  const current = cadenceBySession.get(sessionId) || {
    lastInboundAt: 0,
    lastReplyAt: 0,
    lastLowSignalReplyAt: 0
  };

  const lowSignal = isLowSignalMessage(text);
  const rapidInbound = now - current.lastInboundAt < 9000;
  const recentReply = now - current.lastReplyAt < 14000;
  const lowSignalCooldown = now - current.lastLowSignalReplyAt < 45000;

  current.lastInboundAt = now;
  cadenceBySession.set(sessionId, current);

  if (!lowSignal) return { silence: false, lowSignal: false };
  if ((rapidInbound || recentReply) && lowSignalCooldown) {
    return { silence: true, lowSignal: true };
  }

  return { silence: false, lowSignal: true };
}

function markReplySent(sessionId, wasLowSignalReply = false) {
  const now = Date.now();
  const current = cadenceBySession.get(sessionId) || {
    lastInboundAt: now,
    lastReplyAt: 0,
    lastLowSignalReplyAt: 0
  };
  current.lastReplyAt = now;
  if (wasLowSignalReply) {
    current.lastLowSignalReplyAt = now;
  }
  cadenceBySession.set(sessionId, current);
}

function isDuplicateInboundMessage(messageId) {
  const key = String(messageId || "").trim();
  if (!key) return false;
  const now = Date.now();
  const prev = inboundMessageCache.get(key);
  if (prev && now - prev < INBOUND_DEDUP_TTL_MS) return true;
  inboundMessageCache.set(key, now);
  if (inboundMessageCache.size > 2000) {
    for (const [id, ts] of inboundMessageCache.entries()) {
      if (now - ts > INBOUND_DEDUP_TTL_MS) inboundMessageCache.delete(id);
    }
  }
  return false;
}

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
    return {
      handled: true,
      reply: `${BOT_HELPER_PREFIX}\nPerfecto, cita confirmada. Te esperamos. Si necesitas cambiar horario, responde 2.`
    };
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

function validateTwilio(req) {
  const shouldValidate = (process.env.TWILIO_VALIDATE_SIGNATURE || "false") === "true";
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!shouldValidate) return true;
  if (!authToken) return false;

  const signature = req.headers["x-twilio-signature"];
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  return twilio.validateRequest(authToken, signature, url, req.body);
}

twilioWebhookRouter.post("/whatsapp", async (req, res) => {
  if (!validateTwilio(req)) {
    return res.status(403).send("Invalid Twilio signature");
  }

  const from = req.body.From || "unknown";
  const incomingText = req.body.Body || "";
  const sessionId = `wa:${from}`;
  const inboundMessageId = req.body.MessageSid || "";

  if (isDuplicateInboundMessage(inboundMessageId)) {
    const twiml = new twilio.twiml.MessagingResponse();
    return res.type("text/xml").send(twiml.toString());
  }

  try {
    const existingLead = await getLeadBySessionId(sessionId);
    const settings = await getConversationSettings(sessionId);
    const botEnabled = Number(settings?.bot_enabled ?? 1) === 1;
    const hotLead = isHotLead(incomingText);
    const wantsHuman = requestsHuman(incomingText);
    const handoffToHuman = hotLead || wantsHuman;
    const inferredStatus = inferLeadStatus(incomingText);
    await upsertLeadProfile({
      sessionId,
      phone: from.replace(/^whatsapp:/, ""),
      source: "whatsapp",
      language: detectLanguage(incomingText),
      intent: null,
      status: inferredStatus,
      priority: handoffToHuman ? "HIGH" : "NORMAL",
      mode: botEnabled && !handoffToHuman ? "BOT" : "HUMAN",
      lastMessageAt: new Date().toISOString()
    });

    if (handoffToHuman) {
      await persistIncomingUserMessage({
        sessionId,
        userMessage: incomingText,
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

      await persistOutgoingAssistantMessage({
        sessionId,
        assistantMessage: handoffReply,
        source: "human-handoff",
        intent: "handoff"
      });

      sendInboundWhatsAppPush({ sessionId, from, message: incomingText }).catch(() => {});

      const shouldNotifyOwner =
        String(existingLead?.mode || "BOT").toUpperCase() !== "HUMAN" ||
        String(existingLead?.priority || "NORMAL").toUpperCase() !== "HIGH";

      if (shouldNotifyOwner) {
        const openAppt = await getLatestOpenAppointmentForLead(sessionId);
        sendHotLeadHandoffOwnerEmail({
          to: process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com",
          lead: updatedLead,
          appointment: openAppt,
          lastMessage: incomingText
        }).catch(() => {});
      }

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message().body(handoffReply);
      return res.type("text/xml").send(twiml.toString());
    }

    const appointmentFlow = await handleAppointmentFlow({ sessionId, incomingText });
    if (appointmentFlow.handled) {
      await persistIncomingUserMessage({
        sessionId,
        userMessage: incomingText,
        source: "appointment-flow"
      });
      await persistOutgoingAssistantMessage({
        sessionId,
        assistantMessage: appointmentFlow.reply,
        source: "appointment-flow",
        intent: "appointment_flow"
      });
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message().body(appointmentFlow.reply);
      return res.type("text/xml").send(twiml.toString());
    }

    if (!botEnabled) {
      await persistIncomingUserMessage({
        sessionId,
        userMessage: incomingText,
        source: "bot-disabled"
      });
      sendInboundWhatsAppPush({ sessionId, from, message: incomingText }).catch(() => {});

      const twiml = new twilio.twiml.MessagingResponse();
      return res.type("text/xml").send(twiml.toString());
    }

    const cadenceDecision = shouldSilenceLowSignalReply(sessionId, incomingText);
    if (cadenceDecision.silence) {
      await persistIncomingUserMessage({
        sessionId,
        userMessage: incomingText,
        source: "rate-limit-low-signal"
      });
      sendInboundWhatsAppPush({ sessionId, from, message: incomingText }).catch(() => {});
      const twiml = new twilio.twiml.MessagingResponse();
      return res.type("text/xml").send(twiml.toString());
    }

    const session = getDealerSession(sessionId);
    const learningState = getLearningState(sessionId);

    const aiResult = await processDealerSessionMessageWithLLM(
      incomingText,
      session.context,
      learningState
    );

    if (!existingLead) {
      aiResult.reply = `${FIRST_CONTACT_MESSAGE}\n\n${aiResult.reply}`;
    }

    await saveDealerTurn({
      sessionId,
      userMessage: incomingText,
      aiResult
    });
    sendInboundWhatsAppPush({ sessionId, from, message: incomingText }).catch(() => {});

    const twiml = new twilio.twiml.MessagingResponse();
    const msg = twiml.message();
    msg.body(aiResult.reply);
    if (aiResult.mediaUrl) {
      msg.media(aiResult.mediaUrl);
    }

    markReplySent(sessionId, cadenceDecision.lowSignal);

    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("Twilio webhook error:", error);
    res.status(500).send("Server error");
  }
});
