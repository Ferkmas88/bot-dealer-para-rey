import { Router } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createInventoryUnit,
  createAppointment,
  deleteAppointment,
  deleteInventoryUnit,
  getAppointmentById,
  getLatestOpenAppointmentForLead,
  getLeadBySessionId,
  getConversationSettings,
  getInventoryById,
  listAppointments,
  listDealerConversations,
  deleteConversationBySessionId,
  purgeConversationsByPrefixes,
  listLeads,
  listDealerMessagesBySession,
  markConversationRead,
  persistOutgoingAssistantMessage,
  setConversationBotEnabled,
  listInventory,
  upsertLeadProfile,
  upsertPushSubscription,
  deletePushSubscription,
  updateAppointment,
  updateLeadStatus,
  updateInventoryUnit
} from "../services/sqliteLeadStore.js";
import { sendManualWhatsAppReply } from "../services/twilioSender.js";
import { sendMetaWhatsAppText } from "../services/metaSender.js";
import { getPushPublicConfig, getPushRuntimeStatus, sendTestPush } from "../services/pushNotifications.js";
import { sendAppointmentConfirmedOwnerEmail, sendOwnerTestEmail } from "../services/ownerNotifications.js";

const inventoryPayloadSchema = z.object({
  make: z.string().min(1),
  model: z.string().min(1),
  year: z.coerce.number().int().min(1900).max(2100),
  price: z.coerce.number().nonnegative(),
  mileage: z.coerce.number().int().nonnegative(),
  transmission: z.string().min(1),
  fuel_type: z.string().min(1),
  color: z.string().min(1),
  status: z.enum(["available", "sold", "reserved"]).default("available"),
  featured: z.coerce.number().int().min(0).max(1).optional().default(0)
});

const inventoryPatchSchema = inventoryPayloadSchema.partial();
const pushSubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  })
});

const leadStatusSchema = z.object({
  status: z.enum(["NEW", "QUALIFYING", "QUALIFIED", "APPT_PENDING", "BOOKED", "NO_RESPONSE", "CLOSED_WON", "CLOSED_LOST"]),
  assigned_to: z.string().optional().nullable(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  mode: z.enum(["BOT", "HUMAN"]).optional()
});

const appointmentCreateSchema = z.object({
  lead_session_id: z.string().min(1),
  scheduled_at: z.string().datetime(),
  vehicle_id: z.coerce.number().int().optional().nullable(),
  notes: z.string().optional().default(""),
  status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "RESCHEDULED", "NO_SHOW", "COMPLETED"]).optional().default("PENDING"),
  confirmation_state: z.enum(["PROPOSED", "AWAITING_CONFIRMATION", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCELLED"]).optional().default("PROPOSED"),
  proposal_options: z.array(z.string().datetime()).optional().default([])
});

const appointmentPatchSchema = z.object({
  scheduled_at: z.string().datetime().optional(),
  vehicle_id: z.coerce.number().int().optional().nullable(),
  notes: z.string().optional(),
  status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "RESCHEDULED", "NO_SHOW", "COMPLETED"]).optional(),
  confirmation_state: z.enum(["PROPOSED", "AWAITING_CONFIRMATION", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCELLED"]).optional(),
  proposal_options: z.array(z.string().datetime()).optional()
});

const appointmentActionSchema = z.object({
  action: z.enum(["confirm", "reschedule", "cancel"])
});

const createWhatsappContactSchema = z.object({
  phone: z.string().min(7),
  name: z.string().optional().default(""),
  provider: z.enum(["twilio", "meta"]).optional().default("twilio")
});

const uploadPayloadSchema = z.object({
  filename: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120),
  dataUrl: z.string().min(20)
});

const ALLOWED_UPLOAD_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/mp3",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/mp4",
  "video/mp4",
  "video/webm",
  "application/pdf"
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsPublicDir = path.resolve(__dirname, "../../public/uploads");

function sanitizeFilename(value) {
  const cleaned = String(value || "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 100);
  return cleaned || "upload";
}

function parseDataUrl(value) {
  const str = String(value || "");
  const match = str.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    base64: match[2]
  };
}

function extensionFromMime(mimeType, originalName) {
  const lower = String(mimeType || "").toLowerCase();
  const existingExt = path.extname(String(originalName || "")).toLowerCase();
  if (existingExt) return existingExt;
  if (lower === "image/jpeg") return ".jpg";
  if (lower === "image/png") return ".png";
  if (lower === "image/webp") return ".webp";
  if (lower === "image/gif") return ".gif";
  if (lower === "audio/mpeg" || lower === "audio/mp3") return ".mp3";
  if (lower === "audio/aac") return ".aac";
  if (lower === "audio/ogg") return ".ogg";
  if (lower === "audio/wav") return ".wav";
  if (lower === "audio/mp4") return ".m4a";
  if (lower === "video/mp4") return ".mp4";
  if (lower === "video/webm") return ".webm";
  if (lower === "application/pdf") return ".pdf";
  return ".bin";
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

function normalizePhoneForWhatsapp(raw) {
  const cleaned = String(raw || "").trim().replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/\D/g, "");
  if (!digits) return null;
  const e164 = cleaned.startsWith("+") ? `+${digits}` : `+${digits}`;
  return { e164, digits };
}

export const dealerDbAdminRouter = Router();

dealerDbAdminRouter.get("/dealer/db/inventory", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const rows = await listInventory({ status });
  return res.json({ rows });
});

dealerDbAdminRouter.get("/dealer/db/inventory/:id", async (req, res) => {
  const row = await getInventoryById(req.params.id);
  if (!row) return res.status(404).json({ error: "Inventory unit not found" });
  return res.json({ row });
});

dealerDbAdminRouter.post("/dealer/db/inventory", async (req, res) => {
  const parsed = inventoryPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid inventory payload", details: parsed.error.flatten() });
  }

  const row = await createInventoryUnit(parsed.data);
  return res.status(201).json({ row });
});

dealerDbAdminRouter.put("/dealer/db/inventory/:id", async (req, res) => {
  const parsed = inventoryPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid inventory payload", details: parsed.error.flatten() });
  }

  const row = await updateInventoryUnit(req.params.id, parsed.data);
  if (!row) return res.status(404).json({ error: "Inventory unit not found" });
  return res.json({ row });
});

dealerDbAdminRouter.patch("/dealer/db/inventory/:id", async (req, res) => {
  const parsed = inventoryPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid inventory payload", details: parsed.error.flatten() });
  }

  const row = await updateInventoryUnit(req.params.id, parsed.data);
  if (!row) return res.status(404).json({ error: "Inventory unit not found" });
  return res.json({ row });
});

dealerDbAdminRouter.delete("/dealer/db/inventory/:id", async (req, res) => {
  const deleted = await deleteInventoryUnit(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Inventory unit not found" });
  return res.json({ ok: true });
});

dealerDbAdminRouter.get("/dealer/db/leads", async (req, res) => {
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 200;
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const query = typeof req.query.query === "string" ? req.query.query : "";
  const rows = await listLeads({ limit, status, query });
  return res.json({ rows });
});

dealerDbAdminRouter.get("/dealer/db/leads/:sessionId", async (req, res) => {
  const row = await getLeadBySessionId(req.params.sessionId);
  if (!row) return res.status(404).json({ error: "Lead not found" });
  return res.json({ row });
});

dealerDbAdminRouter.patch("/dealer/db/leads/:sessionId/status", async (req, res) => {
  const parsed = leadStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid lead status payload", details: parsed.error.flatten() });
  }

  const row = await updateLeadStatus(req.params.sessionId, parsed.data.status, {
    assignedTo: parsed.data.assigned_to ?? null,
    priority: parsed.data.priority ?? "NORMAL",
    mode: parsed.data.mode ?? "BOT"
  });

  if (!row) return res.status(404).json({ error: "Lead not found" });
  return res.json({ row });
});

dealerDbAdminRouter.get("/dealer/db/appointments", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from : null;
  const to = typeof req.query.to === "string" ? req.query.to : null;
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 500;
  const rows = await listAppointments({ from, to, status, limit });
  return res.json({ rows });
});

dealerDbAdminRouter.post("/dealer/db/appointments", async (req, res) => {
  const parsed = appointmentCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid appointment payload", details: parsed.error.flatten() });
  }

  const lead = await getLeadBySessionId(parsed.data.lead_session_id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const row = await createAppointment(parsed.data);
  await updateLeadStatus(parsed.data.lead_session_id, "APPT_PENDING", {
    priority: String(lead?.priority || "NORMAL").toUpperCase(),
    mode: String(lead?.mode || "BOT").toUpperCase()
  });
  return res.status(201).json({ row });
});

dealerDbAdminRouter.patch("/dealer/db/appointments/:id", async (req, res) => {
  const parsed = appointmentPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid appointment patch payload", details: parsed.error.flatten() });
  }

  const row = await updateAppointment(req.params.id, parsed.data);
  if (!row) return res.status(404).json({ error: "Appointment not found" });
  return res.json({ row });
});

dealerDbAdminRouter.delete("/dealer/db/appointments/:id", async (req, res) => {
  const deleted = await deleteAppointment(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Appointment not found" });
  return res.json({ ok: true });
});

dealerDbAdminRouter.post("/dealer/db/appointments/:id/confirm", async (req, res) => {
  const appointment = await getAppointmentById(req.params.id);
  if (!appointment) return res.status(404).json({ error: "Appointment not found" });

  const updatedAppointment = await updateAppointment(req.params.id, {
    status: "CONFIRMED",
    confirmation_state: "CONFIRMED",
    confirmed_at: new Date().toISOString()
  });

  const lead = await updateLeadStatus(appointment.lead_session_id, "BOOKED");
  const emailResult = await sendAppointmentConfirmedOwnerEmail({
    to: process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com",
    appointment: updatedAppointment,
    lead
  });

  return res.json({ ok: true, row: updatedAppointment, lead, email: emailResult });
});

dealerDbAdminRouter.get("/dealer/db/conversations", async (req, res) => {
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const query = typeof req.query.query === "string" ? req.query.query : "";
  const rows = await listDealerConversations({ limit, query });
  return res.json({ rows });
});

dealerDbAdminRouter.delete("/dealer/db/conversations/:sessionId", async (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }
  const result = await deleteConversationBySessionId(sessionId);
  return res.json({ ok: true, ...result, sessionId });
});

dealerDbAdminRouter.post("/dealer/db/conversations/purge-tests", async (req, res) => {
  const defaults = [
    "qa-",
    "qa2-",
    "test-",
    "loadtest-",
    "post-deploy-",
    "deploy-watch",
    "probe-inline-context",
    "cheap-car-"
  ];
  const prefixes = Array.isArray(req.body?.prefixes) ? req.body.prefixes : defaults;
  const result = await purgeConversationsByPrefixes(prefixes);
  return res.json({ ok: true, prefixes, ...result });
});

dealerDbAdminRouter.post("/dealer/db/conversations/create-contact", async (req, res) => {
  const parsed = createWhatsappContactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid contact payload", details: parsed.error.flatten() });
  }

  const normalized = normalizePhoneForWhatsapp(parsed.data.phone);
  if (!normalized) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  const provider = parsed.data.provider || "twilio";
  const sessionId = provider === "meta" ? `wa_meta:${normalized.digits}` : `wa:whatsapp:${normalized.e164}`;
  const displayName = String(parsed.data.name || "").trim();

  const lead = await upsertLeadProfile({
    sessionId,
    name: displayName || null,
    phone: normalized.e164,
    source: "whatsapp",
    language: "es",
    intent: "manual_contact",
    status: "NEW",
    priority: "NORMAL",
    mode: "HUMAN",
    lastMessageAt: new Date().toISOString()
  });

  await persistOutgoingAssistantMessage({
    sessionId,
    assistantMessage: `Contacto agregado manualmente${displayName ? `: ${displayName}` : ""}.`,
    source: "manual-contact",
    intent: "manual_contact"
  });
  await setConversationBotEnabled(sessionId, false);
  await markConversationRead(sessionId);

  return res.status(201).json({ ok: true, session_id: sessionId, lead });
});

dealerDbAdminRouter.get("/dealer/db/conversations/:sessionId/messages", async (req, res) => {
  const sessionId = req.params.sessionId;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 500;
  const beforeId = typeof req.query.before_id === "string" ? Number(req.query.before_id) : null;
  const rows = await listDealerMessagesBySession(sessionId, { limit, beforeId });
  const settings = await getConversationSettings(sessionId);
  return res.json({ rows, settings });
});

dealerDbAdminRouter.post("/dealer/db/conversations/:sessionId/read", async (req, res) => {
  const sessionId = req.params.sessionId;
  const settings = await markConversationRead(sessionId);
  return res.json({ ok: true, settings });
});

dealerDbAdminRouter.patch("/dealer/db/conversations/:sessionId/bot", async (req, res) => {
  const sessionId = req.params.sessionId;
  const enabled = Boolean(req.body?.enabled);
  const settings = await setConversationBotEnabled(sessionId, enabled);
  return res.json({ ok: true, settings });
});

dealerDbAdminRouter.post("/dealer/db/conversations/:sessionId/reply", async (req, res) => {
  const sessionId = req.params.sessionId;
  const body = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const mediaUrl = typeof req.body?.mediaUrl === "string" ? req.body.mediaUrl.trim() : "";

  if (!body && !mediaUrl) {
    return res.status(400).json({ error: "Message or mediaUrl is required" });
  }

  try {
    let providerResponse = null;
    if (sessionId.startsWith("wa_meta:")) {
      providerResponse = await sendMetaWhatsAppText({ sessionId, text: body, mediaUrl });
    } else if (sessionId.startsWith("wa:")) {
      providerResponse = await sendManualWhatsAppReply({ sessionId, body, mediaUrl });
    } else {
      return res.status(400).json({ error: "Unsupported session type for manual reply" });
    }

    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: body || `[media] ${mediaUrl}`,
      source: mediaUrl ? "manual-agent-media" : "manual-agent"
    });

    return res.json({
      ok: true,
      sid: providerResponse?.sid || providerResponse?.messages?.[0]?.id || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Failed to send manual reply"
    });
  }
});

dealerDbAdminRouter.post("/dealer/db/uploads", async (req, res) => {
  const parsed = uploadPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid upload payload", details: parsed.error.flatten() });
  }

  const rawData = parseDataUrl(parsed.data.dataUrl);
  if (!rawData) {
    return res.status(400).json({ error: "Invalid dataUrl format" });
  }

  const mimeType = String(parsed.data.mimeType || rawData.mimeType).toLowerCase();
  if (!ALLOWED_UPLOAD_MIME.has(mimeType)) {
    return res.status(400).json({ error: "Unsupported file type" });
  }

  try {
    const bytes = Buffer.from(rawData.base64, "base64");
    const maxBytes = 8 * 1024 * 1024;
    if (!bytes.length || bytes.length > maxBytes) {
      return res.status(400).json({ error: "File too large (max 8MB)" });
    }

    await mkdir(uploadsPublicDir, { recursive: true });
    const safeBase = sanitizeFilename(parsed.data.filename).replace(/\.[^.]+$/, "");
    const ext = extensionFromMime(mimeType, parsed.data.filename);
    const storedName = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeBase}${ext}`;
    const fullPath = path.join(uploadsPublicDir, storedName);
    await writeFile(fullPath, bytes);

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    return res.status(201).json({
      ok: true,
      filename: storedName,
      mimeType,
      size: bytes.length,
      url: `${baseUrl}/uploads/${storedName}`
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Upload failed"
    });
  }
});

dealerDbAdminRouter.get("/dealer/db/conversations/:sessionId/appointment", async (req, res) => {
  const sessionId = req.params.sessionId;
  const lead = await getLeadBySessionId(sessionId);
  const appointment = await getLatestOpenAppointmentForLead(sessionId);
  return res.json({ lead, appointment });
});

dealerDbAdminRouter.post("/dealer/db/conversations/:sessionId/appointment/action", async (req, res) => {
  const sessionId = req.params.sessionId;
  const parsed = appointmentActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid appointment action payload", details: parsed.error.flatten() });
  }

  const lead = await getLeadBySessionId(sessionId);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const appointment = await getLatestOpenAppointmentForLead(sessionId);
  if (!appointment) return res.status(404).json({ error: "No open appointment for this lead" });

  try {
    let updatedAppointment = appointment;
    let outboundText = "";

    if (parsed.data.action === "confirm") {
      updatedAppointment = await updateAppointment(appointment.id, {
        status: "CONFIRMED",
        confirmation_state: "CONFIRMED",
        confirmed_at: new Date().toISOString()
      });
      await updateLeadStatus(sessionId, "BOOKED");
      outboundText = "Perfecto, tu cita quedo confirmada. Te esperamos.";
      const emailResult = await sendAppointmentConfirmedOwnerEmail({
        to: process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com",
        appointment: updatedAppointment,
        lead
      });
      if (!emailResult?.ok) {
        console.error("Appointment confirm email failed:", emailResult?.reason || "unknown");
      }
    } else if (parsed.data.action === "reschedule") {
      const options = buildNextAppointmentOptions();
      updatedAppointment = await updateAppointment(appointment.id, {
        status: "RESCHEDULED",
        confirmation_state: "PROPOSED",
        proposal_options: options
      });
      await updateLeadStatus(sessionId, "APPT_PENDING");
      outboundText = `Te comparto nuevos horarios:\n1) ${formatOptionLine(options[0])}\n2) ${formatOptionLine(options[1])}\nElige 1 o 2 y luego te pido confirmacion final.`;
    } else {
      updatedAppointment = await updateAppointment(appointment.id, {
        status: "CANCELLED",
        confirmation_state: "CANCELLED",
        cancelled_at: new Date().toISOString()
      });
      await updateLeadStatus(sessionId, "NO_RESPONSE");
      outboundText = "Cita cancelada. Cuando quieras reagendar, te ayudo con gusto.";
    }

    if (sessionId.startsWith("wa_meta:")) {
      await sendMetaWhatsAppText({ sessionId, text: outboundText });
    } else if (sessionId.startsWith("wa:")) {
      await sendManualWhatsAppReply({ sessionId, body: outboundText });
    }
    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: outboundText,
      source: "appointment-action",
      intent: `appointment_${parsed.data.action}`
    });

    const updatedLead = await getLeadBySessionId(sessionId);
    return res.json({ ok: true, appointment: updatedAppointment, lead: updatedLead });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Failed to process appointment action"
    });
  }
});

dealerDbAdminRouter.post("/dealer/db/notifications/owner-email/test", async (_req, res) => {
  const to = process.env.OWNER_NOTIFICATION_EMAIL || "ferkmas88@gmail.com";
  const result = await sendOwnerTestEmail({ to });
  if (!result.ok) {
    return res.status(500).json({ ok: false, to, error: result.reason || "Email test failed" });
  }
  return res.json({ ok: true, to, id: result.id || null });
});

dealerDbAdminRouter.get("/dealer/push/config", (_req, res) => {
  return res.json(getPushPublicConfig());
});

dealerDbAdminRouter.post("/dealer/push/subscribe", async (req, res) => {
  const parsed = pushSubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid push subscription payload", details: parsed.error.flatten() });
  }

  const { endpoint, keys } = parsed.data;
  await upsertPushSubscription({
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent: req.get("user-agent") || ""
  });
  return res.json({ ok: true });
});

dealerDbAdminRouter.post("/dealer/push/unsubscribe", async (req, res) => {
  const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });

  await deletePushSubscription(endpoint);
  return res.json({ ok: true });
});

dealerDbAdminRouter.get("/dealer/push/status", async (_req, res) => {
  const status = await getPushRuntimeStatus();
  return res.json(status);
});

dealerDbAdminRouter.post("/dealer/push/test", async (_req, res) => {
  const result = await sendTestPush();
  return res.json(result);
});
