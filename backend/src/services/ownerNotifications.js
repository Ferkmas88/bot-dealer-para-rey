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

  return { ok: true };
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
