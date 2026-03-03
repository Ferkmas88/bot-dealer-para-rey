import twilio from "twilio";

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";

  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing");
  }

  return twilio(accountSid, authToken);
}

function normalizeToWhatsAppAddress(sessionId) {
  const raw = String(sessionId || "");

  if (raw.startsWith("wa:whatsapp:")) {
    return raw.replace("wa:", "");
  }

  if (raw.startsWith("wa:+")) {
    return `whatsapp:${raw.replace("wa:", "")}`;
  }

  if (raw.startsWith("wa:")) {
    const value = raw.replace("wa:", "");
    return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
  }

  if (raw.startsWith("whatsapp:")) return raw;
  if (raw.startsWith("+")) return `whatsapp:${raw}`;

  throw new Error("Cannot derive WhatsApp recipient from sessionId");
}

export async function sendManualWhatsAppReply({ sessionId, body = "", mediaUrl = "" }) {
  const client = getTwilioClient();
  const from = process.env.TWILIO_WHATSAPP_FROM || "";

  if (!from) {
    throw new Error("TWILIO_WHATSAPP_FROM missing");
  }

  const to = normalizeToWhatsAppAddress(sessionId);
  const messageBody = String(body || "").trim();
  const media = String(mediaUrl || "").trim();
  if (!messageBody && !media) {
    throw new Error("Message body or mediaUrl is required");
  }

  const payload = {
    from: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
    to,
    body: messageBody
  };
  if (media) {
    payload.mediaUrl = [media];
  }

  const result = await client.messages.create(payload);

  return result;
}
