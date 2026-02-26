import "dotenv/config";
import express from "express";
import cors from "cors";

import { chatRouter } from "./routes/chat.js";
import { dealerAssistantRouter } from "./routes/dealerAssistant.js";
import { dealerAiRouter } from "./routes/dealerAi.js";
import { dealerDbAdminRouter } from "./routes/dealerDbAdmin.js";
import { twilioWebhookRouter } from "./channels/twilioWebhook.js";
import { metaWebhookRouter } from "./channels/metaWebhook.js";

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "dealer-bot-backend" });
});

app.use("/api/chat", chatRouter);
app.use("/api/dealer", dealerAssistantRouter);
app.use("/", dealerAiRouter);
app.use("/", dealerDbAdminRouter);
app.use("/webhooks/twilio", twilioWebhookRouter);
app.use("/webhooks/meta", metaWebhookRouter);

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
