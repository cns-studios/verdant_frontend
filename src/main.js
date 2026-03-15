import { invoke } from "@tauri-apps/api/core";

const PAGE_SIZE = 50;
const SYNC_INTERVAL_MS = 45000;
const RESYNC_COOLDOWN_MS = 5 * 60 * 1000;

let currentMailbox = "INBOX";
let currentLabel = "";
let currentEmails = [];
let selectedEmail = null;
let currentPage = 1;
let activeFilter = "Important";
let syncTimer = null;
let knownInboxIds = new Set();
let lastSynced = new Map();

const defaultHotkeys = {
  enabled: true,
  compose: "ctrl+n",
  refresh: "ctrl+r",
  settings: "ctrl+,",
  search: "ctrl+k",
  close: "escape",
};

function loadHotkeys() {
  try {
    const raw = localStorage.getItem("verdant.hotkeys");
    if (!raw) return { ...defaultHotkeys };
    return { ...defaultHotkeys, ...JSON.parse(raw) };
  } catch {
    return { ...defaultHotkeys };
  }
}

function saveHotkeys(hotkeys) {
  localStorage.setItem("verdant.hotkeys", JSON.stringify(hotkeys));
}

let hotkeys = loadHotkeys();

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

function shortDate(raw) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw || "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function mailboxTitle(mailbox) {
  switch (mailbox) {
    case "INBOX": return "Inbox";
    case "STARRED": return "Starred";
    case "SNOOZED": return "Snoozed";
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
    .verdant-overlay { position: fixed; inset: 0; z-index: 2100; background: rgba(31,28,24,.42); backdrop-filter: blur(2px); display:flex; align-items:center; justify-content:center; }
    .verdant-panel { width:min(640px, 94vw); max-height: 86vh; overflow:auto; background: var(--surface); border:1px solid var(--border); border-radius:14px; box-shadow: 0 22px 52px rgba(37,35,31,.18); padding: 20px; }
    .verdant-head { display:flex; align-items:flex-start; justify-content:space-between; gap: 12px; margin-bottom: 10px; }
    .verdant-head h2 { font: 500 24px 'Fraunces', serif; color: var(--text); }
    .verdant-close { border:1px solid var(--border); background: var(--surface2); border-radius:8px; width:30px; height:30px; cursor:pointer; color:var(--text); }
    .verdant-panel p { font: 400 13px 'DM Sans', sans-serif; color: var(--text-mid); line-height: 1.5; margin-bottom: 12px; }
    .verdant-actions { display:flex; gap: 10px; justify-content:flex-end; }
    .verdant-btn { padding: 8px 14px; border-radius: 8px; border:1px solid var(--border); background: var(--surface2); color: var(--text); font: 500 12px 'DM Sans', sans-serif; cursor: pointer; }
    .verdant-btn.primary { background: var(--green); color: #fff; border-color: var(--green); }
    .email-body-text pre { white-space: pre-wrap; word-break: break-word; }
    .action-menu { position: absolute; right: 0; top: 34px; width: 190px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 26px rgba(0,0,0,.12); padding: 6px; z-index: 1300; }
    .action-menu button { width:100%; text-align:left; border:0; background:transparent; color:var(--text); padding:8px 10px; border-radius:8px; font:400 12px 'DM Sans', sans-serif; cursor:pointer; }
    .action-menu button:hover { background: var(--surface2); }
    .settings-grid { display:grid; gap: 10px; margin-top: 12px; }
    .settings-row { display:grid; grid-template-columns: 1fr 160px; align-items:center; gap:10px; }
    .settings-row input { height:34px; border-radius:8px; border:1px solid var(--border); background: var(--bg); padding: 0 10px; font: 400 12px 'DM Sans', sans-serif; }
    .settings-switch { display:flex; align-items:center; gap:8px; font: 400 12px 'DM Sans', sans-serif; color:var(--text); }
    .toast-wrap { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2400; display: grid; gap: 8px; }
    .toast { min-width: 220px; max-width: 520px; padding: 10px 14px; border-radius: 10px; border:1px solid var(--border); background: var(--surface); color: var(--text); font: 500 12px 'DM Sans', sans-serif; box-shadow: 0 10px 28px rgba(0,0,0,.12); animation: toast-in .22s ease forwards; }
    .toast.info { border-color: var(--green-muted); }
    .toast.error { border-color: #c08d8d; color: #7a2d2d; }
    @keyframes toast-in { from { opacity:0; transform: translateY(-14px);} to { opacity:1; transform: translateY(0);} }
    .suppress-anim .email-item { animation: none !important; }
    .pager { display:flex; gap:6px; justify-content:center; padding:10px 12px 14px; border-top:1px solid var(--border); background: var(--surface); }
    .pager button { border:1px solid var(--border); background: var(--surface2); color: var(--text); border-radius: 8px; padding: 6px 10px; cursor:pointer; font: 500 12px 'DM Sans', sans-serif; }
    .pager button.active { background: var(--green); color:#fff; border-color: var(--green); }
    .icon-btn.active { background: var(--green-pale); color: var(--green); border: 1px solid var(--green-muted); }
    .icon-btn.danger:hover { background: #f5dede !important; color: #8a2e2e !important; border: 1px solid #d79f9f; }
    .compose-maximized { width: min(1100px, 96vw) !important; height: min(90vh, 920px) !important; }
    .compose-maximized .modal-body { height: calc(100% - 190px); }
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

function showOverlay(title, message, buttons) {
  ensureStyles();
  closeOverlay();
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

  const actions = overlay.querySelector(".verdant-actions");
  for (const btn of buttons) {
    const el = document.createElement("button");
    el.className = `verdant-btn ${btn.primary ? "primary" : ""}`;
    el.textContent = btn.label;
    el.onclick = btn.onClick;
    actions.appendChild(el);
  }
  document.body.appendChild(overlay);
}

function closeOverlay() {
  document.getElementById("verdant-overlay")?.remove();
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
  if (activeFilter === "Important") return isImportant(email);
  if (activeFilter === "All") return true;
  if (activeFilter === "Attachments") {
    return /attachment|\.pdf|\.doc|\.xlsx|\.zip/i.test(email.snippet || "");
  }
  if (activeFilter === "Flagged") return !!email.starred;
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
    if (title === "Star") {
      btn.classList.toggle("active", !!selectedEmail?.starred);
    }
    if (title === "Delete") {
      btn.classList.add("danger");
    }
  });
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
  setListTitle(currentMailbox, totalFiltered);

  for (const email of emails) {
    const row = document.createElement("div");
    row.className = `email-item ${email.is_read ? "" : "unread"}`.trim();
    row.innerHTML = `
      ${email.is_read ? "" : '<div class="unread-dot"></div>'}
      <div class="email-item-inner">
        <div class="email-top">
          <span class="email-sender">${escapeHtml(sanitizeUnicodeNoise(email.sender || "Unknown Sender"))}</span>
          <span class="email-time">${escapeHtml(shortDate(email.date))}</span>
        </div>
        <div class="email-subject">${escapeHtml(sanitizeUnicodeNoise(email.subject || "(No Subject)"))}</div>
        <div class="email-preview">${escapeHtml(sanitizeUnicodeNoise(email.snippet || ""))}</div>
      </div>
    `;

    row.addEventListener("click", () => {
      selectEmail(email, row).catch(console.error);
    });

    list.appendChild(row);
  }

  if (emails.length > 0) {
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
  setBadge(navByLabel("Snoozed"), counts.snoozed_total);
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

async function loadLocalMailbox(mailbox, label = "", animate = false) {
  currentMailbox = mailbox;
  currentLabel = label;
  currentEmails = await invoke("get_emails", { mailbox, label });
  currentPage = 1;
  renderEmailList(animate);
  await refreshCounts();
}

async function syncMailboxInBackground(mailbox, label = "") {
  const key = `${mailbox}|${label}`;
  const now = Date.now();
  const last = lastSynced.get(key) || 0;

  if (now - last < RESYNC_COOLDOWN_MS) return;
  lastSynced.set(key, now);

  if (mailbox !== "STARRED") {
    showToast("Fetching mails...", "info", 1200);
    await invoke("sync_mailbox", { mailbox });
  }

  const latest = await invoke("get_emails", { mailbox, label });
  if (mailbox === "INBOX" && !label) {
    await notifyNewEmails(latest);
  }

  if (currentMailbox === mailbox && currentLabel === label) {
    currentEmails = latest;
    renderEmailList(false);
    await refreshCounts();
  }
}

async function openMailbox(mailbox, label = "", animate = false) {
  await loadLocalMailbox(mailbox, label, animate);
  syncMailboxInBackground(mailbox, label).catch((err) => {
    console.error("Background sync failed:", err);
    showToast(String(err), "error", 2500);
  });
}

function bindMailboxNav() {
  const map = {
    Inbox: ["INBOX", ""],
    Starred: ["STARRED", ""],
    Snoozed: ["SNOOZED", ""],
    Sent: ["SENT", ""],
    Drafts: ["DRAFT", ""],
    Work: ["INBOX", "Work"],
    Personal: ["INBOX", "Personal"],
    Finance: ["INBOX", "Finance"],
  };

  const items = Array.from(document.querySelectorAll(".sidebar .nav-item"));
  for (const item of items) {
    const label = Object.keys(map).find((key) => item.textContent.trim().startsWith(key));
    if (!label) continue;

    item.onclick = async (ev) => {
      ev.preventDefault();
      items.forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
      const [mailbox, localLabel] = map[label];
      await openMailbox(mailbox, localLabel, true);
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
  await loadLocalMailbox(currentMailbox, currentLabel, false);
  syncMailboxInBackground(currentMailbox, currentLabel).catch(() => {});
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
        await invoke("set_email_read_status", { emailId: selectedEmail.id, isRead: !selectedEmail.is_read });
        showToast(!selectedEmail.is_read ? "Marked as read" : "Marked as unread");
        await refreshAfterAction();
        return;
      }
      if (title === "Star") {
        await invoke("toggle_starred", { emailId: selectedEmail.id });
        showToast("Star status updated");
        await refreshAfterAction();
        return;
      }
      if (title === "Label") {
        buildActionMenu(
          [
            { label: "Set label: Work", onClick: () => invoke("set_email_labels", { emailId: selectedEmail.id, labels: "Work" }) },
            { label: "Set label: Personal", onClick: () => invoke("set_email_labels", { emailId: selectedEmail.id, labels: "Personal" }) },
            { label: "Set label: Finance", onClick: () => invoke("set_email_labels", { emailId: selectedEmail.id, labels: "Finance" }) },
            { label: "Clear labels", onClick: () => invoke("set_email_labels", { emailId: selectedEmail.id, labels: "" }) },
          ],
          button
        );
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

function openSettingsModal(profile) {
  showOverlay("Settings", `Signed in as ${profile.email}`, [{ label: "Close", onClick: closeOverlay }]);
  const panel = document.querySelector("#verdant-overlay .verdant-panel");
  if (!panel) return;

  const grid = document.createElement("div");
  grid.className = "settings-grid";
  grid.innerHTML = `
    <label class="settings-switch"><input type="checkbox" id="hk-enabled" ${hotkeys.enabled ? "checked" : ""}> Enable keyboard shortcuts</label>
    <div class="settings-row"><span>Compose</span><input id="hk-compose" value="${escapeHtml(hotkeys.compose)}" /></div>
    <div class="settings-row"><span>Refresh</span><input id="hk-refresh" value="${escapeHtml(hotkeys.refresh)}" /></div>
    <div class="settings-row"><span>Settings</span><input id="hk-settings" value="${escapeHtml(hotkeys.settings)}" /></div>
    <div class="settings-row"><span>Search</span><input id="hk-search" value="${escapeHtml(hotkeys.search)}" /></div>
    <button class="verdant-btn" id="settings-save">Save Shortcuts</button>
    <button class="verdant-btn" id="settings-sync">Sync Now</button>
    <button class="verdant-btn" id="settings-clear">Clear Local DB</button>
    <button class="verdant-btn" id="settings-logout" style="color:#8a3b3b;">Logout</button>
  `;
  panel.appendChild(grid);

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
    await syncMailboxInBackground(currentMailbox, currentLabel);
    closeOverlay();
  });

  panel.querySelector("#settings-clear")?.addEventListener("click", async () => {
    await invoke("clear_local_data");
    await openMailbox(currentMailbox, currentLabel, false);
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
  if (row) row.onclick = () => openSettingsModal(profile);
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
    syncMailboxInBackground("INBOX", "").catch((e) => console.error("Periodic sync failed", e));
  }, SYNC_INTERVAL_MS);
}

function injectComposeMaximizeButton() {
  if (document.getElementById("compose-max-btn")) return;
  const header = document.querySelector(".compose-modal .modal-header");
  if (!header) return;

  const closeBtn = header.querySelector(".modal-close");
  const maxBtn = document.createElement("button");
  maxBtn.id = "compose-max-btn";
  maxBtn.className = "modal-close";
  maxBtn.title = "Maximize";
  maxBtn.textContent = "[]";
  maxBtn.style.marginRight = "6px";

  maxBtn.onclick = () => {
    const modal = document.querySelector(".compose-modal");
    if (!modal) return;
    modal.classList.toggle("compose-maximized");
  };

  closeBtn?.insertAdjacentElement("beforebegin", maxBtn);
}

function bindComposeSend() {
  const sendBtn = document.querySelector(".compose-modal .send-btn");
  if (!sendBtn) return;

  sendBtn.addEventListener("click", async () => {
    const fields = document.querySelectorAll(".modal-field input");
    const to = fields[0]?.value?.trim() || "";
    const subject = fields[2]?.value?.trim() || "";
    const body = document.querySelector(".modal-body textarea")?.value || "";

    if (!to) {
      showToast("Recipient is required", "error");
      return;
    }

    showToast("Sending mail...");
    await invoke("send_email", { to, subject, body });
    showToast("Email sent");

    if (typeof window.closeCompose === "function") window.closeCompose();
    fields.forEach((f) => (f.value = ""));
    const ta = document.querySelector(".modal-body textarea");
    if (ta) ta.value = "";

    await openMailbox(currentMailbox, currentLabel, false);
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
      if (typeof window.openCompose === "function") window.openCompose();
      return;
    }

    if (combo === hotkeys.refresh) {
      event.preventDefault();
      showToast("Fetching mails...");
      await syncMailboxInBackground(currentMailbox, currentLabel);
      return;
    }

    if (combo === hotkeys.settings) {
      event.preventDefault();
      const profile = await invoke("get_user_profile");
      openSettingsModal(profile);
      return;
    }

    if (combo === hotkeys.search) {
      event.preventDefault();
      const search = document.querySelector(".search-bar input");
      search?.focus();
    }
  });
}

async function initializeConnectedUI() {
  bindMailboxNav();
  bindReadingActions();
  bindFilterChips();
  bindComposeSend();
  bindHotkeys();
  injectComposeMaximizeButton();
  await bindUserProfileAndSettings();

  const inboxNow = await invoke("get_emails", { mailbox: "INBOX", label: "" });
  knownInboxIds = new Set((inboxNow || []).map((m) => m.id));

  await openMailbox("INBOX", "", true);
  startPeriodicSync();
}

document.addEventListener("DOMContentLoaded", async () => {
  ensureStyles();
  clearMockImmediately();

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
