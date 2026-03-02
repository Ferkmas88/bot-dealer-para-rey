import { persistDealerFeedbackToSqlite, persistDealerTurnToSqlite } from "./sqliteLeadStore.js";

const sessions = new Map();

function createEmptySession(sessionId) {
  return {
    sessionId,
    context: {
      model: null,
      budget: null,
      date: null,
      contact: { email: null, phone: null },
      lastIntent: null
    },
    extractedData: {
      model: null,
      budget: null,
      date: null,
      contact: { email: null, phone: null }
    },
    conversation: [],
    monitoring: {
      objectionCount: 0,
      missedAppointments: 0,
      lowRatingCount: 0,
      feedback: [],
      failures: [],
      learningProposals: []
    },
    updatedAt: new Date().toISOString()
  };
}

function mergeExtracted(existing, incoming) {
  return {
    model: incoming.model ?? existing.model ?? null,
    budget: incoming.budget ?? existing.budget ?? null,
    date: incoming.date ?? existing.date ?? null,
    contact: {
      email: incoming.contact?.email ?? existing.contact?.email ?? null,
      phone: incoming.contact?.phone ?? existing.contact?.phone ?? null
    }
  };
}

function isMissedAppointmentMessage(message) {
  return /(no pude ir|no fui|se me paso|perdi la cita|missed.*appointment|couldn'?t make it)/i.test(message || "");
}

function upsertLearningProposal(session, type, description) {
  const existing = session.monitoring.learningProposals.find((p) => p.type === type);
  const now = new Date().toISOString();

  if (existing) {
    existing.count += 1;
    existing.description = description;
    existing.updatedAt = now;
    return;
  }

  session.monitoring.learningProposals.push({
    type,
    description,
    count: 1,
    updatedAt: now
  });
}

function registerFailure(session, type, details) {
  const record = {
    type,
    details,
    createdAt: new Date().toISOString()
  };

  session.monitoring.failures.push(record);

  if (session.monitoring.failures.length > 100) {
    session.monitoring.failures.splice(0, session.monitoring.failures.length - 100);
  }
}

function updateLearningSignals(session, userMessage, aiResult) {
  if (aiResult.intent === "objection") {
    session.monitoring.objectionCount += 1;
  }

  if (isMissedAppointmentMessage(userMessage)) {
    session.monitoring.missedAppointments += 1;
    registerFailure(session, "missed_appointment", "Lead could not attend the scheduled appointment.");
    upsertLearningProposal(
      session,
      "missed_appointment_follow_up",
      "Use empathetic reschedule template and send confirmation + reminder 24h/2h before appointment."
    );
  }

  if (session.monitoring.objectionCount >= 2) {
    registerFailure(session, "repeated_objections", "Lead raised multiple price/value objections.");
    upsertLearningProposal(
      session,
      "negotiation_reply_upgrade",
      "Upgrade negotiation replies with value stack: discount band, monthly payment option, trade-in and urgency close."
    );
  }
}

export function getDealerSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createEmptySession(sessionId));
  }
  return sessions.get(sessionId);
}

export function getLearningState(sessionId) {
  const session = getDealerSession(sessionId);
  return {
    objectionCount: session.monitoring.objectionCount,
    missedAppointments: session.monitoring.missedAppointments,
    lowRatingCount: session.monitoring.lowRatingCount
  };
}

export async function saveDealerTurn({ sessionId, userMessage, aiResult }) {
  const session = getDealerSession(sessionId);
  const timestamp = new Date().toISOString();

  session.conversation.push({ role: "user", content: userMessage, timestamp });
  session.conversation.push({ role: "assistant", content: aiResult.reply, timestamp });

  if (session.conversation.length > 100) {
    session.conversation.splice(0, session.conversation.length - 100);
  }

  session.context = aiResult.updatedContext;
  session.extractedData = mergeExtracted(session.extractedData, aiResult.entities);
  updateLearningSignals(session, userMessage, aiResult);
  session.updatedAt = timestamp;

  try {
    await persistDealerTurnToSqlite({ sessionId, userMessage, aiResult, timestamp });
  } catch (error) {
    registerFailure(session, "sqlite_persist_turn_failed", error?.message || "Failed to persist turn to sqlite.");
  }
}

export async function saveDealerFeedback({ sessionId, rating, comment = "", reply = "" }) {
  const session = getDealerSession(sessionId);
  const entry = {
    rating,
    comment,
    reply,
    createdAt: new Date().toISOString()
  };

  session.monitoring.feedback.push(entry);

  if (session.monitoring.feedback.length > 100) {
    session.monitoring.feedback.splice(0, session.monitoring.feedback.length - 100);
  }

  if (rating <= 2) {
    session.monitoring.lowRatingCount += 1;
    registerFailure(session, "low_feedback", "User rated reply as low quality.");
    upsertLearningProposal(
      session,
      "clarity_reply_pattern",
      "Use shorter replies, explicit next step, and one direct qualifying question at the end."
    );
  }

  session.updatedAt = new Date().toISOString();

  try {
    await persistDealerFeedbackToSqlite({ sessionId, rating, comment, reply });
  } catch (error) {
    registerFailure(session, "sqlite_persist_feedback_failed", error?.message || "Failed to persist feedback to sqlite.");
  }
}

export function getDealerSessionSummary(sessionId) {
  const session = getDealerSession(sessionId);
  return {
    sessionId: session.sessionId,
    context: session.context,
    extractedData: session.extractedData,
    conversationLength: session.conversation.length,
    monitoring: {
      objectionCount: session.monitoring.objectionCount,
      missedAppointments: session.monitoring.missedAppointments,
      lowRatingCount: session.monitoring.lowRatingCount,
      feedbackCount: session.monitoring.feedback.length,
      recentFailures: session.monitoring.failures.slice(-5),
      learningProposals: session.monitoring.learningProposals
    },
    updatedAt: session.updatedAt
  };
}
