import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sqlitePath = resolve("./data/test-qa-matrix.sqlite");
mkdirSync(dirname(sqlitePath), { recursive: true });
if (existsSync(sqlitePath)) {
  try {
    rmSync(sqlitePath, { force: true });
  } catch {
    // ignore stale lock from previous interrupted run
  }
}

process.env.SQLITE_PATH = sqlitePath;
process.env.OWNER_NOTIFICATION_EMAIL = process.env.OWNER_NOTIFICATION_EMAIL || "qa@example.com";

const { processInboundDealerMessage } = await import("../src/services/dealerInboundEngine.js");

const personas = Number(process.env.QA_PERSONAS || 10);
const questions = [
  "Hola","Buenas","Buenas tardes","?Hay alguien ah??","?Qui?n me puede ayudar?","Estoy interesado en un carro","Quiero informaci?n","?Este es el dealer?","?Es Empire Rey?","Necesito ayuda",
  "?Qu? carros tienen disponibles?","?Tienen SUVs?","?Tienen sedanes?","?Tienen pickups?","?Cu?l es el carro m?s barato?","Busco un carro econ?mico","?Qu? carros tienen en oferta?","?Tienen carros autom?ticos?","?Tienen carros familiares?","?Qu? carro recomiendan?",
  "?Cu?nto cuesta ese carro?","?Cu?nto es el pago semanal?","?Cu?nto es el down payment?","?Cu?nto necesito para empezar?","?Tienen pagos mensuales?","?Cu?l es el carro m?s barato que tienen?","?Puedo pagar poco al principio?","?Tienen financiamiento f?cil?","?Cu?nto pagar?a al mes?","?Cu?nto pagar?a por semana?",
  "?Aprueban sin cr?dito?","?Aceptan ITIN?","Solo tengo ID ?puedo comprar?","Tengo cr?dito bajo ?puedo aplicar?","?Necesito cr?dito para comprar?","?Aprueban r?pido?","?Cu?nto tarda la aprobaci?n?","?Hacen financiamiento interno?","?Puedo aplicar hoy?","?Me aprueban el mismo d?a?",
  "?D?nde est?n ubicados?","?Cu?l es la direcci?n?","?A qu? hora abren?","?A qu? hora cierran?","?Est?n abiertos hoy?","?Puedo ir ahora?","?Tienen p?gina web?","?Tienen Facebook o Instagram?","?Cu?l es el tel?fono del dealer?","?Puedo hablar con el due?o?",
  "Quiero agendar una cita","?Puedo ir ma?ana?","?A qu? hora puedo ir?","?Puedo visitar el dealer hoy?","?Necesito cita para ir?","?Puedo ir sin cita?","Quiero ver los carros en persona","?Puedo probar el carro?","?Puedo reservar un carro?","?Puedo ir el fin de semana?",
  "?Qu? necesito para comprar un carro?","?Necesito licencia?","?Aceptan ITIN?","?Puedo comprar con pasaporte?","?Necesito seguro?","?Qu? documentos debo llevar?","?Necesito comprobante de ingresos?","?Puedo comprar si soy nuevo en el pa?s?","?Necesito Social Security?","?Qu? papeles necesito?",
  "Tengo un carro viejo ?lo reciben?","?Aceptan trade-in?","?Puedo cambiar mi carro por otro?","?Cu?nto me dan por mi carro?","?Reciben carros usados?","?Aceptan carros da?ados?","?Puedo usar mi carro como parte de pago?","?Compran carros usados?","?Puedo vender mi carro al dealer?","?Aceptan carros con problemas?",
  "?Tienen mec?nico?","?Hacen reparaciones?","?Pueden revisar mi carro?","?Cu?nto cuesta revisar un carro?","?Hacen cambio de aceite?","?Arreglan frenos?","?Puedo llevar mi carro al mec?nico?","?Hacen diagn?sticos?","?Cu?nto cuesta reparar un carro?","?Puedo hablar con el mec?nico?",
  "Solo estoy mirando opciones","Estoy comparando precios","No estoy seguro qu? carro comprar","Quiero ver qu? tienen disponible","Estoy buscando algo barato","Estoy viendo opciones para mi familia","Tal vez compre pronto","Estoy pensando comprar un carro","?Qu? me recomiendan?","?Qu? carros tienen hoy?"
];

const results = [];
for (let p = 1; p <= personas; p += 1) {
  const sessionId = `qa-persona-${p}`;
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const r = await processInboundDealerMessage({
      sessionId,
      incomingText: q,
      inboundProfileName: "QA",
      phone: null,
      source: "webchat",
      channel: "twilio_whatsapp",
      userId: `qa-user-${p}`,
      messageId: `qa-${p}-${i + 1}`,
      timestampMs: Date.now()
    });
    results.push({ persona: p, idx: i + 1, question: q, kind: r.kind, reply: String(r.reply || "") });
  }
}

const total = results.length;
const byKind = results.reduce((acc, row) => {
  const key = row.kind || "unknown";
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

console.log(JSON.stringify({ personas, questions: questions.length, total, byKind }, null, 2));

if (existsSync(sqlitePath)) {
  try {
    rmSync(sqlitePath, { force: true });
  } catch {
    // sqlite module may hold a lock briefly; cleanup is best-effort
  }
}
