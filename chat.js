// ================================================================
//  chat.js — FlowChat (Supabase Edition)
//  Auth guard, DMs, groups, messages, media, typing, presence, theme.
// ================================================================

import { supabase, mediaUrl } from "./supabase-client.js";

// ── Global state ─────────────────────────────────────────────────
let me = null;
let activeId = null;
let activeType = null;
let activeConv = null;
let chatList = [];
let currentChatTab = "all";
let messageChannel = null;
let typingChannel = null;
let listChannels = [];
let replyTo = null;
let pendingFile = null;
let typingTimeout = null;
let groupSelectedUsers = [];
let presenceHeartbeat = null;
let lastTypingSent = 0;

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// ── Auth guard ───────────────────────────────────────────────────
// If we just got redirected back from Google, the URL still has
// "#access_token=..." in it. Supabase's client parses that
// automatically (detectSessionInUrl: true in supabase-client.js),
// but that parsing is async — calling getSession() immediately can
// race ahead of it and see no session yet, even though one is about
// to exist. We detect that case and wait for the SIGNED_IN event
// instead of bouncing straight back to login.html.
async function getSessionWaitingForOAuth() {
  const { data: { session: existing } } = await supabase.auth.getSession();
  if (existing) return existing;

  const hasOAuthHash = location.hash.includes("access_token");
  if (!hasOAuthHash) return null;

  // Give Supabase's client a moment to finish parsing the URL hash
  // and firing SIGNED_IN, then ask again.
  return new Promise(resolve => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      if (event === "SIGNED_IN" && sess) {
        sub.subscription.unsubscribe();
        resolve(sess);
      }
    });
    // Safety timeout: don't hang forever if something's actually wrong.
    setTimeout(() => { sub.subscription.unsubscribe(); resolve(null); }, 4000);
  });
}

const session = await getSessionWaitingForOAuth();
if (!session) {
  location.href = "login.html";
  throw new Error("redirecting to login");
}

// Clean the token mess out of the URL bar now that the session is set,
// so a refresh doesn't re-process a stale/expired hash and so the
// access token isn't sitting visibly in the address bar or browser history.
if (location.hash.includes("access_token")) {
  history.replaceState(null, "", location.pathname);
}

const { data: profileRow, error: profileErr } = await supabase
  .from("profiles").select("*").eq("id", session.user.id).single();

if (profileErr || !profileRow) {
  console.error("Failed to load profile:", profileErr);
} else {
  me = profileRow;
}

supabase.auth.onAuthStateChange((event, sess) => {
  if (event === "SIGNED_OUT" || !sess) location.href = "login.html";
});

// ── Presence ─────────────────────────────────────────────────────
async function markOnline() {
  if (!me) return;
  await supabase.from("profiles").update({ online: true, last_seen: new Date().toISOString() }).eq("id", me.id);
}
async function markOffline() {
  if (!me) return;
  await supabase.from("profiles").update({ online: false, last_seen: new Date().toISOString() }).eq("id", me.id);
}
window.addEventListener("beforeunload", markOffline);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") markOnline();
});

// ── Helpers ──────────────────────────────────────────────────────
function escHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}
function escAttr(s) {
  return (s ?? "").replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}
function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || name[0].toUpperCase();
}
function formatFileSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatListTime(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function dayLabel(iso) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "long", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}
function getFileKind(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "file";
}
function avatarHtml(name, avatarUrl) {
  if (avatarUrl) return `<img src="${escAttr(avatarUrl)}" alt="">`;
  return escHtml(getInitials(name));
}
function toast(msg) {
  const stack = document.getElementById("toast-stack");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
window.toast = toast;

// ── Theme ────────────────────────────────────────────────────────
function applyTheme() {
  const saved = localStorage.getItem("flowchat-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = saved ? saved === "dark" : prefersDark;
  document.documentElement.classList.toggle("dark", dark);
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.checked = dark;
}
window.toggleTheme = function(isDark) {
  document.documentElement.classList.toggle("dark", isDark);
  localStorage.setItem("flowchat-theme", isDark ? "dark" : "light");
};

// ── Modals ───────────────────────────────────────────────────────
window.openModal = function(id) {
  document.getElementById(id).classList.add("show");
  if (id === "new-dm-modal") {
    document.getElementById("dm-search-input").value = "";
    document.getElementById("dm-results").innerHTML = "";
    document.getElementById("dm-search-input").focus();
  }
  if (id === "new-group-modal") {
    document.getElementById("group-name-input").value = "";
    document.getElementById("group-search-input").value = "";
    document.getElementById("group-results").innerHTML = "";
    groupSelectedUsers = [];
    renderSelectedGroupUsers();
  }
};
window.closeModal = function(id) {
  document.getElementById(id).classList.remove("show");
};
document.querySelectorAll(".modal-overlay").forEach(overlay => {
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.remove("show"); });
});

window.openSettings = function() {
  if (me) {
    document.getElementById("settings-avatar").innerHTML = avatarHtml(me.name, me.avatar_url);
    document.getElementById("settings-name").textContent = me.name;
    document.getElementById("settings-email").textContent = me.email;
    document.getElementById("settings-name-input").value = me.name;
  }
  document.getElementById("settings-panel").classList.add("open");
  document.getElementById("settings-overlay").classList.add("show");
};
window.closeSettings = function() {
  document.getElementById("settings-panel").classList.remove("open");
  document.getElementById("settings-overlay").classList.remove("show");
};
window.saveProfile = async function() {
  const newName = document.getElementById("settings-name-input").value.trim();
  if (!newName) { toast("Name can't be empty"); return; }
  const { error } = await supabase.from("profiles").update({ name: newName }).eq("id", me.id);
  if (error) { toast("Couldn't save: " + error.message); return; }
  me.name = newName;
  document.getElementById("my-name").textContent = newName;
  document.getElementById("settings-name").textContent = newName;
  toast("Profile updated");
};
window.handleLogout = async function() {
  await markOffline();
  await supabase.auth.signOut();
  location.href = "login.html";
};

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  if (!me) { toast("Couldn't load your account. Try refreshing."); return; }
  applyTheme();
  populateSettings();
  await markOnline();
  await loadChatList();
  presenceHeartbeat = setInterval(markOnline, 60000);
  await registerServiceWorker();
  await reflectPushSubscriptionState();
}
function populateSettings() {
  document.getElementById("my-avatar").innerHTML = avatarHtml(me.name, me.avatar_url);
  document.getElementById("my-name").textContent = me.name;
  document.getElementById("my-email").textContent = me.email;
}
init();

// ================================================================
//  PUSH NOTIFICATIONS
// ================================================================
// IMPORTANT: set this to the same public key you generated for the
// Edge Function (see push-schema.sql / README "Push notifications").
// This one is safe to expose client-side — only the PRIVATE key is secret.
const VAPID_PUBLIC_KEY = "BL_8p29zoyilHGbPi7keLh8SnEPMq70uwRCZQdbBFAW2aBDg3SvjVI5SJzUo-7c1IYRXEkhqOeWuu88feQSutcs";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (e) {
    console.error("Service worker registration failed:", e);
    return null;
  }
}

// Reflect whether this browser already has an active push subscription,
// so the settings toggle shows the correct state on load.
async function reflectPushSubscriptionState() {
  const toggle = document.getElementById("push-toggle");
  if (!toggle || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (toggle) toggle.closest(".theme-toggle-row").style.display = "none";
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  toggle.checked = !!existing;
}

window.togglePushNotifications = async function(enable) {
  const toggle = document.getElementById("push-toggle");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    toast("Push notifications aren't supported in this browser.");
    if (toggle) toggle.checked = false;
    return;
  }

  const reg = await navigator.serviceWorker.ready;

  if (enable) {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("Notification permission was denied.");
      if (toggle) toggle.checked = false;
      return;
    }
    try {
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
      const json = subscription.toJSON();
      const { error } = await supabase.from("push_subscriptions").upsert({
        user_id: me.id,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth_key: json.keys.auth
      }, { onConflict: "endpoint" });
      if (error) throw error;
      toast("Notifications enabled");
    } catch (e) {
      console.error("Push subscribe failed:", e);
      toast("Couldn't enable notifications: " + e.message);
      if (toggle) toggle.checked = false;
    }
  } else {
    try {
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", existing.endpoint);
        await existing.unsubscribe();
      }
      toast("Notifications disabled");
    } catch (e) {
      console.error("Push unsubscribe failed:", e);
    }
  }
};

// ================================================================
//  CHAT LIST (sidebar)
// ================================================================
async function loadChatList() {
  const [{ data: convos, error: convErr }, { data: groups, error: groupErr }] = await Promise.all([
    supabase.from("conversations").select("*").or(`user_a.eq.${me.id},user_b.eq.${me.id}`),
    supabase.from("groups").select("*, group_members!inner(user_id)").eq("group_members.user_id", me.id)
  ]);
  if (convErr) console.error("Failed to load conversations:", convErr);
  if (groupErr) console.error("Failed to load groups:", groupErr);

  const dmItems = [];
  for (const c of convos || []) {
    const otherId = c.user_a === me.id ? c.user_b : c.user_a;
    const { data: otherUser } = await supabase.from("profiles").select("*").eq("id", otherId).single();
    if (!otherUser) continue;
    dmItems.push({
      id: c.id, type: "dm",
      name: otherUser.name, avatar_url: otherUser.avatar_url,
      other_user_id: otherUser.id, online: otherUser.online,
      last_message: c.last_message, last_at: c.last_at || c.created_at
    });
  }
  const groupItems = (groups || []).map(g => ({
    id: g.id, type: "group",
    name: g.name, avatar_url: g.photo_url,
    last_message: g.last_message, last_at: g.last_at || g.created_at
  }));

  chatList = [...dmItems, ...groupItems].sort((a, b) => new Date(b.last_at || 0) - new Date(a.last_at || 0));
  renderChatList(document.getElementById("search-input").value);
  subscribeToListUpdates();
}

function renderChatList(filterText = "") {
  const listEl = document.getElementById("chat-list");
  const q = filterText.trim().toLowerCase();
  let items = chatList;
  if (currentChatTab !== "all") items = items.filter(i => i.type === currentChatTab);
  if (q) items = items.filter(i => i.name.toLowerCase().includes(q));

  if (items.length === 0) {
    listEl.innerHTML = `<div class="sb-empty">${q ? "No matches" : "No conversations yet — start one!"}</div>`;
    return;
  }
  listEl.innerHTML = items.map(c => `
    <div class="chat-item ${activeId === c.id ? "active" : ""}" onclick="openChat('${c.id}','${c.type}')">
      <div class="avatar">
        ${avatarHtml(c.name, c.avatar_url)}
        ${c.type === "dm" ? `<span class="presence ${c.online ? "status-online" : "status-offline"}"></span>` : ""}
      </div>
      <div class="chat-item-body">
        <div class="chat-item-top">
          <div class="chat-item-name">${escHtml(c.name)}</div>
          <div class="chat-item-time">${formatListTime(c.last_at)}</div>
        </div>
        <div class="chat-item-preview">${escHtml(c.last_message || "No messages yet")}</div>
      </div>
    </div>
  `).join("");
}
window.filterChats = function(val) { renderChatList(val); };
window.switchChatTab = function(tab, el) {
  currentChatTab = tab;
  document.querySelectorAll(".sb-tab").forEach(t => t.classList.remove("active"));
  el.classList.add("active");
  renderChatList(document.getElementById("search-input").value);
};

let listSubscribed = false;
function subscribeToListUpdates() {
  if (listSubscribed) return; // only wire these listeners once
  listSubscribed = true;
  const ch = supabase
    .channel("sidebar-updates")
    .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => loadChatList())
    .on("postgres_changes", { event: "*", schema: "public", table: "groups" }, () => loadChatList())
    .on("postgres_changes", { event: "*", schema: "public", table: "group_members", filter: `user_id=eq.${me.id}` }, () => loadChatList())
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles" }, payload => {
      const item = chatList.find(c => c.other_user_id === payload.new.id);
      if (item) { item.online = payload.new.online; renderChatList(document.getElementById("search-input").value); }
    })
    .subscribe();
  listChannels.push(ch);
}

// ================================================================
//  OPEN / CLOSE A CHAT
// ================================================================
window.openChat = async function(id, type) {
  if (!me) { toast("Still loading your account, try again in a second."); return; }
  if (activeId === id) { showChatPanel(); return; }

  activeId = id;
  activeType = type;
  replyTo = null;
  cancelReply();

  document.getElementById("empty-state").style.display = "none";
  document.getElementById("chat-view").classList.add("show");
  document.getElementById("input-area").classList.add("show");
  showChatPanel();
  renderChatList(document.getElementById("search-input").value);

  if (type === "dm") {
    const item = chatList.find(c => c.id === id);
    const { data: otherUser } = await supabase.from("profiles").select("*").eq("id", item.other_user_id).single();
    activeConv = { ...item, other_user: otherUser };
    document.getElementById("ch-avatar").innerHTML = avatarHtml(otherUser.name, otherUser.avatar_url);
    document.getElementById("ch-name").textContent = otherUser.name;
    document.getElementById("ch-status").textContent = otherUser.online ? "Online" : "Offline";
  } else {
    const { data: group } = await supabase.from("groups").select("*").eq("id", id).single();
    const { data: members } = await supabase.from("group_members").select("*, profiles(*)").eq("group_id", id);
    activeConv = { ...group, members: members || [] };
    document.getElementById("ch-avatar").innerHTML = avatarHtml(group.name, group.photo_url);
    document.getElementById("ch-name").textContent = group.name;
    document.getElementById("ch-status").textContent = `${(members || []).length} members`;
  }

  await loadMessages();
  subscribeToActiveChat();
};

function showChatPanel() {
  document.getElementById("sidebar").classList.add("hidden");
  document.getElementById("chat").classList.add("visible");
}
window.backToList = function() {
  document.getElementById("sidebar").classList.remove("hidden");
  document.getElementById("chat").classList.remove("visible");
};

// ── Mobile: right-swipe on an open chat to go back to the chat list ──
(function setupSwipeBack() {
  const chatEl = document.getElementById("chat");
  if (!chatEl) return;
  const EDGE_ZONE = 40, MIN_DIST = 60, MAX_VERTICAL = 60;
  let startX = 0, startY = 0, tracking = false, dragging = false;

  chatEl.addEventListener("touchstart", e => {
    if (window.innerWidth > 768) return;
    if (!chatEl.classList.contains("visible")) return;
    const t = e.touches[0];
    if (t.clientX > EDGE_ZONE) { tracking = false; return; }
    startX = t.clientX; startY = t.clientY; tracking = true; dragging = false;
  }, { passive: true });

  chatEl.addEventListener("touchmove", e => {
    if (!tracking) return;
    const t = e.touches[0];
    const dx = t.clientX - startX, dy = Math.abs(t.clientY - startY);
    if (dy > MAX_VERTICAL) { tracking = false; chatEl.style.transform = ""; return; }
    if (dx > 0) { dragging = true; chatEl.style.transition = "none"; chatEl.style.transform = `translateX(${dx}px)`; }
  }, { passive: true });

  chatEl.addEventListener("touchend", e => {
    chatEl.style.transition = ""; chatEl.style.transform = "";
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX, dy = Math.abs(t.clientY - startY);
    if (dragging && dx > MIN_DIST && dy < MAX_VERTICAL) backToList();
  }, { passive: true });

  chatEl.addEventListener("touchcancel", () => {
    tracking = false; chatEl.style.transition = ""; chatEl.style.transform = "";
  }, { passive: true });
})();

// ================================================================
//  MESSAGES — load, render, realtime
// ================================================================
async function loadMessages() {
  const col = activeType === "dm" ? "conversation_id" : "group_id";

  // Fetch messages with their direct sender profile. We deliberately
  // do NOT nest a second sender lookup inside `reply` here — messages
  // self-references (reply_to_id -> messages.id) combined with a
  // second profiles join can trip PostgREST's foreign-key
  // disambiguation. Instead we fetch replied-to messages separately
  // and stitch them together client-side, which is simpler and avoids
  // relying on exact constraint names.
  const { data: msgs, error } = await supabase
    .from("messages")
    .select("*, sender:profiles!messages_sender_id_fkey(name, avatar_url)")
    .eq(col, activeId)
    .order("created_at", { ascending: true });

  if (error) { console.error("Failed to load messages:", error); toast("Couldn't load messages."); return; }

  const replyIds = [...new Set((msgs || []).map(m => m.reply_to_id).filter(Boolean))];
  let repliesById = {};
  if (replyIds.length) {
    const { data: replySources } = await supabase
      .from("messages")
      .select("id, text, type, sender:profiles!messages_sender_id_fkey(name)")
      .in("id", replyIds);
    repliesById = Object.fromEntries((replySources || []).map(r => [r.id, r]));
  }
  (msgs || []).forEach(m => { if (m.reply_to_id) m.reply = repliesById[m.reply_to_id] || null; });

  renderMessages(msgs || []);
  scrollToBottom();
}

function renderMessages(msgs) {
  const el = document.getElementById("messages");
  let html = "";
  let lastDay = null, lastSender = null;

  msgs.forEach((msg, i) => {
    const day = dayLabel(msg.created_at);
    if (day !== lastDay) { html += `<div class="day-divider">${day}</div>`; lastDay = day; lastSender = null; }

    const own = msg.sender_id === me.id;
    const grouped = lastSender === msg.sender_id && !own;
    lastSender = msg.sender_id;
    const senderName = msg.sender?.name || "Unknown";
    const senderAvatar = msg.sender?.avatar_url;

    let bubbleContent = "";
    if (msg.reply) {
      const replyText = msg.reply.text || (msg.reply.type === "image" ? "📷 Image" : msg.reply.type === "video" ? "🎬 Video" : msg.reply.type === "audio" ? "🎵 Audio" : "📄 File");
      bubbleContent += `<div class="reply-quote"><span class="rq-name">${escHtml(msg.reply.sender?.name || "User")}</span><br>${escHtml(replyText)}</div>`;
    }

    if (msg.deleted) {
      bubbleContent += `<span style="opacity:.55;font-style:italic">Message deleted</span>`;
    } else if (msg.type === "image") {
      bubbleContent += `<img class="msg-img" src="${escAttr(msg.url)}" onclick="openLightbox('${escAttr(msg.url)}')">`;
      if (msg.text) bubbleContent += `<div style="margin-top:6px">${escHtml(msg.text)}</div>`;
    } else if (msg.type === "video") {
      bubbleContent += `<video class="msg-video" src="${escAttr(msg.url)}" controls preload="metadata"></video>`;
      if (msg.text) bubbleContent += `<div style="margin-top:6px">${escHtml(msg.text)}</div>`;
    } else if (msg.type === "audio") {
      bubbleContent += `<div class="msg-audio"><span>🎵</span><audio class="msg-audio-el" src="${escAttr(msg.url)}" controls preload="metadata"></audio></div>`;
      if (msg.text) bubbleContent += `<div style="margin-top:6px">${escHtml(msg.text)}</div>`;
    } else if (msg.type === "file") {
      bubbleContent += `<a href="${escAttr(msg.url)}" target="_blank" class="msg-file">
        <span style="font-size:20px">📄</span>
        <div><div class="msg-file-name">${escHtml(msg.file_name || "File")}</div><div class="msg-file-size">${msg.file_size ? formatFileSize(msg.file_size) + " · " : ""}Tap to open</div></div>
      </a>`;
    } else {
      bubbleContent += escHtml(msg.text || "");
    }

    const editedTag = msg.edited && !msg.deleted ? `<span class="msg-edited">edited</span>` : "";

    html += `
      <div class="msg-row ${own ? "own" : ""} ${grouped ? "grouped" : ""}"
           oncontextmenu="showMsgContextMenu(event,'${msg.id}',${own},${!!msg.deleted})"
           ontouchstart="msgTouchStart(event,'${msg.id}',${own},${!!msg.deleted})"
           ontouchend="msgTouchEnd()">
        <div class="avatar">${avatarHtml(senderName, senderAvatar)}</div>
        <div class="bubble-wrap">
          ${!own && activeType === "group" && !grouped ? `<div class="msg-sender">${escHtml(senderName)}</div>` : ""}
          <div class="bubble">${bubbleContent}</div>
          <div class="msg-meta">${editedTag}<span>${formatTime(msg.created_at)}</span></div>
        </div>
      </div>`;
  });

  el.innerHTML = html || `<div class="sb-empty" style="margin:auto;">No messages yet. Say hi 👋</div>`;
}

function scrollToBottom() {
  const el = document.getElementById("messages");
  el.scrollTop = el.scrollHeight;
}

function subscribeToActiveChat() {
  if (messageChannel) supabase.removeChannel(messageChannel);
  if (typingChannel) supabase.removeChannel(typingChannel);

  const col = activeType === "dm" ? "conversation_id" : "group_id";

  messageChannel = supabase
    .channel(`messages-${activeId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `${col}=eq.${activeId}` }, () => {
      loadMessages();
    })
    .subscribe();

  typingChannel = supabase
    .channel(`typing-${activeId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "typing_status", filter: `${col}=eq.${activeId}` }, () => {
      renderTypingIndicator();
    })
    .subscribe();
}

async function renderTypingIndicator() {
  const col = activeType === "dm" ? "conversation_id" : "group_id";
  const { data } = await supabase.from("typing_status").select("*, profiles(name)").eq(col, activeId).neq("user_id", me.id);
  const recent = (data || []).filter(t => Date.now() - new Date(t.updated_at).getTime() < 6000);

  const existing = document.querySelector(".typing-row");
  if (existing) existing.remove();
  if (!recent.length) return;

  const el = document.getElementById("messages");
  const row = document.createElement("div");
  row.className = "typing-row";
  row.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
  el.appendChild(row);
  scrollToBottom();
}

// ================================================================
//  SENDING MESSAGES
// ================================================================
window.handleInputKeydown = function(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
};
window.handleInputChange = function(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  sendTypingPing();
};

async function sendTypingPing() {
  const now = Date.now();
  if (now - lastTypingSent < 2000) return; // throttle
  lastTypingSent = now;
  const col = activeType === "dm" ? "conversation_id" : "group_id";
  await supabase.from("typing_status").upsert({
    [col]: activeId, user_id: me.id, updated_at: new Date().toISOString()
  }, { onConflict: activeType === "dm" ? "conversation_id,user_id" : "group_id,user_id" });
}

window.sendMessage = async function() {
  if (!me || !activeId) { toast("Still loading your account, try again in a second."); return; }
  const input = document.getElementById("msg-input");
  const text = input.value.trim();

  if (!text && !pendingFile) return;

  const col = activeType === "dm" ? "conversation_id" : "group_id";
  const baseMsg = {
    [col]: activeId,
    sender_id: me.id,
    reply_to_id: replyTo?.id || null
  };

  input.value = "";
  input.style.height = "auto";
  const fileToSend = pendingFile;
  pendingFile = null;
  cancelReply();

  if (fileToSend) {
    await uploadAndSend(fileToSend, { ...baseMsg, text: text || null });
  } else {
    const { error } = await supabase.from("messages").insert({ ...baseMsg, type: "text", text });
    if (error) { toast("Failed to send: " + error.message); return; }
    await touchConversationPreview(text);
  }
};

async function touchConversationPreview(previewText) {
  const table = activeType === "dm" ? "conversations" : "groups";
  await supabase.from(table).update({ last_message: previewText, last_at: new Date().toISOString() }).eq("id", activeId);
}

async function uploadAndSend(file, baseMsg) {
  const kind = getFileKind(file);
  showUploadProgress(0, file.name);
  try {
    const ext = file.name.split(".").pop();
    const path = `${activeId}/${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage.from("media").upload(path, file, {
      cacheControl: "3600", upsert: false
    });
    if (upErr) throw upErr;
    showUploadProgress(70, file.name);

    const url = mediaUrl(path);
    const { error } = await supabase.from("messages").insert({
      ...baseMsg, type: kind, url,
      file_name: file.name, file_size: file.size
    });
    if (error) throw error;

    const previewText = kind === "image" ? "📷 Image" : kind === "video" ? "🎬 Video" : kind === "audio" ? "🎵 Audio" : `📄 ${file.name}`;
    await touchConversationPreview(previewText);

    showUploadProgress(100, file.name);
    hideUploadProgress();
    toast("Sent!");
  } catch (e) {
    hideUploadProgress();
    toast("Upload failed: " + e.message);
  }
}

function showUploadProgress(pct, fileName) {
  let bar = document.getElementById("upload-progress");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "upload-progress";
    bar.innerHTML = `<div class="up-info"><span id="up-name"></span><span id="up-pct"></span></div><div class="up-track"><div class="up-fill" id="up-fill"></div></div>`;
    document.getElementById("input-area").prepend(bar);
  }
  document.getElementById("up-name").textContent = fileName;
  document.getElementById("up-pct").textContent = pct + "%";
  document.getElementById("up-fill").style.width = pct + "%";
}
function hideUploadProgress() {
  document.getElementById("upload-progress")?.remove();
}

// ── File picker ──────────────────────────────────────────────────
window.handleFileSelect = function(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) {
    toast(`File too large (max ${Math.floor(MAX_FILE_SIZE / (1024*1024))}MB)`);
    input.value = ""; return;
  }
  pendingFile = file;
  const kind = getFileKind(file);
  const icon = kind === "image" ? "🖼️" : kind === "video" ? "🎬" : kind === "audio" ? "🎵" : "📎";
  toast(`${icon} ${file.name} ready — press send`);
};

// ── Reply ────────────────────────────────────────────────────────
window.startReply = function(msgId, senderName, text) {
  replyTo = { id: msgId, senderName, text: text || "[media]" };
  document.getElementById("rb-name").textContent = senderName;
  document.getElementById("rb-text").textContent = text || "[media]";
  document.getElementById("reply-bar").classList.add("show");
  document.getElementById("msg-input").focus();
};
window.cancelReply = function() {
  replyTo = null;
  document.getElementById("reply-bar").classList.remove("show");
};

// ── Edit / Delete ────────────────────────────────────────────────
window.editMessage = async function(msgId, currentText) {
  const newText = prompt("Edit message:", currentText);
  if (newText === null || newText.trim() === "" || newText === currentText) return;
  const { error } = await supabase.from("messages").update({ text: newText.trim(), edited: true }).eq("id", msgId);
  if (error) toast("Couldn't edit: " + error.message);
};
window.deleteMessage = async function(msgId) {
  if (!confirm("Delete this message?")) return;
  const { error } = await supabase.from("messages").update({ deleted: true, text: null, url: null }).eq("id", msgId);
  if (error) toast("Couldn't delete: " + error.message);
};

// ── Context menu (right-click / long-press) ─────────────────────
let ctxMsg = null;
let longPressTimer = null;

window.showMsgContextMenu = function(e, msgId, isOwn, isDeleted) {
  e.preventDefault();
  if (isDeleted) return;
  const row = e.currentTarget;
  const bubbleText = row.querySelector(".bubble")?.textContent?.trim() || "";
  const senderName = row.querySelector(".msg-sender")?.textContent || me.name;
  ctxMsg = { msgId, isOwn, text: bubbleText, senderName: isOwn ? me.name : senderName };

  const menu = document.getElementById("context-menu");
  let items = `<div class="cm-item" onclick="ctxReply()">↩ Reply</div>`;
  if (isOwn) {
    items += `<div class="cm-item" onclick="ctxEdit()">✎ Edit</div>`;
    items += `<div class="cm-item danger" onclick="ctxDelete()">🗑 Delete</div>`;
  }
  menu.innerHTML = items;
  menu.style.left = Math.min(e.clientX, window.innerWidth - 170) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 120) + "px";
  menu.classList.add("show");
};
window.msgTouchStart = function(e, msgId, isOwn, isDeleted) {
  if (isDeleted) return;
  longPressTimer = setTimeout(() => {
    const fakeEvent = { preventDefault: () => {}, currentTarget: e.currentTarget, clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
    showMsgContextMenu(fakeEvent, msgId, isOwn, isDeleted);
  }, 500);
};
window.msgTouchEnd = function() { clearTimeout(longPressTimer); };

document.addEventListener("click", e => {
  if (!e.target.closest("#context-menu")) document.getElementById("context-menu").classList.remove("show");
});
window.ctxReply = function() {
  startReply(ctxMsg.msgId, ctxMsg.senderName, ctxMsg.text);
  document.getElementById("context-menu").classList.remove("show");
};
window.ctxEdit = function() {
  editMessage(ctxMsg.msgId, ctxMsg.text);
  document.getElementById("context-menu").classList.remove("show");
};
window.ctxDelete = function() {
  deleteMessage(ctxMsg.msgId);
  document.getElementById("context-menu").classList.remove("show");
};

// ── Lightbox ─────────────────────────────────────────────────────
window.openLightbox = function(url) {
  document.getElementById("lightbox-img").src = url;
  document.getElementById("lightbox").classList.add("show");
};
window.closeLightbox = function() {
  document.getElementById("lightbox").classList.remove("show");
};

// ================================================================
//  NEW DM
// ================================================================
let dmSearchDebounce = null;
window.searchUsers = function(query) {
  clearTimeout(dmSearchDebounce);
  dmSearchDebounce = setTimeout(async () => {
    const q = query.trim();
    const resultsEl = document.getElementById("dm-results");
    if (!q) { resultsEl.innerHTML = ""; return; }

    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
      .neq("id", me.id)
      .limit(15);

    if (error) { resultsEl.innerHTML = `<div class="sb-empty">Search failed</div>`; return; }
    if (!data.length) { resultsEl.innerHTML = `<div class="sb-empty">No users found</div>`; return; }

    resultsEl.innerHTML = data.map(u => `
      <div class="user-result" onclick="startDm('${u.id}')">
        <div class="avatar">${avatarHtml(u.name, u.avatar_url)}</div>
        <div>
          <div class="user-result-name">${escHtml(u.name)}</div>
          <div class="user-result-email">${escHtml(u.email)}</div>
        </div>
      </div>`).join("");
  }, 300);
};

window.startDm = async function(otherUserId) {
  // Conversations are stored with a consistent (lower-id, higher-id)
  // pair ordering so the unique constraint in the schema can prevent
  // duplicate threads regardless of who starts the chat.
  const [a, b] = [me.id, otherUserId].sort();

  let { data: existing } = await supabase
    .from("conversations").select("*")
    .eq("user_a", a).eq("user_b", b)
    .maybeSingle();

  let convId;
  if (existing) {
    convId = existing.id;
  } else {
    const { data: created, error } = await supabase
      .from("conversations").insert({ user_a: a, user_b: b })
      .select().single();
    if (error) { toast("Couldn't start chat: " + error.message); return; }
    convId = created.id;
  }

  closeModal("new-dm-modal");
  await loadChatList();
  openChat(convId, "dm");
};

// ================================================================
//  NEW GROUP
// ================================================================
let groupSearchDebounce = null;
window.searchUsersForGroup = function(query) {
  clearTimeout(groupSearchDebounce);
  groupSearchDebounce = setTimeout(async () => {
    const q = query.trim();
    const resultsEl = document.getElementById("group-results");
    if (!q) { resultsEl.innerHTML = ""; return; }

    const { data } = await supabase
      .from("profiles").select("*")
      .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
      .neq("id", me.id)
      .limit(15);

    const filtered = (data || []).filter(u => !groupSelectedUsers.some(s => s.id === u.id));
    if (!filtered.length) { resultsEl.innerHTML = `<div class="sb-empty">No users found</div>`; return; }

    resultsEl.innerHTML = filtered.map(u => `
      <div class="user-result" onclick='addToGroupSelection(${JSON.stringify(u).replace(/'/g, "&#39;")})'>
        <div class="avatar">${avatarHtml(u.name, u.avatar_url)}</div>
        <div>
          <div class="user-result-name">${escHtml(u.name)}</div>
          <div class="user-result-email">${escHtml(u.email)}</div>
        </div>
      </div>`).join("");
  }, 300);
};

window.addToGroupSelection = function(user) {
  if (groupSelectedUsers.some(u => u.id === user.id)) return;
  groupSelectedUsers.push(user);
  renderSelectedGroupUsers();
  document.getElementById("group-search-input").value = "";
  document.getElementById("group-results").innerHTML = "";
};
window.removeFromGroupSelection = function(userId) {
  groupSelectedUsers = groupSelectedUsers.filter(u => u.id !== userId);
  renderSelectedGroupUsers();
};
function renderSelectedGroupUsers() {
  const el = document.getElementById("group-selected");
  el.innerHTML = groupSelectedUsers.map(u => `
    <div style="display:flex;align-items:center;gap:6px;background:var(--secondary);color:var(--secondary-foreground);padding:4px 8px 4px 4px;border-radius:999px;font-size:12px;">
      <div class="avatar" style="width:20px;height:20px;font-size:9px;">${avatarHtml(u.name, u.avatar_url)}</div>
      ${escHtml(u.name)}
      <span style="cursor:pointer;opacity:.6;" onclick="removeFromGroupSelection('${u.id}')">✕</span>
    </div>`).join("");
}

window.createGroup = async function() {
  const name = document.getElementById("group-name-input").value.trim();
  if (!name) { toast("Give the group a name"); return; }
  if (groupSelectedUsers.length === 0) { toast("Add at least one member"); return; }

  const { data: group, error } = await supabase
    .from("groups").insert({ name, created_by: me.id })
    .select().single();
  if (error) { toast("Couldn't create group: " + error.message); return; }

  // Creator joins as admin; everyone selected joins as a regular member.
  const memberRows = [
    { group_id: group.id, user_id: me.id, is_admin: true },
    ...groupSelectedUsers.map(u => ({ group_id: group.id, user_id: u.id, is_admin: false }))
  ];
  const { error: memErr } = await supabase.from("group_members").insert(memberRows);
  if (memErr) { toast("Group created but couldn't add members: " + memErr.message); return; }

  closeModal("new-group-modal");
  await loadChatList();
  openChat(group.id, "group");
};

// ================================================================
//  HEADER CLICK / CHAT OPTIONS
// ================================================================
window.headerInfoClick = function() {
  if (activeType === "group") openGroupInfo();
};
window.openChatOptions = function() {
  if (activeType === "group") { openGroupInfo(); return; }
  // DM options: just offer to clear/delete the conversation for now.
  if (confirm("Delete this conversation? This removes it for both of you.")) {
    supabase.from("conversations").delete().eq("id", activeId).then(({ error }) => {
      if (error) { toast("Couldn't delete: " + error.message); return; }
      backToList();
      document.getElementById("chat-view").classList.remove("show");
      document.getElementById("input-area").classList.remove("show");
      document.getElementById("empty-state").style.display = "flex";
      activeId = null;
      loadChatList();
    });
  }
};

// ================================================================
//  GROUP INFO + ADMIN ACTIONS
// ================================================================
window.openGroupInfo = async function() {
  if (!activeConv || activeType !== "group") return;

  const { data: members } = await supabase.from("group_members").select("*, profiles(*)").eq("group_id", activeId);
  activeConv.members = members || [];
  const myMembership = activeConv.members.find(m => m.user_id === me.id);
  const iAmAdmin = !!myMembership?.is_admin;

  document.getElementById("gi-name").textContent = activeConv.name;

  const renameField = document.getElementById("gi-rename-field");
  const addField = document.getElementById("gi-add-field");
  renameField.style.display = iAmAdmin ? "block" : "none";
  addField.style.display = iAmAdmin ? "block" : "none";
  if (iAmAdmin) document.getElementById("gi-rename-input").value = activeConv.name;

  const membersDiv = document.getElementById("gi-members");
  membersDiv.innerHTML = "<div style='color:var(--muted-foreground);font-size:12px;margin-bottom:10px;'>Members</div>" +
    activeConv.members.map(m => {
      const u = m.profiles;
      const isMe = u.id === me.id;
      let controls = "";
      if (iAmAdmin && !isMe) {
        const promoteBtn = !m.is_admin
          ? `<button class="gi-action-btn" title="Make admin" onclick="promoteAdmin('${u.id}')">⬆</button>`
          : `<button class="gi-action-btn" title="Remove admin" onclick="demoteAdmin('${u.id}')">⬇</button>`;
        const removeBtn = `<button class="gi-action-btn gi-action-danger" title="Remove" onclick="removeMember('${u.id}','${escAttr(u.name)}')">✕</button>`;
        controls = `<div style="display:flex;gap:6px;">${promoteBtn}${removeBtn}</div>`;
      }
      return `<div class="user-result">
        <div class="avatar">${avatarHtml(u.name, u.avatar_url)}</div>
        <div style="flex:1;">
          <div class="user-result-name">${escHtml(u.name)}${m.is_admin ? ' <span style="font-size:10px;color:var(--primary)">Admin</span>' : ''}</div>
          <div class="user-result-email">${escHtml(u.email)}</div>
        </div>
        ${controls}
      </div>`;
    }).join("");

  const adminDiv = document.getElementById("gi-admin-actions");
  adminDiv.innerHTML = activeConv.created_by === me.id
    ? `<button class="btn btn-danger" onclick="deleteGroup()">Delete group</button>`
    : `<button class="btn btn-danger" onclick="leaveGroup()">Leave group</button>`;

  openModal("group-info-modal");
};

window.renameGroup = async function() {
  const newName = document.getElementById("gi-rename-input").value.trim();
  if (!newName) { toast("Name can't be empty"); return; }
  const { error } = await supabase.from("groups").update({ name: newName }).eq("id", activeId);
  if (error) { toast("Couldn't rename: " + error.message); return; }
  activeConv.name = newName;
  document.getElementById("ch-name").textContent = newName;
  document.getElementById("gi-name").textContent = newName;
  toast("Group renamed");
};

let addMemberDebounce = null;
window.searchUsersForAdd = function(query) {
  clearTimeout(addMemberDebounce);
  addMemberDebounce = setTimeout(async () => {
    const q = query.trim();
    const resultsEl = document.getElementById("gi-add-results");
    if (!q) { resultsEl.innerHTML = ""; return; }
    const existingIds = activeConv.members.map(m => m.user_id);
    const { data } = await supabase.from("profiles").select("*").or(`name.ilike.%${q}%,email.ilike.%${q}%`).limit(15);
    const filtered = (data || []).filter(u => !existingIds.includes(u.id));
    resultsEl.innerHTML = filtered.map(u => `
      <div class="user-result" onclick="addGroupMember('${u.id}')">
        <div class="avatar">${avatarHtml(u.name, u.avatar_url)}</div>
        <div><div class="user-result-name">${escHtml(u.name)}</div><div class="user-result-email">${escHtml(u.email)}</div></div>
      </div>`).join("");
  }, 300);
};
window.addGroupMember = async function(userId) {
  const { error } = await supabase.from("group_members").insert({ group_id: activeId, user_id: userId, is_admin: false });
  if (error) { toast("Couldn't add member: " + error.message); return; }
  document.getElementById("gi-add-input").value = "";
  document.getElementById("gi-add-results").innerHTML = "";
  toast("Member added");
  openGroupInfo();
};

window.promoteAdmin = async function(userId) {
  const { error } = await supabase.from("group_members").update({ is_admin: true }).eq("group_id", activeId).eq("user_id", userId);
  if (error) { toast("Couldn't promote: " + error.message); return; }
  toast("Promoted to admin");
  openGroupInfo();
};
window.demoteAdmin = async function(userId) {
  if (userId === activeConv.created_by) { toast("Can't remove the creator's admin rights"); return; }
  const { error } = await supabase.from("group_members").update({ is_admin: false }).eq("group_id", activeId).eq("user_id", userId);
  if (error) { toast("Couldn't demote: " + error.message); return; }
  toast("Admin rights removed");
  openGroupInfo();
};
window.removeMember = async function(userId, name) {
  if (userId === activeConv.created_by) { toast("Can't remove the group creator"); return; }
  if (!confirm(`Remove ${name} from the group?`)) return;
  const { error } = await supabase.from("group_members").delete().eq("group_id", activeId).eq("user_id", userId);
  if (error) { toast("Couldn't remove: " + error.message); return; }
  toast(`${name} removed`);
  openGroupInfo();
};
window.leaveGroup = async function() {
  closeModal("group-info-modal");
  const { error } = await supabase.from("group_members").delete().eq("group_id", activeId).eq("user_id", me.id);
  if (error) { toast("Couldn't leave: " + error.message); return; }
  toast("Left group");
  backToList();
  document.getElementById("chat-view").classList.remove("show");
  document.getElementById("input-area").classList.remove("show");
  document.getElementById("empty-state").style.display = "flex";
  activeId = null;
  loadChatList();
};
window.deleteGroup = async function() {
  closeModal("group-info-modal");
  if (!confirm("Delete this group for everyone? This can't be undone.")) return;
  const { error } = await supabase.from("groups").delete().eq("id", activeId);
  if (error) { toast("Couldn't delete: " + error.message); return; }
  toast("Group deleted");
  backToList();
  document.getElementById("chat-view").classList.remove("show");
  document.getElementById("input-area").classList.remove("show");
  document.getElementById("empty-state").style.display = "flex";
  activeId = null;
  loadChatList();
};








