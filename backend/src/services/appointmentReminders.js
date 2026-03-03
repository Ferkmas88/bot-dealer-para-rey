import { findAppointmentsForReminder, getConsecutiveAssistantMessagesSinceLastUser, updateAppointment } from "./sqliteLeadStore.js";
import { sendManualWhatsAppReply } from "./twilioSender.js";
import { persistOutgoingAssistantMessage } from "./sqliteLeadStore.js";

function buildReminderMessage({ scheduledAt, minutesBefore }) {
  const when = new Date(scheduledAt);
  const whenText = Number.isNaN(when.getTime())
    ? String(scheduledAt)
    : when.toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const leadTimeText = minutesBefore <= 20 ? "15 minutos" : "2 horas";
  return `Recordatorio de cita (${leadTimeText}) para ${whenText}. Responde: confirmar / reprogramar / cancelar.`;
}

async function sendReminderForAppointment(appointment, minutesBefore) {
  const sessionId = appointment?.lead_session_id;
  if (!sessionId || !String(sessionId).startsWith("wa:")) return { ok: false, skipped: true };
  const assistantStreak = await getConsecutiveAssistantMessagesSinceLastUser(sessionId, { maxScan: 30 });
  if (assistantStreak >= 2) {
    if (minutesBefore <= 20) {
      await updateAppointment(appointment.id, {
        reminder_15m_sent_at: new Date().toISOString()
      });
    } else {
      await updateAppointment(appointment.id, {
        reminder_2h_sent_at: new Date().toISOString()
      });
    }
    return { ok: false, skipped: true, reason: "assistant_streak_limit" };
  }
  const message = buildReminderMessage({ scheduledAt: appointment.scheduled_at, minutesBefore });

  await sendManualWhatsAppReply({ sessionId, body: message });
  await persistOutgoingAssistantMessage({
    sessionId,
    assistantMessage: message,
    source: "appointment-reminder",
    intent: "appointment_reminder"
  });

  if (minutesBefore <= 20) {
    await updateAppointment(appointment.id, {
      reminder_15m_sent_at: new Date().toISOString()
    });
  } else {
    await updateAppointment(appointment.id, {
      reminder_2h_sent_at: new Date().toISOString()
    });
  }

  return { ok: true };
}

async function runReminderWindow(minutesBefore) {
  const rows = await findAppointmentsForReminder({ minutesBefore });
  if (!rows.length) return;

  for (const appointment of rows) {
    try {
      await sendReminderForAppointment(appointment, minutesBefore);
    } catch (error) {
      console.error("Appointment reminder failed:", appointment?.id, error?.message || error);
    }
  }
}

export function startAppointmentReminderJob() {
  const enabled = (process.env.APPOINTMENT_REMINDERS_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) return;

  const tick = async () => {
    await runReminderWindow(120);
    await runReminderWindow(15);
  };

  tick().catch(() => {});
  setInterval(() => {
    tick().catch(() => {});
  }, 60_000);
}
