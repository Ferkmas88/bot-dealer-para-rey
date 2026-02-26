export function MessageList({ messages }) {
  return (
    <div className="chat" role="log" aria-live="polite">
      {messages.map((m) => (
        <article key={m.id} className={`bubble ${m.role}`}>
          <strong>{m.role === "assistant" ? "Dealer AI" : "Cliente"}</strong>
          <p>{m.content}</p>
          {m.role === "assistant" && m.intent ? (
            <span className="intent-pill">Intent: {m.intent}</span>
          ) : null}
        </article>
      ))}
    </div>
  );
}
