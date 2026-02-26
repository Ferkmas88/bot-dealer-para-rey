const ACTIONS = [
  { id: "appointment", label: "Agendar Cita", message: "Quiero agendar una cita para test drive" },
  { id: "inventory", label: "Ver inventario", message: "Muéstrame inventario disponible" },
  { id: "financing", label: "Solicitar financiamiento", message: "Quiero solicitar financiamiento" }
];

export function SuggestedActions({ onAction, disabled }) {
  return (
    <section className="actions" aria-label="Acciones sugeridas">
      {ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          className="action-btn"
          onClick={() => onAction(action.message)}
          disabled={disabled}
        >
          {action.label}
        </button>
      ))}
    </section>
  );
}
