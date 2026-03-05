import express from "express";
import twilio from "twilio";
import { processInboundDealerMessage } from "../services/dealerInboundEngine.js";
import { persistIncomingUserMessage } from "../services/sqliteLeadStore.js";
import { sendInboundWhatsAppPush } from "../services/pushNotifications.js";

export const twilioWebhookRouter = express.Router();

const cadenceBySession = new Map();
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

function isShortMeaningfulReply(text) {
  const value = String(text || "").trim().toLowerCase();
  return /^(ok|okay|si|sí|yes|no|thx|thanks|\?)$/.test(value);
}

function shouldSilenceLowSignalReply(sessionId, text) {
  if (isShortMeaningfulReply(text)) {
    return { silence: false, lowSignal: false };
  }
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
  if (wasLowSignalReply) current.lastLowSignalReplyAt = now;
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

    const result = await processInboundDealerMessage({
      sessionId,
      incomingText,
      inboundProfileName,
      phone: from.replace(/^whatsapp:/, ""),
      source: "whatsapp",
      channel: "twilio_whatsapp",
      userId: from,
      messageId: inboundMessageId,
      timestampMs: Date.now()
    });

    if (result.shouldNotifyInboundPush) {
      sendInboundWhatsAppPush({ sessionId, from, message: incomingText }).catch(() => {});
    }

    const twiml = new twilio.twiml.MessagingResponse();
    if (result.shouldReply && result.reply) {
      const msg = twiml.message();
      msg.body(result.reply);
      if (result.mediaUrl) {
        msg.media(result.mediaUrl);
      }
      markReplySent(sessionId, cadenceDecision.lowSignal);
    }

    return res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("Twilio webhook error:", error);
    return res.status(500).send("Server error");
  }
});
