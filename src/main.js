import { invoke } from "@tauri-apps/api/core";

let currentMailbox = "INBOX";
let currentEmails = [];
let currentSelected = null;

function escapeHtml(input) {
  if (!input) return "";
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
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

function clearMockImmediately() {
  const list = document.querySelector(".email-list");
  if (list) list.innerHTML = "";
}

function renderOnboarding(message, options = {}) {
  const {
    showButton = true,
    buttonText = "Connect Gmail",
    action = "connect",
    title = "Connect Your Gmail Account",
  } = options;

  const list = document.querySelector(".email-list");
  if (!list) return;

  list.innerHTML = `
    <div class="email-item active" style="cursor: default;">
      <div class="email-item-inner" style="padding: 16px;">
        <div class="email-top">
          <span class="email-sender">Verdant Setup</span>
          <span class="email-time">Now</span>
        </div>
        <div class="email-subject">${escapeHtml(title)}</div>
        <div class="email-preview">${escapeHtml(message)}</div>
        ${showButton ? `<button id="onboarding-action" class="send-btn" data-action="${escapeHtml(action)}" style="margin-top: 12px; width: auto;">${escapeHtml(buttonText)}</button>` : ""}
      </div>
    </div>
  `;

  const button = document.getElementById("onboarding-action");
  if (!button) return;

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = button.dataset.action === "connect" ? "Connecting..." : "Retrying...";

    try {
      if (button.dataset.action === "connect") {
        await invoke("connect_gmail");
      }
      await initializeConnectedUI();
    } catch (error) {
      renderOnboarding(String(error), {
        showButton: true,
        buttonText: "Retry",
        action: "retry",
        title: "Action Failed",
      });
    }
  });
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

  if (subject) subject.textContent = email.subject || "(No Subject)";
  if (from) from.textContent = email.sender || "Unknown Sender";
  if (date) date.textContent = email.date || "";
  if (body) body.innerHTML = email.body_html || `<pre>${escapeHtml(email.snippet || "")}</pre>`;

  if (avatar) {
    const initials = (email.sender || "?")
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
  if (!currentSelected || currentSelected.is_read) return;
  currentSelected.is_read = true;
  await invoke("set_email_read_status", { emailId: currentSelected.id, isRead: true });
  await refreshCounts();
}

async function selectEmail(email, row) {
  currentSelected = email;

  document.querySelectorAll(".email-item").forEach((el) => el.classList.remove("active"));
  row.classList.add("active");
  row.classList.remove("unread");
  const dot = row.querySelector(".unread-dot");
  if (dot) dot.remove();

  renderReadingPane(email);
  await markSelectedAsReadIfNeeded();
}

function renderEmailList(emails) {
  const list = document.querySelector(".email-list");
  if (!list) return;

  list.innerHTML = "";
  setListTitle(currentMailbox, emails.length);

  for (const email of emails) {
    const row = document.createElement("div");
    row.className = `email-item ${email.is_read ? "" : "unread"}`.trim();
    row.innerHTML = `
      ${email.is_read ? "" : '<div class="unread-dot"></div>'}
      <div class="email-item-inner">
        <div class="email-top">
          <span class="email-sender">${escapeHtml(email.sender || "Unknown Sender")}</span>
          <span class="email-time">${escapeHtml(shortDate(email.date))}</span>
        </div>
        <div class="email-subject">${escapeHtml(email.subject || "(No Subject)")}</div>
        <div class="email-preview">${escapeHtml(email.snippet || "")}</div>
      </div>
    `;

    row.addEventListener("click", () => {
      selectEmail(email, row).catch(console.error);
    });

    list.appendChild(row);
  }

  if (emails.length > 0) {
    const first = list.querySelector(".email-item");
    if (first) {
      selectEmail(emails[0], first).catch(console.error);
    }
  } else {
    renderOnboarding("No messages found for this mailbox.", {
      showButton: false,
      title: `${mailboxTitle(currentMailbox)} Is Empty`,
    });
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
    if (badge) badge.remove();
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

async function loadMailbox(mailbox) {
  currentMailbox = mailbox;

  if (mailbox !== "STARRED") {
    await invoke("sync_mailbox", { mailbox });
  }

  currentEmails = await invoke("get_emails", { mailbox });
  renderEmailList(currentEmails || []);
  await refreshCounts();
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
      try {
        await loadMailbox(map[label]);
      } catch (error) {
        renderOnboarding(String(error), {
          showButton: true,
          buttonText: "Retry Sync",
          action: "retry",
          title: "Sync Failed",
        });
      }
    };
  }
}

function bindReadingActions() {
  const buttons = Array.from(document.querySelectorAll(".reading-actions .icon-btn"));
  for (const button of buttons) {
    const title = button.getAttribute("title") || "";

    if (title === "Label" || title === "More") {
      button.style.display = "none";
      continue;
    }

    button.onclick = async () => {
      if (!currentSelected) return;
      try {
        if (title === "Archive") {
          await invoke("archive_email", { emailId: currentSelected.id });
          await loadMailbox(currentMailbox);
          return;
        }

        if (title === "Delete") {
          await invoke("trash_email", { emailId: currentSelected.id });
          await loadMailbox(currentMailbox);
          return;
        }

        if (title === "Mark unread") {
          const next = currentSelected.is_read;
          currentSelected.is_read = !next;
          await invoke("set_email_read_status", { emailId: currentSelected.id, isRead: !next });
          await loadMailbox(currentMailbox);
          return;
        }

        if (title === "Star") {
          await invoke("toggle_starred", { emailId: currentSelected.id });
          if (currentMailbox === "STARRED") {
            await loadMailbox(currentMailbox);
          } else {
            await refreshCounts();
          }
        }
      } catch (error) {
        alert(`Action failed: ${error}`);
      }
    };
  }
}

function bindSendButton() {
  const sendBtn = document.querySelector(".send-btn");
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

    try {
      await invoke("send_email", { to, subject, body });
      if (typeof window.closeCompose === "function") {
        window.closeCompose();
      }
      fields.forEach((input) => {
        input.value = "";
      });
      const textarea = document.querySelector(".modal-body textarea");
      if (textarea) textarea.value = "";
      await loadMailbox(currentMailbox);
    } catch (error) {
      alert(`Failed to send email: ${error}`);
    }
  });
}

function bindUserMenu() {
  const userRow = document.querySelector(".user-row");
  if (!userRow) return;

  userRow.style.position = "relative";

  const menu = document.createElement("div");
  menu.id = "user-menu";
  menu.style.cssText = "position:absolute; left:0; bottom:56px; width:220px; background:#eeece7; border:1px solid #d8d4cb; border-radius:10px; padding:8px; display:none; z-index:1000;";
  menu.innerHTML = `
    <button data-action="sync" style="width:100%; text-align:left; background:transparent; border:0; padding:8px; border-radius:8px; cursor:pointer;">Sync Now</button>
    <button data-action="clear" style="width:100%; text-align:left; background:transparent; border:0; padding:8px; border-radius:8px; cursor:pointer;">Clear Local DB</button>
    <button data-action="logout" style="width:100%; text-align:left; background:transparent; border:0; padding:8px; border-radius:8px; cursor:pointer; color:#8a3b3b;">Logout</button>
  `;
  userRow.appendChild(menu);

  userRow.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });

  document.addEventListener("click", () => {
    menu.style.display = "none";
  });

  menu.addEventListener("click", async (e) => {
    e.stopPropagation();
    const action = e.target?.dataset?.action;
    if (!action) return;

    try {
      if (action === "sync") {
        await loadMailbox(currentMailbox);
      }
      if (action === "clear") {
        await invoke("clear_local_data");
        await loadMailbox(currentMailbox);
      }
      if (action === "logout") {
        await invoke("logout");
        clearMockImmediately();
        renderOnboarding("You have been logged out. Connect Gmail again to continue.", {
          showButton: true,
          buttonText: "Connect Gmail",
          action: "connect",
          title: "Logged Out",
        });
      }
    } catch (error) {
      alert(`User action failed: ${error}`);
    }
  });
}

async function bindUserProfile() {
  const profile = await invoke("get_user_profile");
  const avatar = document.querySelector(".sidebar .avatar");
  const name = document.querySelector(".sidebar .user-name");
  const email = document.querySelector(".sidebar .user-email");

  if (avatar) avatar.textContent = profile.initials;
  if (name) name.textContent = profile.name;
  if (email) email.textContent = profile.email;
}

async function initializeConnectedUI() {
  bindMailboxNav();
  bindReadingActions();
  bindSendButton();
  bindUserMenu();
  await bindUserProfile();
  await loadMailbox("INBOX");
}

document.addEventListener("DOMContentLoaded", async () => {
  clearMockImmediately();

  try {
    const status = await invoke("auth_status");

    if (!status.has_client_id) {
      renderOnboarding("Missing GOOGLE_CLIENT_ID in .env. Add credentials, restart app, then connect.", {
        showButton: false,
        title: "Configuration Required",
      });
      return;
    }

    if (!status.connected) {
      renderOnboarding("Connect your Gmail account to start syncing real mail.", {
        showButton: true,
        buttonText: "Connect Gmail",
        action: "connect",
        title: "Connect Your Gmail Account",
      });
      return;
    }

    await initializeConnectedUI();
  } catch (error) {
    renderOnboarding(String(error), {
      showButton: true,
      buttonText: "Retry",
      action: "retry",
      title: "Initialization Failed",
    });
  }
});
