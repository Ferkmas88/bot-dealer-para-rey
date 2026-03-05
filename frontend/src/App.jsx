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
const APPOINTMENTS_API_URL = `${API_BASE_URL}/dealer/db/appointments`;
const LEADS_API_URL = `${API_BASE_URL}/dealer/db/leads`;
const CONVERSATIONS_API_URL = `${API_BASE_URL}/dealer/db/conversations`;
const PUSH_CONFIG_URL = `${API_BASE_URL}/dealer/push/config`;
const PUSH_SUBSCRIBE_URL = `${API_BASE_URL}/dealer/push/subscribe`;
const PUSH_UNSUBSCRIBE_URL = `${API_BASE_URL}/dealer/push/unsubscribe`;
const PANEL_PASSWORD = import.meta.env.VITE_PANEL_PASSWORD || "ReyDealer2026";
const AUTH_STORAGE_KEY = "dealer-panel-auth";
const AUTH_PERSIST_STORAGE_KEY = "dealer-panel-auth-persist-v1";
const AUTH_PERSIST_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const INBOX_SEEN_STORAGE_KEY = "dealer-inbox-seen-counts-v1";
const CONTACT_NAME_MAP_STORAGE_KEY = "dealer-contact-name-map-v1";
const INBOX_CONVERSATIONS_CACHE_KEY = "dealer-inbox-conversations-cache-v1";
const INBOX_LAST_SESSION_STORAGE_KEY = "dealer-inbox-last-session-v1";
const INBOX_MESSAGES_CACHE_INDEX_KEY = "dealer-inbox-messages-cache-index-v1";
const INBOX_MESSAGES_CACHE_PREFIX = "dealer-inbox-messages-cache-v1:";
const INBOX_MESSAGES_CACHE_MAX_THREADS = 40;
const INBOX_BADGE_POLL_MS = 7000;
const INBOX_LIST_POLL_MS = 5000;
const INBOX_MESSAGES_POLL_MS = 3500;
const OPENING_PROMO_MESSAGE =
  "Hola 👋\n" +
  "Soy el asistente automático de Empire Rey Auto Sales. Estoy disponible 24/7 para ayudarte.\n\n" +
  "Puedo ayudarte a:\n" +
  "• Encontrar el carro que necesitas\n" +
  "• Agendar una cita en el dealer\n" +
  "• Comunicarte con Rey y con el mecánico";

const EMPTY_FORM = {
  make: "",
  model: "",
  year: "",
  price: "",
  mileage: "",
  vehicle_type: "Sedan",
  color: "",
  status: "available"
};

function formatSessionLabel(sessionId) {
  if (!sessionId) return "Sin session";
  if (sessionId.startsWith("wa:whatsapp:")) return sessionId.replace("wa:whatsapp:", "");
  if (sessionId.startsWith("wa_meta:")) return `+${sessionId.replace("wa_meta:", "")}`;
  if (sessionId.startsWith("wa:")) return sessionId.replace("wa:", "");
  return sessionId;
}

function findContactNameByDigits(contactNameMap, rawValue) {
  const digits = normalizePhoneDigits(rawValue);
  if (!digits) return "";

  const direct = String(contactNameMap?.[digits] || "").trim();
  if (direct) return direct;

  const entries = Object.entries(contactNameMap || {});
  let bestMatch = "";
  let bestLength = 0;
  for (const [knownDigits, name] of entries) {
    const candidateName = String(name || "").trim();
    if (!knownDigits || !candidateName) continue;
    if (digits.includes(knownDigits) || knownDigits.includes(digits)) {
      if (knownDigits.length > bestLength) {
        bestLength = knownDigits.length;
        bestMatch = candidateName;
      }
    }
  }
  return bestMatch;
}

function formatConversationDisplayName(row, contactNameMap = {}) {
  const name = String(row?.lead_name || "").trim();
  if (name) return name;
  const mappedByPhone = findContactNameByDigits(contactNameMap, row?.lead_phone || "");
  if (mappedByPhone) return mappedByPhone;
  const mappedBySession = findContactNameByDigits(contactNameMap, row?.session_id || "");
  if (mappedBySession) return mappedBySession;
  return formatSessionLabel(row?.session_id || "");
}

function formatAppointmentLeadName(row, contactNameMap = {}) {
  const name = String(row?.lead_name || "").trim();
  if (name) return name;
  const mappedByPhone = findContactNameByDigits(contactNameMap, row?.lead_phone || "");
  if (mappedByPhone) return mappedByPhone;
  const mappedBySession = findContactNameByDigits(contactNameMap, row?.lead_session_id || "");
  if (mappedBySession) return mappedBySession;
  if (row?.lead_phone) return row.lead_phone;
  return formatSessionLabel(row?.lead_session_id || "");
}

function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
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

function toDateInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function normalizeLeadStatus(value, fallback = "QUALIFYING") {
  const allowed = new Set(["NEW", "QUALIFYING", "QUALIFIED", "APPT_PENDING", "BOOKED", "NO_RESPONSE", "CLOSED_WON", "CLOSED_LOST"]);
  const normalized = String(value || fallback).trim().toUpperCase();
  return allowed.has(normalized) ? normalized : fallback;
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

function loadContactNameMap() {
  try {
    const raw = localStorage.getItem(CONTACT_NAME_MAP_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveContactNameMap(value) {
  try {
    localStorage.setItem(CONTACT_NAME_MAP_STORAGE_KEY, JSON.stringify(value || {}));
  } catch {
    // noop
  }
}

function loadConversationsCache() {
  try {
    const raw = localStorage.getItem(INBOX_CONVERSATIONS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveConversationsCache(rows) {
  try {
    localStorage.setItem(INBOX_CONVERSATIONS_CACHE_KEY, JSON.stringify(Array.isArray(rows) ? rows : []));
  } catch {
    // noop
  }
}

function loadLastSelectedSessionId() {
  try {
    return String(localStorage.getItem(INBOX_LAST_SESSION_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

function saveLastSelectedSessionId(sessionId) {
  try {
    if (!sessionId) {
      localStorage.removeItem(INBOX_LAST_SESSION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(INBOX_LAST_SESSION_STORAGE_KEY, String(sessionId));
  } catch {
    // noop
  }
}

function loadMessagesCacheIndex() {
  try {
    const raw = localStorage.getItem(INBOX_MESSAGES_CACHE_INDEX_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveMessagesCacheIndex(index) {
  try {
    localStorage.setItem(INBOX_MESSAGES_CACHE_INDEX_KEY, JSON.stringify(index || {}));
  } catch {
    // noop
  }
}

function loadMessagesCacheForSession(sessionId) {
  if (!sessionId) return null;
  try {
    const raw = localStorage.getItem(`${INBOX_MESSAGES_CACHE_PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
      settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : null
    };
  } catch {
    return null;
  }
}

function saveMessagesCacheForSession(sessionId, rows, settings = null) {
  if (!sessionId) return;
  try {
    localStorage.setItem(
      `${INBOX_MESSAGES_CACHE_PREFIX}${sessionId}`,
      JSON.stringify({
        rows: Array.isArray(rows) ? rows : [],
        settings: settings && typeof settings === "object" ? settings : null
      })
    );

    const nextIndex = { ...loadMessagesCacheIndex(), [sessionId]: Date.now() };
    const entries = Object.entries(nextIndex).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
    const keep = entries.slice(0, INBOX_MESSAGES_CACHE_MAX_THREADS).map(([id]) => id);
    const keepSet = new Set(keep);

    for (const [id] of entries) {
      if (keepSet.has(id)) continue;
      localStorage.removeItem(`${INBOX_MESSAGES_CACHE_PREFIX}${id}`);
      delete nextIndex[id];
    }

    saveMessagesCacheIndex(nextIndex);
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

function resolveAdminViewFromPathname() {
  if (typeof window === "undefined") return "crm";
  const path = window.location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (path === "/admin/whatsapp" || path === "/admin/whatpp" || path === "/wsp") return "inbox";
  if (path === "/admin/citas" || path === "/citas") return "appointments";
  return "crm";
}

function resolveRouteModeFromPathname() {
  if (typeof window === "undefined") return "admin";
  const path = window.location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (path === "/admin/whatsapp" || path === "/admin/whatpp" || path === "/wsp") return "whatsapp";
  return "admin";
}

function defaultViewForRouteMode(routeMode) {
  return routeMode === "whatsapp" ? "inbox" : "crm";
}

function resolveAdminTabFromPathname() {
  if (typeof window === "undefined") return "inventory";
  const path = window.location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (path === "/admin/citas" || path === "/citas") return "appointments";
  return "inventory";
}

function appointmentEmptyMessage(filter) {
  if (filter === "today") return "No hay citas para hoy.";
  if (filter === "date") return "No hay citas para la fecha seleccionada.";
  if (filter === "upcoming") return "No hay citas proximas.";
  return "No hay citas registradas.";
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
  const [routeMode] = useState(resolveRouteModeFromPathname);
  const [activeView, setActiveView] = useState(resolveAdminViewFromPathname);
  const [adminView, setAdminView] = useState(resolveAdminTabFromPathname);
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

  const [appointmentsRows, setAppointmentsRows] = useState([]);
  const [upcomingAppointmentsRows, setUpcomingAppointmentsRows] = useState([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(false);
  const [appointmentsError, setAppointmentsError] = useState("");
  const [appointmentsMenuFilter, setAppointmentsMenuFilter] = useState("all");
  const [appointmentsDate, setAppointmentsDate] = useState(() => toDateInputValue(new Date()));
  const [leadRows, setLeadRows] = useState([]);
  const [appointmentForm, setAppointmentForm] = useState({
    lead_session_id: "",
    scheduled_at: "",
    notes: ""
  });
  const [savingAppointment, setSavingAppointment] = useState(false);

  const [conversationRows, setConversationRows] = useState(loadConversationsCache);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState(loadLastSelectedSessionId);
  const [selectedMessages, setSelectedMessages] = useState([]);
  const [selectedSettings, setSelectedSettings] = useState({ bot_enabled: 1, last_read_at: null });
  const [selectedLead, setSelectedLead] = useState(null);
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [appointmentActionLoading, setAppointmentActionLoading] = useState(false);
  const [appointmentActionError, setAppointmentActionError] = useState("");
  const [appointmentActionSuccess, setAppointmentActionSuccess] = useState("");
  const [leadActionLoading, setLeadActionLoading] = useState(false);
  const [leadActionError, setLeadActionError] = useState("");
  const [leadActionSuccess, setLeadActionSuccess] = useState("");
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [contactNameMap, setContactNameMap] = useState(loadContactNameMap);
  const [showAddContactForm, setShowAddContactForm] = useState(false);
  const [newContactPhone, setNewContactPhone] = useState("");
  const [newContactName, setNewContactName] = useState("");
  const [addingContact, setAddingContact] = useState(false);
  const [addContactError, setAddContactError] = useState("");
  const [addContactSuccess, setAddContactSuccess] = useState("");
  const [contactPickerLoading, setContactPickerLoading] = useState(false);
  const [contactPickerError, setContactPickerError] = useState("");
  const [contactPickerSuccess, setContactPickerSuccess] = useState("");
  const [manualReplyText, setManualReplyText] = useState("");
  const [manualReplyError, setManualReplyError] = useState("");
  const [manualReplySuccess, setManualReplySuccess] = useState("");
  const [manualSending, setManualSending] = useState(false);
  const [botUpdating, setBotUpdating] = useState(false);
  const [inboxUnreadMessages, setInboxUnreadMessages] = useState(0);
  const routeModeRef = useRef(resolveRouteModeFromPathname());
  const selectedSessionRef = useRef("");
  const threadMessagesRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);
  const seenCountsRef = useRef(loadSeenCounts());
  const pushSupported =
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window;
  const contactPickerSupported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "contacts" in navigator &&
    typeof navigator.contacts?.select === "function";

  useEffect(() => {
    saveContactNameMap(contactNameMap);
  }, [contactNameMap]);

  useEffect(() => {
    saveConversationsCache(conversationRows);
  }, [conversationRows]);

  const kpis = useMemo(() => {
    const total = inventoryRows.length;
    const available = inventoryRows.filter((row) => row.status === "available").length;
    const reserved = inventoryRows.filter((row) => row.status === "reserved").length;
    const sold = inventoryRows.filter((row) => row.status === "sold").length;
    return { total, available, reserved, sold };
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
    saveLastSelectedSessionId(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    setActiveView(defaultViewForRouteMode(routeMode));
  }, [routeMode]);

  useEffect(() => {
    if (isAuthenticated) {
      sessionStorage.setItem(AUTH_STORAGE_KEY, "ok");
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated && routeMode === "admin" && adminView === "inventory") {
      loadInventory();
    }
  }, [isAuthenticated, routeMode, adminView]);

  useEffect(() => {
    if (isAuthenticated && routeMode === "admin" && adminView === "appointments") {
      loadAppointments();
      loadUpcomingAppointments();
      loadLeads();
    }
  }, [isAuthenticated, routeMode, adminView, appointmentsMenuFilter, appointmentsDate]);

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
    if (typeof window === "undefined") return undefined;
    if (routeMode !== "whatsapp" || !isMobile) return undefined;

    const onPopState = () => {
      if (mobileInboxPanel === "chat") {
        setMobileInboxPanel("list");
      }
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [routeMode, isMobile, mobileInboxPanel]);

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
    const timer = setInterval(run, INBOX_BADGE_POLL_MS);
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
    const timer = setInterval(run, INBOX_LIST_POLL_MS);
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
    const timer = setInterval(run, INBOX_MESSAGES_POLL_MS);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [selectedSessionId, activeView]);

  useEffect(() => {
    if (!selectedSessionId || activeView !== "inbox") return;
    const cached = loadMessagesCacheForSession(selectedSessionId);
    if (!cached) return;
    setSelectedMessages(cached.rows);
    if (cached.settings) {
      setSelectedSettings(cached.settings);
    }
  }, [selectedSessionId, activeView]);

  useEffect(() => {
    if (!isAuthenticated || activeView !== "inbox") return undefined;
    if (typeof window === "undefined") return undefined;

    const refreshNow = () => {
      loadConversations({ keepSelection: true });
      if (selectedSessionRef.current) {
        loadMessagesForSession(selectedSessionRef.current);
      }
    };

    const onFocus = () => refreshNow();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshNow();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isAuthenticated, activeView]);

  function isThreadNearBottom() {
    const el = threadMessagesRef.current;
    if (!el) return true;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance < 90;
  }

  function handleThreadScroll() {
    shouldStickToBottomRef.current = isThreadNearBottom();
  }

  function scrollThreadToBottom(force = false) {
    const el = threadMessagesRef.current;
    if (!el) return;
    if (!force && !shouldStickToBottomRef.current) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        shouldStickToBottomRef.current = true;
      });
    });
  }

  useEffect(() => {
    if (activeView !== "inbox") return;
    shouldStickToBottomRef.current = true;
    scrollThreadToBottom(true);
  }, [selectedSessionId, activeView]);

  useEffect(() => {
    if (activeView !== "inbox") return;
    scrollThreadToBottom(false);
  }, [selectedMessages, activeView]);

  useEffect(() => {
    if (activeView !== "inbox") return;
    if (!isMobile) return;
    if (mobileInboxPanel !== "chat") return;
    shouldStickToBottomRef.current = true;
    scrollThreadToBottom(true);
  }, [mobileInboxPanel, isMobile, activeView]);

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
      setAdminView(resolveAdminTabFromPathname());
      setActiveView(defaultViewForRouteMode(routeModeRef.current));
      return;
    }
    setAuthError("Contrasena incorrecta.");
  }

  function handleAdminTabChange(nextView) {
    const view = nextView === "appointments" ? "appointments" : "inventory";
    setAdminView(view);
    if (typeof window === "undefined") return;
    const nextPath = view === "appointments" ? "/admin/citas" : "/admin";
    if (window.location.pathname !== nextPath) {
      window.history.replaceState({}, "", nextPath);
    }
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

  async function loadLeads() {
    try {
      const res = await fetch(`${LEADS_API_URL}?limit=300`);
      const data = await res.json();
      setLeadRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch {
      setLeadRows([]);
    }
  }

  async function loadAppointments() {
    setAppointmentsLoading(true);
    setAppointmentsError("");
    try {
      const params = new URLSearchParams({ limit: "500" });
      const now = new Date();
      if (appointmentsMenuFilter === "date" && appointmentsDate) {
        const from = `${appointmentsDate}T00:00:00.000Z`;
        const to = `${appointmentsDate}T23:59:59.999Z`;
        params.set("from", from);
        params.set("to", to);
      } else if (appointmentsMenuFilter === "today") {
        const today = toDateInputValue(now);
        const from = `${today}T00:00:00.000Z`;
        const to = `${today}T23:59:59.999Z`;
        params.set("from", from);
        params.set("to", to);
      } else if (appointmentsMenuFilter === "upcoming") {
        params.set("from", now.toISOString());
      }
      const res = await fetch(`${APPOINTMENTS_API_URL}?${params.toString()}`);
      const data = await res.json();
      setAppointmentsRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch {
      setAppointmentsError("No pude cargar citas.");
    } finally {
      setAppointmentsLoading(false);
    }
  }

  async function loadUpcomingAppointments() {
    try {
      const params = new URLSearchParams({ limit: "500" });
      const now = new Date();
      params.set("from", now.toISOString());
      const res = await fetch(`${APPOINTMENTS_API_URL}?${params.toString()}`);
      const data = await res.json();
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const sorted = rows
        .filter((row) => {
          const status = String(row?.status || "").toUpperCase();
          return status !== "CANCELLED" && status !== "COMPLETED" && status !== "NO_SHOW";
        })
        .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
      setUpcomingAppointmentsRows(sorted);
    } catch {
      setUpcomingAppointmentsRows([]);
    }
  }

  async function saveAppointment(e) {
    e.preventDefault();
    if (savingAppointment) return;
    setAppointmentsError("");
    if (!appointmentForm.lead_session_id || !appointmentForm.scheduled_at) {
      setAppointmentsError("Lead y fecha/hora son requeridos.");
      return;
    }

    setSavingAppointment(true);
    try {
      const iso = new Date(appointmentForm.scheduled_at).toISOString();
      const payload = {
        lead_session_id: appointmentForm.lead_session_id.trim(),
        scheduled_at: iso,
        notes: appointmentForm.notes || ""
      };

      const res = await fetch(APPOINTMENTS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error("request failed");

      setAppointmentForm({ lead_session_id: "", scheduled_at: "", notes: "" });
      await loadAppointments();
      await loadUpcomingAppointments();
    } catch {
      setAppointmentsError("No pude crear la cita.");
    } finally {
      setSavingAppointment(false);
    }
  }

  async function confirmAppointment(id) {
    if (!id) return;
    setAppointmentsError("");
    try {
      const res = await fetch(`${APPOINTMENTS_API_URL}/${id}/confirm`, { method: "POST" });
      if (!res.ok) throw new Error("request failed");
      await loadAppointments();
      await loadUpcomingAppointments();
    } catch {
      setAppointmentsError("No pude confirmar la cita.");
    }
  }

  async function deleteAppointment(id) {
    if (!id) return;
    if (typeof window !== "undefined") {
      const ok = window.confirm("Eliminar esta cita? Esta accion no se puede deshacer.");
      if (!ok) return;
    }
    setAppointmentsError("");
    try {
      const res = await fetch(`${APPOINTMENTS_API_URL}/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("request failed");
      await loadAppointments();
      await loadUpcomingAppointments();
    } catch {
      setAppointmentsError("No pude eliminar la cita.");
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
      params.set("_ts", String(Date.now()));
      const res = await fetch(`${CONVERSATIONS_API_URL}?${params.toString()}`, {
        cache: "no-store"
      });
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

  async function loadConversationAppointment(targetSessionId, { mountedRef = null } = {}) {
    if (!targetSessionId) return;
    try {
      const encoded = encodeURIComponent(targetSessionId);
      const ts = Date.now();
      const res = await fetch(`${CONVERSATIONS_API_URL}/${encoded}/appointment?_ts=${ts}`, {
        cache: "no-store"
      });
      const data = await res.json();
      if (mountedRef && !mountedRef()) return;
      setSelectedLead(data?.lead || null);
      setSelectedAppointment(data?.appointment || null);
    } catch {
      if (!mountedRef || mountedRef()) {
        setSelectedLead(null);
        setSelectedAppointment(null);
      }
    }
  }

  async function loadMessagesForSession(targetSessionId, { mountedRef = null } = {}) {
    if (!targetSessionId) return;
    setMessagesLoading(true);
    setMessagesError("");
    try {
      const encoded = encodeURIComponent(targetSessionId);
      const ts = Date.now();
      const res = await fetch(`${CONVERSATIONS_API_URL}/${encoded}/messages?limit=200&_ts=${ts}`, {
        cache: "no-store"
      });
      const data = await res.json();
      if (mountedRef && !mountedRef()) return;
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const settings = data?.settings || { bot_enabled: 1, last_read_at: null };
      setSelectedMessages(rows);
      setSelectedSettings(settings);
      saveMessagesCacheForSession(targetSessionId, rows, settings);
      await loadConversationAppointment(targetSessionId, { mountedRef });
      if (routeMode === "whatsapp") {
        scrollThreadToBottom();
      }
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
    if (isMobile) {
      if (typeof window !== "undefined" && routeMode === "whatsapp" && mobileInboxPanel !== "chat") {
        window.history.pushState({ wspChat: true, sessionId: targetSessionId }, "", window.location.href);
      }
      setMobileInboxPanel("chat");
    }
    setManualReplyError("");
    setManualReplySuccess("");
    setLeadActionError("");
    setLeadActionSuccess("");
    await markThreadAsRead(targetSessionId);
  }

  async function runAppointmentAction(action) {
    if (!selectedSessionId || appointmentActionLoading) return;
    setAppointmentActionError("");
    setAppointmentActionSuccess("");
    setAppointmentActionLoading(true);
    try {
      const encoded = encodeURIComponent(selectedSessionId);
      const res = await fetch(`${CONVERSATIONS_API_URL}/${encoded}/appointment/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "No se pudo ejecutar accion de cita");

      setSelectedLead(data?.lead || null);
      setSelectedAppointment(data?.appointment || null);
      setAppointmentActionSuccess("Cita actualizada.");
      await loadMessagesForSession(selectedSessionId);
      await loadConversations({ keepSelection: true });
    } catch (error) {
      setAppointmentActionError(error?.message || "No se pudo actualizar cita.");
    } finally {
      setAppointmentActionLoading(false);
    }
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

  async function takeLeadAsHuman() {
    if (!selectedSessionId || leadActionLoading) return;
    setLeadActionError("");
    setLeadActionSuccess("");
    setLeadActionLoading(true);
    try {
      const encoded = encodeURIComponent(selectedSessionId);
      const targetStatus = normalizeLeadStatus(
        selectedLead?.status,
        selectedAppointment ? "APPT_PENDING" : "QUALIFIED"
      );

      const leadRes = await fetch(`${LEADS_API_URL}/${encoded}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: targetStatus,
          priority: "HIGH",
          mode: "HUMAN"
        })
      });
      const leadData = await leadRes.json();
      if (!leadRes.ok) throw new Error(leadData?.error || "No se pudo actualizar lead");

      await fetch(`${CONVERSATIONS_API_URL}/${encoded}/bot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false })
      });

      setSelectedLead(leadData?.row || null);
      setSelectedSettings((prev) => ({ ...prev, bot_enabled: 0 }));
      setConversationRows((prev) =>
        prev.map((row) =>
          row.session_id === selectedSessionId
            ? {
                ...row,
                bot_enabled: 0,
                lead_mode: "HUMAN",
                lead_priority: "HIGH",
                lead_status: targetStatus
              }
            : row
        )
      );

      setLeadActionSuccess("Lead tomado en modo HUMANO.");
    } catch (error) {
      setLeadActionError(error?.message || "No se pudo activar modo humano.");
    } finally {
      setLeadActionLoading(false);
    }
  }

  async function sendManualReply(e) {
    e.preventDefault();
    await sendManualReplyMessage(manualReplyText);
  }

  async function sendManualReplyMessage(rawMessage) {
    if (!selectedSessionId || manualSending) return;
    if (!selectedSessionId.startsWith("wa:") && !selectedSessionId.startsWith("wa_meta:")) {
      setManualReplyError("Respuesta manual disponible solo para chats WhatsApp.");
      return;
    }
    const message = String(rawMessage || "").trim();
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

  async function pickPhoneContact() {
    if (contactPickerLoading) return;
    setContactPickerError("");
    setContactPickerSuccess("");

    if (!contactPickerSupported) {
      setContactPickerError("Este navegador no permite leer contactos del telefono.");
      return;
    }

    setContactPickerLoading(true);
    try {
      const picked = await navigator.contacts.select(["name", "tel"], { multiple: true });
      if (!Array.isArray(picked) || !picked.length) {
        setContactPickerSuccess("No seleccionaste contacto.");
        return;
      }

      const nextMap = { ...contactNameMap };
      let synced = 0;
      let firstValidContact = null;

      for (const contact of picked) {
        const contactName = String(contact?.name?.[0] || "").trim();
        const tels = Array.isArray(contact?.tel) ? contact.tel : [];
        if (!contactName || !tels.length) continue;
        for (const tel of tels) {
          const digits = normalizePhoneDigits(tel);
          if (!digits) continue;
          nextMap[digits] = contactName;
          if (!firstValidContact) {
            firstValidContact = { contactName, tel: String(tel || ""), digits };
          }
          synced += 1;
        }
      }

      if (!synced) {
        setContactPickerError("Los contactos elegidos no tienen nombre y telefono valido.");
        return;
      }
      setContactNameMap(nextMap);

      const primaryDigits = firstValidContact?.digits || "";
      const primaryLabel = firstValidContact?.contactName || firstValidContact?.tel || "";
      if (primaryDigits) {
        const match = conversationRows.find((row) => {
          const sessionDigits = normalizePhoneDigits(row?.session_id || "");
          const leadDigits = normalizePhoneDigits(row?.lead_phone || "");
          return (
            sessionDigits.includes(primaryDigits) ||
            primaryDigits.includes(sessionDigits) ||
            leadDigits.includes(primaryDigits) ||
            primaryDigits.includes(leadDigits)
          );
        });
        setSearchQuery(primaryLabel || primaryDigits);
        if (match?.session_id) {
          await handleSelectConversation(match.session_id);
        }
      }
      setContactPickerSuccess(`Sincronizados ${synced} telefonos de contactos.`);
    } catch (error) {
      if (String(error?.name || "") === "AbortError") {
        setContactPickerSuccess("Seleccion de contacto cancelada.");
      } else {
        setContactPickerError("No pude abrir contactos del telefono.");
      }
    } finally {
      setContactPickerLoading(false);
    }
  }

  async function createNewContact(e) {
    e.preventDefault();
    if (addingContact) return;
    const phone = String(newContactPhone || "").trim();
    const name = String(newContactName || "").trim();
    if (!phone) {
      setAddContactError("Escribe un telefono valido.");
      return;
    }

    setAddContactError("");
    setAddContactSuccess("");
    setAddingContact(true);
    try {
      const res = await fetch(`${CONVERSATIONS_API_URL}/create-contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          name: name || undefined,
          provider: "twilio"
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "No se pudo crear contacto.");

      if (name) {
        const digits = normalizePhoneDigits(phone);
        if (digits) {
          setContactNameMap((prev) => ({ ...prev, [digits]: name }));
        }
      }

      setNewContactPhone("");
      setNewContactName("");
      setShowAddContactForm(false);
      setAddContactSuccess("Contacto agregado.");
      await loadConversations({ keepSelection: false });
      if (data?.session_id) {
        await handleSelectConversation(data.session_id);
      }
    } catch (error) {
      setAddContactError(error?.message || "No pude agregar el contacto.");
    } finally {
      setAddingContact(false);
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
      vehicle_type: row.vehicle_type || "Sedan",
      color: row.color || "",
      status: row.status || "available"
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
      featured: 0
    };

    const method = editingId ? "PATCH" : "POST";
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
      <main className={`app ${routeMode === "whatsapp" ? "app-wsp" : ""}`}>
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
    <main className={`app ${routeMode === "whatsapp" ? "app-wsp" : ""}`}>
      <section className={`crm-shell ${routeMode === "whatsapp" ? "crm-shell-wsp" : ""}`}>
        <header className="topbar">
          <div className="brand-block">
            <img src="/2026-01-14.webp" alt="Empire Rey logo" className="brand-logo" />
            <div>
              <p className="eyebrow">Empire Rey Dealer CRM</p>
              <h1>Centro de Operaciones</h1>
            </div>
          </div>
          <div className={`topbar-actions ${routeMode === "whatsapp" ? "topbar-actions-wsp" : ""}`}>
            {routeMode === "admin" ? (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  window.location.href = "/wsp";
                }}
              >
                Abrir WhatsApp ({inboxUnreadMessages})
              </button>
            ) : (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  window.location.href = "/admin";
                }}
              >
                Abrir Inventario
              </button>
            )}
            {routeMode === "admin" ? (
              <>
                <button
                  type="button"
                  className={adminView === "inventory" ? "active-btn" : "secondary-btn"}
                  onClick={() => handleAdminTabChange("inventory")}
                >
                  Inventario
                </button>
                <button
                  type="button"
                  className={adminView === "appointments" ? "active-btn" : "secondary-btn"}
                  onClick={() => handleAdminTabChange("appointments")}
                >
                  Citas
                </button>
                {adminView === "inventory" ? (
                  <button type="button" className="secondary-btn" onClick={loadInventory} disabled={inventoryLoading}>
                    {inventoryLoading ? "Cargando..." : "Sincronizar"}
                  </button>
                ) : (
                  <button type="button" className="secondary-btn" onClick={loadAppointments} disabled={appointmentsLoading}>
                    {appointmentsLoading ? "Cargando..." : "Refrescar citas"}
                  </button>
                )}
              </>
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

        {routeMode === "admin" ? (
          adminView === "inventory" ? (
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
                  <p>Reservados</p>
                  <strong>{kpis.reserved}</strong>
                </article>
                <article className="kpi-card">
                  <p>Vendidos</p>
                  <strong>{kpis.sold}</strong>
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
                  <select value={inventoryForm.vehicle_type} onChange={(e) => setInventoryForm((prev) => ({ ...prev, vehicle_type: e.target.value }))} required>
                    <option value="Sedan">Sedan</option>
                    <option value="SUV">SUV</option>
                    <option value="Pickup">Pickup</option>
                  </select>
                  <input placeholder="Color" value={inventoryForm.color} onChange={(e) => setInventoryForm((prev) => ({ ...prev, color: e.target.value }))} required />
                  <select value={inventoryForm.status} onChange={(e) => setInventoryForm((prev) => ({ ...prev, status: e.target.value }))}>
                    <option value="available">Disponible</option>
                    <option value="reserved">Reservado</option>
                    <option value="sold">Vendido</option>
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
                        <th>Ano</th>
                        <th>Marca</th>
                        <th>Modelo</th>
                        <th>Tipo</th>
                        <th>Precio</th>
                        <th>Millaje</th>
                        <th>Color</th>
                        <th>Transmision</th>
                        <th>Combustible</th>
                        <th>Status</th>
                        <th>Destacado</th>
                        <th>Actualizado</th>
                        <th>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inventoryRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.id}</td>
                          <td>{row.year || "-"}</td>
                          <td>{row.make || "-"}</td>
                          <td>{row.model || "-"}</td>
                          <td>{row.vehicle_type || "Sedan"}</td>
                          <td>${Number(row.price || 0).toLocaleString("en-US")}</td>
                          <td>{Number(row.mileage || 0).toLocaleString("en-US")} mi</td>
                          <td>{row.color || "-"}</td>
                          <td>{row.transmission || "-"}</td>
                          <td>{row.fuel_type || "-"}</td>
                          <td>{row.status}</td>
                          <td>{Number(row.featured) ? "Si" : "No"}</td>
                          <td>{formatTimestamp(row.updated_at)}</td>
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
          <section className="crm-layout appointments-layout">
            <section className="crm-main">
              <article className="panel crm-form-panel">
                <div className="panel-head">
                  <h2>Nueva cita</h2>
                  <p className="subtle">Agenda rapido con lead + fecha/hora.</p>
                </div>
                {appointmentsError ? <p className="error-text">{appointmentsError}</p> : null}
                <form className="appointment-create-form" onSubmit={saveAppointment}>
                  <input
                    list="leads-list"
                    placeholder="Lead session_id o telefono"
                    value={appointmentForm.lead_session_id}
                    onChange={(e) => setAppointmentForm((prev) => ({ ...prev, lead_session_id: e.target.value }))}
                    required
                  />
                  <datalist id="leads-list">
                    {leadRows.map((lead) => (
                      <option key={lead.session_id} value={lead.session_id}>
                        {lead.name || lead.phone || lead.session_id}
                      </option>
                    ))}
                  </datalist>
                  <input
                    type="datetime-local"
                    value={appointmentForm.scheduled_at}
                    onChange={(e) => setAppointmentForm((prev) => ({ ...prev, scheduled_at: e.target.value }))}
                    required
                  />
                  <input
                    placeholder="Notas"
                    value={appointmentForm.notes}
                    onChange={(e) => setAppointmentForm((prev) => ({ ...prev, notes: e.target.value }))}
                  />
                  <button type="submit" disabled={savingAppointment}>
                    {savingAppointment ? "Guardando..." : "Crear cita"}
                  </button>
                </form>
              </article>

              <article className="panel crm-table-panel">
                <div className="panel-head">
                  <h2>Calendario de citas</h2>
                  <div className="appointments-toolbar">
                    <button
                      type="button"
                      className={appointmentsMenuFilter === "today" ? "active-btn" : "secondary-btn"}
                      onClick={() => {
                        setAppointmentsDate(toDateInputValue(new Date()));
                        setAppointmentsMenuFilter("today");
                      }}
                    >
                      Hoy
                    </button>
                    <button
                      type="button"
                      className={appointmentsMenuFilter === "upcoming" ? "active-btn" : "secondary-btn"}
                      onClick={() => setAppointmentsMenuFilter("upcoming")}
                    >
                      Proximas
                    </button>
                    <button
                      type="button"
                      className={appointmentsMenuFilter === "all" ? "active-btn" : "secondary-btn"}
                      onClick={() => setAppointmentsMenuFilter("all")}
                    >
                      Todas
                    </button>
                    <input
                      className="appointments-date-input"
                      type="date"
                      value={appointmentsDate}
                      onChange={(e) => {
                        setAppointmentsDate(e.target.value);
                        setAppointmentsMenuFilter("date");
                      }}
                      aria-label="Seleccionar fecha de citas"
                    />
                  </div>
                </div>
                {appointmentsLoading ? <p className="subtle">Cargando citas...</p> : null}
                <div className="inventory-table-wrap">
                  <table className="inventory-table">
                    <thead>
                      <tr>
                        <th>Fecha/Hora</th>
                        <th>Lead</th>
                        <th>Telefono</th>
                        <th>Status</th>
                        <th>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {appointmentsRows.map((row) => (
                        <tr key={row.id}>
                          <td>{formatTimestamp(row.scheduled_at)}</td>
                          <td>{formatAppointmentLeadName(row, contactNameMap)}</td>
                          <td>{row.lead_phone || "-"}</td>
                          <td>{row.status}</td>
                          <td className="row-actions">
                            <button
                              type="button"
                              className="secondary-btn"
                              onClick={() => confirmAppointment(row.id)}
                              disabled={String(row.status || "").toUpperCase() === "CONFIRMED"}
                            >
                              Confirmar
                            </button>
                            <button
                              type="button"
                              className="danger-btn"
                              onClick={() => deleteAppointment(row.id)}
                            >
                              Eliminar
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!appointmentsRows.length && !appointmentsLoading ? (
                        <tr>
                          <td colSpan={5}>{appointmentEmptyMessage(appointmentsMenuFilter)}</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </article>
            </section>

            <aside className="panel crm-chat">
              <div className="panel-head">
                <h2>Resumen</h2>
              </div>
              <section className="appointments-summary-grid">
                <article className="kpi-card">
                  <p>Citas visibles</p>
                  <strong>{appointmentsRows.length}</strong>
                </article>
                <article className="kpi-card">
                  <p>Proximas</p>
                  <strong>{upcomingAppointmentsRows.length}</strong>
                </article>
                <article className="kpi-card">
                  <p>Leads</p>
                  <strong>{leadRows.length}</strong>
                </article>
              </section>
              <p className="subtle">Al confirmar una cita se envia correo automatico al dueno.</p>
              <div className="appointments-side-list">
                {upcomingAppointmentsRows.map((row) => (
                  <article key={`upcoming-${row.id}`} className="appointments-side-item">
                    <p>
                      <strong>{formatTimestamp(row.scheduled_at)}</strong>
                    </p>
                    <p>{formatAppointmentLeadName(row, contactNameMap)}</p>
                    <p className="subtle">{row.lead_phone || "-"}</p>
                    <p className="subtle">Estado: {row.status}</p>
                  </article>
                ))}
                {!upcomingAppointmentsRows.length ? <p className="subtle">No hay citas proximas.</p> : null}
              </div>
            </aside>
          </section>
          )
        ) : (
          <section className={`panel inbox-shell ${routeMode === "whatsapp" ? "inbox-shell-wsp" : ""}`}>
            <div className="inbox-layout">
              {!isMobile || mobileInboxPanel === "list" ? (
              <aside className="thread-list">
                <div className="thread-head">
                  <h2>Conversaciones</h2>
                  <p className="subtle">{conversationRows.length} contactos / {unreadTotal} mensajes sin leer</p>
                </div>
                <input
                  className="thread-search"
                  placeholder="Buscar nombre, numero o session..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <div className="thread-contact-actions">
                  <button
                    type="button"
                    className="secondary-btn thread-contact-add-btn"
                    onClick={() => setShowAddContactForm((prev) => !prev)}
                  >
                    {showAddContactForm ? "Cancelar" : "Agregar contacto"}
                  </button>
                  <button
                    type="button"
                    className="secondary-btn thread-contact-sync-mini"
                    onClick={pickPhoneContact}
                    disabled={contactPickerLoading}
                    title="Refrescar nombres del telefono"
                    aria-label="Refrescar nombres del telefono"
                  >
                    {contactPickerLoading ? "..." : "⟳"}
                  </button>
                </div>
                {showAddContactForm ? (
                  <form className="thread-add-contact-form" onSubmit={createNewContact}>
                    <input
                      placeholder="Telefono (+1502...)"
                      value={newContactPhone}
                      onChange={(e) => setNewContactPhone(e.target.value)}
                      required
                    />
                    <input
                      placeholder="Nombre (opcional)"
                      value={newContactName}
                      onChange={(e) => setNewContactName(e.target.value)}
                    />
                    <button type="submit" disabled={addingContact}>
                      {addingContact ? "Guardando..." : "Guardar contacto"}
                    </button>
                  </form>
                ) : null}
                {addContactError ? <p className="error-text">{addContactError}</p> : null}
                {addContactSuccess ? <p className="subtle">{addContactSuccess}</p> : null}
                {contactPickerError ? <p className="error-text">{contactPickerError}</p> : null}
                {contactPickerSuccess ? <p className="subtle">{contactPickerSuccess}</p> : null}
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
                        {formatConversationDisplayName(row, contactNameMap)}
                        {Number(row.unread_count || 0) > 0 ? (
                          <span className="thread-unread">{row.unread_count}</span>
                        ) : null}
                      </div>
                      <div className="thread-preview">{row.last_message || "Sin mensajes"}</div>
                      <div className="thread-meta">
                        <span>{formatTimestamp(row.updated_at)}</span>
                        <span>
                          {Number(row.bot_enabled ?? 1) === 1 ? "Bot ON" : "Bot OFF"} / {String(row.lead_mode || "BOT").toUpperCase()} / {String(row.lead_priority || "NORMAL").toUpperCase()} / U:{row.user_messages || 0} B:{row.assistant_messages || 0}
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
                  <h2>{selectedThread ? formatConversationDisplayName(selectedThread, contactNameMap) : "Selecciona un chat"}</h2>
                  <p className="subtle">{selectedThread ? selectedThread.session_id : "Esperando seleccion..."}</p>
                  {selectedLead ? (
                    <p className="subtle">
                      Lead: {String(selectedLead.status || selectedThread?.lead_status || "NEW").toUpperCase()} / {String(selectedLead.mode || selectedThread?.lead_mode || "BOT").toUpperCase()} / {String(selectedLead.priority || selectedThread?.lead_priority || "NORMAL").toUpperCase()}
                    </p>
                  ) : null}
                  {selectedAppointment ? (
                    <p className="subtle">
                      Cita: {formatTimestamp(selectedAppointment.scheduled_at)} / Estado: {selectedAppointment.status}
                    </p>
                  ) : selectedLead ? (
                    <p className="subtle">Lead sin cita activa.</p>
                  ) : null}
                </div>
                {messagesError ? <p className="error-text">{messagesError}</p> : null}
                <div className="thread-messages" ref={threadMessagesRef} onScroll={handleThreadScroll}>
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
                        : selectedSessionId.startsWith("wa:") || selectedSessionId.startsWith("wa_meta:")
                          ? "Responder manualmente..."
                          : "Solo chats WhatsApp permiten respuesta manual"
                    }
                    value={manualReplyText}
                    onChange={(e) => setManualReplyText(e.target.value)}
                    disabled={!selectedSessionId || manualSending || (!selectedSessionId.startsWith("wa:") && !selectedSessionId.startsWith("wa_meta:"))}
                  />
                  <button
                    type="submit"
                    disabled={!selectedSessionId || manualSending || !manualReplyText.trim() || (!selectedSessionId.startsWith("wa:") && !selectedSessionId.startsWith("wa_meta:"))}
                  >
                    {manualSending ? "Enviando..." : "Responder Manualmente"}
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

