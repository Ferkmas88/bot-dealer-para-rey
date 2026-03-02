const CACHE_NAME = "empire-rey-crm-v2";
const APP_SHELL = ["/", "/manifest.webmanifest", "/2026-01-14.webp"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  // Always prefer network for the app shell/navigation so new deploys show immediately.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          return caches.match("/");
        })
      )
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Nuevo mensaje", body: "Tienes una nueva notificacion." };
  }

  const title = data.title || "Nuevo mensaje";
  const badgeCount = Number(data.badgeCount || 0);
  const options = {
    body: data.body || "Tienes una nueva notificacion.",
    icon: data.icon || "/2026-01-14.webp",
    badge: data.badge || "/2026-01-14.webp",
    tag: data.tag || "dealer-whatsapp-inbox",
    data: {
      url: data.url || "/"
    }
  };

  event.waitUntil(
    (async () => {
      if (self.navigator && "setAppBadge" in self.navigator) {
        if (badgeCount > 0) {
          await self.navigator.setAppBadge(badgeCount);
        } else if ("clearAppBadge" in self.navigator) {
          await self.navigator.clearAppBadge();
        }
      }
      await self.registration.showNotification(title, options);
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) {
            client.navigate(targetUrl);
          }
          return client;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("message", (event) => {
  const type = event?.data?.type;
  if (type !== "SET_BADGE") return;
  const count = Number(event?.data?.count || 0);

  event.waitUntil(
    (async () => {
      if (!self.navigator || !("setAppBadge" in self.navigator)) return;
      if (count > 0) {
        await self.navigator.setAppBadge(count);
      } else if ("clearAppBadge" in self.navigator) {
        await self.navigator.clearAppBadge();
      }
    })()
  );
});
