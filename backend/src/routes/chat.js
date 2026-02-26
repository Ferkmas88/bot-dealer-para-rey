import { Router } from "express";
import { z } from "zod";
import { runDealerAssistant } from "../services/langchainFlow.js";
import { appendMessage, getConversation } from "../services/leadContext.js";

const bodySchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  metadata: z.record(z.any()).optional()
});

export const chatRouter = Router();

chatRouter.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Invalid payload",
      details: parsed.error.flatten()
    });
  }

  const { sessionId, message, metadata } = parsed.data;

  try {
    appendMessage(sessionId, { role: "user", content: message });

    const history = getConversation(sessionId);
    const aiReply = await runDealerAssistant({ sessionId, message, history, metadata });

    appendMessage(sessionId, { role: "assistant", content: aiReply });

    return res.json({
      ok: true,
      sessionId,
      reply: aiReply,
      turns: history.length + 1
    });
  } catch (error) {
    console.error("/api/chat error:", error);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});
