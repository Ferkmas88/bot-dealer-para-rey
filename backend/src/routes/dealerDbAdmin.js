import { Router } from "express";
import { z } from "zod";
import {
  createInventoryUnit,
  deleteInventoryUnit,
  getConversationSettings,
  getInventoryById,
  listDealerConversations,
  listDealerMessagesBySession,
  markConversationRead,
  persistOutgoingAssistantMessage,
  setConversationBotEnabled,
  listInventory,
  upsertPushSubscription,
  deletePushSubscription,
  updateInventoryUnit
} from "../services/sqliteLeadStore.js";
import { sendManualWhatsAppReply } from "../services/twilioSender.js";
import { getPushPublicConfig } from "../services/pushNotifications.js";

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
