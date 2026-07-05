// ================================================================
//  sw.js — FlowChat Service Worker
//  Handles incoming push events and notification clicks.
//  Must be served from the ROOT of your domain (not a subfolder),
//  e.g. https://flowchat.onrender.com/sw.js
// ================================================================

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

// ── Incoming push from the send-push Edge Function ────────────────
self.addEventListener("push", event => {
  let data = { title: "FlowChat", body: "You have a new message", url: "/chat.html" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // If the payload isn't JSON for some reason, fall back to defaults above.
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "flowchat-message",
      renotify: true,
      data: { url: data.url || "/chat.html" }
    })
  );
});

// ── Clicking the notification focuses an open tab, or opens a new one ──
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/chat.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes("chat.html") && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
