function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildEmailHtml({ appointment, lead }) {
  const leadName = lead?.name || "Sin nombre";
  const leadPhone = lead?.phone || appointment?.lead_phone || appointment?.lead_session_id || "N/A";
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>Cita Confirmada - Empire Rey</h2>
      <p><strong>Cliente:</strong> ${leadName}</p>
      <p><strong>Telefono:</strong> ${leadPhone}</p>
      <p><strong>Lead:</strong> ${appointment?.lead_session_id || "-"}</p>
      <p><strong>Fecha/Hora:</strong> ${formatDateTime(appointment?.scheduled_at)}</p>
      <p><strong>Estado:</strong> ${appointment?.status || "-"}</p>
      <p><strong>Vehiculo ID:</strong> ${appointment?.vehicle_id ?? "-"}</p>
    </div>
  `;
}

function buildHotLeadEmailHtml({ lead, lastMessage = "", appointment = null }) {
  const leadName = lead?.name || "Sin nombre";
  const leadPhone = lead?.phone || lead?.session_id || "N/A";
  const priority = String(lead?.priority || "HIGH").toUpperCase();
  const status = String(lead?.status || "QUALIFYING").toUpperCase();
  const hasAppointment = Boolean(appointment?.scheduled_at);

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>HOT LEAD - Requiere humano</h2>
      <p><strong>Cliente:</strong> ${escapeHtml(leadName)}</p>
      <p><strong>Telefono:</strong> ${escapeHtml(leadPhone)}</p>
      <p><strong>Lead:</strong> ${escapeHtml(lead?.session_id || "-")}</p>
      <p><strong>Prioridad:</strong> ${escapeHtml(priority)}</p>
      <p><strong>Status:</strong> ${escapeHtml(status)}</p>
      ${
        hasAppointment
          ? `<p><strong>Cita:</strong> ${escapeHtml(formatDateTime(appointment.scheduled_at))} (${escapeHtml(appointment.status || "PENDING")})</p>`
          : "<p><strong>Cita:</strong> No tiene cita activa</p>"
      }
      <p><strong>Ultimo mensaje cliente:</strong></p>
      <blockquote style="border-left:3px solid #d4a63a;padding-left:10px;color:#333">${escapeHtml(lastMessage || "-")}</blockquote>
    </div>
  `;
}

async function sendViaResend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.RESEND_FROM || "Empire Rey <onboarding@resend.dev>";
  if (!apiKey) return { ok: false, reason: "RESEND_API_KEY missing" };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html
    })
  });

  if (!response.ok) {
    const reason = await response.text();
    return { ok: false, reason: `Resend error ${response.status}: ${reason}` };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    ok: true,
    id: payload?.id || null
  };
}

export async function sendAppointmentConfirmedOwnerEmail({ to, appointment, lead }) {
  if (!to) return { ok: false, reason: "Owner email missing" };

  const subject = `Cita confirmada: ${lead?.name || appointment?.lead_session_id || "Lead"}`;
  const html = buildEmailHtml({ appointment, lead });
  const result = await sendViaResend({ to, subject, html });

  if (!result.ok) {
    console.error("Owner appointment email failed:", result.reason);
  }

  return result;
}

export async function sendHotLeadHandoffOwnerEmail({ to, lead, lastMessage = "", appointment = null }) {
  if (!to) return { ok: false, reason: "Owner email missing" };

  const subject = `HOT lead: ${lead?.name || lead?.phone || lead?.session_id || "Lead"}`;
  const html = buildHotLeadEmailHtml({ lead, lastMessage, appointment });
  const result = await sendViaResend({ to, subject, html });

  if (!result.ok) {
    console.error("Owner hot lead email failed:", result.reason);
  }

  return result;
}

export async function sendOwnerTestEmail({ to }) {
  if (!to) return { ok: false, reason: "Owner email missing" };
  const subject = "Prueba de correo - Empire Rey";
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>Prueba de correo</h2>
      <p>Este es un correo de prueba de notificaciones de citas.</p>
      <p><strong>Fecha:</strong> ${new Date().toLocaleString("en-US")}</p>
    </div>
  `;
  const result = await sendViaResend({ to, subject, html });
  if (!result.ok) {
    console.error("Owner test email failed:", result.reason);
  }
  return result;
}
