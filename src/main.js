import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const PAGE_SIZE = 50;
const SYNC_INTERVAL_MS = 45000;
const RESYNC_COOLDOWN_MS = 5 * 60 * 1000;
const HOTKEY_COOLDOWN_MS = {
  compose: 350,
  composeMaximize: 200,
  refresh: 1800,
  settings: 1200,
  search: 250,
};

let currentMailbox = "INBOX";
let currentEmails = [];
let selectedEmail = null;
let currentPage = 1;
let activeFilter = "Important";
let searchQuery = "";
let syncTimer = null;
let knownInboxIds = new Set();
let lastSynced = new Map();
let lastHotkeyAt = new Map();
let mailboxNextPageToken = new Map();
let isFetchingMore = false;
let isDeepSearchActive = false;
let isReadingPaneHidden = false;
let appHeaderControlsBound = false;
let composeAttachments = [];
let composeSendMode = "plain";
let composeDraftId = null;
let composeRecipientUiBound = false;

const CONTACTS_STORAGE_KEY = "verdant.contacts";
const MAX_CONTACTS = 1200;
let contactsByEmail = loadContacts();
const composeRecipients = { to: [], cc: [] };
const recipientSuggestState = {
  to: { items: [], activeIndex: -1 },
  cc: { items: [], activeIndex: -1 },
};

const defaultHotkeys = {
  enabled: true,
  compose: "ctrl+n",
  composeMaximize: "h",
  refresh: "ctrl+r",
  settings: "ctrl+,",
  search: "ctrl+k",
  close: "escape",
};

let hotkeys = loadHotkeys();

function loadHotkeys() {
  try {
    const raw = localStorage.getItem("verdant.hotkeys");
    return raw ? { ...defaultHotkeys, ...JSON.parse(raw) } : { ...defaultHotkeys };
  } catch {
    return { ...defaultHotkeys };
  }
}

function saveHotkeys(next) {
  localStorage.setItem("verdant.hotkeys", JSON.stringify(next));
}

function normalizeCombo(input) {
  return (input || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace("control", "ctrl");
}

function eventCombo(event) {
  if (event.key === "Escape") return "escape";
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  const parts = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

function escapeHtml(input) {
  if (!input) return "";
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeUnicodeNoise(input) {
  if (!input) return "";
  return input
    .replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractSenderAddress(sender) {
  const clean = sanitizeUnicodeNoise(sender || "");
  const bracketMatch = clean.match(/<([^>]+)>/);
  let email = (bracketMatch ? bracketMatch[1] : clean).trim().toLowerCase();
  if (!email.includes("@")) {
    const token = email.split(/[\s,;]+/).find((part) => part.includes("@"));
    email = token ? token.trim().toLowerCase() : "";
  }
  return email;
}

function senderInitials(sender) {
  const raw = sanitizeUnicodeNoise(sender || "?").replace(/<.*?>/g, "").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length) {
    return parts.slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";
  }
  const addr = extractSenderAddress(raw);
  if (!addr) return "?";
  return (addr[0] || "?").toUpperCase();
}

function normalizeEmailAddress(input) {
  const value = sanitizeUnicodeNoise(input || "").toLowerCase();
  const match = value.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : "";
}

function parseContactToken(rawToken) {
  const clean = sanitizeUnicodeNoise(rawToken || "");
  if (!clean) return null;

  const email = normalizeEmailAddress(clean);
  if (!email) return null;

  const bracketName = clean.replace(/<[^>]+>/g, "").replace(/[\"']/g, "").trim();
  const bareName = clean.replace(email, "").replace(/[<>\"']/g, "").trim();
  const name = sanitizeUnicodeNoise(bracketName || bareName || "");
  return { email, name };
}

function parseContactsFromHeader(headerValue) {
  const value = String(headerValue || "");
  if (!value.trim()) return [];

  return value
    .split(/[,;\n]+/)
    .map((token) => parseContactToken(token))
    .filter(Boolean);
}

function loadContacts() {
  try {
    const raw = localStorage.getItem(CONTACTS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();

    const map = new Map();
    for (const item of parsed) {
      const email = normalizeEmailAddress(item?.email || "");
      if (!email) continue;
      map.set(email, {
        email,
        name: sanitizeUnicodeNoise(item?.name || ""),
        updatedAt: Number(item?.updatedAt || 0) || Date.now(),
      });
      if (map.size >= MAX_CONTACTS) break;
    }
    return map;
  } catch {
    return new Map();
  }
}

function persistContacts() {
  try {
    const list = Array.from(contactsByEmail.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, MAX_CONTACTS);
    localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Ignore storage write failures.
  }
}

function upsertContact(rawEmail, rawName = "") {
  const email = normalizeEmailAddress(rawEmail);
  if (!email) return;

  const existing = contactsByEmail.get(email);
  const incomingName = sanitizeUnicodeNoise(rawName || "");
  const next = {
    email,
    name: incomingName || existing?.name || "",
    updatedAt: Date.now(),
  };

  contactsByEmail.set(email, next);

  if (contactsByEmail.size > MAX_CONTACTS) {
    const overflow = Array.from(contactsByEmail.values())
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    const removeCount = contactsByEmail.size - MAX_CONTACTS;
    overflow.slice(0, removeCount).forEach((item) => contactsByEmail.delete(item.email));
  }

  persistContacts();
}

function extractContactsFromEmailRecord(email) {
  const contacts = [];
  contacts.push(...parseContactsFromHeader(email?.sender || ""));
  contacts.push(...parseContactsFromHeader(email?.to_recipients || ""));
  contacts.push(...parseContactsFromHeader(email?.cc_recipients || ""));
  return contacts;
}

function ingestContactsFromEmails(emails) {
  for (const email of emails || []) {
    const contacts = extractContactsFromEmailRecord(email);
    contacts.forEach((contact) => upsertContact(contact.email, contact.name));
  }
}

function senderAvatarUrls(sender, mailbox = "") {
  if ((mailbox || "").toUpperCase() === "SENT") return [];
  const email = extractSenderAddress(sender);
  if (!email || !email.includes("@")) return [];
  const domain = email.split("@")[1];
  if (!domain || domain === "localhost") return [];

  return [
    `https://logo.clearbit.com/${encodeURIComponent(domain)}`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
  ];
}

function applySenderAvatar(container, sender, mailbox = "") {
  if (!container) return;
  container.classList.remove("has-image");
  container.innerHTML = "";
  container.textContent = senderInitials(sender);

  const urls = senderAvatarUrls(sender, mailbox);
  if (!urls.length) return;

  const img = document.createElement("img");
  img.alt = "Sender icon";
  let idx = 0;

  img.onload = () => {
    container.classList.add("has-image");
    container.textContent = "";
    container.innerHTML = "";
    container.appendChild(img);
  };

  img.onerror = () => {
    idx += 1;
    if (idx < urls.length) {
      img.src = urls[idx];
    }
  };

  img.src = urls[idx];
}

function formatListDate(raw) {
  const cleanedRaw = stripMailTimezone(raw);
  const d = new Date(cleanedRaw);
  if (Number.isNaN(d.getTime())) return cleanedRaw;

  const now = new Date();
  const dayNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMail = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((dayNow - dayMail) / 86400000);

  if (diff === 0) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diff === 1) {
    return "Yesterday";
  }
  return d.toLocaleDateString();
}

function stripMailTimezone(raw) {
  return String(raw || "")
    .replace(/\s(?:GMT|UTC)?[+-]\d{4}\b/gi, "")
    .replace(/\s+\((?:GMT|UTC)[^)]*\)/gi, "")
    .trim();
}

function formatReadingDate(raw) {
  const cleanedRaw = stripMailTimezone(raw);
  const d = new Date(cleanedRaw);
  if (Number.isNaN(d.getTime())) return cleanedRaw;

  const now = new Date();
  const sameYear = now.getFullYear() === d.getFullYear();
  return d.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function mailboxTitle(mailbox) {
  switch (mailbox) {
    case "INBOX": return "Inbox";
    case "STARRED": return "Starred";
    case "ARCHIVE": return "Archive";
    case "SENT": return "Sent";
    case "DRAFT": return "Drafts";
    default: return "Mailbox";
  }
}

function isSettingsOpen() {
  return !!document.getElementById("verdant-overlay");
}

function isComposeOpen() {
  return document.getElementById("composeModal")?.classList.contains("open");
}

function ensureStyles() {
  if (document.getElementById("verdant-dynamic-styles")) return;
  const style = document.createElement("style");
  style.id = "verdant-dynamic-styles";
  style.textContent = `
    .verdant-overlay { position: fixed; inset: 0; z-index: 2100; background: rgba(31,28,24,.42); backdrop-filter: blur(2px); display:flex; align-items:center; justify-content:center; opacity: 0; pointer-events: none; transition: opacity .18s ease; }
    .verdant-overlay.open { opacity: 1; pointer-events: auto; }
    .verdant-panel { width:min(640px, 94vw); max-height: 86vh; overflow:auto; background: var(--surface); border:1px solid var(--border); border-radius:14px; box-shadow: 0 22px 52px rgba(37,35,31,.18); padding: 20px; transform: translateY(12px) scale(.98); transition: transform .18s ease; }
    .verdant-overlay.open .verdant-panel { transform: translateY(0) scale(1); }
    .verdant-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .verdant-head h2 { font: 500 24px 'Fraunces', serif; color: var(--text); }
    .verdant-close { border:1px solid var(--border); background: var(--surface2); border-radius:8px; width:30px; height:30px; cursor:pointer; color:var(--text); }
    .verdant-panel p { font: 400 13px 'DM Sans', sans-serif; color: var(--text-mid); line-height:1.5; margin-bottom:12px; }
    .verdant-actions { display:flex; gap:10px; justify-content:flex-end; }
    .verdant-btn { padding:8px 14px; border-radius:8px; border:1px solid var(--border); background: var(--surface2); color: var(--text); font: 500 12px 'DM Sans', sans-serif; cursor:pointer; }
    .verdant-btn.primary { background: var(--green); color:#fff; border-color: var(--green); }
    .email-item-main { display:flex; align-items:flex-start; gap:10px; width:100%; }
    .email-item { position:relative; }
    .email-item-inner { position:relative; padding-right:76px; flex:1; min-width:0; }
    .email-top { display:block; min-height:16px; margin-bottom:3px; }
    .email-sender { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; -webkit-mask-image: linear-gradient(to right, #000 0%, #000 78%, transparent 100%); mask-image: linear-gradient(to right, #000 0%, #000 78%, transparent 100%); }
    .email-time { position:absolute; right:18px; top:13px; width:72px; text-align:right; white-space:nowrap; font-variant-numeric: tabular-nums; letter-spacing:.01em; z-index:2; }
    .sender-avatar { width:30px; height:30px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center; font:600 11px 'DM Sans', sans-serif; color:#fff; background: linear-gradient(135deg, var(--green-mid), var(--green-light)); overflow:hidden; }
    .sender-avatar img, .meta-avatar img { width:100%; height:100%; object-fit:cover; display:block; }
    .sender-avatar.has-image, .meta-avatar.has-image { background: var(--surface2); color: transparent; }
    .email-body-text pre { white-space: pre-wrap; word-break: break-word; background: var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }

    .action-menu { position:absolute; right:0; top:34px; width:190px; background: var(--surface); border:1px solid var(--border); border-radius:10px; box-shadow:0 12px 26px rgba(0,0,0,.12); padding:6px; z-index:1300; }
    .action-menu button { width:100%; text-align:left; border:0; background:transparent; color:var(--text); padding:8px 10px; border-radius:8px; font:400 12px 'DM Sans', sans-serif; cursor:pointer; }
    .action-menu button:hover { background: var(--surface2); }
    .settings-grid { display:grid; gap:10px; margin-top:12px; }
    .settings-row { display:grid; grid-template-columns: 1fr 160px; align-items:center; gap:10px; }
    .settings-row input { height:34px; border-radius:8px; border:1px solid var(--border); background: var(--bg); padding:0 10px; font:400 12px 'DM Sans', sans-serif; }
    .settings-switch { display:flex; align-items:center; gap:8px; font:400 12px 'DM Sans', sans-serif; color:var(--text); }
    .settings-tabs { display:flex; gap:8px; margin-top:10px; border-bottom:1px solid var(--border); padding-bottom:10px; }
    .settings-tab { border:1px solid var(--border); background: var(--surface2); color:var(--text-mid); border-radius:999px; padding:6px 12px; font:500 12px 'DM Sans', sans-serif; cursor:pointer; }
    .settings-tab.active { background: var(--green-pale); border-color: var(--green-muted); color: var(--green); }
    .settings-pane { display:none; margin-top:12px; }
    .settings-pane.active { display:grid; gap:10px; }
    .settings-card { border:1px solid var(--border); border-radius:10px; background: var(--bg); padding:12px; display:grid; gap:8px; }
    .settings-info-row { display:flex; justify-content:space-between; gap:12px; font:400 12px 'DM Sans', sans-serif; color:var(--text-mid); }
    .settings-info-row strong { color: var(--text); font-weight:500; }
    .settings-help { font:400 12px/1.5 'DM Sans', sans-serif; color:var(--text-mid); margin-top:2px; }
    .settings-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; }
    .settings-danger { color:#8a3b3b; border-color:#dcb9b9; }
    .toast-wrap { position: fixed; top:12px; left:50%; transform: translateX(-50%); z-index:2400; display:grid; gap:8px; }
    .toast { min-width:220px; max-width:520px; padding:10px 14px; border-radius:10px; border:1px solid var(--border); background: var(--surface); color: var(--text); font:500 12px 'DM Sans', sans-serif; box-shadow:0 10px 28px rgba(0,0,0,.12); animation: toast-in .22s ease forwards; }
    .toast.info { border-color: var(--green-muted); }
    .toast.error { border-color: #c08d8d; color: #7a2d2d; }
    @keyframes toast-in { from { opacity:0; transform: translateY(-14px);} to { opacity:1; transform: translateY(0);} }
    .suppress-anim .email-item { animation:none !important; }
    .pager { display:flex; gap:6px; justify-content:center; padding:10px 12px 14px; border-top:1px solid var(--border); background: var(--surface); }
    .pager button { border:1px solid var(--border); background: var(--surface2); color: var(--text); border-radius:8px; padding:6px 10px; cursor:pointer; font:500 12px 'DM Sans', sans-serif; }
    .pager button.active { background: var(--green); color:#fff; border-color: var(--green); }
    .list-fetch-indicator { padding:10px 14px; text-align:center; color:var(--text-muted); font:500 12px 'DM Sans', sans-serif; border-top:1px dashed var(--border); }
    .search-bar { position: relative; }
    .search-bar.has-deep-btn { padding-right: 106px; }
    .deep-search-btn { position:absolute; right:6px; top:50%; transform:translateY(-50%); height:24px; display:inline-flex; align-items:center; border:1px solid var(--green-muted); background: var(--green-pale); color: var(--green); border-radius:999px; padding:0 10px; font:500 11px 'DM Sans', sans-serif; cursor:pointer; white-space:nowrap; }
    .deep-search-btn:disabled { opacity:.6; cursor:default; }
    .email-attachments { border:1px solid var(--border); border-radius:10px; background: var(--surface); padding:10px; margin-bottom:12px; }
    .email-attachments-title { font:600 12px 'DM Sans', sans-serif; color:var(--text-mid); margin-bottom:8px; }
    .email-attachment-list { display:grid; gap:6px; }
    .email-attachment-item { display:flex; align-items:center; justify-content:space-between; gap:10px; border:1px solid var(--border); background: var(--white); border-radius:8px; padding:8px 10px; }
    .email-attachment-meta { min-width:0; display:grid; gap:2px; }
    .email-attachment-name { font:500 12px 'DM Sans', sans-serif; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .email-attachment-sub { font:400 11px 'DM Sans', sans-serif; color:var(--text-muted); }
    .email-attachment-download { border:1px solid var(--border); background: var(--surface2); color: var(--text); border-radius:8px; padding:5px 9px; font:500 11px 'DM Sans', sans-serif; cursor:pointer; }
    .attachment-download-modal { position: fixed; inset: 0; z-index: 2500; background: rgba(31,28,24,.18); pointer-events:none; }
    .attachment-download-card { position:absolute; right:14px; top:14px; width:min(340px, calc(100vw - 28px)); background: var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px; box-shadow: 0 16px 34px rgba(37,35,31,.2); display:flex; align-items:center; gap:10px; transform: translateX(120%); opacity:0; transition: transform .24s ease, opacity .24s ease; }
    .attachment-download-modal.open .attachment-download-card { transform: translateX(0); opacity:1; }
    .attachment-download-icon { width:16px; height:16px; display:flex; align-items:center; justify-content:center; flex-shrink:0; color: var(--green); }
    .attachment-download-icon.is-spinning { border:2px solid var(--green-muted); border-top-color: var(--green); border-radius:50%; animation: verdant-spin .8s linear infinite; }
    .attachment-download-icon.is-success { border:0; animation:none; }
    .attachment-download-icon.is-success svg { width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; }
    .attachment-download-text { font:500 12px 'DM Sans', sans-serif; color: var(--text); }
    @keyframes verdant-spin { to { transform: rotate(360deg); } }
    body.reading-pane-hidden .reading-pane { display: none !important; }
    body.reading-pane-hidden .pane-resizer { display: none !important; }
    body.reading-pane-hidden .email-list-pane { flex:1 1 auto !important; width:auto !important; min-width:0 !important; max-width:none !important; border-right:0 !important; }
    .icon-btn.active { background: var(--green-pale); color: var(--green); border:1px solid var(--green-muted); }
    .icon-btn.danger:hover { background:#f5dede !important; color:#8a2e2e !important; border:1px solid #d79f9f; }
    .compose-maximized { width:min(1100px, 96vw) !important; height:min(90vh, 920px) !important; }
    .compose-maximized .modal-body { height: calc(100% - 190px); }
    #compose-max-btn { display:flex; align-items:center; justify-content:center; }
    #compose-max-btn svg { width:16px; height:16px; }
  `;
  document.head.appendChild(style);
}

function ensureToastWrap() {
  let wrap = document.getElementById("verdant-toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "verdant-toast-wrap";
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  return wrap;
}

function showToast(message, type = "info", timeout = 2200) {
  const wrap = ensureToastWrap();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  wrap.appendChild(toast);
  setTimeout(() => toast.remove(), timeout);
}

function canRunHotkey(action) {
  const cooldown = HOTKEY_COOLDOWN_MS[action] || 0;
  if (cooldown <= 0) return true;

  const now = Date.now();
  const last = lastHotkeyAt.get(action) || 0;
  if (now - last < cooldown) return false;

  lastHotkeyAt.set(action, now);
  return true;
}

function showOverlay(title, message, buttons) {
  ensureStyles();
  closeOverlay(true);
  const overlay = document.createElement("div");
  overlay.id = "verdant-overlay";
  overlay.className = "verdant-overlay";
  overlay.innerHTML = `
    <div class="verdant-panel">
      <div class="verdant-head">
        <h2>${escapeHtml(title)}</h2>
        <button class="verdant-close" aria-label="Close">x</button>
      </div>
      <p>${escapeHtml(message)}</p>
      <div class="verdant-actions"></div>
    </div>
  `;

  overlay.querySelector(".verdant-close")?.addEventListener("click", () => closeOverlay());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeOverlay();
    }
  });
  const actions = overlay.querySelector(".verdant-actions");
  for (const btn of buttons) {
    const el = document.createElement("button");
    el.className = `verdant-btn ${btn.primary ? "primary" : ""}`;
    el.textContent = btn.label;
    el.onclick = btn.onClick;
    actions.appendChild(el);
  }

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("open"));
  refreshAppHeaderSubtitle();
}

function closeOverlay(immediate = false) {
  const overlay = document.getElementById("verdant-overlay");
  if (!overlay) return;
  if (immediate) {
    overlay.remove();
    refreshAppHeaderSubtitle();
    return;
  }
  overlay.classList.remove("open");
  setTimeout(() => {
    overlay.remove();
    refreshAppHeaderSubtitle();
  }, 180);
}

function clearMockImmediately() {
  const list = document.querySelector(".email-list");
  if (list) list.innerHTML = "";
}

function setListTitle(mailbox, count) {
  const title = document.querySelector(".list-title");
  const countEl = document.querySelector(".list-count");
  if (title) title.textContent = mailboxTitle(mailbox);
  if (countEl) countEl.textContent = `${count} messages`;
}

function setAppHeaderSubtitle(label) {
  const subtitle = document.querySelector(".app-subtitle");
  if (!subtitle) return;
  const clean = (label || "Mailbox").trim();
  subtitle.textContent = `- ${clean}`;
}

function resolveAppHeaderSubtitle() {
  if (isComposeOpen()) return "Compose";

  const overlay = document.getElementById("verdant-overlay");
  if (overlay) {
    const heading = overlay.querySelector(".verdant-head h2")?.textContent?.trim();
    if (heading) return heading;
  }

  return mailboxTitle(currentMailbox);
}

function refreshAppHeaderSubtitle() {
  setAppHeaderSubtitle(resolveAppHeaderSubtitle());
}

function setReadingPaneHidden(hidden) {
  isReadingPaneHidden = !!hidden;
  document.body.classList.toggle("reading-pane-hidden", isReadingPaneHidden);
}

function isImportant(email) {
  const labels = (email.labels || "").split(",");
  return !labels.includes("CATEGORY_PROMOTIONS") && !labels.includes("SPAM");
}

function emailMatchesFilter(email) {
  if (activeFilter === "Important" && !isImportant(email)) return false;
  if (activeFilter === "Attachments" && !hasEmailAttachments(email)) return false;

  if (searchQuery) {
    const hay = `${email.subject || ""} ${email.sender || ""} ${email.snippet || ""}`.toLowerCase();
    if (!hay.includes(searchQuery.toLowerCase())) return false;
  }

  return true;
}

function parseEmailAttachments(email) {
  if (!email?.attachments_json) return [];
  try {
    const parsed = JSON.parse(email.attachments_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasEmailAttachments(email) {
  const raw = email?.has_attachments;
  if (raw === true || raw === 1 || raw === "1") return true;
  if (typeof raw === "string" && raw.toLowerCase() === "true") return true;
  return parseEmailAttachments(email).length > 0;
}

function visibleEmails() {
  return (currentEmails || []).filter(emailMatchesFilter);
}

function pagedEmails() {
  return visibleEmails();
}

function updateTopActionStates() {
  const buttons = Array.from(document.querySelectorAll(".reading-actions .icon-btn"));
  buttons.forEach((btn) => {
    const title = btn.getAttribute("title") || "";
    if (title === "Star") btn.classList.toggle("active", !!selectedEmail?.starred);
    if (title === "Delete") btn.classList.add("danger");
    if (title === "Label") btn.style.display = "none";
  });
}

function renderRecipientsLine(email) {
  const metaTo = document.querySelector(".meta-to");
  if (!metaTo) return;

  const toList = sanitizeUnicodeNoise(email.to_recipients || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const ccList = sanitizeUnicodeNoise(email.cc_recipients || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const merged = [...toList, ...ccList];
  const mailbox = (email.mailbox || "").toUpperCase();
  let collapsed = mailbox === "SENT" ? "recipients loading..." : "to me";
  if (merged.length === 1) collapsed = `to ${merged[0]}`;
  if (merged.length > 1) collapsed = `to ${merged[0]}, +${merged.length - 1} others`;

  metaTo.textContent = collapsed;
  metaTo.style.cursor = "pointer";
  metaTo.title = "Click to expand recipients";

  metaTo.onclick = () => {
    const expanded = [
      toList.length ? `To: ${toList.join(", ")}` : "",
      ccList.length ? `Cc: ${ccList.join(", ")}` : "",
    ].filter(Boolean).join(" | ");

    metaTo.textContent = metaTo.textContent === collapsed ? expanded || collapsed : collapsed;
  };
}

function renderReadingPane(email) {
  const subject = document.querySelector(".reading-subject");
  const from = document.querySelector(".meta-from");
  const date = document.querySelector(".meta-date");
  const body = document.querySelector(".email-body-text");
  const avatar = document.querySelector(".meta-avatar");

  if (subject) subject.textContent = sanitizeUnicodeNoise(email.subject || "(No Subject)");
  if (from) from.textContent = sanitizeUnicodeNoise(email.sender || "Unknown Sender");
  if (date) date.textContent = formatReadingDate(email.date || "");
  if (body) {
    const html = sanitizeUnicodeNoise(email.body_html || "");
    body.innerHTML = html || `<pre>${escapeHtml(sanitizeUnicodeNoise(email.snippet || ""))}</pre>`;
  }

  renderReadingAttachments(email);

  if (avatar) {
    applySenderAvatar(avatar, email.sender || "", email.mailbox || "");
  }

  renderRecipientsLine(email);
  updateTopActionStates();
}

function formatAttachmentSize(size) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return "Unknown size";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function showAttachmentDownloadModal(filename) {
  const existing = document.getElementById("attachment-download-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "attachment-download-modal";
  modal.className = "attachment-download-modal";
  modal.innerHTML = `
    <div class="attachment-download-card" role="dialog" aria-live="polite" aria-label="Downloading attachment">
      <div class="attachment-download-icon is-spinning"></div>
      <div class="attachment-download-text">Downloading ${escapeHtml(filename || "attachment")}...</div>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add("open"));
}

async function showAttachmentDownloadSuccess(filename) {
  const modal = document.getElementById("attachment-download-modal");
  if (!modal) return;

  const icon = modal.querySelector(".attachment-download-icon");
  const text = modal.querySelector(".attachment-download-text");

  if (icon) {
    icon.classList.remove("is-spinning");
    icon.classList.add("is-success");
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7L10 17l-5-5"/></svg>`;
  }

  if (text) {
    text.textContent = `Downloaded ${filename || "attachment"}`;
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
}

function hideAttachmentDownloadModal() {
  const modal = document.getElementById("attachment-download-modal");
  if (!modal) return;
  modal.classList.remove("open");
  setTimeout(() => modal.remove(), 240);
}

async function handleAttachmentDownload(emailId, attachment) {
  if (!emailId || !attachment?.attachment_id) {
    showToast("Attachment is unavailable", "error", 2400);
    return;
  }

  showAttachmentDownloadModal(attachment.filename || "attachment");
  try {
    const response = await invoke("download_attachment", {
      emailId,
      attachmentId: attachment.attachment_id,
      filename: attachment.filename || "attachment",
      contentType: attachment.mime_type || "application/octet-stream",
    });

    const bytes = base64ToBytes(response.data_base64 || "");
    const blob = new Blob([bytes], { type: response.content_type || attachment.mime_type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = response.filename || attachment.filename || "attachment";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    await showAttachmentDownloadSuccess(response.filename || attachment.filename || "attachment");
  } finally {
    hideAttachmentDownloadModal();
  }
}

function renderReadingAttachments(email) {
  const readingBody = document.querySelector(".reading-body");
  if (!readingBody) return;

  readingBody.querySelector(".email-attachments")?.remove();

  const attachments = parseEmailAttachments(email).filter((a) => a && a.attachment_id);
  if (!attachments.length) return;

  const section = document.createElement("section");
  section.className = "email-attachments";
  section.innerHTML = `
    <div class="email-attachments-title">Attachments (${attachments.length})</div>
    <div class="email-attachment-list">
      ${attachments.map((attachment, index) => `
        <div class="email-attachment-item">
          <div class="email-attachment-meta">
            <div class="email-attachment-name" title="${escapeHtml(attachment.filename || "attachment")}">${escapeHtml(attachment.filename || "attachment")}</div>
            <div class="email-attachment-sub">${escapeHtml(attachment.mime_type || "file")} • ${escapeHtml(formatAttachmentSize(attachment.size))}</div>
          </div>
          <button class="email-attachment-download" data-attachment-index="${index}">Download</button>
        </div>
      `).join("")}
    </div>
  `;

  const bodyText = readingBody.querySelector(".email-body-text");
  if (bodyText) {
    readingBody.insertBefore(section, bodyText);
  } else {
    readingBody.appendChild(section);
  }

  section.querySelectorAll(".email-attachment-download").forEach((button) => {
    button.addEventListener("click", async () => {
      const index = Number(button.getAttribute("data-attachment-index"));
      const attachment = attachments[index];
      if (!attachment) return;

      button.disabled = true;
      const prev = button.textContent;
      button.textContent = "Downloading...";
      try {
        await handleAttachmentDownload(email.id, attachment);
      } catch (error) {
        console.error("Attachment download failed", error);
        showToast("Could not download attachment", "error", 2600);
      } finally {
        button.disabled = false;
        button.textContent = prev;
      }
    });
  });
}

async function markSelectedAsReadIfNeeded() {
  if (!selectedEmail || selectedEmail.is_read) return;
  selectedEmail.is_read = true;
  await invoke("set_email_read_status", { emailId: selectedEmail.id, isRead: true });
  await refreshCounts();
}

async function selectEmail(email, row) {
  setReadingPaneHidden(false);
  selectedEmail = email;
  document.querySelectorAll(".email-item").forEach((el) => el.classList.remove("active"));
  row.classList.add("active");
  row.classList.remove("unread");
  row.querySelector(".unread-dot")?.remove();
  renderReadingPane(email);
  await markSelectedAsReadIfNeeded();
}

function renderPager() {
  const pane = document.querySelector(".email-list-pane");
  if (!pane) return;
  pane.querySelector(".pager")?.remove();
}

function setListFetchIndicator(text = "") {
  const pane = document.querySelector(".email-list-pane");
  if (!pane) return;
  pane.querySelector(".list-fetch-indicator")?.remove();
  if (!text) return;
  const el = document.createElement("div");
  el.className = "list-fetch-indicator";
  el.textContent = text;
  pane.appendChild(el);
}

async function fetchMoreCurrentMailbox() {
  if (isFetchingMore || isDeepSearchActive) return;
  if (searchQuery.trim()) return;

  const token = mailboxNextPageToken.get(currentMailbox);
  if (!token) return;

  isFetchingMore = true;
  setListFetchIndicator("Loading more emails...");
  try {
    const next = await invoke("sync_mailbox_page", { mailbox: currentMailbox, pageToken: token });
    mailboxNextPageToken.set(currentMailbox, next || null);
    currentEmails = await invoke("get_emails", { mailbox: currentMailbox });
    renderEmailList(false);
    if (!next) {
      setListFetchIndicator("No more emails");
      setTimeout(() => setListFetchIndicator(""), 1000);
    }
  } catch (error) {
    console.error("Failed to fetch more emails", error);
    setListFetchIndicator("");
  } finally {
    isFetchingMore = false;
    if (mailboxNextPageToken.get(currentMailbox)) {
      setListFetchIndicator("");
    }
  }
}

function bindInfiniteScroll() {
  const list = document.querySelector(".email-list");
  if (!list) return;
  list.addEventListener("scroll", () => {
    const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (remaining < 80) {
      fetchMoreCurrentMailbox().catch(console.error);
    }
  });
}

function bindPaneResizer() {
  const pane = document.querySelector(".email-list-pane");
  const resizer = document.getElementById("pane-resizer");
  if (!pane || !resizer) return;

  const STORAGE_KEY = "verdant.listPaneWidth";
  const minWidth = 260;
  const maxWidth = () => Math.min(window.innerWidth * 0.68, 760);

  const applyWidth = (width) => {
    const next = Math.max(minWidth, Math.min(Math.round(width), maxWidth()));
    pane.style.width = `${next}px`;
    pane.style.minWidth = `${next}px`;
    pane.style.flex = `0 0 ${next}px`;
    localStorage.setItem(STORAGE_KEY, String(next));
  };

  const saved = Number(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(saved) && saved > 0) {
    applyWidth(saved);
  }

  const onPointerDown = (event) => {
    if (window.innerWidth <= 980) return;
    event.preventDefault();
    document.body.classList.add("resizing");
    resizer.setPointerCapture?.(event.pointerId);

    const startX = event.clientX;
    const startWidth = pane.getBoundingClientRect().width;

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      const delta = moveEvent.clientX - startX;
      applyWidth(startWidth + delta);
    };

    const onUp = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  resizer.addEventListener("pointerdown", onPointerDown);

  window.addEventListener("resize", () => {
    const current = pane.getBoundingClientRect().width;
    if (current > maxWidth()) {
      applyWidth(current);
    }
  });
}

function renderEmailList(animate = false) {
  const list = document.querySelector(".email-list");
  if (!list) return;

  list.innerHTML = "";
  list.classList.toggle("suppress-anim", !animate);

  const totalFiltered = visibleEmails().length;
  const emails = pagedEmails();
  const selectedId = selectedEmail?.id || null;
  let selectedRow = null;
  let selectedRowEmail = null;
  setListTitle(currentMailbox, totalFiltered);

  for (const email of emails) {
    const row = document.createElement("div");
    row.className = `email-item ${email.is_read ? "" : "unread"}`.trim();
    row.innerHTML = `
      ${email.is_read ? "" : '<div class="unread-dot"></div>'}
      <div class="email-item-main">
        <div class="sender-avatar"></div>
        <div class="email-item-inner">
          <div class="email-top">
            <span class="email-sender">${escapeHtml(sanitizeUnicodeNoise(email.sender || "Unknown Sender"))}</span>
            <span class="email-time">${escapeHtml(formatListDate(email.date))}</span>
          </div>
          <div class="email-subject">${escapeHtml(sanitizeUnicodeNoise(email.subject || "(No Subject)"))}</div>
          <div class="email-preview">${escapeHtml(sanitizeUnicodeNoise(email.snippet || ""))}</div>
        </div>
      </div>
    `;

    applySenderAvatar(row.querySelector(".sender-avatar"), email.sender || "", email.mailbox || "");

    row.addEventListener("click", () => {
      selectEmail(email, row).catch(console.error);
    });

    if (selectedId && email.id === selectedId) {
      row.classList.add("active");
      selectedRow = row;
      selectedRowEmail = email;
    }

    list.appendChild(row);
  }

  if (selectedRow && selectedRowEmail) {
    selectedEmail = selectedRowEmail;
    renderReadingPane(selectedRowEmail);
  } else if (!selectedEmail && emails.length > 0 && !isReadingPaneHidden) {
    const first = list.querySelector(".email-item");
    if (first) selectEmail(emails[0], first).catch(console.error);
  }

  renderPager();
}

function navByLabel(label) {
  const items = Array.from(document.querySelectorAll(".sidebar .nav-item"));
  return items.find((n) => n.textContent.trim().toLowerCase().startsWith(label.toLowerCase()));
}

function setBadge(navItem, value) {
  if (!navItem) return;
  let badge = navItem.querySelector(".nav-badge");
  if (value <= 0) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "nav-badge";
    navItem.appendChild(badge);
  }
  badge.textContent = String(value);
}

async function refreshCounts() {
  const counts = await invoke("get_mailbox_counts");
  setBadge(navByLabel("Inbox"), counts.inbox_unread);
  setBadge(navByLabel("Drafts"), counts.drafts_total);
  setBadge(navByLabel("Starred"), counts.starred_total);
  setBadge(navByLabel("Sent"), counts.sent_total);
  setBadge(navByLabel("Archive"), counts.archive_total);
}

async function notifyNewEmails(nextInbox) {
  const nextIds = new Set((nextInbox || []).map((m) => m.id));
  const unseen = (nextInbox || []).filter((m) => !knownInboxIds.has(m.id) && !m.is_read);
  knownInboxIds = nextIds;

  if (!unseen.length) return;
  showToast(`New email: ${sanitizeUnicodeNoise(unseen[0].subject || "(No Subject)")}`);

  if (!("Notification" in window)) return;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission === "granted") {
    const first = unseen[0];
    new Notification("New email", {
      body: `${sanitizeUnicodeNoise(first.sender)} - ${sanitizeUnicodeNoise(first.subject)}`,
    });
  }
}

async function loadLocalMailbox(mailbox, animate = false) {
  const mailboxChanged = currentMailbox !== mailbox;
  if (mailboxChanged) {
    selectedEmail = null;
    isDeepSearchActive = false;
  }
  currentMailbox = mailbox;
  currentEmails = await invoke("get_emails", { mailbox });
  ingestContactsFromEmails(currentEmails);
  currentPage = 1;
  renderEmailList(animate);
  refreshAppHeaderSubtitle();
  await refreshCounts();
}

async function syncMailboxInBackground(mailbox, force = false) {
  const key = mailbox;
  const now = Date.now();
  const last = lastSynced.get(key) || 0;

  if (!force && now - last < RESYNC_COOLDOWN_MS) return;
  lastSynced.set(key, now);

  if (mailbox !== "STARRED" && mailbox !== "ARCHIVE") {
    showToast("Fetching mails...", "info", 1200);
    const next = await invoke("sync_mailbox_page", { mailbox, pageToken: null });
    mailboxNextPageToken.set(mailbox, next || null);
  }

  const latest = await invoke("get_emails", { mailbox });
  ingestContactsFromEmails(latest);
  if (mailbox === "INBOX") {
    await notifyNewEmails(latest);
  }

  if (currentMailbox === mailbox) {
    currentEmails = latest;
    renderEmailList(false);
    await refreshCounts();
  }
}

async function openMailbox(mailbox, animate = false) {
  await loadLocalMailbox(mailbox, animate);
  syncMailboxInBackground(mailbox).catch((err) => {
    console.error("Background sync failed:", err);
    showToast(String(err), "error", 2500);
  });
}

function bindMailboxNav() {
  const map = {
    Inbox: "INBOX",
    Starred: "STARRED",
    Archive: "ARCHIVE",
    Sent: "SENT",
    Drafts: "DRAFT",
  };

  // Remove labels section completely.
  const sectionLabels = Array.from(document.querySelectorAll(".section-label"));
  sectionLabels.forEach((el) => {
    if (el.textContent.trim() === "Labels") {
      el.style.display = "none";
      const divider = el.previousElementSibling;
      if (divider && divider.classList.contains("sidebar-divider")) divider.style.display = "none";
      let node = el.nextElementSibling;
      while (node && node.classList.contains("nav-item")) {
        node.style.display = "none";
        node = node.nextElementSibling;
      }
    }
  });

  // Replace Snoozed tab label with Archive.
  const snoozed = Array.from(document.querySelectorAll(".sidebar .nav-item")).find((n) => n.textContent.trim().startsWith("Snoozed"));
  if (snoozed) {
    const textNode = Array.from(snoozed.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);
    if (textNode) textNode.textContent = " Archive ";
  }

  const items = Array.from(document.querySelectorAll(".sidebar .nav-item"));
  for (const item of items) {
    const label = Object.keys(map).find((key) => item.textContent.trim().startsWith(key));
    if (!label) continue;

    item.onclick = async (ev) => {
      ev.preventDefault();
      items.forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
      searchQuery = "";
      const searchInput = document.querySelector(".search-bar input");
      if (searchInput) {
        searchInput.value = "";
        searchInput.dispatchEvent(new Event("input"));
      }
      await openMailbox(map[label], true);
    };
  }
}

function buildActionMenu(entries, anchor) {
  document.getElementById("action-menu")?.remove();
  const menu = document.createElement("div");
  menu.id = "action-menu";
  menu.className = "action-menu";

  entries.forEach((entry) => {
    const b = document.createElement("button");
    b.textContent = entry.label;
    b.onclick = async (e) => {
      e.stopPropagation();
      menu.remove();
      await entry.onClick();
      await refreshAfterAction();
    };
    menu.appendChild(b);
  });

  anchor.style.position = "relative";
  anchor.appendChild(menu);
  setTimeout(() => {
    document.addEventListener("click", () => menu.remove(), { once: true });
  }, 0);
}

async function refreshAfterAction() {
  await loadLocalMailbox(currentMailbox, false);
  syncMailboxInBackground(currentMailbox).catch(() => {});
}

function bindReadingActions() {
  const buttons = Array.from(document.querySelectorAll(".reading-actions .icon-btn"));
  for (const button of buttons) {
    const title = button.getAttribute("title") || "";

    button.onclick = async () => {
      if (!selectedEmail) return;

      if (title === "Archive") {
        await invoke("archive_email", { emailId: selectedEmail.id });
        showToast("Email archived");
        await refreshAfterAction();
        return;
      }

      if (title === "Delete") {
        await invoke("trash_email", { emailId: selectedEmail.id });
        showToast("Email moved to trash");
        await refreshAfterAction();
        return;
      }

      if (title === "Mark unread") {
        const nextRead = !selectedEmail.is_read;
        await invoke("set_email_read_status", { emailId: selectedEmail.id, isRead: nextRead });
        selectedEmail.is_read = nextRead;
        showToast(nextRead ? "Marked as read" : "Marked as unread");
        await refreshAfterAction();
        return;
      }

      if (title === "Star") {
        await invoke("toggle_starred", { emailId: selectedEmail.id });
        selectedEmail.starred = !selectedEmail.starred;
        showToast("Star status updated");
        updateTopActionStates();
        await refreshAfterAction();
        return;
      }

      if (title === "More") {
        const menuEntries = [
          { label: "Mark as Read", onClick: () => invoke("set_email_read_status", { emailId: selectedEmail.id, isRead: true }) },
          { label: "Mark as Unread", onClick: () => invoke("set_email_read_status", { emailId: selectedEmail.id, isRead: false }) },
          { label: "Toggle Star", onClick: () => invoke("toggle_starred", { emailId: selectedEmail.id }) },
        ];

        if (selectedEmail.mailbox === "DRAFT") {
          menuEntries.unshift(
            { label: "Edit Draft", onClick: async () => openComposeForDraft(selectedEmail) },
            {
              label: "Send Draft",
              onClick: async () => {
                const draftId = selectedEmail.draft_id;
                if (!draftId) {
                  showToast("No draft id found for this message", "error");
                  return;
                }
                await invoke("send_existing_draft", { draftId });
                showToast("Draft sent");
              },
            }
          );
        }

        buildActionMenu(menuEntries, button);
        return;
      }

      if (title === "Close pane") {
        selectedEmail = null;
        document.querySelectorAll(".email-item").forEach((el) => el.classList.remove("active"));
        setReadingPaneHidden(true);
      }
    };
  }

  updateTopActionStates();
}

function bindFilterChips() {
  const chips = Array.from(document.querySelectorAll(".filter-chips .chip"));
  const target = chips.find((c) => c.textContent.trim() === "Unread");
  if (target) target.textContent = "Important";

  chips.forEach((chip) => {
    chip.onclick = () => {
      chips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeFilter = chip.textContent.trim();
      currentPage = 1;
      renderEmailList(false);
    };
  });

  const importantChip = chips.find((c) => c.textContent.trim() === "Important");
  chips.forEach((c) => c.classList.remove("active"));
  importantChip?.classList.add("active");
  activeFilter = "Important";
}

function bindSearch() {
  const input = document.querySelector(".search-bar input");
  if (!input) return;

  const searchBar = input.closest(".search-bar");
  let deepBtn = document.getElementById("deep-search-btn");
  if (!deepBtn && searchBar) {
    deepBtn = document.createElement("button");
    deepBtn.id = "deep-search-btn";
    deepBtn.className = "deep-search-btn";
    deepBtn.textContent = "Deep Search";
    searchBar.appendChild(deepBtn);
  }

  if (searchBar) searchBar.classList.add("has-deep-btn");

  const updateDeepButtonVisibility = () => {
    if (!deepBtn) return;
    deepBtn.hidden = !searchQuery.trim();
  };

  deepBtn?.addEventListener("click", async () => {
    if (!searchQuery.trim()) return;
    deepBtn.disabled = true;
    deepBtn.textContent = "Searching...";
    try {
      const results = await invoke("deep_search_emails", { query: searchQuery.trim() });
      isDeepSearchActive = true;
      currentEmails = results || [];
      currentPage = 1;
      renderEmailList(false);
      setListTitle(currentMailbox, currentEmails.length);
    } catch (error) {
      showToast(String(error), "error", 2600);
    } finally {
      deepBtn.disabled = false;
      deepBtn.textContent = "Deep Search";
      updateDeepButtonVisibility();
    }
  });

  input.addEventListener("input", () => {
    searchQuery = input.value || "";
    if (!searchQuery.trim()) {
      isDeepSearchActive = false;
    }
    currentPage = 1;
    renderEmailList(false);
    updateDeepButtonVisibility();
  });

  updateDeepButtonVisibility();
}

async function openSettingsModal(profile) {
  let auth = { connected: true };
  let counts = {
    inbox_total: 0,
    inbox_unread: 0,
    starred_total: 0,
    sent_total: 0,
    drafts_total: 0,
    archive_total: 0,
  };

  try {
    [auth, counts] = await Promise.all([
      invoke("auth_status"),
      invoke("get_mailbox_counts"),
    ]);
  } catch (error) {
    console.warn("Failed to load extended settings details", error);
  }

  const lastInboxSync = lastSynced.get("INBOX")
    ? new Date(lastSynced.get("INBOX")).toLocaleString()
    : "Not synced in this session";

  showOverlay("Settings", `Signed in as ${profile.email}`, []);
  const panel = document.querySelector("#verdant-overlay .verdant-panel");
  if (!panel) return;

  const grid = document.createElement("div");
  grid.className = "settings-grid";
  grid.innerHTML = `
    <div class="settings-tabs">
      <button class="settings-tab active" data-tab="account">Account</button>
      <button class="settings-tab" data-tab="shortcuts">Shortcuts</button>
      <button class="settings-tab" data-tab="app">App</button>
    </div>

    <section class="settings-pane active" data-pane="account">
      <div class="settings-card">
        <div class="settings-info-row"><span>Name</span><strong>${escapeHtml(profile.name || "User")}</strong></div>
        <div class="settings-info-row"><span>Email</span><strong>${escapeHtml(profile.email || "-")}</strong></div>
        <div class="settings-info-row"><span>Initials</span><strong>${escapeHtml(profile.initials || "U")}</strong></div>
        <div class="settings-info-row"><span>Gmail Status</span><strong>${auth.connected ? "Connected" : "Disconnected"}</strong></div>
        <div class="settings-info-row"><span>Inbox</span><strong>${counts.inbox_unread} unread / ${counts.inbox_total} total</strong></div>
        <div class="settings-info-row"><span>Last Inbox Sync</span><strong>${escapeHtml(lastInboxSync)}</strong></div>
      </div>
      <div class="settings-actions">
        <button class="verdant-btn settings-danger" id="settings-logout">Logout</button>
      </div>
    </section>

    <section class="settings-pane" data-pane="shortcuts">
      <label class="settings-switch"><input type="checkbox" id="hk-enabled" ${hotkeys.enabled ? "checked" : ""}> Enable keyboard shortcuts</label>
      <div class="settings-row"><span>Compose</span><input id="hk-compose" value="${escapeHtml(hotkeys.compose)}" /></div>
      <div class="settings-row"><span>Compose Maximize</span><input id="hk-compose-maximize" value="${escapeHtml(hotkeys.composeMaximize)}" /></div>
      <div class="settings-row"><span>Refresh</span><input id="hk-refresh" value="${escapeHtml(hotkeys.refresh)}" /></div>
      <div class="settings-row"><span>Settings</span><input id="hk-settings" value="${escapeHtml(hotkeys.settings)}" /></div>
      <div class="settings-row"><span>Search</span><input id="hk-search" value="${escapeHtml(hotkeys.search)}" /></div>
      <div class="settings-actions">
        <button class="verdant-btn" id="settings-save">Save Shortcuts</button>
      </div>
    </section>

    <section class="settings-pane" data-pane="app">
      <div class="settings-card">
        <div class="settings-help">
          Verdant keeps a local mail cache database on your device to make loading and searching faster.
          Clearing the local DB only removes cached messages on this device. Your Gmail account and server-side messages are not deleted.
        </div>
      </div>
      <div class="settings-actions">
        <button class="verdant-btn" id="settings-sync">Sync Emails Now</button>
        <button class="verdant-btn" id="settings-clear">Clear Local DB</button>
      </div>
    </section>
  `;
  panel.appendChild(grid);

  const tabs = Array.from(panel.querySelectorAll(".settings-tab"));
  const panes = Array.from(panel.querySelectorAll(".settings-pane"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.getAttribute("data-tab");
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      panes.forEach((pane) => pane.classList.toggle("active", pane.getAttribute("data-pane") === target));
    });
  });

  panel.querySelector("#settings-save")?.addEventListener("click", () => {
    hotkeys = {
      enabled: !!panel.querySelector("#hk-enabled")?.checked,
      compose: normalizeCombo(panel.querySelector("#hk-compose")?.value || defaultHotkeys.compose),
      composeMaximize: normalizeCombo(panel.querySelector("#hk-compose-maximize")?.value || defaultHotkeys.composeMaximize),
      refresh: normalizeCombo(panel.querySelector("#hk-refresh")?.value || defaultHotkeys.refresh),
      settings: normalizeCombo(panel.querySelector("#hk-settings")?.value || defaultHotkeys.settings),
      search: normalizeCombo(panel.querySelector("#hk-search")?.value || defaultHotkeys.search),
      close: "escape",
    };
    saveHotkeys(hotkeys);
    showToast("Shortcuts saved");
  });

  panel.querySelector("#settings-sync")?.addEventListener("click", async () => {
    showToast("Fetching mails...");
    await syncMailboxInBackground(currentMailbox, true);
    await refreshCounts();
    showToast("Sync complete");
  });

  panel.querySelector("#settings-clear")?.addEventListener("click", async () => {
    await invoke("clear_local_data");
    await openMailbox(currentMailbox, false);
    showToast("Local database cleared");
    closeOverlay();
  });

  panel.querySelector("#settings-logout")?.addEventListener("click", async () => {
    await invoke("logout");
    closeOverlay();
    showOnboardingScreen("You were logged out.");
  });
}

async function bindUserProfileAndSettings() {
  const profile = await invoke("get_user_profile");
  const avatar = document.querySelector(".sidebar .avatar");
  const name = document.querySelector(".sidebar .user-name");
  const email = document.querySelector(".sidebar .user-email");
  const row = document.querySelector(".user-row");

  if (avatar) avatar.textContent = profile.initials;
  if (name) name.textContent = profile.name;
  if (email) email.textContent = profile.email;
  if (row) row.onclick = () => openSettingsModal(profile).catch(console.error);
}

function showOnboardingScreen(message = "Connect your Gmail account to continue.") {
  clearMockImmediately();
  showOverlay("Connect Your Gmail Account", message, [
    {
      label: "Connect Gmail",
      primary: true,
      onClick: async () => {
        try {
          showToast("Starting Gmail connection...");
          await invoke("connect_gmail");
          closeOverlay();
          await initializeConnectedUI();
        } catch (error) {
          showOnboardingScreen(String(error));
        }
      },
    },
  ]);
}

function startPeriodicSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    syncMailboxInBackground("INBOX").catch((e) => console.error("Periodic sync failed", e));
  }, SYNC_INTERVAL_MS);
}

function bindComposeWindowControls() {
  const maxBtn = document.getElementById("compose-max-btn");
  const modal = document.getElementById("composeModal");
  if (!maxBtn || !modal) return;

  const toggleComposeMaximized = () => {
    const dialog = modal.querySelector(".compose-modal");
    if (!dialog) return;
    dialog.classList.toggle("compose-maximized");
  };

  maxBtn.onclick = toggleComposeMaximized;
  window.toggleComposeMaximized = toggleComposeMaximized;
}

function bindAppHeaderControls() {
  if (appHeaderControlsBound) return;
  const minBtn = document.getElementById("app-min-btn");
  const maxBtn = document.getElementById("app-max-btn");
  const closeBtn = document.getElementById("app-close-btn");
  const header = document.querySelector(".app-header");
  if (!minBtn || !maxBtn || !closeBtn || !header) return;
  appHeaderControlsBound = true;

  let appWindow;
  try {
    appWindow = getCurrentWindow();
  } catch {
    // Running in plain browser preview without Tauri window integration.
    minBtn.style.display = "none";
    maxBtn.style.display = "none";
    closeBtn.style.display = "none";
  }

  if (appWindow) {
    minBtn.addEventListener("click", async () => {
      await appWindow.minimize();
    });

    maxBtn.addEventListener("click", async () => {
      await appWindow.toggleMaximize();
    });

    closeBtn.addEventListener("click", async () => {
      await appWindow.close();
    });

    header.addEventListener("dblclick", async (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".app-header-controls")) return;
      await appWindow.toggleMaximize();
    });
  }

  window.addEventListener("verdant-compose-opened", refreshAppHeaderSubtitle);
  window.addEventListener("verdant-compose-closed", refreshAppHeaderSubtitle);
  refreshAppHeaderSubtitle();
}

function normalizeComposeHtml(rawHtml) {
  const trimmed = (rawHtml || "").trim();
  if (!trimmed || trimmed === "<br>" || trimmed === "<div><br></div>") {
    return "";
  }
  return rawHtml;
}

function recipientFieldNodes(field) {
  return {
    input: document.getElementById(`compose-${field}`),
    wrap: document.getElementById(`compose-${field}-input-wrap`),
    suggest: document.getElementById(`compose-${field}-suggest`),
  };
}

function recipientLabel(contact) {
  const name = sanitizeUnicodeNoise(contact?.name || "");
  const email = sanitizeUnicodeNoise(contact?.email || "");
  return name ? `${name} <${email}>` : email;
}

function renderRecipientChips(field) {
  const { input, wrap } = recipientFieldNodes(field);
  if (!input || !wrap) return;

  wrap.querySelectorAll(".compose-recipient-chip").forEach((el) => el.remove());
  const recipients = composeRecipients[field] || [];

  recipients.forEach((contact, index) => {
    const chip = document.createElement("span");
    chip.className = "compose-recipient-chip";
    chip.innerHTML = `
      <span class="compose-recipient-chip-label" title="${escapeHtml(recipientLabel(contact))}">${escapeHtml(recipientLabel(contact))}</span>
      <button class="compose-recipient-chip-remove" type="button" aria-label="Remove recipient">x</button>
    `;
    chip.querySelector(".compose-recipient-chip-remove")?.addEventListener("click", () => {
      composeRecipients[field] = recipients.filter((_, i) => i !== index);
      renderRecipientChips(field);
      renderRecipientSuggestions(field);
      input.focus();
    });
    wrap.insertBefore(chip, input);
  });
}

function recipientSuggestionsForField(field, query) {
  const q = sanitizeUnicodeNoise(query || "").toLowerCase();
  if (!q) return [];

  const existing = new Set((composeRecipients[field] || []).map((r) => r.email));
  return Array.from(contactsByEmail.values())
    .filter((contact) => !existing.has(contact.email))
    .map((contact) => {
      const hay = `${contact.name || ""} ${contact.email}`.toLowerCase();
      const starts = contact.email.startsWith(q) || (contact.name || "").toLowerCase().startsWith(q);
      return { ...contact, hay, starts };
    })
    .filter((contact) => contact.hay.includes(q))
    .sort((a, b) => {
      if (a.starts !== b.starts) return a.starts ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    })
    .slice(0, 8);
}

function hideRecipientSuggestions(field) {
  const { suggest } = recipientFieldNodes(field);
  if (!suggest) return;
  suggest.classList.remove("open");
  suggest.innerHTML = "";
  recipientSuggestState[field].items = [];
  recipientSuggestState[field].activeIndex = -1;
}

function renderRecipientSuggestions(field) {
  const { input, suggest } = recipientFieldNodes(field);
  if (!input || !suggest) return;

  const items = recipientSuggestionsForField(field, input.value);
  recipientSuggestState[field].items = items;

  if (!items.length) {
    hideRecipientSuggestions(field);
    return;
  }

  let activeIndex = recipientSuggestState[field].activeIndex;
  if (activeIndex < 0 || activeIndex >= items.length) activeIndex = 0;
  recipientSuggestState[field].activeIndex = activeIndex;

  suggest.innerHTML = items
    .map((item, idx) => `
      <button class="compose-recipient-option ${idx === activeIndex ? "active" : ""}" type="button" data-idx="${idx}">
        <span class="compose-recipient-option-name">${escapeHtml(item.name || item.email)}</span>
        <span class="compose-recipient-option-email">${escapeHtml(item.email)}</span>
      </button>
    `)
    .join("");

  suggest.classList.add("open");
  suggest.querySelectorAll(".compose-recipient-option").forEach((btn) => {
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const idx = Number(btn.getAttribute("data-idx"));
      const item = items[idx];
      if (item) {
        addComposeRecipient(field, item);
      }
    });
  });
}

function addComposeRecipient(field, contactLike) {
  const parsed = typeof contactLike === "string" ? parseContactToken(contactLike) : {
    email: normalizeEmailAddress(contactLike?.email || ""),
    name: sanitizeUnicodeNoise(contactLike?.name || ""),
  };

  if (!parsed?.email) return false;
  if ((composeRecipients[field] || []).some((entry) => entry.email === parsed.email)) return false;

  const known = contactsByEmail.get(parsed.email);
  const next = {
    email: parsed.email,
    name: parsed.name || known?.name || "",
  };

  composeRecipients[field].push(next);
  upsertContact(next.email, next.name);

  const { input } = recipientFieldNodes(field);
  if (input) input.value = "";

  renderRecipientChips(field);
  hideRecipientSuggestions(field);
  return true;
}

function commitRecipientInput(field) {
  const { input } = recipientFieldNodes(field);
  if (!input) return;

  const raw = sanitizeUnicodeNoise(input.value || "");
  if (!raw) {
    hideRecipientSuggestions(field);
    return;
  }

  const parts = parseContactsFromHeader(raw);
  if (!parts.length) {
    const fallback = parseContactToken(raw);
    if (fallback) addComposeRecipient(field, fallback);
    else hideRecipientSuggestions(field);
    return;
  }

  let changed = false;
  parts.forEach((contact) => {
    changed = addComposeRecipient(field, contact) || changed;
  });
  if (!changed) hideRecipientSuggestions(field);
}

function pickActiveRecipientSuggestion(field) {
  const state = recipientSuggestState[field];
  const item = state.items[state.activeIndex];
  if (!item) return false;
  return addComposeRecipient(field, item);
}

function recipientString(field) {
  return (composeRecipients[field] || []).map((contact) => contact.email).join(", ");
}

function setComposeRecipientsFromHeader(field, headerValue) {
  composeRecipients[field] = parseContactsFromHeader(headerValue).map((contact) => ({
    email: contact.email,
    name: contact.name || contactsByEmail.get(contact.email)?.name || "",
  }));
  renderRecipientChips(field);
  hideRecipientSuggestions(field);
}

function bindComposeRecipientField(field) {
  const { input } = recipientFieldNodes(field);
  if (!input) return;

  input.addEventListener("input", () => {
    recipientSuggestState[field].activeIndex = -1;
    renderRecipientSuggestions(field);
  });

  input.addEventListener("keydown", (event) => {
    const state = recipientSuggestState[field];
    const open = state.items.length > 0;

    if (event.key === "ArrowDown" && open) {
      event.preventDefault();
      state.activeIndex = (state.activeIndex + 1 + state.items.length) % state.items.length;
      renderRecipientSuggestions(field);
      return;
    }

    if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      state.activeIndex = (state.activeIndex - 1 + state.items.length) % state.items.length;
      renderRecipientSuggestions(field);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (!pickActiveRecipientSuggestion(field)) {
        commitRecipientInput(field);
      }
      return;
    }

    if (event.key === "Tab" && open) {
      event.preventDefault();
      if (!pickActiveRecipientSuggestion(field)) {
        commitRecipientInput(field);
      }
      return;
    }

    if (event.key === "," || event.key === ";") {
      event.preventDefault();
      commitRecipientInput(field);
      return;
    }

    if (event.key === " " && (input.value || "").includes("@")) {
      event.preventDefault();
      commitRecipientInput(field);
      return;
    }

    if (event.key === "Backspace" && !input.value) {
      const recipients = composeRecipients[field] || [];
      if (recipients.length) {
        composeRecipients[field] = recipients.slice(0, -1);
        renderRecipientChips(field);
      }
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      commitRecipientInput(field);
      hideRecipientSuggestions(field);
    }, 80);
  });

  input.addEventListener("focus", () => {
    renderRecipientSuggestions(field);
  });
}

function bindComposeRecipientInputs() {
  if (composeRecipientUiBound) return;
  composeRecipientUiBound = true;

  bindComposeRecipientField("to");
  bindComposeRecipientField("cc");
  renderRecipientChips("to");
  renderRecipientChips("cc");
}

function collectComposePayload() {
  const toInput = document.getElementById("compose-to");
  const ccInput = document.getElementById("compose-cc");
  const subjectInput = document.getElementById("compose-subject");
  const bodyInput = document.getElementById("compose-body");

  commitRecipientInput("to");
  commitRecipientInput("cc");

  const bodyHtmlRaw = bodyInput?.innerHTML || "";
  const bodyHtml = normalizeComposeHtml(bodyHtmlRaw);
  const body = bodyInput?.innerText || "";

  return {
    toInput,
    ccInput,
    subjectInput,
    bodyInput,
    to: recipientString("to"),
    cc: recipientString("cc"),
    subject: subjectInput?.value?.trim() || "",
    body,
    bodyHtml,
  };
}

function resetComposeState() {
  const toInput = recipientFieldNodes("to").input;
  const ccInput = recipientFieldNodes("cc").input;
  const subjectInput = document.getElementById("compose-subject");
  const bodyInput = document.getElementById("compose-body");

  if (toInput) toInput.value = "";
  if (ccInput) ccInput.value = "";
  if (subjectInput) subjectInput.value = "";
  if (bodyInput) bodyInput.innerHTML = "";

  composeAttachments = [];
  composeSendMode = "plain";
  composeDraftId = null;
  composeRecipients.to = [];
  composeRecipients.cc = [];
  renderRecipientChips("to");
  renderRecipientChips("cc");
  hideRecipientSuggestions("to");
  hideRecipientSuggestions("cc");
  renderComposeAttachments();
}

function openComposeForDraft(email) {
  if (!email) return;
  if (typeof window.openCompose === "function") window.openCompose();

  const toInput = recipientFieldNodes("to").input;
  const ccInput = recipientFieldNodes("cc").input;
  const subjectInput = document.getElementById("compose-subject");
  const bodyInput = document.getElementById("compose-body");

  setComposeRecipientsFromHeader("to", email.to_recipients || "");
  setComposeRecipientsFromHeader("cc", email.cc_recipients || "");
  if (toInput) toInput.value = "";
  if (ccInput) ccInput.value = "";
  if (subjectInput) subjectInput.value = email.subject || "";
  if (bodyInput) bodyInput.innerHTML = email.body_html || "";

  composeSendMode = "html";
  composeDraftId = email.draft_id || null;
}

function selectionContextNode() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
}

function closestInEditor(editor, tagName) {
  const context = selectionContextNode();
  if (!(context instanceof Element)) return null;
  const el = context.closest(tagName);
  if (!el || !editor.contains(el)) return null;
  return el;
}

function unwrapElementToText(element) {
  const text = document.createTextNode(element.textContent || "");
  element.replaceWith(text);
}

function applyFormatToComposer(formatType) {
  const editor = document.getElementById("compose-body");
  if (!editor) return;

  editor.focus();

  if (formatType === "bold") {
    document.execCommand("bold");
  } else if (formatType === "italic") {
    document.execCommand("italic");
  } else if (formatType === "header") {
    const existingHeader = closestInEditor(editor, "h2");
    document.execCommand("formatBlock", false, existingHeader ? "p" : "h2");
  } else if (formatType === "list") {
    document.execCommand("insertUnorderedList");
  } else if (formatType === "quote") {
    const existingQuote = closestInEditor(editor, "blockquote");
    document.execCommand("formatBlock", false, existingQuote ? "p" : "blockquote");
  } else if (formatType === "code") {
    const existingPre = closestInEditor(editor, "pre");
    if (existingPre) {
      unwrapElementToText(existingPre);
    } else {
      const selected = window.getSelection()?.toString() || "code";
      document.execCommand("insertHTML", false, `<pre><code>${escapeHtml(selected)}</code></pre>`);
    }
  } else if (formatType === "clear") {
    document.execCommand("removeFormat");
    const existingHeader = closestInEditor(editor, "h2");
    if (existingHeader) document.execCommand("formatBlock", false, "p");
    const existingQuote = closestInEditor(editor, "blockquote");
    if (existingQuote) document.execCommand("formatBlock", false, "p");
    const existingList = closestInEditor(editor, "ul");
    if (existingList) document.execCommand("insertUnorderedList");
    const existingPre = closestInEditor(editor, "pre");
    if (existingPre) unwrapElementToText(existingPre);
  }

  composeSendMode = "html";
}

function bindComposeFormatting() {
  const formatToggle = document.getElementById("compose-format-btn");
  const toolbar = document.getElementById("compose-format-toolbar");
  if (!formatToggle || !toolbar) return;

  formatToggle.addEventListener("click", () => {
    toolbar.classList.toggle("open");
    formatToggle.classList.toggle("active", toolbar.classList.contains("open"));
    if (toolbar.classList.contains("open")) {
      composeSendMode = "html";
    }
  });

  toolbar.querySelectorAll("[data-format]").forEach((button) => {
    button.addEventListener("click", () => {
      applyFormatToComposer(button.getAttribute("data-format") || "bold");
    });
  });

  window.addEventListener("verdant-compose-closed", () => {
    toolbar.classList.remove("open");
    formatToggle.classList.remove("active");
    composeSendMode = "plain";
  });
}

function composeAttachmentLabel(fileName) {
  const clean = (fileName || "attachment").trim();
  return clean.length > 34 ? `${clean.slice(0, 31)}...` : clean;
}

function renderComposeAttachments() {
  const wrap = document.getElementById("compose-attachments");
  if (!wrap) return;

  wrap.innerHTML = "";
  for (const [idx, attachment] of composeAttachments.entries()) {
    const chip = document.createElement("div");
    chip.className = "compose-attachment";
    chip.innerHTML = `
      <span class="compose-attachment-name" title="${escapeHtml(attachment.filename)}">${escapeHtml(composeAttachmentLabel(attachment.filename))}</span>
      <button class="compose-attachment-remove" aria-label="Remove attachment" title="Remove">x</button>
    `;

    chip.querySelector(".compose-attachment-remove")?.addEventListener("click", () => {
      composeAttachments = composeAttachments.filter((_, i) => i !== idx);
      renderComposeAttachments();
    });
    wrap.appendChild(chip);
  }
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function bindComposeAttachments() {
  const attachBtn = document.getElementById("compose-attach-btn");
  const fileInput = document.getElementById("compose-file-input");
  if (!attachBtn || !fileInput) return;

  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    for (const file of files) {
      const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
      composeAttachments.push({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        dataBase64,
      });
    }
    fileInput.value = "";
    renderComposeAttachments();
  });

  window.addEventListener("verdant-compose-opened", () => {
    if (!composeDraftId) {
      resetComposeState();
    }
  });

  window.addEventListener("verdant-compose-closed", () => {
    resetComposeState();
  });
}

function bindComposeSend() {
  const sendBtn = document.querySelector(".compose-modal .send-btn");
  if (!sendBtn) return;

  sendBtn.addEventListener("click", async () => {
    const payload = collectComposePayload();

    if (!payload.to) {
      showToast("Recipient is required", "error");
      return;
    }

    showToast("Sending mail...");
    if (composeDraftId) {
      const saved = await invoke("save_draft", {
        to: payload.to,
        cc: payload.cc,
        subject: payload.subject,
        body: payload.body,
        mode: composeSendMode,
        bodyHtml: composeSendMode === "html" ? payload.bodyHtml : null,
        attachments: composeAttachments,
        draftId: composeDraftId,
      });
      await invoke("send_existing_draft", { draftId: saved.draft_id || composeDraftId });
    } else {
      await invoke("send_email", {
        to: payload.to,
        cc: payload.cc,
        subject: payload.subject,
        body: payload.body,
        mode: composeSendMode,
        bodyHtml: composeSendMode === "html" ? payload.bodyHtml : null,
        attachments: composeAttachments,
      });
    }

    parseContactsFromHeader(payload.to).forEach((contact) => upsertContact(contact.email, contact.name));
    parseContactsFromHeader(payload.cc).forEach((contact) => upsertContact(contact.email, contact.name));

    showToast("Email sent");

    if (typeof window.closeCompose === "function") window.closeCompose();

    await openMailbox(currentMailbox, false);
  });
}

function bindComposeDraftSave() {
  const draftBtn = document.getElementById("compose-save-draft-btn");
  if (!draftBtn) return;

  draftBtn.addEventListener("click", async () => {
    const payload = collectComposePayload();
    showToast("Saving draft...");

    const result = await invoke("save_draft", {
      to: payload.to,
      cc: payload.cc,
      subject: payload.subject,
      body: payload.body,
      mode: composeSendMode,
      bodyHtml: composeSendMode === "html" ? payload.bodyHtml : null,
      attachments: composeAttachments,
      draftId: composeDraftId,
    });

    composeDraftId = result.draft_id || composeDraftId;
    showToast("Draft saved");
    await openMailbox(currentMailbox, false);
  });
}

function bindHotkeys() {
  document.addEventListener("keydown", async (event) => {
    const combo = normalizeCombo(eventCombo(event));

    if (combo === hotkeys.close) {
      if (isSettingsOpen()) {
        closeOverlay();
        return;
      }
      if (isComposeOpen() && typeof window.closeCompose === "function") {
        window.closeCompose();
      }
      return;
    }

    if (!hotkeys.enabled) return;

    if (combo === hotkeys.compose) {
      event.preventDefault();
      if (!canRunHotkey("compose")) return;
      if (typeof window.openCompose === "function") window.openCompose();
      return;
    }

    if (combo === hotkeys.composeMaximize) {
      if (!isComposeOpen()) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) {
        return;
      }
      event.preventDefault();
      if (!canRunHotkey("composeMaximize")) return;
      if (typeof window.toggleComposeMaximized === "function") {
        window.toggleComposeMaximized();
      }
      return;
    }

    if (combo === hotkeys.refresh) {
      event.preventDefault();
      if (!canRunHotkey("refresh")) return;
      showToast("Fetching mails...");
      await syncMailboxInBackground(currentMailbox, true);
      return;
    }

    if (combo === hotkeys.settings) {
      event.preventDefault();
      if (!canRunHotkey("settings")) return;
      const profile = await invoke("get_user_profile");
      await openSettingsModal(profile);
      return;
    }

    if (combo === hotkeys.search) {
      event.preventDefault();
      if (!canRunHotkey("search")) return;
      const search = document.querySelector(".search-bar input");
      search?.focus();
    }
  });
}

async function initializeConnectedUI() {
  bindAppHeaderControls();
  bindMailboxNav();
  bindReadingActions();
  bindFilterChips();
  bindSearch();
  bindPaneResizer();
  bindInfiniteScroll();
  bindComposeWindowControls();
  bindComposeRecipientInputs();
  bindComposeFormatting();
  bindComposeAttachments();
  bindComposeSend();
  bindComposeDraftSave();
  bindHotkeys();
  await bindUserProfileAndSettings();

  const inboxNow = await invoke("get_emails", { mailbox: "INBOX" });
  ingestContactsFromEmails(inboxNow);
  knownInboxIds = new Set((inboxNow || []).map((m) => m.id));

  await openMailbox("INBOX", true);
  startPeriodicSync();
}

document.addEventListener("DOMContentLoaded", async () => {
  ensureStyles();
  bindAppHeaderControls();
  clearMockImmediately();
  document.querySelector(".reply-bar")?.remove();

  try {
    const status = await invoke("auth_status");
    if (!status.has_client_id) {
      showOverlay("Configuration Required", "Missing GOOGLE_CLIENT_ID in .env. Add credentials and restart Verdant.", [
        { label: "Close", onClick: closeOverlay },
      ]);
      return;
    }

    if (!status.connected) {
      showOnboardingScreen();
      return;
    }

    await initializeConnectedUI();
  } catch (error) {
    showOverlay("Initialization Failed", String(error), [
      { label: "Retry", primary: true, onClick: () => window.location.reload() },
    ]);
  }
});
