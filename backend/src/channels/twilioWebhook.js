import express from "express";
import twilio from "twilio";
import { processDealerSessionMessageWithLLM } from "../services/dealerSalesAssistant.js";
import { getDealerSession, getLearningState, saveDealerTurn } from "../services/dealerSessionStore.js";

export const twilioWebhookRouter = express.Router();

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
    const session = getDealerSession(sessionId);
    const learningState = getLearningState(sessionId);

    const aiResult = await processDealerSessionMessageWithLLM(
      incomingText,
      session.context,
      learningState
    );

    saveDealerTurn({
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

    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("Twilio webhook error:", error);
    res.status(500).send("Server error");
  }
});
