import { invoke } from "@tauri-apps/api/core";

const PAGE_SIZE = 50;
const SYNC_INTERVAL_MS = 45000;
const RESYNC_COOLDOWN_MS = 5 * 60 * 1000;
const HOTKEY_COOLDOWN_MS = {
  compose: 350,
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
let composeAttachments = [];
let composeSendMode = "plain";

const defaultHotkeys = {
  enabled: true,
  compose: "ctrl+n",
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

function formatListDate(raw) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw || "";

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
}

function closeOverlay(immediate = false) {
  const overlay = document.getElementById("verdant-overlay");
  if (!overlay) return;
  if (immediate) {
    overlay.remove();
    return;
  }
  overlay.classList.remove("open");
  setTimeout(() => overlay.remove(), 180);
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

function isImportant(email) {
  const labels = (email.labels || "").split(",");
  return !labels.includes("CATEGORY_PROMOTIONS") && !labels.includes("SPAM");
}

function emailMatchesFilter(email) {
  if (activeFilter === "Important" && !isImportant(email)) return false;
  if (activeFilter === "Attachments" && !/attachment|\.pdf|\.doc|\.xlsx|\.zip/i.test(email.snippet || "")) return false;
  if (activeFilter === "Flagged" && !email.starred) return false;

  if (searchQuery) {
    const hay = `${email.subject || ""} ${email.sender || ""} ${email.snippet || ""}`.toLowerCase();
    if (!hay.includes(searchQuery.toLowerCase())) return false;
  }

  return true;
}

function visibleEmails() {
  return (currentEmails || []).filter(emailMatchesFilter);
}

function pagedEmails() {
  const list = visibleEmails();
  const start = (currentPage - 1) * PAGE_SIZE;
  return list.slice(start, start + PAGE_SIZE);
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
  let collapsed = "to me";
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
  if (date) date.textContent = email.date || "";
  if (body) {
    const html = sanitizeUnicodeNoise(email.body_html || "");
    body.innerHTML = html || `<pre>${escapeHtml(sanitizeUnicodeNoise(email.snippet || ""))}</pre>`;
  }

  if (avatar) {
    const initials = sanitizeUnicodeNoise(email.sender || "?")
      .replace(/<.*?>/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || "")
      .join("")
      .toUpperCase();
    avatar.textContent = initials || "?";
  }

  renderRecipientsLine(email);
  updateTopActionStates();
}

async function markSelectedAsReadIfNeeded() {
  if (!selectedEmail || selectedEmail.is_read) return;
  selectedEmail.is_read = true;
  await invoke("set_email_read_status", { emailId: selectedEmail.id, isRead: true });
  await refreshCounts();
}

async function selectEmail(email, row) {
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

  const total = visibleEmails().length;
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return;

  const pager = document.createElement("div");
  pager.className = "pager";

  const start = Math.max(1, currentPage - 2);
  const end = Math.min(pages, start + 4);

  for (let i = start; i <= end; i += 1) {
    const btn = document.createElement("button");
    btn.textContent = String(i);
    if (i === currentPage) btn.classList.add("active");
    btn.onclick = () => {
      currentPage = i;
      renderEmailList(false);
    };
    pager.appendChild(btn);
  }

  pane.appendChild(pager);
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
      <div class="email-item-inner">
        <div class="email-top">
          <span class="email-sender">${escapeHtml(sanitizeUnicodeNoise(email.sender || "Unknown Sender"))}</span>
          <span class="email-time">${escapeHtml(formatListDate(email.date))}</span>
        </div>
        <div class="email-subject">${escapeHtml(sanitizeUnicodeNoise(email.subject || "(No Subject)"))}</div>
        <div class="email-preview">${escapeHtml(sanitizeUnicodeNoise(email.snippet || ""))}</div>
      </div>
    `;

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
  } else if (!selectedEmail && emails.length > 0) {
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
  }
  currentMailbox = mailbox;
  currentEmails = await invoke("get_emails", { mailbox });
  currentPage = 1;
  renderEmailList(animate);
  await refreshCounts();
}

async function syncMailboxInBackground(mailbox) {
  const key = mailbox;
  const now = Date.now();
  const last = lastSynced.get(key) || 0;

  if (now - last < RESYNC_COOLDOWN_MS) return;
  lastSynced.set(key, now);

  if (mailbox !== "STARRED" && mailbox !== "ARCHIVE") {
    showToast("Fetching mails...", "info", 1200);
    await invoke("sync_mailbox", { mailbox });
  }

  const latest = await invoke("get_emails", { mailbox });
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
        buildActionMenu(
          [
            { label: "Mark as Read", onClick: () => invoke("set_email_read_status", { emailId: selectedEmail.id, isRead: true }) },
            { label: "Mark as Unread", onClick: () => invoke("set_email_read_status", { emailId: selectedEmail.id, isRead: false }) },
            { label: "Toggle Star", onClick: () => invoke("toggle_starred", { emailId: selectedEmail.id }) },
          ],
          button
        );
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
  input.addEventListener("input", () => {
    searchQuery = input.value || "";
    currentPage = 1;
    renderEmailList(false);
  });
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
    await syncMailboxInBackground(currentMailbox);
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
  if (!maxBtn) return;

  maxBtn.onclick = () => {
    const modal = document.querySelector(".compose-modal");
    if (!modal) return;
    modal.classList.toggle("compose-maximized");
  };
}

function normalizeComposeHtml(rawHtml) {
  const trimmed = (rawHtml || "").trim();
  if (!trimmed || trimmed === "<br>" || trimmed === "<div><br></div>") {
    return "";
  }
  return rawHtml;
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

  window.addEventListener("verdant-compose-closed", () => {
    composeAttachments = [];
    renderComposeAttachments();
  });
}

function bindComposeSend() {
  const sendBtn = document.querySelector(".compose-modal .send-btn");
  if (!sendBtn) return;

  sendBtn.addEventListener("click", async () => {
    const toInput = document.getElementById("compose-to");
    const ccInput = document.getElementById("compose-cc");
    const subjectInput = document.getElementById("compose-subject");
    const bodyInput = document.getElementById("compose-body");

    const to = toInput?.value?.trim() || "";
    const cc = ccInput?.value?.trim() || "";
    const subject = subjectInput?.value?.trim() || "";
    const bodyHtmlRaw = bodyInput?.innerHTML || "";
    const bodyHtml = normalizeComposeHtml(bodyHtmlRaw);
    const body = bodyInput?.innerText || "";

    if (!to) {
      showToast("Recipient is required", "error");
      return;
    }

    showToast("Sending mail...");
    await invoke("send_email", {
      to,
      cc,
      subject,
      body,
      mode: composeSendMode,
      bodyHtml: composeSendMode === "html" ? bodyHtml : null,
      attachments: composeAttachments,
    });
    showToast("Email sent");

    if (typeof window.closeCompose === "function") window.closeCompose();
    if (toInput) toInput.value = "";
    if (ccInput) ccInput.value = "";
    if (subjectInput) subjectInput.value = "";
    if (bodyInput) bodyInput.innerHTML = "";
    composeAttachments = [];
    composeSendMode = "plain";
    renderComposeAttachments();

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

    if (combo === hotkeys.refresh) {
      event.preventDefault();
      if (!canRunHotkey("refresh")) return;
      showToast("Fetching mails...");
      await syncMailboxInBackground(currentMailbox);
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
  bindMailboxNav();
  bindReadingActions();
  bindFilterChips();
  bindSearch();
  bindComposeWindowControls();
  bindComposeFormatting();
  bindComposeAttachments();
  bindComposeSend();
  bindHotkeys();
  await bindUserProfileAndSettings();

  const inboxNow = await invoke("get_emails", { mailbox: "INBOX" });
  knownInboxIds = new Set((inboxNow || []).map((m) => m.id));

  await openMailbox("INBOX", true);
  startPeriodicSync();
}

document.addEventListener("DOMContentLoaded", async () => {
  ensureStyles();
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
