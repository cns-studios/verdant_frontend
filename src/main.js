import { invoke } from "@tauri-apps/api/core";

let currentMailbox = "INBOX";
let currentEmails = [];
let selectedEmail = null;
let activeFilter = "All";
let syncTimer = null;
let knownInboxIds = new Set();

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
    case "INBOX":
      return "Inbox";
    case "STARRED":
      return "Starred";
    case "SNOOZED":
      return "Snoozed";
    case "SENT":
      return "Sent";
    case "DRAFT":
      return "Drafts";
    default:
      return "Mailbox";
  }
}

function emailMatchesFilter(email) {
  if (activeFilter === "Unread") return !email.is_read;
  if (activeFilter === "Flagged") return !!email.starred;
  if (activeFilter === "Attachments") {
    return /attachment|\.pdf|\.doc|\.xlsx|\.zip/i.test(email.snippet || "");
  }
  return true;
}

function ensureStyles() {
  if (document.getElementById("verdant-dynamic-styles")) return;
  const style = document.createElement("style");
  style.id = "verdant-dynamic-styles";
  style.textContent = `
    .verdant-overlay { position: fixed; inset: 0; z-index: 2000; background: rgba(31,28,24,0.42); backdrop-filter: blur(2px); display:flex; align-items:center; justify-content:center; }
    .verdant-panel { width:min(560px, 92vw); background: var(--surface); border:1px solid var(--border); border-radius:14px; box-shadow: 0 22px 52px rgba(37,35,31,0.18); padding: 24px; }
    .verdant-panel h2 { font: 500 24px 'Fraunces', serif; color: var(--text); margin-bottom: 10px; }
    .verdant-panel p { font: 400 13px 'DM Sans', sans-serif; color: var(--text-mid); line-height: 1.5; margin-bottom: 16px; }
    .verdant-actions { display:flex; gap: 10px; justify-content:flex-end; }
    .verdant-btn { padding: 8px 14px; border-radius: 8px; border:1px solid var(--border); background: var(--surface2); color: var(--text); font: 500 12px 'DM Sans', sans-serif; cursor: pointer; }
    .verdant-btn.primary { background: var(--green); color: #fff; border-color: var(--green); }
    .email-body-text pre { white-space: pre-wrap; word-break: break-word; }
    .action-menu { position: absolute; right: 0; top: 34px; width: 180px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 26px rgba(0,0,0,.12); padding: 6px; z-index: 1200; }
    .action-menu button { width:100%; text-align:left; border:0; background:transparent; color:var(--text); padding:8px 10px; border-radius:8px; font:400 12px 'DM Sans', sans-serif; cursor:pointer; }
    .action-menu button:hover { background: var(--surface2); }
    .settings-grid { display: grid; gap: 10px; }
  `;
  document.head.appendChild(style);
}

function showOverlay(title, message, buttons) {
  ensureStyles();
  closeOverlay();
  const overlay = document.createElement("div");
  overlay.id = "verdant-overlay";
  overlay.className = "verdant-overlay";
  overlay.innerHTML = `
    <div class="verdant-panel">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="verdant-actions"></div>
    </div>
  `;
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

function filteredEmails() {
  return (currentEmails || []).filter(emailMatchesFilter);
}

function renderEmailList() {
  const list = document.querySelector(".email-list");
  if (!list) return;
  const emails = filteredEmails();

  list.innerHTML = "";
  setListTitle(currentMailbox, emails.length);

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
  if (!("Notification" in window)) return;

  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if (Notification.permission === "granted") {
    const first = unseen[0];
    new Notification("New email", {
      body: `${sanitizeUnicodeNoise(first.sender)} - ${sanitizeUnicodeNoise(first.subject)}`,
    });
  }
}

async function loadLocalMailbox(mailbox) {
  currentMailbox = mailbox;
  currentEmails = await invoke("get_emails", { mailbox });
  renderEmailList();
  await refreshCounts();
}

async function syncMailboxInBackground(mailbox) {
  if (mailbox !== "STARRED") {
    await invoke("sync_mailbox", { mailbox });
  }
  const latest = await invoke("get_emails", { mailbox });
  if (mailbox === "INBOX") {
    await notifyNewEmails(latest);
  }
  if (currentMailbox === mailbox) {
    currentEmails = latest;
    renderEmailList();
    await refreshCounts();
  }
}

async function openMailbox(mailbox) {
  await loadLocalMailbox(mailbox);
  syncMailboxInBackground(mailbox).catch((err) => console.error("Background sync failed:", err));
}

function bindMailboxNav() {
  const map = {
    Inbox: "INBOX",
    Starred: "STARRED",
    Snoozed: "SNOOZED",
    Sent: "SENT",
    Drafts: "DRAFT",
  };

  const items = Array.from(document.querySelectorAll(".sidebar .nav-item"));
  for (const item of items) {
    const label = Object.keys(map).find((key) => item.textContent.trim().startsWith(key));
    if (!label) continue;

    item.onclick = async (ev) => {
      ev.preventDefault();
      items.forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
      await openMailbox(map[label]);
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
  await loadLocalMailbox(currentMailbox);
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
        await refreshAfterAction();
        return;
      }
      if (title === "Delete") {
        await invoke("trash_email", { emailId: selectedEmail.id });
        await refreshAfterAction();
        return;
      }
      if (title === "Mark unread") {
        await invoke("set_email_read_status", { emailId: selectedEmail.id, isRead: !selectedEmail.is_read });
        await refreshAfterAction();
        return;
      }
      if (title === "Star") {
        await invoke("toggle_starred", { emailId: selectedEmail.id });
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
}

function bindFilterChips() {
  const chips = Array.from(document.querySelectorAll(".filter-chips .chip"));
  chips.forEach((chip) => {
    chip.onclick = () => {
      chips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeFilter = chip.textContent.trim();
      renderEmailList();
    };
  });
}

function openSettingsModal(profile) {
  showOverlay("Settings", `Signed in as ${profile.email}`, [{ label: "Close", onClick: closeOverlay }]);
  const panel = document.querySelector("#verdant-overlay .verdant-panel");
  if (!panel) return;

  const grid = document.createElement("div");
  grid.className = "settings-grid";
  grid.innerHTML = `
    <button class="verdant-btn" id="settings-sync">Sync Now</button>
    <button class="verdant-btn" id="settings-clear">Clear Local DB</button>
    <button class="verdant-btn" id="settings-logout" style="color:#8a3b3b;">Logout</button>
  `;
  panel.appendChild(grid);

  panel.querySelector("#settings-sync")?.addEventListener("click", async () => {
    await syncMailboxInBackground(currentMailbox);
    closeOverlay();
  });
  panel.querySelector("#settings-clear")?.addEventListener("click", async () => {
    await invoke("clear_local_data");
    await openMailbox(currentMailbox);
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
  showOverlay("Connect Your Gmail Account", message, [
    {
      label: "Connect Gmail",
      primary: true,
      onClick: async () => {
        try {
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
  }, 45000);
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
      alert("Recipient is required");
      return;
    }

    await invoke("send_email", { to, subject, body });
    if (typeof window.closeCompose === "function") window.closeCompose();
    fields.forEach((f) => (f.value = ""));
    const ta = document.querySelector(".modal-body textarea");
    if (ta) ta.value = "";
    await openMailbox(currentMailbox);
  });
}

async function initializeConnectedUI() {
  bindMailboxNav();
  bindReadingActions();
  bindFilterChips();
  bindComposeSend();
  await bindUserProfileAndSettings();

  const inboxNow = await invoke("get_emails", { mailbox: "INBOX" });
  knownInboxIds = new Set((inboxNow || []).map((m) => m.id));

  await openMailbox("INBOX");
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
