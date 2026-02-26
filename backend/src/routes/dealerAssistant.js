import { Router } from "express";
import { z } from "zod";
import { processDealerMessage } from "../services/dealerSalesAssistant.js";

const bodySchema = z.object({
  message: z.string().min(1)
});

export const dealerAssistantRouter = Router();

dealerAssistantRouter.post("/process", (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Invalid payload",
      details: parsed.error.flatten()
    });
  }

  const { message } = parsed.data;
  const result = processDealerMessage(message);

  return res.json({
    ok: true,
    ...result
  });
});
