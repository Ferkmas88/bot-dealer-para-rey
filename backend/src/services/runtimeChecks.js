function boolFromEnv(value, defaultValue = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function runStartupChecks() {
  const warnings = [];
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const twilioValidate = boolFromEnv(process.env.TWILIO_VALIDATE_SIGNATURE, false);

  if (!process.env.OWNER_NOTIFICATION_EMAIL) {
    warnings.push("OWNER_NOTIFICATION_EMAIL is not set. Using fallback email for owner notifications.");
  }

  if (!process.env.RESEND_API_KEY) {
    warnings.push("RESEND_API_KEY is missing. Owner email notifications can fail.");
  }

  if (isProd && !twilioValidate) {
    warnings.push("TWILIO_VALIDATE_SIGNATURE=false in production. Enable signature validation for webhook security.");
  }

  if (!process.env.TWILIO_AUTH_TOKEN) {
    warnings.push("TWILIO_AUTH_TOKEN is missing. Twilio webhook validation and sending may fail.");
  }

  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    warnings.push("Meta WhatsApp env vars are incomplete (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID).");
  }

  for (const warning of warnings) {
    console.warn(`[startup-check] ${warning}`);
  }

  return {
    ok: warnings.length === 0,
    warnings
  };
}
