import { Router } from "express";
import { z } from "zod";
import {
  createInventoryUnit,
  createAppointment,
  deleteInventoryUnit,
  getAppointmentById,
  getLeadBySessionId,
  getConversationSettings,
  getInventoryById,
  listAppointments,
  listDealerConversations,
  listLeads,
  listDealerMessagesBySession,
  markConversationRead,
  persistOutgoingAssistantMessage,
  setConversationBotEnabled,
  listInventory,
  upsertPushSubscription,
  deletePushSubscription,
  updateAppointment,
  updateLeadStatus,
  updateInventoryUnit
} from "../services/sqliteLeadStore.js";
import { sendManualWhatsAppReply } from "../services/twilioSender.js";
import { getPushPublicConfig, getPushRuntimeStatus, sendTestPush } from "../services/pushNotifications.js";
import { sendAppointmentConfirmedOwnerEmail } from "../services/ownerNotifications.js";

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

dealerDbAdminRouter.post("/dealer/db/appointments/:id/confirm", async (req, res) => {
  const appointment = await getAppointmentById(req.params.id);
  if (!appointment) return res.status(404).json({ error: "Appointment not found" });

  const updatedAppointment = await updateAppointment(req.params.id, {
    status: "CONFIRMED",
    confirmation_state: "CONFIRMED",
    confirmed_at: new Date().toISOString()
  });

  const lead = await updateLeadStatus(appointment.lead_session_id, "BOOKED");
  await sendAppointmentConfirmedOwnerEmail({
    to: process.env.OWNER_NOTIFICATION_EMAIL || "rey1309ltu@gmail.com",
    appointment: updatedAppointment,
    lead
  });

  return res.json({ ok: true, row: updatedAppointment, lead });
});

dealerDbAdminRouter.get("/dealer/db/conversations", async (req, res) => {
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const query = typeof req.query.query === "string" ? req.query.query : "";
  const rows = await listDealerConversations({ limit, query });
  return res.json({ rows });
});

dealerDbAdminRouter.get("/dealer/db/conversations/:sessionId/messages", async (req, res) => {
  const sessionId = req.params.sessionId;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 500;
  const rows = await listDealerMessagesBySession(sessionId, { limit });
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

  if (!body) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const twilioResponse = await sendManualWhatsAppReply({ sessionId, body });
    await persistOutgoingAssistantMessage({
      sessionId,
      assistantMessage: body,
      source: "manual-agent"
    });

    return res.json({
      ok: true,
      sid: twilioResponse?.sid || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Failed to send manual reply"
    });
  }
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
