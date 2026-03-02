import { useEffect, useMemo, useRef, useState } from "react";
import { MessageList } from "./components/MessageList";
import { InputBox } from "./components/InputBox";
import { SuggestedActions } from "./components/SuggestedActions";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:4000")
).replace(/\/+$/, "");
const API_URL = `${API_BASE_URL}/dealer/ai`;
const DB_API_URL = `${API_BASE_URL}/dealer/db/inventory`;
const CONVERSATIONS_API_URL = `${API_BASE_URL}/dealer/db/conversations`;
const PUSH_CONFIG_URL = `${API_BASE_URL}/dealer/push/config`;
const PUSH_SUBSCRIBE_URL = `${API_BASE_URL}/dealer/push/subscribe`;
const PUSH_UNSUBSCRIBE_URL = `${API_BASE_URL}/dealer/push/unsubscribe`;
const PANEL_PASSWORD = import.meta.env.VITE_PANEL_PASSWORD || "ReyDealer2026";
const AUTH_STORAGE_KEY = "dealer-panel-auth";
const AUTH_PERSIST_STORAGE_KEY = "dealer-panel-auth-persist-v1";
const AUTH_PERSIST_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const INBOX_SEEN_STORAGE_KEY = "dealer-inbox-seen-counts-v1";
const OPENING_PROMO_MESSAGE =
  "QUE HUBO MI GENTE LINDA DE KENTUCKY! 🚨\n" +
  "Acabas de llegar al pais? Ya puedes tener tu carro!\n" +
  "Llamanos hoy mismo: Reyder Quevedo - 502 576 8116 / 502 780 1096\n" +
  "3510 Dixie Hwy 40216\n\n" +
  "TODAS LAS APLICACIONES SON APROBADAS\n" +
  "No tienes buen credito? APROBADO.\n" +
  "Solo tienes tu ID? APROBADO.\n" +
  "Madre soltera? Tenemos planes especiales desde $85/semana.\n" +
  "Tienes un carro viejo? Lo recibimos como parte de pago.";

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

function formatSessionLabel(sessionId) {
  if (!sessionId) return "Sin session";
  if (sessionId.startsWith("wa:whatsapp:")) return sessionId.replace("wa:whatsapp:", "");
  if (sessionId.startsWith("wa_meta:")) return `+${sessionId.replace("wa_meta:", "")}`;
  if (sessionId.startsWith("wa:")) return sessionId.replace("wa:", "");
  return sessionId;
}

function formatTimestamp(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function loadSeenCounts() {
  try {
    const raw = localStorage.getItem(INBOX_SEEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSeenCounts(value) {
  try {
    localStorage.setItem(INBOX_SEEN_STORAGE_KEY, JSON.stringify(value || {}));
  } catch {
    // noop
  }
}

function loadPersistedAuth() {
  try {
    const raw = localStorage.getItem(AUTH_PERSIST_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.ok !== true) return false;
    const expiresAt = Number(parsed.expiresAt || 0);
    if (!expiresAt || Date.now() > expiresAt) {
      localStorage.removeItem(AUTH_PERSIST_STORAGE_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function App() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 860px)").matches;
  });
  const [mobileInboxPanel, setMobileInboxPanel] = useState("list");
  const [isAuthenticated, setIsAuthenticated] = useState(
    () => sessionStorage.getItem(AUTH_STORAGE_KEY) === "ok" || loadPersistedAuth()
  );
  const [rememberMe, setRememberMe] = useState(true);
  const [passwordInput, setPasswordInput] = useState("");
  const [authError, setAuthError] = useState("");
  const [activeView, setActiveView] = useState("inbox");
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushStatus, setPushStatus] = useState("");
  const [notificationPermission, setNotificationPermission] = useState(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    return Notification.permission;
  });

  const [sessionId, setSessionId] = useState("web-dealer-1");
  const [messages, setMessages] = useState([
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: OPENING_PROMO_MESSAGE,
      intent: "welcome"
    }
  ]);
  const [loading, setLoading] = useState(false);

  const [inventoryRows, setInventoryRows] = useState([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState("");
  const [inventoryForm, setInventoryForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);

  const [conversationRows, setConversationRows] = useState([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [selectedMessages, setSelectedMessages] = useState([]);
  const [selectedSettings, setSelectedSettings] = useState({ bot_enabled: 1, last_read_at: null });
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [manualReplyText, setManualReplyText] = useState("");
  const [manualReplyError, setManualReplyError] = useState("");
  const [manualReplySuccess, setManualReplySuccess] = useState("");
  const [manualSending, setManualSending] = useState(false);
  const [botUpdating, setBotUpdating] = useState(false);
  const [inboxUnreadMessages, setInboxUnreadMessages] = useState(0);
  const selectedSessionRef = useRef("");
  const seenCountsRef = useRef(loadSeenCounts());
  const pushSupported =
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window;

  const kpis = useMemo(() => {
    const total = inventoryRows.length;
    const available = inventoryRows.filter((row) => row.status === "available").length;
    const sold = inventoryRows.filter((row) => row.status === "sold").length;
    const featured = inventoryRows.filter((row) => Number(row.featured) === 1).length;
    return { total, available, sold, featured };
  }, [inventoryRows]);

  const selectedThread = useMemo(
    () => conversationRows.find((row) => row.session_id === selectedSessionId) || null,
    [conversationRows, selectedSessionId]
  );

  const unreadTotal = useMemo(
    () => conversationRows.reduce((acc, row) => acc + Number(row.unread_count || 0), 0),
    [conversationRows]
  );

  useEffect(() => {
    selectedSessionRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    if (isAuthenticated) {
      sessionStorage.setItem(AUTH_STORAGE_KEY, "ok");
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      loadInventory();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !pushSupported) return;
    syncPushState().catch(() => {});
  }, [isAuthenticated, pushSupported]);

  useEffect(() => {
    if (!isAuthenticated || !pushSupported) return;
    if (notificationPermission !== "granted") return;

    if ("setAppBadge" in navigator) {
      if (unreadTotal > 0) {
        navigator.setAppBadge(unreadTotal).catch(() => {});
      } else if ("clearAppBadge" in navigator) {
        navigator.clearAppBadge().catch(() => {});
      }
    }

    navigator.serviceWorker.ready
      .then((registration) => {
        const target = registration.active || registration.waiting || registration.installing;
        if (!target) return;
        target.postMessage({ type: "SET_BADGE", count: unreadTotal });
      })
      .catch(() => {});
  }, [isAuthenticated, pushSupported, notificationPermission, unreadTotal]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const media = window.matchMedia("(max-width: 860px)");
    const apply = () => {
      const mobile = media.matches;
      setIsMobile(mobile);
      if (!mobile) {
        setMobileInboxPanel("chat");
      } else if (!selectedSessionRef.current) {
        setMobileInboxPanel("list");
      }
    };

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    let isMounted = true;

    const run = async () => {
      try {
        const res = await fetch(`${CONVERSATIONS_API_URL}?limit=200`);
        const data = await res.json();
        const incomingRows = Array.isArray(data?.rows) ? data.rows : [];
        const seenCounts = { ...(seenCountsRef.current || {}) };
        const rows = incomingRows.map((row) => {
          const sessionKey = row.session_id;
          const currentUserCount = Number(row.user_messages || 0);
          if (typeof seenCounts[sessionKey] !== "number") {
            seenCounts[sessionKey] = currentUserCount;
          }
          const computedUnread = Math.max(0, currentUserCount - Number(seenCounts[sessionKey] || 0));
          const backendUnread = Number(row.unread_count);
          const unreadCount = Number.isFinite(backendUnread) ? backendUnread : computedUnread;
          return { ...row, unread_count: unreadCount };
        });
        seenCountsRef.current = seenCounts;
        saveSeenCounts(seenCounts);

        if (!isMounted) return;
        const unreadMessages = rows.reduce((acc, row) => acc + Number(row.unread_count || 0), 0);
        setInboxUnreadMessages(unreadMessages);
      } catch {
        if (isMounted) setInboxUnreadMessages(0);
      }
    };

    run();
    const timer = setInterval(run, 10000);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || activeView !== "inbox") return;
    let isMounted = true;

    const run = async () => {
      await loadConversations({ keepSelection: true, mountedRef: () => isMounted });
    };

    run();
    const timer = setInterval(run, 10000);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [isAuthenticated, activeView]);

  useEffect(() => {
    if (!isAuthenticated || activeView !== "inbox") return;
    const timer = setTimeout(() => {
      loadConversations({ keepSelection: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    if (!selectedSessionId || activeView !== "inbox") return;
    let isMounted = true;

    const run = async () => {
      await loadMessagesForSession(selectedSessionId, { mountedRef: () => isMounted });
    };

    run();
    const timer = setInterval(run, 6000);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [selectedSessionId, activeView]);

  function handleLogin(e) {
    e.preventDefault();
    if (passwordInput === PANEL_PASSWORD) {
      sessionStorage.setItem(AUTH_STORAGE_KEY, "ok");
      if (rememberMe) {
        localStorage.setItem(
          AUTH_PERSIST_STORAGE_KEY,
          JSON.stringify({ ok: true, expiresAt: Date.now() + AUTH_PERSIST_TTL_MS })
        );
      } else {
        localStorage.removeItem(AUTH_PERSIST_STORAGE_KEY);
      }
      setIsAuthenticated(true);
      setAuthError("");
      setPasswordInput("");
      setActiveView("inbox");
      return;
    }
    setAuthError("Contrasena incorrecta.");
  }

  function handleLogout() {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(AUTH_PERSIST_STORAGE_KEY);
    setIsAuthenticated(false);
  }

  async function getPushConfig() {
    const res = await fetch(PUSH_CONFIG_URL);
    const data = await res.json();
    return {
      enabled: Boolean(data?.enabled),
      publicKey: typeof data?.publicKey === "string" ? data.publicKey : ""
    };
  }

  async function syncPushState() {
    if (!pushSupported) return;
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    setPushEnabled(Boolean(existing));
  }

  async function enableNotifications() {
    if (!pushSupported) {
      setNotificationPermission("unsupported");
      setPushStatus("Este navegador no soporta notificaciones push.");
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission !== "granted") {
        setPushStatus("Permiso de notificaciones denegado.");
        return;
      }

      const config = await getPushConfig();
      if (!config.enabled || !config.publicKey) {
        setPushStatus("Push no configurado en servidor (falta VAPID).");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const applicationServerKey = urlBase64ToUint8Array(config.publicKey);
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey
        });
      }

      await fetch(PUSH_SUBSCRIBE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription)
      });

      setPushEnabled(true);
      setPushStatus("Notificaciones activadas.");
    } catch {
      setNotificationPermission("denied");
      setPushStatus("No se pudieron activar notificaciones.");
    }
  }

  async function disableNotifications() {
    if (!pushSupported) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch(PUSH_UNSUBSCRIBE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint })
        });
        await subscription.unsubscribe();
      }
      setPushEnabled(false);
      setPushStatus("Notificaciones desactivadas.");
    } catch {
      setPushStatus("No se pudo desactivar notificaciones.");
    }
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

  async function loadConversations({ keepSelection = false, mountedRef = null } = {}) {
    if (!keepSelection) setConversationsLoading(true);
    setConversationsError("");

    try {
      const params = new URLSearchParams({ limit: "200" });
      if (searchQuery.trim()) {
        params.set("query", searchQuery.trim());
      }
      const res = await fetch(`${CONVERSATIONS_API_URL}?${params.toString()}`);
      const data = await res.json();
      const incomingRows = Array.isArray(data?.rows) ? data.rows : [];
      const seenCounts = { ...(seenCountsRef.current || {}) };
      const rows = incomingRows.map((row) => {
        const sessionKey = row.session_id;
        const currentUserCount = Number(row.user_messages || 0);
        if (typeof seenCounts[sessionKey] !== "number") {
          seenCounts[sessionKey] = currentUserCount;
        }
        const computedUnread = Math.max(0, currentUserCount - Number(seenCounts[sessionKey] || 0));
        const backendUnread = Number(row.unread_count);
        const unreadCount = Number.isFinite(backendUnread) ? backendUnread : computedUnread;
        return { ...row, unread_count: unreadCount };
      });
      seenCountsRef.current = seenCounts;
      saveSeenCounts(seenCounts);
      if (mountedRef && !mountedRef()) return;
      setConversationRows(rows);

      if (!rows.length) {
        setSelectedSessionId("");
        setSelectedMessages([]);
        return;
      }

      const currentSelectedSessionId = selectedSessionRef.current;

      if (!currentSelectedSessionId) {
        setSelectedSessionId(rows[0].session_id);
        return;
      }

      const stillExists = rows.some((row) => row.session_id === currentSelectedSessionId);
      if (!stillExists) {
        setSelectedSessionId(rows[0].session_id);
      }
    } catch {
      if (!mountedRef || mountedRef()) {
        setConversationsError("No pude cargar conversaciones.");
      }
    } finally {
      if (!keepSelection && (!mountedRef || mountedRef())) {
        setConversationsLoading(false);
      }
    }
  }

  async function loadMessagesForSession(targetSessionId, { mountedRef = null } = {}) {
    if (!targetSessionId) return;
    setMessagesLoading(true);
    setMessagesError("");
    try {
      const encoded = encodeURIComponent(targetSessionId);
      const res = await fetch(`${CONVERSATIONS_API_URL}/${encoded}/messages?limit=500`);
      const data = await res.json();
      if (mountedRef && !mountedRef()) return;
      setSelectedMessages(Array.isArray(data?.rows) ? data.rows : []);
      setSelectedSettings(data?.settings || { bot_enabled: 1, last_read_at: null });
    } catch {
      if (!mountedRef || mountedRef()) {
        setMessagesError("No pude cargar mensajes de este chat.");
      }
    } finally {
      if (!mountedRef || mountedRef()) {
        setMessagesLoading(false);
      }
    }
  }

  async function markThreadAsRead(targetSessionId) {
    if (!targetSessionId) return;
    try {
      const encoded = encodeURIComponent(targetSessionId);
      await fetch(`${CONVERSATIONS_API_URL}/${encoded}/read`, {
        method: "POST"
      });
      const seenCounts = { ...(seenCountsRef.current || {}) };
      const row = conversationRows.find((item) => item.session_id === targetSessionId);
      if (row) {
        seenCounts[targetSessionId] = Number(row.user_messages || 0);
        seenCountsRef.current = seenCounts;
        saveSeenCounts(seenCounts);
      }
      setConversationRows((prev) =>
        prev.map((row) =>
          row.session_id === targetSessionId
            ? { ...row, unread_count: 0 }
            : row
        )
      );
    } catch {
      // noop
    }
  }

  async function handleSelectConversation(targetSessionId) {
    setSelectedSessionId(targetSessionId);
    if (isMobile) setMobileInboxPanel("chat");
    setManualReplyError("");
    setManualReplySuccess("");
    await markThreadAsRead(targetSessionId);
  }

  async function toggleBotForSelectedContact() {
    if (!selectedSessionId || botUpdating) return;
    const nextEnabled = Number(selectedSettings?.bot_enabled ?? 1) !== 1;
    setBotUpdating(true);
    try {
      const encoded = encodeURIComponent(selectedSessionId);
      const res = await fetch(`${CONVERSATIONS_API_URL}/${encoded}/bot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "No se pudo actualizar bot");

      setSelectedSettings(data?.settings || { bot_enabled: nextEnabled ? 1 : 0, last_read_at: null });
      setConversationRows((prev) =>
        prev.map((row) =>
          row.session_id === selectedSessionId
            ? { ...row, bot_enabled: nextEnabled ? 1 : 0 }
            : row
        )
      );
    } catch {
      setMessagesError("No pude actualizar Bot ON/OFF.");
    } finally {
      setBotUpdating(false);
    }
  }

  async function sendManualReply(e) {
    e.preventDefault();
    if (!selectedSessionId || manualSending) return;
    if (!selectedSessionId.startsWith("wa:")) {
      setManualReplyError("Respuesta manual disponible solo para chats Twilio (wa:).");
      return;
    }
    const message = manualReplyText.trim();
    if (!message) return;

    setManualReplyError("");
    setManualReplySuccess("");
    setManualSending(true);

    try {
      const encoded = encodeURIComponent(selectedSessionId);
      const res = await fetch(`${CONVERSATIONS_API_URL}/${encoded}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "No se pudo enviar");

      setManualReplyText("");
      setManualReplySuccess("Mensaje enviado.");
      await loadMessagesForSession(selectedSessionId);
      await loadConversations({ keepSelection: true });
    } catch (error) {
      setManualReplyError(error?.message || "No pude enviar mensaje manual.");
    } finally {
      setManualSending(false);
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
          <label className="remember-row">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            Recordarme en este dispositivo (30 dias)
          </label>
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
          <div className="brand-block">
            <img src="/2026-01-14.webp" alt="Empire Rey logo" className="brand-logo" />
            <div>
              <p className="eyebrow">Empire Rey Dealer CRM</p>
              <h1>Centro de Operaciones</h1>
            </div>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className={activeView === "crm" ? "active-btn" : "secondary-btn"}
              onClick={() => setActiveView("crm")}
            >
              Inventario
            </button>
            <button
              type="button"
              className={activeView === "inbox" ? "active-btn" : "secondary-btn"}
              onClick={() => setActiveView("inbox")}
            >
              Inbox WhatsApp ({activeView === "inbox" ? unreadTotal : inboxUnreadMessages})
            </button>
            {activeView === "crm" ? (
              <button type="button" className="secondary-btn" onClick={loadInventory} disabled={inventoryLoading}>
                {inventoryLoading ? "Cargando..." : "Sincronizar"}
              </button>
            ) : (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => loadConversations({ keepSelection: false })}
                disabled={conversationsLoading}
              >
                {conversationsLoading ? "Cargando..." : "Refrescar chats"}
              </button>
            )}
            {pushSupported ? (
              pushEnabled ? (
                <button type="button" className="secondary-btn" onClick={disableNotifications}>
                  Notificaciones ON
                </button>
              ) : (
                <button type="button" className="secondary-btn" onClick={enableNotifications}>
                  Activar notificaciones
                </button>
              )
            ) : null}
            <button type="button" className="danger-btn" onClick={handleLogout}>
              Salir
            </button>
          </div>
        </header>
        {pushStatus ? <p className="hint">{pushStatus}</p> : null}

        {activeView === "crm" ? (
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
        ) : (
          <section className="panel inbox-shell">
            <div className="inbox-layout">
              {!isMobile || mobileInboxPanel === "list" ? (
              <aside className="thread-list">
                <div className="thread-head">
                  <h2>Conversaciones</h2>
                  <p className="subtle">{conversationRows.length} contactos / {unreadTotal} mensajes sin leer</p>
                </div>
                <input
                  className="thread-search"
                  placeholder="Buscar numero o session..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {conversationsError ? <p className="error-text">{conversationsError}</p> : null}
                <div className="thread-scroll">
                  {conversationRows.map((row) => (
                    <button
                      key={row.session_id}
                      type="button"
                      className={`thread-item ${selectedSessionId === row.session_id ? "active" : ""} ${Number(row.unread_count || 0) > 0 ? "unread" : ""}`}
                      onClick={() => handleSelectConversation(row.session_id)}
                    >
                      <div className="thread-title">
                        {formatSessionLabel(row.session_id)}
                        {Number(row.unread_count || 0) > 0 ? (
                          <span className="thread-unread">{row.unread_count}</span>
                        ) : null}
                      </div>
                      <div className="thread-preview">{row.last_message || "Sin mensajes"}</div>
                      <div className="thread-meta">
                        <span>{formatTimestamp(row.updated_at)}</span>
                        <span>
                          {Number(row.bot_enabled ?? 1) === 1 ? "Bot ON" : "Bot OFF"} / U:{row.user_messages || 0} B:{row.assistant_messages || 0}
                        </span>
                      </div>
                    </button>
                  ))}
                  {!conversationRows.length && !conversationsLoading ? <p className="subtle">No hay conversaciones todavia.</p> : null}
                </div>
              </aside>
              ) : null}

              {!isMobile || mobileInboxPanel === "chat" ? (
              <section className="thread-chat">
                <div className="thread-chat-head">
                  {isMobile ? (
                    <button type="button" className="secondary-btn mobile-back-btn" onClick={() => setMobileInboxPanel("list")}>
                      Volver
                    </button>
                  ) : null}
                  <h2>{selectedThread ? formatSessionLabel(selectedThread.session_id) : "Selecciona un chat"}</h2>
                  <p className="subtle">{selectedThread ? selectedThread.session_id : "Esperando seleccion..."}</p>
                  {selectedSessionId ? (
                    <div className="thread-actions">
                      <button type="button" className="secondary-btn" onClick={toggleBotForSelectedContact} disabled={botUpdating}>
                        {botUpdating ? "Guardando..." : Number(selectedSettings?.bot_enabled ?? 1) === 1 ? "Bot ON (clic para OFF)" : "Bot OFF (clic para ON)"}
                      </button>
                      <button type="button" className="secondary-btn" onClick={() => markThreadAsRead(selectedSessionId)}>
                        Marcar leido
                      </button>
                    </div>
                  ) : null}
                </div>
                {messagesError ? <p className="error-text">{messagesError}</p> : null}
                <div className="thread-messages">
                  {selectedMessages.map((msg) => (
                    <article key={msg.id} className={`thread-bubble ${msg.role === "assistant" ? "assistant" : "user"}`}>
                      <div className="thread-bubble-top">
                        <strong>{msg.role === "assistant" ? "Bot" : "Cliente"}</strong>
                        <span>{formatTimestamp(msg.created_at)}</span>
                      </div>
                      <p>{msg.content}</p>
                    </article>
                  ))}
                  {!selectedMessages.length && !messagesLoading ? (
                    <p className="subtle">{selectedSessionId ? "Este contacto aun no tiene mensajes guardados." : "Elige una conversacion de la izquierda."}</p>
                  ) : null}
                </div>
                <form className="manual-reply" onSubmit={sendManualReply}>
                  <input
                    placeholder={
                      !selectedSessionId
                        ? "Selecciona un chat para responder"
                        : selectedSessionId.startsWith("wa:")
                          ? "Responder manualmente..."
                          : "Solo chats Twilio permiten respuesta manual"
                    }
                    value={manualReplyText}
                    onChange={(e) => setManualReplyText(e.target.value)}
                    disabled={!selectedSessionId || manualSending || !selectedSessionId.startsWith("wa:")}
                  />
                  <button
                    type="submit"
                    disabled={!selectedSessionId || manualSending || !manualReplyText.trim() || !selectedSessionId.startsWith("wa:")}
                  >
                    {manualSending ? "Enviando..." : "Enviar manual"}
                  </button>
                </form>
                {manualReplyError ? <p className="error-text">{manualReplyError}</p> : null}
                {manualReplySuccess ? <p className="subtle">{manualReplySuccess}</p> : null}
              </section>
              ) : null}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
