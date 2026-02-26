import { useState } from "react";

export function InputBox({ onSend, disabled }) {
  const [text, setText] = useState("");

  function submit(e) {
    e.preventDefault();
    const next = text.trim();
    if (!next || disabled) return;
    onSend(next);
    setText("");
  }

  return (
    <form onSubmit={submit} className="composer">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ej: Busco una SUV 2021 con financiamiento"
      />
      <button type="submit" disabled={disabled}>
        {disabled ? "Enviando..." : "Enviar"}
      </button>
    </form>
  );
}
