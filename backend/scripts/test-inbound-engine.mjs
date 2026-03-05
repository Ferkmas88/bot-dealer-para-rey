import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const sqlitePath = resolve("./data/test-inbound-engine.sqlite");
mkdirSync(dirname(sqlitePath), { recursive: true });
if (existsSync(sqlitePath)) {
  rmSync(sqlitePath, { force: true });
}

process.env.SQLITE_PATH = sqlitePath;
process.env.OWNER_NOTIFICATION_EMAIL = process.env.OWNER_NOTIFICATION_EMAIL || "test@example.com";
process.env.COPY_EXPERIMENT = process.env.COPY_EXPERIMENT || "ab";
process.env.COPY_AB_MODE = process.env.COPY_AB_MODE || "hash";
process.env.COPY_AB_SALT = process.env.COPY_AB_SALT || "test-copy-salt";

const { processInboundDealerMessage, getInboundEngineMetrics, resetInboundEngineMetrics } = await import(
  "../src/services/dealerInboundEngine.js"
);
const db = new DatabaseSync(sqlitePath);

function expectAny(text, patterns, label) {
  const ok = patterns.some((rx) => rx.test(text || ""));
  assert.ok(ok, `${label} -> reply inesperada:\n${text}`);
}

function expectNot(text, pattern, label) {
  assert.ok(!pattern.test(text || ""), `${label} -> reply no permitida:\n${text}`);
}

async function ask(sessionId, channel, text, extra = {}) {
  return processInboundDealerMessage({
    sessionId,
    incomingText: text,
    inboundProfileName: "QA",
    phone: "5551113333",
    source: "whatsapp",
    channel,
    userId: `test-user:${sessionId}`,
    ...extra
  });
}

async function run() {
  const runId = Date.now();
  const results = [];
  resetInboundEngineMetrics();

  {
    const r = await ask(`test:${runId}:address`, "twilio_whatsapp", "donde estan ubicados");
    expectAny(r.reply, [/3510/i, /dixie/i, /louisville/i], "address");
    results.push("address");
  }

  {
    const r = await ask(`test:${runId}:mechanic`, "meta_whatsapp", "tienen mecanico");
    expectAny(r.reply, [/mecanic/i, /servicio/i], "mechanic");
    results.push("mechanic");
  }

  {
    const r = await ask(`test:${runId}:handoff`, "twilio_whatsapp", "quiero hablar con una persona");
    expectAny(r.reply, [/rey/i, /asesor humano/i, /502/i], "handoff");
    results.push("handoff");
  }

  {
    const sid = `test:${runId}:create_appt`;
    await ask(sid, "meta_whatsapp", "quiero cita manana 11am");
    await ask(sid, "meta_whatsapp", "me llamo luis");
    const r = await ask(sid, "meta_whatsapp", "5027801096");
    expectAny(r.reply, [/cita/i, /agend/i, /confirm/i, /reservar/i, /telefono/i], "appointment_create");
    expectNot(r.reply, /buscas sedan|pickup|suv/i, "appointment_create_no_fallback");
    results.push("appointment_create");
  }

  {
    const sid = `test:${runId}:single_message_all_fields`;
    const r = await ask(
      sid,
      "twilio_whatsapp",
      "quiero cita manana 1pm, mi nombre es Carlos y mi telefono 5021234567"
    );
    expectAny(r.reply, [/cita/i, /agend/i, /confirm/i, /nombre/i, /telefono/i], "appointment_all_fields_single_message");
    expectNot(r.reply, /buscas sedan|pickup|suv/i, "appointment_all_fields_single_message_no_fallback");
    results.push("appointment_all_fields_single_message");
  }

  {
    const sid = `test:${runId}:hour_question`;
    await ask(sid, "twilio_whatsapp", "quiero cita manana 4pm");
    await ask(sid, "twilio_whatsapp", "me llamo ana");
    await ask(sid, "twilio_whatsapp", "5025768116");
    const r = await ask(sid, "twilio_whatsapp", "a que hora es la cita");
    expectAny(r.reply, [/cita/i, /confirm/i, /para/i, /\b4pm\b/i], "appointment_hour_question");
    expectNot(r.reply, /trabajamos de lunes/i, "appointment_hour_not_business_hours");
    results.push("appointment_hour_question");
  }

  {
    const sid = `test:${runId}:cancel_appt`;
    await ask(sid, "meta_whatsapp", "quiero cita manana 5pm");
    await ask(sid, "meta_whatsapp", "me llamo jose");
    await ask(sid, "meta_whatsapp", "5559993333");
    const r = await ask(sid, "meta_whatsapp", "cancelar");
    expectAny(r.reply, [/cancelada/i, /cancel/i], "appointment_cancel");
    results.push("appointment_cancel");
  }

  {
    const sid = `test:${runId}:phone_before_name`;
    await ask(sid, "meta_whatsapp", "quiero cita manana 2pm");
    const r = await ask(sid, "meta_whatsapp", "5024441111");
    expectAny(r.reply, [/nombre/i, /cita/i, /telefono/i], "phone_before_name");
    expectNot(r.reply, /buscas sedan|pickup|suv/i, "phone_before_name_no_fallback");
    results.push("phone_before_name");
  }

  {
    const sid = `test:${runId}:occupied_then_phone`;
    const seedSid = `test:${runId}:occupied_seed`;
    await ask(seedSid, "twilio_whatsapp", "quiero cita manana 3pm");
    await ask(seedSid, "twilio_whatsapp", "me llamo seed");
    await ask(seedSid, "twilio_whatsapp", "5551118888");

    const first = await ask(sid, "twilio_whatsapp", "quiero cita manana 3pm");
    const second = await ask(sid, "twilio_whatsapp", "5029990000");
    expectAny(first.reply, [/ocupado/i, /disponible/i, /cita/i], "occupied_first_reply");
    expectAny(second.reply, [/otra hora/i, /hora para tu cita/i, /hora/i], "occupied_then_phone_keeps_flow");
    expectNot(second.reply, /buscas sedan|pickup|suv/i, "occupied_then_phone_no_fallback");
    results.push("occupied_then_phone_keeps_flow");
  }

  {
    const sid = `test:${runId}:active_flow_faq`;
    await ask(sid, "meta_whatsapp", "quiero cita manana 3pm");
    const r = await ask(sid, "meta_whatsapp", "donde estan");
    expectAny(r.reply, [/3510|dixie|louisville/i], "active_flow_faq_address_part");
    expectAny(r.reply, [/hora para tu cita/i, /otra hora/i], "active_flow_faq_returns_to_flow");
    results.push("active_flow_faq_returns_to_flow");
  }

  {
    const sid = `test:${runId}:affirmation_response`;
    const seedSid = `test:${runId}:affirmation_seed`;
    await ask(seedSid, "meta_whatsapp", "quiero cita manana 3pm");
    await ask(seedSid, "meta_whatsapp", "me llamo seed2");
    await ask(seedSid, "meta_whatsapp", "5551117777");

    await ask(sid, "meta_whatsapp", "quiero cita manana 3pm");
    const r = await ask(sid, "meta_whatsapp", "si");
    expectAny(r.reply, [/hora/i, /prefieres/i, /cita/i], "affirmation_response");
    expectNot(r.reply, /buscas sedan|pickup|suv/i, "affirmation_response_no_fallback");
    results.push("affirmation_response");
  }

  {
    const sid = `test:${runId}:emoji_or_short_ack`;
    const seedSid = `test:${runId}:emoji_seed`;
    await ask(seedSid, "twilio_whatsapp", "quiero cita manana 3pm");
    await ask(seedSid, "twilio_whatsapp", "me llamo seed3");
    await ask(seedSid, "twilio_whatsapp", "5551116666");

    await ask(sid, "twilio_whatsapp", "quiero cita manana 3pm");
    const r = await ask(sid, "twilio_whatsapp", "👍");
    expectAny(r.reply, [/hora/i, /cita/i, /prefieres/i], "emoji_or_short_ack");
    expectNot(r.reply, /buscas sedan|pickup|suv/i, "emoji_or_short_ack_no_fallback");
    results.push("emoji_or_short_ack");
  }

  {
    const sid = `test:${runId}:conversation_full_booking_flow`;
    const r1 = await ask(sid, "twilio_whatsapp", "hola");
    const r2 = await ask(sid, "twilio_whatsapp", "quiero cita manana");
    const r3 = await ask(sid, "twilio_whatsapp", "3:30pm");
    const r4 = await ask(sid, "twilio_whatsapp", "mi nombre es juan");
    const r5 = await ask(sid, "twilio_whatsapp", "5023337777");
    expectAny(r1.reply, [/Empire Rey Auto Sales/i, /asistente virtual/i], "conversation_full_booking_flow_intro");
    expectAny(r2.reply, [/hora/i, /cita/i], "conversation_full_booking_flow_step2");
    expectAny(r3.reply, [/nombre|telefono|cita|reservar|ocupado|disponible/i], "conversation_full_booking_flow_step3");
    expectAny(r4.reply, [/telefono|cita|nombre|otra hora|no esta libre|ocupado/i], "conversation_full_booking_flow_step4");
    expectAny(r5.reply, [/cita|direccion|queda|confirm|otra hora|no esta libre|ocupado/i], "conversation_full_booking_flow_step5");
    expectNot(r5.reply, /buscas sedan|pickup|suv/i, "conversation_full_booking_flow_no_fallback");
    results.push("conversation_full_booking_flow");
  }

  {
    const sid = `test:${runId}:persistence_check`;
    await ask(sid, "meta_whatsapp", "quiero cita manana 7:17pm");
    await ask(sid, "meta_whatsapp", "me llamo persist");
    await ask(sid, "meta_whatsapp", "5028882222");

    const row = db
      .prepare(
        `SELECT a.id, a.lead_session_id, a.status, a.confirmation_state, a.scheduled_at
         FROM appointments a
         WHERE a.lead_session_id = ?
         ORDER BY a.id DESC
         LIMIT 1`
      )
      .get(sid);
    assert.ok(row, "appointment_persistence -> no se inserto cita en DB");
    expectAny(String(row.status || ""), [/PENDING|CONFIRMED|RESCHEDULED/i], "appointment_persistence_status");
    assert.ok(row.scheduled_at, "appointment_persistence -> scheduled_at vacio");
    results.push("appointment_persistence");
  }

  {
    const sid = `test:${runId}:no_openai_fallback`;
    const r = await ask(sid, "meta_whatsapp", "necesito ayuda general de compra");
    expectAny(r.reply, [/alta demanda/i, /down payment/i, /suv|sedan|pickup/i], "no_openai_key_fallback");
    results.push("no_openai_key_fallback");
  }

  {
    const sid = `test:${runId}:no_resend_no_crash`;
    const r = await ask(sid, "twilio_whatsapp", "quiero cita manana 6:47pm");
    expectAny(r.reply, [/cita|hora|agend|confirm/i], "no_resend_key_does_not_crash");
    results.push("no_resend_key_does_not_crash");
  }

  {
    const sid = `test:${runId}:duplicate_event`;
    const key = `dup-${runId}-1`;
    await ask(sid, "meta_whatsapp", "quiero cita manana 6:05pm", { messageId: key });
    await ask(sid, "meta_whatsapp", "quiero cita manana 6:05pm", { messageId: key });
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM appointments
         WHERE lead_session_id = ?`
      )
      .get(sid);
    assert.ok(Number(countRow?.c || 0) <= 1, "duplicate_event_does_not_double_book -> mas de una cita creada");
    results.push("duplicate_event_does_not_double_book");
  }

  {
    const before = getInboundEngineMetrics().llmCallsCount;
    await ask(`test:${runId}:cost_control_1`, "twilio_whatsapp", "donde estan");
    await ask(`test:${runId}:cost_control_2`, "meta_whatsapp", "quiero cita manana 10am");
    const after = getInboundEngineMetrics().llmCallsCount;
    assert.equal(after, before, "cost_control_no_llm_for_fastpaths -> llmCallsCount incremento en fastpaths");
    results.push("cost_control_no_llm_for_fastpaths");
  }

  {
    const sid = `test:${runId}:copy_variant_stable`;
    await ask(sid, "twilio_whatsapp", "hola", { userId: "stable-user-100" });
    await ask(sid, "twilio_whatsapp", "donde estan", { userId: "stable-user-100" });
    const variants = db
      .prepare(
        `SELECT DISTINCT copy_variant AS v
         FROM conversation_events
         WHERE session_id = ?
           AND copy_variant IS NOT NULL`
      )
      .all(sid)
      .map((r) => String(r.v || ""));
    assert.equal(variants.length, 1, "copy_variant_stable -> variante cambio dentro de la misma conversacion");
    assert.ok(["A", "B"].includes(variants[0]), "copy_variant_stable -> variante invalida");
    results.push("copy_variant_stable");
  }

  console.log(`PASS ${results.length} tests`);
  for (const name of results) {
    console.log(`- ${name}`);
  }
}

run().catch((error) => {
  console.error("FAIL test-inbound-engine");
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
