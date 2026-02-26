---
name: dealer-bot-ops
description: Operate and troubleshoot the "Bot dealer para Rey" stack (backend, LLM provider connection, WhatsApp webhooks, tunnel URLs, and SQLite inventory). Use when validating that the bot is responding end-to-end, checking provider status, loading inventory data, or diagnosing why WhatsApp stopped replying.
---

# Dealer Bot Ops

Run these checks in order when the bot is not replying correctly.

## 1) Verify backend and LLM

- Check health:
  - `curl.exe -s http://localhost:4000/health`
- Check AI provider status:
  - `curl.exe -s http://localhost:4000/dealer/ai/connection`
- Confirm storage:
  - `curl.exe -s http://localhost:4000/dealer/ai/storage`

If `connected=false`, the bot will fall back to local logic.

## 2) Validate bot response path

- Send a direct backend message:
  - PowerShell:
    - `$body = @{ sessionId='ops-check'; message='busco pickup con presupuesto 23000' } | ConvertTo-Json`
    - `Invoke-RestMethod -Method POST -Uri 'http://localhost:4000/dealer/ai' -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 8`
- Confirm:
  - `source` should be `llm:cerebras` when provider is online.
  - Inventory lines should come from SQLite and show max 2 vehicles.

## 3) WhatsApp webhook diagnostics (Twilio)

- Local webhook smoke test:
  - `curl.exe -s -X POST http://localhost:4000/webhooks/twilio/whatsapp -d "From=whatsapp:+5215555555555" -d "Body=hola"`
- If local works but WhatsApp does not, check tunnel and Twilio URL.

## 4) Tunnel management

- Start localtunnel:
  - `cd backend`
  - `& "C:\Program Files\nodejs\npx.cmd" localtunnel --port 4000`
- Use webhook URL:
  - `https://<subdomain>.loca.lt/webhooks/twilio/whatsapp`
- Verify public URL:
  - `curl.exe -s https://<subdomain>.loca.lt/health`

If tunnel changes, update Twilio Sandbox "When a message comes in" immediately.

## 5) SQLite inventory operations

- DB location:
  - `backend/data/dealer.sqlite`
- Table used by bot matching:
  - `inventory` (`status='available'` only)
- Quick count check (Node):
  - `node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('backend/data/dealer.sqlite'); console.log(db.prepare('select count(*) c from inventory where status=''available''').get());"`

## 6) Behavior rules to keep

- Never invent vehicles.
- Show max 2 units.
- Include year/make/model/price/mileage.
- Treat "pickup" as truck.
- If no exact match, return similar alternatives.
- Push to appointment in every response.
