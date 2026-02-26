const conversations = new Map();

export function getConversation(sessionId) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, []);
  }
  return conversations.get(sessionId);
}

export function appendMessage(sessionId, message) {
  const history = getConversation(sessionId);
  history.push({
    role: message.role,
    content: message.content,
    timestamp: new Date().toISOString()
  });

  if (history.length > 50) {
    history.splice(0, history.length - 50);
  }
}
