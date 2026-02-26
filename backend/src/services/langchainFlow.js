import { ChatPromptTemplate } from "@langchain/core/prompts";
import { generateChatCompletion } from "./openaiClient.js";

const systemPrompt = process.env.SYSTEM_PROMPT ||
  "Eres un vendedor experto en autos. Ayuda al cliente a elegir vehiculo, presupuesto y siguiente accion.";

function toTranscript(history = []) {
  return history
    .slice(-12)
    .map((m) => `${m.role === "assistant" ? "Asistente" : "Cliente"}: ${m.content}`)
    .join("\n");
}

export async function runDealerAssistant({ message, history, metadata }) {
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    [
      "human",
      [
        "Historial reciente:",
        "{history}",
        "",
        "Datos de contexto opcionales:",
        "{metadata}",
        "",
        "Mensaje actual del cliente:",
        "{message}",
        "",
        "Responde en espanol con tono comercial consultivo.",
        "Siempre termina con una pregunta de avance (cita, presupuesto o preferencias)."
      ].join("\n")
    ]
  ]);

  const formatted = await prompt.format({
    history: toTranscript(history),
    metadata: JSON.stringify(metadata || {}, null, 2),
    message
  });

  const reply = await generateChatCompletion([
    { role: "system", content: systemPrompt },
    { role: "user", content: formatted }
  ]);

  return reply || "Perfecto. Para ayudarte mejor, dime tu presupuesto aproximado y tipo de auto que buscas.";
}
