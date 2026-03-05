# Bot AI para Dealer - Base Inicial

Base de proyecto para arrancar un bot AI para concesionario/dealer con:

- Node.js + Express (API principal)
- LangChain (orquestacion del prompt)
- OpenAI API
- Frontend en React (Vite)
- Endpoint webhook para WhatsApp via Twilio

## Estructura

- `backend/`: API, logica de IA, webhook de Twilio
- `frontend/`: panel simple para probar conversaciones

## Requisitos

- Node.js 18+
- Cuenta OpenAI
- (Opcional) Cuenta Twilio WhatsApp Sandbox

## 1) Configuracion

1. Copia `backend/.env.example` a `backend/.env`.
2. Completa al menos:
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (ejemplo: `gpt-4o-mini` o `gpt-4.1-mini`)
   - `SYSTEM_PROMPT`
   - `NEON_DATABASE_URL` (requerido en produccion)
   - `NEON_ONLY=true` (recomendado para forzar Neon y desactivar fallback SQLite)

En produccion se recomienda Neon-only para evitar desalineaciones con SQLite local.

## 2) Instalar dependencias

Backend:

```bash
cd backend
npm install
npm run dev
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## 3) Endpoints clave

- `GET /health` -> estado del backend
- `POST /api/chat` -> chat JSON para web
- `POST /webhooks/twilio/whatsapp` -> webhook WhatsApp Twilio
- `GET /dealer/db/inventory` -> listar inventario SQLite
- `POST /dealer/db/inventory` -> crear unidad
- `PUT /dealer/db/inventory/:id` -> actualizar unidad
- `DELETE /dealer/db/inventory/:id` -> eliminar unidad
- `GET /dealer/ai/storage` -> confirma si backend esta usando `postgres` o `sqlite`
- `POST /dealer/ai/cache/clear` -> limpia cache de sesiones en memoria (`{ "sessionId": "..." }` opcional)

## Skill conversacional (DB on-demand)

Se agrego la skill local:

- `skills/dealer-conversacional-db-on-demand/SKILL.md`

Objetivo: responder en modo dealer conversacional y consultar base de datos solo cuando el usuario solicita disponibilidad/inventario/precio/filtros.

## 4) Prueba rapida

```bash
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo-1","message":"Hola, busco una SUV usada"}'
```

## 5) Twilio (opcional)

Configura en Twilio Sandbox la URL de webhook apuntando a:

- `https://TU_DOMINIO/webhooks/twilio/whatsapp`

Para desarrollo local usa ngrok o Cloudflare Tunnel.
