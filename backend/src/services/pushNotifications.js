import webpush from "web-push";
import { deletePushSubscription, getUnreadMessagesTotal, listPushSubscriptions } from "./sqliteLeadStore.js";

function getVapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  const enabled = Boolean(publicKey && privateKey);
  return { enabled, publicKey, privateKey, subject };
}

function configureWebPush() {
  const config = getVapidConfig();
  if (!config.enabled) return config;

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return config;
}

export function getPushPublicConfig() {
  const config = getVapidConfig();
  return {
    enabled: config.enabled,
    publicKey: config.enabled ? config.publicKey : null
  };
}

export async function sendInboundWhatsAppPush({ sessionId, from, message }) {
  const config = configureWebPush();
  if (!config.enabled) return { sent: 0, skipped: true };

  const subscriptions = await listPushSubscriptions();
  if (!subscriptions.length) return { sent: 0, skipped: true };

  const safeFrom = String(from || sessionId || "WhatsApp");
  const safeMessage = String(message || "").trim() || "Nuevo mensaje recibido";
  const badgeCount = await getUnreadMessagesTotal();
  const payload = JSON.stringify({
    title: "Nuevo mensaje de WhatsApp",
    body: `${safeFrom}: ${safeMessage.slice(0, 140)}`,
    icon: "/2026-01-14.webp",
    badge: "/2026-01-14.webp",
    tag: "dealer-whatsapp-inbox",
    url: "/",
    badgeCount
  });

  let sent = 0;
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, payload);
        sent += 1;
      } catch (error) {
        const statusCode = Number(error?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          await deletePushSubscription(subscription.endpoint);
        }
      }
    })
  );

  return { sent, skipped: false };
}
