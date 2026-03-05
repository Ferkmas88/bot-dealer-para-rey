import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import { chatRouter } from "./routes/chat.js";
import { dealerAssistantRouter } from "./routes/dealerAssistant.js";
import { dealerAiRouter } from "./routes/dealerAi.js";
import { dealerDbAdminRouter } from "./routes/dealerDbAdmin.js";
import { twilioWebhookRouter } from "./channels/twilioWebhook.js";
import { metaWebhookRouter } from "./channels/metaWebhook.js";
import { startAppointmentReminderJob } from "./services/appointmentReminders.js";
import { runStartupChecks } from "./services/runtimeChecks.js";

const app = express();
const port = process.env.PORT || 4000;
const releaseTag = "greeting-guard-2026-03-05-7da66f1";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDistPath = path.resolve(__dirname, "../public");

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false, limit: "25mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "dealer-bot-backend", release: releaseTag });
});

app.use("/api/chat", chatRouter);
app.use("/api/dealer", dealerAssistantRouter);
app.use("/", dealerAiRouter);
app.use("/", dealerDbAdminRouter);
app.use("/webhooks/twilio", twilioWebhookRouter);
app.use("/webhooks/meta", metaWebhookRouter);
app.use(express.static(frontendDistPath));

app.get(["/admin", "/admin/whatsapp", "/admin/whatpp", "/wsp"], (_req, res) => {
  return res.sendFile(path.join(frontendDistPath, "index.html"));
});

app.get("*", (req, res, next) => {
  if (
    req.path === "/health" ||
    req.path.startsWith("/api") ||
    req.path.startsWith("/dealer") ||
    req.path.startsWith("/webhooks")
  ) {
    return next();
  }

  return res.sendFile(path.join(frontendDistPath, "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error("[express-error]", error?.message || error);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error?.message || error);
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
  runStartupChecks();
});

startAppointmentReminderJob();
