import { createHash } from "node:crypto";
import { applyFirstTouchPolicy, handleDealerMessage } from "./dealerSalesAssistant.js";
import { hasAnyLlmProvider } from "./openaiClient.js";
import { getDealerSession, getLearningState, saveDealerTurn } from "./dealerSessionStore.js";
import {
  cleanupProcessedInboundMessages,
  createAppointment,
  getConversationSettings,
  getLeadBySessionId,
  getLatestAssistantIntroAt,
  getLatestOpenAppointmentForLead,
  isAppointmentSlotAvailable,
  markProcessedInboundMessage,
  persistConversationEvent,
  persistIncomingUserMessage,
  persistOutgoingAssistantMessage,
  upsertLeadProfile,
  updateAppointment,
  updateLeadStatus
} from "./sqliteLeadStore.js";
import {
  sendAppointmentConfirmedOwnerEmail,
  sendAppointmentCreatedOwnerEmail,
  sendHotLeadHandoffOwnerEmail
} from "./ownerNotifications.js";

const DEALER_ADDRESS_TEXT = "3510 Dixie Hwy, Louisville, KY 40216";
const MECHANIC_CONTACT_REPLY =
  "Si, contamos con servicio mecanico. Pronto tendremos esa informacion disponible.";
const MENU_ENTRY_REPLY =
  "Hola 👋 Soy el asistente de Empire Rey Auto Sales.\n\n" +
  "¿En que te ayudo hoy?\n\n" +
  "1️⃣ Buscar un carro\n" +
  "2️⃣ Agendar una cita\n" +
  "3️⃣ Comunicarte con Rey\n" +
  "4️⃣ Comunicarte con el mecanico\n\n" +
  "Escribe el numero o dime que necesitas.";
const BUSINESS_HOURS_REPLY =
  "Trabajamos de lunes a sabado de 11:00 AM a 8:00 PM y domingo de 11:00 AM a 4:00 PM. Si quieres, te agendo cita para visitarnos.";
const TRADE_IN_REPLY =
  "Si, recibimos tu auto usado como parte de pago. Comparte ano, marca, modelo y millaje para darte un estimado rapido.";
const DOCS_REPLY =
  "Para avanzar normalmente pedimos ID o licencia vigente, comprobante de ingreso y direccion. Si tienes ITIN tambien te apoyamos.";
const FINANCE_FASTPATH_REPLY =
  "Si, te podemos ayudar con aprobacion aunque tengas credito bajo o sin historial. Tambien trabajamos con ITIN/ID. Dime tu down payment aproximado y pago semanal objetivo.";
const NO_LLM_FALLBACK_REPLY =
  "Ahora mismo estoy teniendo alta demanda. Dime: SUV, Sedan o Pickup y tu down payment y te ayudo.";
const COPY_EXPERIMENT = String(process.env.COPY_EXPERIMENT || "off").toLowerCase();
const COPY_AB_MODE = String(process.env.COPY_AB_MODE || "hash").toLowerCase();
const COPY_FORCE_VARIANT = String(process.env.COPY_FORCE_VARIANT || "A").toUpperCase() === "B" ? "B" : "A";
const COPY_AB_SALT = String(process.env.COPY_AB_SALT || "empire-rey-copy-v1");
const COPY_VARIANT_TTL_HOURS = 24;
let llmCallsCount = 0;
let lastProcessedCleanupAt = 0;

export function getInboundEngineMetrics() {
  return {
    llmCallsCount
  };
}

export function resetInboundEngineMetrics() {
  llmCallsCount = 0;
}

function buildInboundMessageKey({ sessionId, channel, messageId, incomingText, timestampMs }) {
  const safeChannel = String(channel || "unknown").trim();
  const safeSession = String(sessionId || "unknown").trim();
  const safeMessageId = String(messageId || "").trim();
  if (safeMessageId) return `${safeChannel}:${safeMessageId}`;

  const safeText = String(incomingText || "").trim().toLowerCase();
  const bucket = Math.floor(Number(timestampMs || Date.now()) / 15000);
  const hash = createHash("sha1").update(`${safeChannel}|${safeSession}|${safeText}|${bucket}`).digest("hex");
  return `${safeChannel}:hash:${hash}`;
}

async function ensureProcessedMessageStoreMaintenance() {
  const now = Date.now();
  if (now - lastProcessedCleanupAt < 10 * 60 * 1000) return;
  lastProcessedCleanupAt = now;
  await cleanupProcessedInboundMessages({ olderThanHours: 48 });
}

function logConversationEvent(event) {
  try {
    console.log("[inbound-event]", JSON.stringify(event));
  } catch {
    console.log("[inbound-event]", String(event?.action || "unknown"));
  }
}

function resolveCopyVariant({ session, stableUserId }) {
  if (COPY_EXPERIMENT !== "ab") return "A";
  if (!session?.context) return "A";

  const assignedAtMs = session.context.copyVariantAssignedAt ? Date.parse(session.context.copyVariantAssignedAt) : NaN;
  const expired = Number.isFinite(assignedAtMs)
    ? Date.now() - assignedAtMs > COPY_VARIANT_TTL_HOURS * 60 * 60 * 1000
    : true;

  if (session.context.copyVariant && !expired) return session.context.copyVariant;

  let variant = "A";
  if (COPY_AB_MODE === "force") {
    variant = COPY_FORCE_VARIANT;
  } else {
    const hashHex = createHash("sha1")
      .update(`${COPY_AB_SALT}|${String(stableUserId || "")}`)
      .digest("hex");
    const parity = parseInt(hashHex.slice(-1), 16) % 2;
    variant = parity === 0 ? "A" : "B";
  }

  session.context.copyVariant = variant;
  session.context.copyVariantAssignedAt = new Date().toISOString();
  return variant;
}

function byVariant(copyVariant, shortCopy, twoLineCopy) {
  return copyVariant === "B" ? twoLineCopy : shortCopy;
}

function buildNoLlmFallbackReply(copyVariant) {
  return byVariant(
    copyVariant,
    "Alta demanda ahora. Dime SUV/Sedan/Pickup y tu down para ayudarte rapido.",
    NO_LLM_FALLBACK_REPLY
  );
}

function buildRepeatGreetingReply(copyVariant) {
  return byVariant(
    copyVariant,
    "Perfecto. Seguimos. Buscas Sedan, SUV o Pickup?",
    "Perfecto ✅ Seguimos. Dime si buscas Sedan, SUV o Pickup y te ayudo a cerrar cita."
  );
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

function mergeLeadStatus(existingStatus, inferredStatus) {
  const current = String(existingStatus || "").trim().toUpperCase();
  const next = String(inferredStatus || "NEW").trim().toUpperCase();
  if (current === "BOOKED" || current === "CLOSED_WON" || current === "CLOSED_LOST") return current;
  return next || "NEW";
}

function isHotLead(text) {
  return /(voy hoy|hoy mismo|urgent|urgente|llamame|call me|hablar ahora|quiero hablar ya|necesito asesor ya)/i.test(
    text || ""
  );
}

function requestsHuman(text) {
  return /(humano|asesor|agent|agente|persona|representante|equipo|team|alguien|atencion directa|persona real)/i.test(
    text || ""
  );
}

function asksAddress(text) {
  return /(direccion|direcci[oó]n|ubicacion|ubicaci[oó]n|donde estan|d[oó]nde est[aá]n|address|location|where are you located|where.*located|mapa|maps)/i.test(
    String(text || "")
  );
}

function asksMechanic(text) {
  return /(mecanico|mec[a?]nico|mechanic|taller|servicio mecanico|servicio mec[a?]nico|reparacion|reparaciones|arreglan|frenos|aceite|motor|diagnostico|diagn?stico|revisar mi carro|contacto.*mec)/i.test(
    String(text || "")
  );
}

function asksBusinessHours(text) {
  return /(horario|horarios|a que hora abren|a que hora cierran|abren|cierran|open|close|business hours)/i.test(
    String(text || "")
  );
}

function asksTradeIn(text) {
  return /(trade[\s-]?in|parte de pago|reciben carros usados|reciben auto usado|compran carros usados|vender mi carro)/i.test(
    String(text || "")
  );
}

function asksBuyingDocs(text) {
  return /(que necesito|que documentos|que papeles|documentos|papeles|licencia|pasaporte|social security|seguro para comprar)/i.test(
    String(text || "")
  );
}

function asksFinancingBasics(text) {
  return /(itin|solo tengo id|sin credito|credito bajo|mal credito|financiamiento interno|aprobacion|aprueban)/i.test(
    String(text || "")
  );
}

function asksVisitIntent(text) {
  return /(puedo ir|quiero ir|puedo pasar|pasar ahora|visitar|ver los carros|ver carros|en persona|como hago una cita|hacer una cita)/i.test(
    String(text || "")
  );
}

function isGreetingOnly(text) {
  return /^(hola+(\s+\w+)?|hello+|hi+|hey+|holi+|ola+|buenas|buen dia|buenos dias|buenas tardes|buenas noches|saludos|que tal|hola bot|good morning|good evening)\s*$/i.test(
    String(text || "").trim()
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

function isThreeChoice(text) {
  return /^\s*3\s*$/.test(text) || /^(opcion|option)\s*3\b/i.test(text);
}

function isFourChoice(text) {
  return /^\s*4\s*$/.test(text) || /^(opcion|option)\s*4\b/i.test(text);
}

function asksReyDirect(text) {
  return /(hablar con rey|comunicar.*rey|conectar.*rey|dueno|dueño|owner|rey)/i.test(String(text || ""));
}

function isMenuTrigger(text) {
  return /^(menu|men[uú]|ayuda|help|opciones|options)$/i.test(String(text || "").trim());
}

function normalizeVehicleTypeChoice(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || /\bsedan\b/.test(raw)) return "Sedan";
  if (raw === "2" || /\bsuv\b|camioneta/.test(raw)) return "SUV";
  if (raw === "3" || /pickup|pick[\s-]*up|truck/.test(raw)) return "Pickup";
  return null;
}

function setSimpleAppointmentFlow(session, stage, patch = {}) {
  const prev = session?.context?.appointmentFlow && typeof session.context.appointmentFlow === "object" ? session.context.appointmentFlow : {};
  session.context = {
    ...(session.context || {}),
    activeFlow: "appointment",
    appointmentFlow: {
      ...prev,
      ...patch,
      stage,
      updatedAt: new Date().toISOString()
    }
  };
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
  if (/(quiero|cita|agendar|agenda|appointment|mecanico|mec[aá]nico|servicio|carro|auto|pickup|suv|sedan|hoy|manana|mañana|ma\?ana|por la tarde)/i.test(lower)) return null;
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

function hasAppointmentSignal(text) {
  return /(agendar|agenda|cita|appointment|test drive|prueba de manejo|hoy|manana|mañana|\b[0-1]?\d(?::[0-5]\d)?\s*(am|pm)\b)/i.test(
    text || ""
  );
}

function extractPhone(text) {
  const digits = String(text || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function buildAppointmentMissingPrompt() {
  return "Ahora dime otra hora para tu cita (ejemplo: 3pm o 4:30pm).";
}

function keepAppointmentFlow(session, stage = "collecting") {
  session.context = {
    ...(session.context || {}),
    activeFlow: "appointment",
    appointmentFlow: {
      stage,
      updatedAt: new Date().toISOString()
    }
  };
}

function clearAppointmentFlow(session) {
  session.context = {
    ...(session.context || {}),
    activeFlow: null,
    appointmentFlow: null
  };
}

function markMenuIntroSent(session) {
  session.context = {
    ...(session.context || {}),
    assistantIntroSent: true,
    assistantIntroSentAt: new Date().toISOString()
  };
}

function applyFirstTouchToReply({ session, incomingText, reply }) {
  if (!reply) return reply;
  const aiResult = {
    reply,
    updatedContext: session.context || {}
  };
  applyFirstTouchPolicy({ message: incomingText, context: session.context || {}, aiResult });
  session.context = aiResult.updatedContext || session.context || {};
  return aiResult.reply;
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
    const leadRow = await updateLeadStatus(sessionId, "BOOKED");
    await sendAppointmentConfirmedOwnerEmail({
      to: process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com",
      appointment: confirmed,
      lead: leadRow
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

  if (!openAppt && requestedAt) {
    const options = await buildAvailableAppointmentOptions();
    const slotAvailable = await isAppointmentSlotAvailable({
      scheduledAt: requestedAt,
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
      scheduled_at: requestedAt,
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

export async function processInboundDealerMessage({
  sessionId,
  incomingText,
  inboundProfileName = "",
  phone = null,
  source = "whatsapp",
  channel = "unknown",
  userId = null,
  messageId = null,
  timestampMs = Date.now()
}) {
  const startedAt = Date.now();
  const safeUserId = userId || phone || sessionId;
  let copyVariant = "A";
  const baseEvent = {
    conversationId: sessionId,
    channel,
    userId: safeUserId
  };
  const emitEvent = async ({ action, intent = null, activeFlow = null, missingFields = null, error = null }) => {
    const latencyMs = Date.now() - startedAt;
    const payload = {
      ...baseEvent,
      action,
      intent,
      activeFlow,
      missingFields,
      latencyMs,
      copyVariant,
      error: error || null
    };
    logConversationEvent(payload);
    await persistConversationEvent({
      sessionId,
      channel,
      userId: safeUserId,
      copyVariant,
      action,
      intent,
      activeFlow,
      missingFields,
      latencyMs,
      error
    });
  };

  await ensureProcessedMessageStoreMaintenance();
  const messageKey = buildInboundMessageKey({ sessionId, channel, messageId, incomingText, timestampMs });
  const inserted = await markProcessedInboundMessage({
    messageKey,
    sessionId,
    channel,
    createdAt: new Date(Number(timestampMs || Date.now())).toISOString()
  });
  if (!inserted) {
    await emitEvent({ action: "duplicate_ignored" });
    return { reply: null, mediaUrl: null, shouldReply: false, shouldNotifyInboundPush: false, kind: "duplicate" };
  }

  const session = getDealerSession(sessionId);
  let introRecentlySent = Boolean(session?.context?.assistantIntroSent);
  if (!session?.context?.assistantIntroSent) {
    const latestIntroAt = await getLatestAssistantIntroAt(sessionId);
    if (latestIntroAt) {
      const introTs = Date.parse(latestIntroAt);
      if (Number.isFinite(introTs) && Date.now() - introTs < 24 * 60 * 60 * 1000) {
        session.context.assistantIntroSent = true;
        session.context.assistantIntroSentAt = new Date(introTs).toISOString();
        introRecentlySent = true;
      }
    }
  }
  copyVariant = resolveCopyVariant({ session, stableUserId: safeUserId });
  const isActiveAppointmentFlow = session?.context?.activeFlow === "appointment";
  const appointmentStage = session?.context?.appointmentFlow?.stage || null;
  const detectedPhone = extractPhone(incomingText);
  const detectedName = extractLooseCustomerName(incomingText);
  const detectedTime = parseRequestedTime(incomingText);
  const detectedDay = parseRequestedDay(incomingText);
  const detectedDateTime = parseRequestedDateTime(incomingText) || (detectedDay && detectedTime ? composeIsoFromDayAndTime(detectedDay, detectedTime) : null);

  const existingLead = await getLeadBySessionId(sessionId);
  const settings = await getConversationSettings(sessionId);
  const botEnabled = Number(settings?.bot_enabled ?? 1) === 1;
  const hotLead = isHotLead(incomingText);
  const wantsHuman = requestsHuman(incomingText);
  const handoffToHuman = hotLead || wantsHuman;
  const inferredStatus = inferLeadStatus(incomingText);
  const nextLeadStatus = mergeLeadStatus(existingLead?.status, inferredStatus);

  await upsertLeadProfile({
    sessionId,
    phone: phone || existingLead?.phone || null,
    name: existingLead?.name || inboundProfileName || null,
    source,
    language: detectLanguage(incomingText),
    intent: null,
    status: nextLeadStatus,
    priority: handoffToHuman ? "HIGH" : "NORMAL",
    mode: botEnabled && !handoffToHuman ? "BOT" : "HUMAN",
    lastMessageAt: new Date().toISOString()
  });

  const isMenuRequested = isMenuTrigger(incomingText);
  const isOption1 = isOneChoice(incomingText);
  const isOption2 = isTwoChoice(incomingText);
  const isOption3 = isThreeChoice(incomingText);
  const isOption4 = isFourChoice(incomingText);
  const isSimpleAppointmentStage =
    isActiveAppointmentFlow &&
    ["simple_need_name", "simple_need_datetime", "simple_need_vehicle_type"].includes(String(appointmentStage || ""));

  if (!isActiveAppointmentFlow && (isGreetingOnly(incomingText) || isMenuRequested)) {
    markMenuIntroSent(session);
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "menu-entry" });
    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: MENU_ENTRY_REPLY,
      source: "menu-entry",
      intent: "welcome"
    });
    await emitEvent({ action: "menu_entry", intent: "welcome", activeFlow: null });
    return { reply: MENU_ENTRY_REPLY, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "menu-entry" };
  }

  if (
    !isActiveAppointmentFlow &&
    (isOption1 || /(buscar.*carro|ver.*carro|que carros|que autos|inventario|disponibles|mostrar.*carros)/i.test(incomingText))
  ) {
    const reply = applyFirstTouchToReply({
      session,
      incomingText,
      reply: "Perfecto. Que tipo de carro buscas? Sedan, SUV o Pickup?"
    });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "menu-option-1" });
    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: reply,
      source: "menu-option-1",
      intent: "buying_interest"
    });
    await emitEvent({ action: "menu_option_1", intent: "buying_interest", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "menu-option-1" };
  }

  if (
    !isActiveAppointmentFlow &&
    (isOption2 || /agendar|agendo|quiero cita|crear cita|programar cita|appointment|test drive|prueba de manejo/i.test(incomingText))
  ) {
    setSimpleAppointmentFlow(session, "simple_need_name");
    const reply = applyFirstTouchToReply({
      session,
      incomingText,
      reply: "Perfecto. Para agendar tu cita, cual es tu nombre?"
    });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "menu-option-2" });
    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: reply,
      source: "menu-option-2",
      intent: "appointment_flow"
    });
    await emitEvent({ action: "menu_option_2", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["name"] });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "menu-option-2" };
  }

  if (!isActiveAppointmentFlow && (isOption3 || asksReyDirect(incomingText))) {
    const reply = applyFirstTouchToReply({
      session,
      incomingText,
      reply: "Claro. Puedes comunicarte con Rey al +1 (502) 576-8116."
    });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "menu-option-3" });
    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: reply,
      source: "menu-option-3",
      intent: "handoff"
    });
    await emitEvent({ action: "menu_option_3", intent: "handoff", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: true, kind: "menu-option-3" };
  }

  if (!isActiveAppointmentFlow && (isOption4 || asksMechanic(incomingText))) {
    const reply = applyFirstTouchToReply({
      session,
      incomingText,
      reply: "Claro. Si, contamos con servicio mecanico. Pronto tendremos esa informacion disponible."
    });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "menu-option-4" });
    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: reply,
      source: "menu-option-4",
      intent: "service_info"
    });
    await emitEvent({ action: "menu_option_4", intent: "service_info", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: true, kind: "menu-option-4" };
  }

  if (isSimpleAppointmentStage) {
    if (appointmentStage === "simple_need_name") {
      if (!detectedName) {
        const reply = applyFirstTouchToReply({
          session,
          incomingText,
          reply: "Para continuar con la cita, comparteme tu nombre por favor."
        });
        await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-simple" });
        await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-simple", intent: "appointment_flow" });
        await emitEvent({ action: "appointment_simple", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["name"] });
        return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-simple" };
      }

      await upsertLeadProfile({ sessionId, name: detectedName, lastMessageAt: new Date().toISOString() });
      setSimpleAppointmentFlow(session, "simple_need_datetime");
      const reply = applyFirstTouchToReply({
        session,
        incomingText,
        reply: `Perfecto, ${detectedName}. Que dia y hora te gustaria venir? (ejemplo: manana 11am)`
      });
      await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-simple" });
      await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-simple", intent: "appointment_flow" });
      await emitEvent({ action: "appointment_simple", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["time"] });
      return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-simple" };
    }

    if (appointmentStage === "simple_need_datetime") {
      if (!detectedDateTime) {
        const reply = applyFirstTouchToReply({
          session,
          incomingText,
          reply: "Necesito dia y hora para agendar. Ejemplo: hoy 4pm o manana 11am."
        });
        await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-simple" });
        await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-simple", intent: "appointment_flow" });
        await emitEvent({ action: "appointment_simple", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["time"] });
        return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-simple" };
      }

      setSimpleAppointmentFlow(session, "simple_need_vehicle_type", { requestedAt: detectedDateTime });
      await upsertLeadProfile({
        sessionId,
        datePref: detectedDateTime,
        status: "APPT_PENDING",
        lastMessageAt: new Date().toISOString()
      });
      const reply = applyFirstTouchToReply({
        session,
        incomingText,
        reply: "Perfecto. Que tipo de carro buscas? 1) Sedan 2) SUV 3) Pickup"
      });
      await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-simple" });
      await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-simple", intent: "appointment_flow" });
      await emitEvent({ action: "appointment_simple", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["vehicle_type"] });
      return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-simple" };
    }

    if (appointmentStage === "simple_need_vehicle_type") {
      const vehicleType = normalizeVehicleTypeChoice(incomingText);
      if (!vehicleType) {
        const reply = applyFirstTouchToReply({
          session,
          incomingText,
          reply: "Responde con 1, 2 o 3: 1) Sedan 2) SUV 3) Pickup."
        });
        await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-simple" });
        await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-simple", intent: "appointment_flow" });
        await emitEvent({ action: "appointment_simple", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["vehicle_type"] });
        return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-simple" };
      }

      const requestedAt = session?.context?.appointmentFlow?.requestedAt || null;
      if (!requestedAt) {
        setSimpleAppointmentFlow(session, "simple_need_datetime");
        const reply = applyFirstTouchToReply({
          session,
          incomingText,
          reply: "Se perdio el horario. Dime de nuevo dia y hora (ejemplo: manana 11am)."
        });
        await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-simple" });
        await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-simple", intent: "appointment_flow" });
        await emitEvent({ action: "appointment_simple", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["time"] });
        return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-simple" };
      }

      const openAppt = await getLatestOpenAppointmentForLead(sessionId);
      let appointmentRow = null;
      if (openAppt) {
        appointmentRow = await updateAppointment(openAppt.id, {
          scheduled_at: requestedAt,
          status: "PENDING",
          confirmation_state: "PROPOSED",
          notes: `Tipo buscado: ${vehicleType}`
        });
      } else {
        appointmentRow = await createAppointment({
          lead_session_id: sessionId,
          scheduled_at: requestedAt,
          status: "PENDING",
          confirmation_state: "PROPOSED",
          notes: `Creada por flujo simple. Tipo buscado: ${vehicleType}`
        });
      }

      const leadRow = await upsertLeadProfile({
        sessionId,
        status: "APPT_PENDING",
        intent: "appointment_flow",
        datePref: requestedAt,
        lastMessageAt: new Date().toISOString()
      });
      await updateLeadStatus(sessionId, "APPT_PENDING");
      if (!openAppt && appointmentRow) {
        const emailResult = await sendAppointmentCreatedOwnerEmail({
          to: process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com",
          appointment: appointmentRow,
          lead: leadRow
        });
        if (!emailResult?.ok) {
          console.error("Simple appointment created email failed:", emailResult?.reason || "unknown");
        }
      }

      clearAppointmentFlow(session);
      const reply = applyFirstTouchToReply({
        session,
        incomingText,
        reply: `Listo. Ya agende tu cita para ${formatOptionLine(requestedAt)}.\nTipo de carro: ${vehicleType}.\nSi quieres, tambien te puedo comunicar con Rey.`
      });
      await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-simple" });
      await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-simple", intent: "appointment_flow" });
      await emitEvent({ action: "appointment_simple_created", intent: "appointment_flow", activeFlow: null });
      return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-simple" };
    }
  }

  if (!isActiveAppointmentFlow && isGreetingOnly(incomingText) && introRecentlySent) {
    const reply = applyFirstTouchToReply({ session, incomingText, reply: buildRepeatGreetingReply(copyVariant) });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "greeting-repeat" });
    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: reply,
      source: "greeting-repeat",
      intent: "welcome"
    });
    await emitEvent({ action: "greeting_repeat", intent: "welcome", activeFlow: null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "greeting-repeat" };
  }

  if (isActiveAppointmentFlow) {
    if (detectedPhone) {
      await upsertLeadProfile({
        sessionId,
        phone: detectedPhone,
        lastMessageAt: new Date().toISOString()
      });
    }
    if (detectedName) {
      await upsertLeadProfile({
        sessionId,
        name: detectedName,
        lastMessageAt: new Date().toISOString()
      });
    }

    const userAskedAddress = asksAddress(incomingText);
    const userAskedMechanic = asksMechanic(incomingText);
    const needsNewTime = appointmentStage === "need_new_time";
    const needsPhone = appointmentStage === "need_phone";
    const needsName = appointmentStage === "need_name";
    const hasNewTimeInput = Boolean(detectedDateTime || detectedTime || detectedDay);

    if (needsPhone && detectedPhone) {
      const openAppt = await getLatestOpenAppointmentForLead(sessionId);
      const when = openAppt?.scheduled_at ? formatOptionLine(openAppt.scheduled_at) : "el horario acordado";
      clearAppointmentFlow(session);
      const flowReply = `Perfecto, ya tengo tu telefono. Tu cita queda para ${when}.\nDireccion: ${DEALER_ADDRESS_TEXT}`;
      const reply = applyFirstTouchToReply({ session, incomingText, reply: flowReply });
      await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-active-flow" });
      await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-active-flow", intent: "appointment_flow" });
      await emitEvent({ action: "appointment_active_flow", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["time"] });
      return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-active-flow" };
    }

    if (needsPhone && !detectedPhone) {
      let replyPrefix = "";
      if (userAskedAddress) {
        replyPrefix = `Estamos en ${DEALER_ADDRESS_TEXT} `;
      } else if (userAskedMechanic) {
        replyPrefix = "Si, tambien ofrecemos servicio mecanico. ";
      }
      const ack = detectedName ? "Perfecto, ya tengo tu nombre. " : "";
      const flowReply = `${replyPrefix}${ack}${byVariant(
        copyVariant,
        "Comparteme tu telefono para confirmar la cita.",
        "Para cerrar tu cita, comparteme tu telefono de contacto por favor."
      )}`.trim();
      const reply = applyFirstTouchToReply({ session, incomingText, reply: flowReply });
      await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-active-flow" });
      await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-active-flow", intent: "appointment_flow" });
      await emitEvent({ action: "appointment_active_flow", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["phone"] });
      return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-active-flow" };
    }

    if (needsName && !detectedName) {
      let replyPrefix = "";
      if (userAskedAddress) {
        replyPrefix = `Estamos en ${DEALER_ADDRESS_TEXT} `;
      } else if (userAskedMechanic) {
        replyPrefix = "Si, tambien ofrecemos servicio mecanico. ";
      }
      const ack = detectedPhone ? "Perfecto, ya tengo tu telefono. " : "";
      const flowReply = `${replyPrefix}${ack}${byVariant(
        copyVariant,
        "Comparteme tu nombre para reservar la cita.",
        "Para reservar la cita, comparteme tu nombre por favor."
      )}`.trim();
      const reply = applyFirstTouchToReply({ session, incomingText, reply: flowReply });
      await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-active-flow" });
      await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-active-flow", intent: "appointment_flow" });
      await emitEvent({ action: "appointment_active_flow", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["name"] });
      return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-active-flow" };
    }

    if (needsName && detectedName) {
      keepAppointmentFlow(session, "need_phone");
      const flowReply = byVariant(
        copyVariant,
        "Listo. Ya tengo tu nombre. Ahora tu telefono para confirmar la cita.",
        "Perfecto, ya tengo tu nombre. Ahora comparteme tu telefono de contacto para cerrar la cita."
      );
      const reply = applyFirstTouchToReply({ session, incomingText, reply: flowReply });
      await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-active-flow" });
      await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-active-flow", intent: "appointment_flow" });
      await emitEvent({ action: "appointment_active_flow", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["phone"] });
      return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-active-flow" };
    }

    if (needsNewTime && !hasNewTimeInput) {
      let replyPrefix = "";
      if (userAskedAddress) {
        replyPrefix = `Estamos en ${DEALER_ADDRESS_TEXT} `;
      } else if (userAskedMechanic) {
        replyPrefix = "Si, tambien ofrecemos servicio mecanico. ";
      }
      const ack = detectedPhone || detectedName ? "Perfecto, ya lo tengo. " : "";
      const flowReply = `${replyPrefix}${ack}${byVariant(
        copyVariant,
        "Esa hora no esta libre. Dime otra hora (ej: 3pm o 4:30pm).",
        buildAppointmentMissingPrompt()
      )}`.trim();
      const reply = applyFirstTouchToReply({ session, incomingText, reply: flowReply });
      await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "appointment-active-flow" });
      await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "appointment-active-flow", intent: "appointment_flow" });
      await emitEvent({ action: "appointment_active_flow", intent: "appointment_flow", activeFlow: "appointment", missingFields: ["time"] });
      return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "appointment-active-flow" };
    }
  }

  if (asksAddress(incomingText)) {
    const reply = applyFirstTouchToReply({ session, incomingText, reply: DEALER_ADDRESS_TEXT });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "address-fastpath" });
    await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "address-fastpath", intent: "location" });
    await emitEvent({ action: "faq_address", intent: "location", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "address-fastpath" };
  }

  if (asksMechanic(incomingText)) {
    const reply = applyFirstTouchToReply({ session, incomingText, reply: MECHANIC_CONTACT_REPLY });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "mechanic-fastpath" });
    await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "mechanic-fastpath", intent: "service_info" });
    await emitEvent({ action: "faq_mechanic", intent: "service_info", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "mechanic-fastpath" };
  }

  if (asksTradeIn(incomingText)) {
    const reply = applyFirstTouchToReply({ session, incomingText, reply: TRADE_IN_REPLY });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "tradein-fastpath" });
    await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "tradein-fastpath", intent: "trade_in" });
    await emitEvent({ action: "faq_tradein", intent: "trade_in", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "tradein-fastpath" };
  }

  if (asksBusinessHours(incomingText)) {
    const reply = applyFirstTouchToReply({ session, incomingText, reply: BUSINESS_HOURS_REPLY });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "hours-fastpath" });
    await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "hours-fastpath", intent: "business_hours" });
    await emitEvent({ action: "faq_hours", intent: "business_hours", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "hours-fastpath" };
  }

  if (asksBuyingDocs(incomingText)) {
    const reply = applyFirstTouchToReply({ session, incomingText, reply: DOCS_REPLY });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "docs-fastpath" });
    await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "docs-fastpath", intent: "docs_info" });
    await emitEvent({ action: "faq_docs", intent: "docs_info", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "docs-fastpath" };
  }

  if (asksFinancingBasics(incomingText)) {
    const reply = applyFirstTouchToReply({ session, incomingText, reply: FINANCE_FASTPATH_REPLY });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "finance-fastpath" });
    await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "finance-fastpath", intent: "finance_info" });
    await emitEvent({ action: "faq_finance", intent: "finance_info", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "finance-fastpath" };
  }

  if (asksVisitIntent(incomingText)) {
    const reply = applyFirstTouchToReply({
      session,
      incomingText,
      reply: "Perfecto. Si quieres, te agendo cita para venir a ver los carros. Dime que dia y hora te funciona."
    });
    await persistIncomingUserMessage({ sessionId, userMessage: incomingText, source: "visit-fastpath" });
    await persistOutgoingAssistantMessage({ sessionId, assistantMessage: reply, source: "visit-fastpath", intent: "appointment_flow" });
    await emitEvent({ action: "visit_fastpath", intent: "appointment_flow", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: false, kind: "visit-fastpath" };
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

    const rawReply = wantsHuman
      ? "Claro. Te ayudo a comunicarte con Rey ahora mismo."
      : "Veo interes urgente. Te conecto con un asesor humano ahora mismo para atenderte mas rapido.";
    const reply = applyFirstTouchToReply({ session, incomingText, reply: rawReply });

    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: reply,
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
        lastMessage: incomingText
      }).catch(() => {});
    }

    await emitEvent({ action: "handoff_rey", intent: "handoff", activeFlow: session?.context?.activeFlow || null });
    return { reply, mediaUrl: null, shouldReply: true, shouldNotifyInboundPush: true, kind: "human-handoff" };
  }

  const appointmentFlow = await handleAppointmentFlow({ sessionId, incomingText, lead: existingLead });
  if (appointmentFlow.handled) {
    const loweredReply = String(appointmentFlow.reply || "").toLowerCase();
    const isCanceled = /cancelada|cancelada|cita cancelada|cancel/i.test(loweredReply);
    const isConfirmed = /(cita quedo confirmada|te agende|cita confirmada|tienes una cita confirmed|tienes una cita confirmada)/i.test(
      appointmentFlow.reply || ""
    );
    const needsNameOrPhoneOrTime = /(hora exacta|me compartes tu nombre|comparteme tu telefono|compartemelo por favor|telefono de contacto:\s*compartemelo|dime dia y hora|dime otra hora|ese horario ya esta ocupado|para cuando quieres la cita)/i.test(
      appointmentFlow.reply || ""
    );

    if (needsNameOrPhoneOrTime || hasAppointmentSignal(incomingText) || isActiveAppointmentFlow) {
      let stage = /ocupado/i.test(appointmentFlow.reply || "") ? "need_new_time" : "collecting";
      if (/nombre/i.test(appointmentFlow.reply || "")) stage = "need_name";
      if (/telefono|tel[eé]fono|compartemelo/i.test(appointmentFlow.reply || "")) stage = "need_phone";
      keepAppointmentFlow(session, stage);
    } else if (isCanceled || isConfirmed) {
      clearAppointmentFlow(session);
    }

    const reply = applyFirstTouchToReply({ session, incomingText, reply: appointmentFlow.reply });
    await persistIncomingUserMessage({
      sessionId,
      userMessage: incomingText,
      source: "appointment-flow"
    });
    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: reply,
      source: "appointment-flow",
      intent: "appointment_flow"
    });
    const missingFields = /nombre/i.test(reply)
      ? ["name"]
      : /telefono|tel[eé]fono/i.test(reply)
      ? ["phone"]
      : /hora/i.test(reply)
      ? ["time"]
      : [];
    await emitEvent({ action: "appointment_flow", intent: "appointment_flow", activeFlow: session?.context?.activeFlow || null, missingFields });
    return {
      reply,
      mediaUrl: null,
      shouldReply: true,
      shouldNotifyInboundPush: false,
      kind: "appointment-flow"
    };
  }

  if (!botEnabled) {
    await persistIncomingUserMessage({
      sessionId,
      userMessage: incomingText,
      source: "bot-disabled"
    });
    await emitEvent({ action: "bot_disabled", activeFlow: session?.context?.activeFlow || null });
    return { reply: null, mediaUrl: null, shouldReply: false, shouldNotifyInboundPush: true, kind: "bot-disabled" };
  }

  const learningState = getLearningState(sessionId);
  let aiResult = null;
  if (!hasAnyLlmProvider) {
    aiResult = {
      reply: applyFirstTouchToReply({ session, incomingText, reply: buildNoLlmFallbackReply(copyVariant) }),
      intent: "question",
      entities: {
        model: null,
        budget: null,
        date: null,
        contact: { email: null, phone: null }
      },
      source: "no-llm-provider-fallback",
      mediaUrl: null,
      updatedContext: session.context || {}
    };
  } else {
    aiResult = await handleDealerMessage({
      message: incomingText,
      context: session.context,
      learningState,
      channel
    });
  }

  await saveDealerTurn({
    sessionId,
    userMessage: incomingText,
    aiResult
  });
  if (String(aiResult?.source || "").startsWith("llm:")) {
    llmCallsCount += 1;
  }
  await emitEvent({
    action: String(aiResult?.source || "").startsWith("llm:") ? "llm" : "ai_fallback",
    intent: aiResult?.intent || null,
    activeFlow: session?.context?.activeFlow || null
  });

  return {
    reply: aiResult.reply,
    mediaUrl: aiResult.mediaUrl || null,
    shouldReply: true,
    shouldNotifyInboundPush: true,
    kind: "ai"
  };
}

