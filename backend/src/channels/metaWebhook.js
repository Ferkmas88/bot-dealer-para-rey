import express from "express";
import { processDealerSessionMessageWithLLM } from "../services/dealerSalesAssistant.js";
import { getDealerSession, getLearningState, saveDealerTurn } from "../services/dealerSessionStore.js";
import { getConversationSettings, persistIncomingUserMessage } from "../services/sqliteLeadStore.js";

export const metaWebhookRouter = express.Router();

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
      const sessionId = `wa_meta:${msg.from}`;
      const settings = await getConversationSettings(sessionId);
      const botEnabled = Number(settings?.bot_enabled ?? 1) === 1;

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
