import express from "express";
import twilio from "twilio";
import { processDealerSessionMessageWithLLM } from "../services/dealerSalesAssistant.js";
import { getDealerSession, getLearningState, saveDealerTurn } from "../services/dealerSessionStore.js";
import {
  createAppointment,
  getConversationSettings,
  getLeadBySessionId,
  hasWelcomeMessageSent,
  isAppointmentSlotAvailable,
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
const FIRST_CONTACT_MESSAGE =
  "Hola 👋\n" +
  "Soy el asistente automático de Empire Rey Auto Sales. Estoy disponible 24/7 para ayudarte.\n\n" +
  "Puedo ayudarte a:\n" +
  "• Encontrar el carro que necesitas\n" +
  "• Agendar una cita en el dealer\n" +
  "• Conectarte directamente con Rey\n" +
  "• Contactar a nuestro mecánico";
const DEALER_ADDRESS_TEXT = "3510 Dixie Hwy, Louisville, KY 40216";
const MECHANIC_CONTACT_REPLY = "Sobre el mecanico: pronto estara disponible su contacto.";
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

function isGreetingOnlyMessage(text) {
  return /^(hola+(\s+\w+)?|hello+|hi+|hey+|holi+|ola+|buenas|buen dia|buenos dias|buenas tardes|buenas noches|saludos|que tal|hola bot|good morning|good evening)\s*$/i.test(String(text || "").trim());
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

function asksAddress(text) {
  return /(direccion|direcci[oó]n|ubicacion|ubicaci[oó]n|donde estan|d[oó]nde est[aá]n|address|location|mapa|maps)/i.test(
    String(text || "")
  );
}

function asksMechanic(text) {
  return /(mecanico|mec[aá]nico|mechanic|servicio mecanico|servicio mec[aá]nico|taller)/i.test(String(text || ""));
}

function buildNextAppointmentOptions() {
  const now = new Date();
  const option1 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  option1.setHours(11, 0, 0, 0);
  const option2 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  option2.setHours(16, 0, 0, 0);
  return [option1.toISOString(), option2.toISOString()];
}

async function buildAvailableAppointmentOptions({ excludeAppointmentId = null } = {}) {
  const base = new Date();
  const candidates = [];
  const hours = [11, 13, 15, 16, 17];
  for (let d = 0; d < 7; d += 1) {
    for (const h of hours) {
      const slot = new Date(base);
      slot.setDate(base.getDate() + d);
      slot.setHours(h, 0, 0, 0);
      if (slot.getTime() <= Date.now()) continue;
      candidates.push(slot.toISOString());
    }
  }

  const free = [];
  for (const candidate of candidates) {
    const ok = await isAppointmentSlotAvailable({
      scheduledAt: candidate,
      excludeAppointmentId,
      windowMinutes: 45
    });
    if (ok) free.push(candidate);
    if (free.length >= 2) break;
  }
  return free.length ? free : buildNextAppointmentOptions();
}

function formatOptionLine(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function parseRequestedDateTime(text) {
  const raw = String(text || "").toLowerCase();
  const dayOffset = /manana|mañana|ma\?ana|tomorrow/.test(raw) ? 1 : /hoy|today/.test(raw) ? 0 : null;
  const parsedTime = parseRequestedTime(raw);
  if (dayOffset === null || !parsedTime) return null;

  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(parsedTime.hour24, parsedTime.minute, 0, 0);
  return date.toISOString();
}

function parseRequestedDay(text) {
  const raw = String(text || "").toLowerCase();
  if (/hoy|today/.test(raw)) return "hoy";
  if (/manana|mañana|ma\?ana|tomorrow/.test(raw)) return "manana";
  return null;
}

function parseRequestedTime(text) {
  const raw = String(text || "").toLowerCase();
  const timeMatch = raw.match(/\b([0-1]?\d)(?::([0-5]\d))?\s*(am|pm)\b/);
  if (timeMatch) {
    const hour12 = Number(timeMatch[1]);
    if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12) return null;
    const minute = Number(timeMatch[2] || "0");
    const meridiem = timeMatch[3];
    let hour24 = hour12 % 12;
    if (meridiem === "pm") hour24 += 12;
    return { hour24, minute };
  }

  // Soporta frases como "a las 4", "4:30", "16:00"
  const fallback = raw.match(/(?:\ba\s*las\b|\blas\b|\b)([01]?\d|2[0-3])(?::([0-5]\d))?\b/);
  if (!fallback) return null;
  const hourRaw = Number(fallback[1]);
  const minute = Number(fallback[2] || "0");
  if (!Number.isFinite(hourRaw) || hourRaw < 0 || hourRaw > 23) return null;

  let hour24 = hourRaw;
  if (hourRaw >= 1 && hourRaw <= 12) {
    if (/\b(pm|p\.m\.|tarde|noche)\b/.test(raw)) {
      hour24 = hourRaw % 12 + 12;
    } else if (/\b(am|a\.m\.|manana|mañana)\b/.test(raw)) {
      hour24 = hourRaw % 12;
    } else if (hourRaw >= 1 && hourRaw <= 7) {
      hour24 = hourRaw + 12;
    } else if (hourRaw === 12) {
      hour24 = 12;
    }
  }

  return { hour24, minute };
}

function composeIsoFromDayAndTime(day, time) {
  if (!day || !time) return null;
  const date = new Date();
  if (day === "manana") date.setDate(date.getDate() + 1);
  date.setHours(time.hour24, time.minute, 0, 0);
  return date.toISOString();
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

function extractLooseCustomerName(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (/\d/.test(raw)) return null;
  if (/[!?.,:;/$]/.test(raw)) return null;
  const normalized = raw
    .replace(/^(soy|i am)\s+/i, "")
    .replace(/^(me llamo|mi nombre es|my name is)\s+/i, "")
    .trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (
    /^(hola|hello|hi|hey|holi|ola|saludos|que tal|hola bot|good morning|good evening|buen dia|ok|okay|si|yes|no|quiero|cita|agendar|agenda|hoy|manana|mañana|ma\?ana|confirmar|reprogramar|cancelar)$/.test(
      lower
    )
  ) {
    return null;
  }
  if (/(quiero|cita|agendar|agenda|appointment|mecanico|mec[aá]nico|servicio|carro|auto|pickup|suv|sedan|hoy|manana|mañana|ma\?ana|por la tarde)/i.test(lower)) {
    return null;
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 3) return null;
  if (!tokens.every((token) => /^[a-zA-ZÀ-ÿ' -]{2,20}$/.test(token))) return null;
  return normalized;
}

function asksOwnAppointment(text) {
  return /(mi cita|tengo cita|ya tengo cita|cuando es mi cita|hora de mi cita|a que hora|qué hora|que hora|appointment)/i.test(
    text || ""
  );
}

async function handleAppointmentFlow({ sessionId, incomingText, lead = null }) {
  const text = String(incomingText || "").trim().toLowerCase();
  const openAppt = await getLatestOpenAppointmentForLead(sessionId);
  let requestedAt = parseRequestedDateTime(text);
  const dayOnly = parseRequestedDay(text);
  const timeOnly = parseRequestedTime(text);
  if (!requestedAt && dayOnly && timeOnly) {
    requestedAt = composeIsoFromDayAndTime(dayOnly, timeOnly);
  } else if (!requestedAt && dayOnly && !timeOnly) {
    await upsertLeadProfile({ sessionId, datePref: dayOnly, lastMessageAt: new Date().toISOString() });
  } else if (!requestedAt && !dayOnly && timeOnly && lead?.date_pref) {
    requestedAt = composeIsoFromDayAndTime(String(lead.date_pref || "").toLowerCase(), timeOnly);
  }
  const providedName = extractLooseCustomerName(incomingText);

  if (openAppt && isCancelAction(text)) {
    await updateAppointment(openAppt.id, {
      status: "CANCELLED",
      confirmation_state: "CANCELLED",
      cancelled_at: new Date().toISOString()
    });
    await updateLeadStatus(sessionId, "NO_RESPONSE");
    return {
      handled: true,
      reply: "Entendido, cita cancelada. Cuando quieras reagendar, te comparto nuevas opciones."
    };
  }

  if (openAppt && isOneChoice(text) && openAppt.confirmation_state === "PROPOSED") {
    const options = Array.isArray(openAppt.proposal_options) ? openAppt.proposal_options : [];
    const selectedAt = options[0] || openAppt.scheduled_at;
    const confirmed = await updateAppointment(openAppt.id, {
      scheduled_at: selectedAt,
      status: "CONFIRMED",
      confirmation_state: "CONFIRMED",
      confirmed_at: new Date().toISOString()
    });
    const leadRow = await updateLeadStatus(sessionId, "BOOKED");
    await sendAppointmentConfirmedOwnerEmail({
      to: process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com",
      appointment: confirmed,
      lead: leadRow
    });
    return {
      handled: true,
      reply: `Listo, tu cita quedo confirmada para ${formatOptionLine(selectedAt)}.\nDireccion: ${DEALER_ADDRESS_TEXT}\nSi quieres cambiarla, dime reprogramar.`
    };
  }

  if (openAppt && requestedAt && openAppt.confirmation_state === "PROPOSED") {
    const slotAvailable = await isAppointmentSlotAvailable({
      scheduledAt: requestedAt,
      excludeAppointmentId: openAppt.id,
      windowMinutes: 45
    });
    if (!slotAvailable) {
      const options = await buildAvailableAppointmentOptions({ excludeAppointmentId: openAppt.id });
      return {
        handled: true,
        reply: `Ese horario ya esta ocupado. Tengo disponible ${formatOptionLine(options[0])} o ${formatOptionLine(options[1])}. Dime cual prefieres.`
      };
    }
    const confirmed = await updateAppointment(openAppt.id, {
      scheduled_at: requestedAt,
      status: "CONFIRMED",
      confirmation_state: "CONFIRMED",
      confirmed_at: new Date().toISOString()
    });
    const leadRow = await updateLeadStatus(sessionId, "BOOKED");
    await sendAppointmentConfirmedOwnerEmail({
      to: process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com",
      appointment: confirmed,
      lead: leadRow
    });
    return {
      handled: true,
      reply: `Perfecto, tu cita quedo confirmada para ${formatOptionLine(requestedAt)}.\nDireccion: ${DEALER_ADDRESS_TEXT}\nTelefono de contacto: ${lead?.phone || "compartemelo por favor"}.`
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
      reply: `Perfecto, la movi a ${formatOptionLine(selectedAt)}. Si quieres otro horario, dime reprogramar.`
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
      reply: `Perfecto, cita confirmada para ${formatOptionLine(openAppt.scheduled_at)}.\nDireccion: ${DEALER_ADDRESS_TEXT}\nSi necesitas cambiar horario, dime reprogramar.`
    };
  }

  if (openAppt && providedName) {
    await upsertLeadProfile({
      sessionId,
      name: providedName,
      lastMessageAt: new Date().toISOString()
    });
    if (openAppt.confirmation_state === "AWAITING_CONFIRMATION") {
      return {
        handled: true,
        reply: `Perfecto, ${providedName}. Ya tengo tu nombre.\nTu cita sigue para ${formatOptionLine(openAppt.scheduled_at)}.\nConfirmame tu telefono de contacto para cerrar datos.`
      };
    }
    if (openAppt.confirmation_state === "PROPOSED") {
      const options = Array.isArray(openAppt.proposal_options) ? openAppt.proposal_options : [];
      return {
        handled: true,
        reply: `Gracias, ${providedName}. Ahora dime dia y hora exacta para agendar (ejemplo: hoy 4pm). Horarios sugeridos: ${formatOptionLine(options[0] || openAppt.scheduled_at)} o ${formatOptionLine(options[1] || openAppt.scheduled_at)}.`
      };
    }
  }

  if (openAppt && (isRescheduleAction(text) || isTwoChoice(text))) {
    const options = await buildAvailableAppointmentOptions({ excludeAppointmentId: openAppt.id });
    await updateAppointment(openAppt.id, {
      status: "RESCHEDULED",
      confirmation_state: "PROPOSED",
      proposal_options: options
    });
    return {
      handled: true,
      reply: `Claro, te doy horarios nuevos: ${formatOptionLine(options[0])} o ${formatOptionLine(options[1])}. Dime cual te funciona y te la dejo lista.`
    };
  }

  if (openAppt && isConfirmAction(text) && openAppt.confirmation_state === "CONFIRMED") {
    return {
      handled: true,
      reply: "Tu cita ya esta confirmada. Si quieres cambiarla, responde reprogramar."
    };
  }

  if (openAppt && asksOwnAppointment(text)) {
    const status = String(openAppt.status || "PENDING").toUpperCase();
    return {
      handled: true,
      reply: `Si, tienes una cita ${status} para ${formatOptionLine(openAppt.scheduled_at)}.\nDireccion: ${DEALER_ADDRESS_TEXT}\nSi quieres cambiarla, responde reprogramar.`
    };
  }

  if (!openAppt && asksOwnAppointment(text)) {
    return {
      handled: true,
      reply: "No veo una cita activa en este momento. Si quieres, te la agendo ahora mismo. Dime dia y hora exacta."
    };
  }

  // Si ya tenemos fecha/hora exacta, crea la cita aunque no repita la palabra "cita".
  if (!openAppt && requestedAt) {
    const options = await buildAvailableAppointmentOptions();
    const initialAt = requestedAt;
    const slotAvailable = await isAppointmentSlotAvailable({
      scheduledAt: initialAt,
      windowMinutes: 45
    });
    if (!slotAvailable) {
      return {
        handled: true,
        reply: `Ese horario ya esta ocupado. Tengo disponible ${formatOptionLine(options[0])} o ${formatOptionLine(options[1])}. Dime cual prefieres.`
      };
    }
    await createAppointment({
      lead_session_id: sessionId,
      scheduled_at: initialAt,
      status: "CONFIRMED",
      confirmation_state: "CONFIRMED",
      confirmed_at: new Date().toISOString(),
      proposal_options: options
    });
    const leadRow = await updateLeadStatus(sessionId, "BOOKED");
    const confirmed = await getLatestOpenAppointmentForLead(sessionId);
    await sendAppointmentConfirmedOwnerEmail({
      to: process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com",
      appointment: confirmed,
      lead: leadRow
    });
    return {
      handled: true,
      reply: `Perfecto, te agende para ${formatOptionLine(requestedAt)}.\nDireccion: ${DEALER_ADDRESS_TEXT}\nTelefono de contacto: ${lead?.phone || "compartemelo por favor"}.\nSi quieres cambiar el horario, dime reprogramar.`
    };
  }

  if (/agendar|cita|appointment|test drive|visita/i.test(text) && !openAppt) {
    return {
      handled: true,
      reply: "Claro. Para cuando quieres la cita? Dime dia y hora exacta (por ejemplo: hoy 4pm o manana 11am)."
    };
  }

  if (!openAppt && providedName) {
    await upsertLeadProfile({
      sessionId,
      name: providedName,
      lastMessageAt: new Date().toISOString()
    });
    if (lead?.date_pref) {
      return {
        handled: true,
        reply: `Perfecto, ${providedName}. Ya tengo tu nombre. Ahora dime la hora exacta para ${lead.date_pref} (ejemplo: 11am, 2pm o 4pm).`
      };
    }
    return {
      handled: true,
      reply: `Perfecto, ${providedName}. Ahora dime dia y hora exacta para agendar tu cita (ejemplo: hoy 4pm o manana 11am).`
    };
  }

  if (!openAppt && dayOnly && !timeOnly) {
    return {
      handled: true,
      reply: `Perfecto. Te ayudo para ${dayOnly}. Que hora exacta te funciona? (ejemplo: 11am, 2pm o 4pm)`
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
  const inboundProfileName = String(req.body.ProfileName || req.body.WaName || "").trim();
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
      name: inboundProfileName || existingLead?.name || null,
      source: "whatsapp",
      language: detectLanguage(incomingText),
      intent: null,
      status: inferredStatus,
      priority: handoffToHuman ? "HIGH" : "NORMAL",
      mode: botEnabled && !handoffToHuman ? "BOT" : "HUMAN",
      lastMessageAt: new Date().toISOString()
    });

    if (isGreetingOnlyMessage(incomingText)) {
      const welcomeAlreadySent = await hasWelcomeMessageSent(sessionId);
      const greetingReply = welcomeAlreadySent
        ? "Hola. Dime que buscas (SUV, sedan o pickup) y tu down payment, y te ayudo ahora mismo."
        : FIRST_CONTACT_MESSAGE;
      await persistIncomingUserMessage({
        sessionId,
        userMessage: incomingText,
        source: "greeting-fastpath"
      });
      await persistOutgoingAssistantMessage({
        sessionId,
        assistantMessage: greetingReply,
        source: "greeting-fastpath",
        intent: "welcome"
      });
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message().body(greetingReply);
      return res.type("text/xml").send(twiml.toString());
    }

    if (asksAddress(incomingText)) {
      const addressReply = DEALER_ADDRESS_TEXT;
      await persistIncomingUserMessage({
        sessionId,
        userMessage: incomingText,
        source: "address-fastpath"
      });
      await persistOutgoingAssistantMessage({
        sessionId,
        assistantMessage: addressReply,
        source: "address-fastpath",
        intent: "location"
      });
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message().body(addressReply);
      return res.type("text/xml").send(twiml.toString());
    }

    if (asksMechanic(incomingText)) {
      const mechanicReply = MECHANIC_CONTACT_REPLY;
      await persistIncomingUserMessage({
        sessionId,
        userMessage: incomingText,
        source: "mechanic-fastpath"
      });
      await persistOutgoingAssistantMessage({
        sessionId,
        assistantMessage: mechanicReply,
        source: "mechanic-fastpath",
        intent: "service_info"
      });
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message().body(mechanicReply);
      return res.type("text/xml").send(twiml.toString());
    }

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

    const appointmentFlow = await handleAppointmentFlow({ sessionId, incomingText, lead: existingLead });
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
