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

function inferMediaType(url) {
  const value = String(url || "").toLowerCase();
  if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(value)) return "image";
  if (/\.(mp3|aac|ogg|m4a|wav)(\?|$)/i.test(value)) return "audio";
  if (/\.(mp4|mov|webm)(\?|$)/i.test(value)) return "video";
  return "document";
}

export async function sendMetaWhatsAppText({ sessionId, to = "", text = "", mediaUrl = "" }) {
  const cfg = getMetaConfig();
  if (!cfg.accessToken || !cfg.phoneNumberId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID missing");
  }

  const normalizedTo = String(to || "").trim() || normalizeMetaToNumber(sessionId);
  if (!normalizedTo) {
    throw new Error("Meta recipient is missing");
  }
  const messageText = String(text || "").trim();
  const media = String(mediaUrl || "").trim();
  if (!messageText && !media) {
    throw new Error("Text or mediaUrl is required");
  }

  const url = `https://graph.facebook.com/${cfg.graphApiVersion}/${cfg.phoneNumberId}/messages`;
  const payload = media
    ? (() => {
        const mediaType = inferMediaType(media);
        if (mediaType === "image") {
          return {
            messaging_product: "whatsapp",
            to: normalizedTo,
            type: "image",
            image: {
              link: media,
              caption: messageText || undefined
            }
          };
        }
        if (mediaType === "audio") {
          return {
            messaging_product: "whatsapp",
            to: normalizedTo,
            type: "audio",
            audio: { link: media }
          };
        }
        if (mediaType === "video") {
          return {
            messaging_product: "whatsapp",
            to: normalizedTo,
            type: "video",
            video: {
              link: media,
              caption: messageText || undefined
            }
          };
        }
        return {
          messaging_product: "whatsapp",
          to: normalizedTo,
          type: "document",
          document: {
            link: media,
            caption: messageText || undefined
          }
        };
      })()
    : {
        messaging_product: "whatsapp",
        to: normalizedTo,
        text: { body: messageText }
      };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Meta send failed (${response.status}): ${details}`);
  }

  return response.json();
}
