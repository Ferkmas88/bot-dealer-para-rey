function getMetaConfig() {
  return {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION || "v21.0"
  };
}

function normalizeMetaToNumber(sessionId) {
  const raw = String(sessionId || "");
  if (raw.startsWith("wa_meta:")) {
    return raw.replace("wa_meta:", "").replace(/\D/g, "");
  }
  throw new Error("Cannot derive Meta recipient from sessionId");
}

export async function sendMetaWhatsAppText({ sessionId, to = "", text = "" }) {
  const cfg = getMetaConfig();
  if (!cfg.accessToken || !cfg.phoneNumberId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID missing");
  }

  const normalizedTo = String(to || "").trim() || normalizeMetaToNumber(sessionId);
  if (!normalizedTo) {
    throw new Error("Meta recipient is missing");
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
      to: normalizedTo,
      text: { body: String(text || "") }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Meta send failed (${response.status}): ${details}`);
  }

  return response.json();
}
