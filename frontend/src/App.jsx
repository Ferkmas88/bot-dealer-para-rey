import { useEffect, useMemo, useState } from "react";
import { MessageList } from "./components/MessageList";
import { InputBox } from "./components/InputBox";
import { SuggestedActions } from "./components/SuggestedActions";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:4000")
).replace(/\/+$/, "");
const API_URL = `${API_BASE_URL}/dealer/ai`;
const DB_API_URL = `${API_BASE_URL}/dealer/db/inventory`;
const PANEL_PASSWORD = import.meta.env.VITE_PANEL_PASSWORD || "ReyDealer2026";
const AUTH_STORAGE_KEY = "dealer-panel-auth";

const EMPTY_FORM = {
  make: "",
  model: "",
  year: "",
  price: "",
  mileage: "",
  transmission: "",
  fuel_type: "",
  color: "",
  status: "available",
  featured: 0
};

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => sessionStorage.getItem(AUTH_STORAGE_KEY) === "ok");
  const [passwordInput, setPasswordInput] = useState("");
  const [authError, setAuthError] = useState("");

  const [sessionId, setSessionId] = useState("web-dealer-1");
  const [messages, setMessages] = useState([
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "Hola, soy tu asesor de ventas. Te ayudo a encontrar el auto ideal y agendar tu test drive.",
      intent: "welcome"
    }
  ]);
  const [loading, setLoading] = useState(false);

  const [inventoryRows, setInventoryRows] = useState([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState("");
  const [inventoryForm, setInventoryForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);

  const kpis = useMemo(() => {
    const total = inventoryRows.length;
    const available = inventoryRows.filter((row) => row.status === "available").length;
    const sold = inventoryRows.filter((row) => row.status === "sold").length;
    const featured = inventoryRows.filter((row) => Number(row.featured) === 1).length;
    return { total, available, sold, featured };
  }, [inventoryRows]);

  useEffect(() => {
    if (isAuthenticated) {
      loadInventory();
    }
  }, [isAuthenticated]);

  function handleLogin(e) {
    e.preventDefault();
    if (passwordInput === PANEL_PASSWORD) {
      sessionStorage.setItem(AUTH_STORAGE_KEY, "ok");
      setIsAuthenticated(true);
      setAuthError("");
      setPasswordInput("");
      return;
    }
    setAuthError("Contrasena incorrecta.");
  }

  function handleLogout() {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    setIsAuthenticated(false);
  }

  async function sendMessage(text) {
    if (!text || loading) return;

    const userMsg = {
      id: crypto.randomUUID(),
      role: "user",
      content: text
    };

    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId })
      });

      const data = await res.json();
      const reply = data?.reply || "Por ahora no pude responder. Intentamos de nuevo en unos segundos?";
      const assistantMsg = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: reply,
        intent: data?.intent || "question"
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Hubo un error de conexion. Estoy listo para continuar en cuanto se restablezca.",
          intent: "error"
        }
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function loadInventory() {
    setInventoryLoading(true);
    setInventoryError("");
    try {
      const res = await fetch(DB_API_URL);
      const data = await res.json();
      setInventoryRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch {
      setInventoryError("No pude cargar inventario.");
    } finally {
      setInventoryLoading(false);
    }
  }

  function resetInventoryForm() {
    setInventoryForm(EMPTY_FORM);
    setEditingId(null);
  }

  function fillFormFromRow(row) {
    setInventoryForm({
      make: row.make || "",
      model: row.model || "",
      year: String(row.year || ""),
      price: String(row.price || ""),
      mileage: String(row.mileage || ""),
      transmission: row.transmission || "",
      fuel_type: row.fuel_type || "",
      color: row.color || "",
      status: row.status || "available",
      featured: Number(row.featured) ? 1 : 0
    });
    setEditingId(row.id);
  }

  async function saveInventoryUnit(e) {
    e.preventDefault();
    setInventoryError("");

    const payload = {
      ...inventoryForm,
      year: Number(inventoryForm.year),
      price: Number(inventoryForm.price),
      mileage: Number(inventoryForm.mileage),
      featured: Number(inventoryForm.featured) ? 1 : 0
    };

    const method = editingId ? "PUT" : "POST";
    const url = editingId ? `${DB_API_URL}/${editingId}` : DB_API_URL;

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error("request failed");

      await loadInventory();
      resetInventoryForm();
    } catch {
      setInventoryError("No pude guardar la unidad. Revisa los campos.");
    }
  }

  async function removeInventoryUnit(id) {
    setInventoryError("");
    try {
      const res = await fetch(`${DB_API_URL}/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("request failed");
      await loadInventory();
      if (editingId === id) resetInventoryForm();
    } catch {
      setInventoryError("No pude eliminar la unidad.");
    }
  }

  if (!isAuthenticated) {
    return (
      <main className="app">
        <section className="auth-card">
          <p className="eyebrow">Empire Rey Console</p>
          <h1>Acceso privado</h1>
          <p className="subtle">Ingresa la contrasena para abrir el CRM comercial.</p>
          <form className="auth-form" onSubmit={handleLogin}>
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Contrasena"
              autoComplete="current-password"
            />
            <button type="submit">Entrar</button>
          </form>
          {authError ? <p className="error-text">{authError}</p> : null}
          <p className="hint">Configurable con VITE_PANEL_PASSWORD.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <section className="crm-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Empire Rey Dealer CRM</p>
            <h1>Centro de Operaciones</h1>
          </div>
          <div className="topbar-actions">
            <button type="button" className="secondary-btn" onClick={loadInventory} disabled={inventoryLoading}>
              {inventoryLoading ? "Cargando..." : "Sincronizar"}
            </button>
            <button type="button" className="danger-btn" onClick={handleLogout}>
              Salir
            </button>
          </div>
        </header>

        <section className="crm-layout">
          <section className="crm-main">
            <section className="kpi-grid">
              <article className="kpi-card">
                <p>Inventario total</p>
                <strong>{kpis.total}</strong>
              </article>
              <article className="kpi-card">
                <p>Disponibles</p>
                <strong>{kpis.available}</strong>
              </article>
              <article className="kpi-card">
                <p>Vendidos</p>
                <strong>{kpis.sold}</strong>
              </article>
              <article className="kpi-card">
                <p>Destacados</p>
                <strong>{kpis.featured}</strong>
              </article>
            </section>

            <article className="panel crm-form-panel">
              <div className="panel-head">
                <h2>{editingId ? "Editar unidad" : "Registrar unidad"}</h2>
                <button type="button" className="secondary-btn" onClick={resetInventoryForm}>
                  {editingId ? "Cancelar edicion" : "Limpiar"}
                </button>
              </div>
              {inventoryError ? <p className="error-text">{inventoryError}</p> : null}
              <form className="inventory-form" onSubmit={saveInventoryUnit}>
                <input placeholder="Marca" value={inventoryForm.make} onChange={(e) => setInventoryForm((prev) => ({ ...prev, make: e.target.value }))} required />
                <input placeholder="Modelo" value={inventoryForm.model} onChange={(e) => setInventoryForm((prev) => ({ ...prev, model: e.target.value }))} required />
                <input type="number" placeholder="Ano" value={inventoryForm.year} onChange={(e) => setInventoryForm((prev) => ({ ...prev, year: e.target.value }))} required />
                <input type="number" step="0.01" placeholder="Precio" value={inventoryForm.price} onChange={(e) => setInventoryForm((prev) => ({ ...prev, price: e.target.value }))} required />
                <input type="number" placeholder="Millaje" value={inventoryForm.mileage} onChange={(e) => setInventoryForm((prev) => ({ ...prev, mileage: e.target.value }))} required />
                <input placeholder="Transmision" value={inventoryForm.transmission} onChange={(e) => setInventoryForm((prev) => ({ ...prev, transmission: e.target.value }))} required />
                <input placeholder="Combustible" value={inventoryForm.fuel_type} onChange={(e) => setInventoryForm((prev) => ({ ...prev, fuel_type: e.target.value }))} required />
                <input placeholder="Color" value={inventoryForm.color} onChange={(e) => setInventoryForm((prev) => ({ ...prev, color: e.target.value }))} required />
                <select value={inventoryForm.status} onChange={(e) => setInventoryForm((prev) => ({ ...prev, status: e.target.value }))}>
                  <option value="available">available</option>
                  <option value="reserved">reserved</option>
                  <option value="sold">sold</option>
                </select>
                <select value={inventoryForm.featured} onChange={(e) => setInventoryForm((prev) => ({ ...prev, featured: Number(e.target.value) }))}>
                  <option value={0}>No destacado</option>
                  <option value={1}>Destacado</option>
                </select>
                <button type="submit">{editingId ? "Actualizar unidad" : "Crear unidad"}</button>
              </form>
            </article>

            <article className="panel crm-table-panel">
              <h2>Inventario comercial</h2>
              <div className="inventory-table-wrap">
                <table className="inventory-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Auto</th>
                      <th>Precio</th>
                      <th>Millaje</th>
                      <th>Status</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inventoryRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.id}</td>
                        <td>
                          {row.year} {row.make} {row.model}
                        </td>
                        <td>${Number(row.price || 0).toLocaleString("en-US")}</td>
                        <td>{Number(row.mileage || 0).toLocaleString("en-US")} mi</td>
                        <td>{row.status}</td>
                        <td className="row-actions">
                          <button type="button" className="secondary-btn" onClick={() => fillFormFromRow(row)}>
                            Editar
                          </button>
                          <button type="button" className="danger-btn" onClick={() => removeInventoryUnit(row.id)}>
                            Eliminar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          </section>

          <aside className="panel crm-chat">
            <div className="panel-head">
              <h2>Asistente IA</h2>
            </div>
            <label className="session">
              Session ID
              <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
            </label>
            <MessageList messages={messages} />
            <SuggestedActions onAction={sendMessage} disabled={loading} />
            <InputBox onSend={sendMessage} disabled={loading} />
          </aside>
        </section>
      </section>
    </main>
  );
}
