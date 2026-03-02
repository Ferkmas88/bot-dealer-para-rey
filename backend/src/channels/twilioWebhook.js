import express from "express";
import twilio from "twilio";
import { processDealerSessionMessageWithLLM } from "../services/dealerSalesAssistant.js";
import { getDealerSession, getLearningState, saveDealerTurn } from "../services/dealerSessionStore.js";
import { getConversationSettings, persistIncomingUserMessage } from "../services/sqliteLeadStore.js";

export const twilioWebhookRouter = express.Router();
const cadenceBySession = new Map();

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
  const sessionId = `wa:${from}`;

  try {
    const settings = await getConversationSettings(sessionId);
    const botEnabled = Number(settings?.bot_enabled ?? 1) === 1;

    if (!botEnabled) {
      await persistIncomingUserMessage({
        sessionId,
        userMessage: incomingText,
        source: "bot-disabled"
      });

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

    await saveDealerTurn({
      sessionId,
      userMessage: incomingText,
      aiResult
    });

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
