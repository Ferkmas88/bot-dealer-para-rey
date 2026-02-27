import { Router } from "express";
import { z } from "zod";
import {
  createInventoryUnit,
  deleteInventoryUnit,
  getInventoryById,
  listInventory,
  updateInventoryUnit
} from "../services/sqliteLeadStore.js";

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
