import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

function resolveRouteMode() {
  const path = window.location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (path === "/wsp" || path === "/admin/whatsapp" || path === "/admin/whatpp") return "whatsapp";
  return "admin";
}

function setPwaHead(routeMode) {
  const title = routeMode === "whatsapp" ? "Empire Rey WhatsApp" : "Empire Rey CRM";
  const manifestHref =
    routeMode === "whatsapp" ? "/manifest-wsp.webmanifest" : "/manifest.webmanifest";
  const themeColor = routeMode === "whatsapp" ? "#0b141a" : "#0f0f10";

  document.title = title;

  const manifestLink = document.querySelector('link[rel="manifest"]');
  if (manifestLink) manifestLink.setAttribute("href", manifestHref);

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute("content", themeColor);

  const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appleTitle) appleTitle.setAttribute("content", title);
}

if (typeof window !== "undefined") {
  setPwaHead(resolveRouteMode());
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const routeMode = resolveRouteMode();
    setPwaHead(routeMode);

    const swUrl = routeMode === "whatsapp" ? "/sw-wsp.js" : "/sw.js";
    const swScope = routeMode === "whatsapp" ? "/wsp" : "/";

    navigator.serviceWorker.register(swUrl, { scope: swScope }).catch((error) => {
      console.error("SW registration failed:", error);
    });
  });
}
