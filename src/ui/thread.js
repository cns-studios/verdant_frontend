import { getInboxThreads, getThreadMessages, markThreadRead, archiveEmail, trashEmail, toggleStarred, setEmailReadStatus } from "../api.js";
import { escapeHtml, sanitizeUnicodeNoise, formatListDate, formatReadingDate } from "../lib/format.js";
import { showToast } from "../lib/toast.js";
import { t } from "../lib/i18n.js";
import { applySenderAvatar } from "./reading.js";
import { downloadAttachment } from "../api.js";
import { openComposeForReply, openComposeForForward } from "./compose.js";


let currentThreads = [];
let selectedThreadId = null;
let selectedThreadMessages = [];
let expandedMessageIds = new Set();
let onRefreshCallback = null;
let onCountsRefreshCallback = null;


function formatParticipants(rawSenders, maxDisplay = 3) {
  if (!rawSenders) return t("app.unknown_sender");

  const seen = new Set();
  const names = rawSenders
    .split(",")
    .map(s => {
      const clean = sanitizeUnicodeNoise(s.trim());
      const nameOnly = clean
        .replace(/<[^>]+>/g, "")
        .replace(/['"]/g, "")
        .trim();
      return nameOnly || clean;
    })
    .filter(name => {
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });

  if (names.length <= maxDisplay) return names.join(", ");
  return `${names.slice(0, maxDisplay).join(", ")} +${names.length - maxDisplay}`;
}


export function renderThreadList(threads, activeFilter, searchQuery) {
  currentThreads = threads || [];
  const list = document.getElementById("email-list");
  if (!list) return;

  list.innerHTML = "";

  const visible = currentThreads.filter(thread => {
    if (activeFilter === "Important") {
      const labels = (thread.labels || "").split(",");
      const isPromo = labels.some(l =>
        ["SPAM", "TRASH", "CATEGORY_PROMOTIONS"].includes(l.trim())
      );
      if (isPromo) return false;
    }
    if (activeFilter === "Unread" && thread.is_read) return false;
    if (activeFilter === "Attachments" && !thread.has_attachments) return false;
    if (searchQuery) {
      const hay = `${thread.subject} ${thread.participants} ${thread.snippet}`.toLowerCase();
      if (!hay.includes(searchQuery.toLowerCase())) return false;
    }
    return true;
  });

  const countEl = document.querySelector(".list-count");
  if (countEl) countEl.textContent = t("list.count", { n: visible.length });

  for (const thread of visible) {
    const row = document.createElement("div");
    const isActive = thread.thread_id === selectedThreadId;
    row.className = `email-item${thread.is_read ? "" : " unread"}${isActive ? " active" : ""}`;
    row.dataset.threadId = thread.thread_id;

    const participants = formatParticipants(thread.participants);
    const count = thread.message_count > 1
      ? `<span class="thread-count">${thread.message_count}</span>`
      : "";

    row.innerHTML = `
      ${thread.is_read ? "" : '<div class="unread-dot"></div>'}
      <div class="email-item-main">
        <div class="sender-avatar"></div>
        <div class="email-item-inner">
          <div class="email-top">
            <span class="email-sender">${escapeHtml(participants)}${count}</span>
            <span class="email-time">${escapeHtml(formatListDate(thread.latest_date))}</span>
          </div>
          <div class="email-subject">${escapeHtml(sanitizeUnicodeNoise(thread.subject || t("app.no_subject")))}</div>
          <div class="email-preview">${escapeHtml(sanitizeUnicodeNoise(thread.snippet || ""))}</div>
        </div>
      </div>
    `;

    const firstSender = (thread.participants || "").split(",")[0] || "";
    applySenderAvatar(row.querySelector(".sender-avatar"), firstSender, "INBOX");
    row.addEventListener("click", () => selectThread(thread, row));
    list.appendChild(row);
  }

  if (!selectedThreadId && visible.length > 0) {
    const firstRow = list.querySelector(".email-item");
    if (firstRow) selectThread(visible[0], firstRow);
  }
}


async function selectThread(thread, row) {
  selectedThreadId = thread.thread_id;
  selectedThreadMessages = [];

  document.querySelectorAll(".email-item").forEach(el => el.classList.remove("active"));
  row.classList.add("active");
  row.classList.remove("unread");
  row.querySelector(".unread-dot")?.remove();
  document.body.classList.remove("reading-pane-hidden");

  const readingBody = document.querySelector(".reading-body");
  if (readingBody) {
    readingBody.innerHTML = `<div class="thread-loading">${escapeHtml(t("toast.fetching"))}</div>`;
  }

  try {
    const messages = await getThreadMessages(thread.thread_id);
    selectedThreadMessages = messages;
    renderThreadPane(thread, messages);

    if (!thread.is_read) {
      await markThreadRead(thread.thread_id);
      thread.is_read = true;
      if (onCountsRefreshCallback) onCountsRefreshCallback();
    }
  } catch (err) {
    if (readingBody) {
      readingBody.innerHTML = `<div class="thread-loading" style="color:#8a3b3b">${escapeHtml(String(err))}</div>`;
    }
  }
}


function renderThreadPane(thread, messages) {
  const subjectEl = document.querySelector(".reading-subject");
  if (subjectEl) subjectEl.textContent = sanitizeUnicodeNoise(thread.subject || t("app.no_subject"));

  const metaEl = document.querySelector(".reading-meta");
  if (metaEl) metaEl.style.display = "none";

  updateThreadActionStates(thread);

  const readingBody = document.querySelector(".reading-body");
  if (!readingBody) return;

  expandedMessageIds = new Set();
  if (messages.length > 0) {
    expandedMessageIds.add(messages[messages.length - 1].id);
  }

  readingBody.innerHTML = "";

  if (messages.length > 1) {
    const participantBar = document.createElement("div");
    participantBar.className = "thread-participant-bar";
    participantBar.innerHTML = `
      <span class="thread-participant-label">${escapeHtml(formatParticipants(thread.participants, 8))}</span>
      <span class="thread-message-total">${messages.length} ${t("thread.messages")}</span>
    `;
    readingBody.appendChild(participantBar);
  }

  const stack = document.createElement("div");
  stack.className = "thread-stack";
  readingBody.appendChild(stack);

  for (const message of messages) {
    stack.appendChild(buildMessageBubble(message, messages));
  }
}


function buildMessageBubble(message, allMessages) {
  const isExpanded = expandedMessageIds.has(message.id);

  const bubble = document.createElement("div");
  bubble.className = `thread-bubble${isExpanded ? " expanded" : " collapsed"}`;
  bubble.dataset.messageId = message.id;

  const senderName = sanitizeUnicodeNoise(message.sender || t("app.unknown_sender"))
    .replace(/<[^>]+>/g, "")
    .replace(/['"]/g, "")
    .trim();

  if (isExpanded) {
    bubble.innerHTML = buildExpandedBubble(message, senderName);
  } else {
    bubble.innerHTML = buildCollapsedBubble(message, senderName);
  }

  const avatar = bubble.querySelector(".thread-bubble-avatar");
  if (avatar) applySenderAvatar(avatar, message.sender || "", "INBOX");

  const header = bubble.querySelector(".thread-bubble-header");
  if (header) {
    header.addEventListener("click", () => toggleBubble(bubble, message, allMessages));
  }

  bindBubbleButtons(bubble, message, allMessages);
  return bubble;
}

function buildCollapsedBubble(message, senderName) {
  return `
    <div class="thread-bubble-header" role="button" tabindex="0" aria-expanded="false">
      <div class="thread-bubble-avatar"></div>
      <div class="thread-bubble-meta-collapsed">
        <span class="thread-bubble-sender">${escapeHtml(senderName)}</span>
        <span class="thread-bubble-preview">${escapeHtml(sanitizeUnicodeNoise(message.snippet || ""))}</span>
      </div>
      <span class="thread-bubble-date">${escapeHtml(formatListDate(message.date))}</span>
      ${message.has_attachments ? '<span class="thread-bubble-attach-icon">📎</span>' : ""}
    </div>
  `;
}

function buildExpandedBubble(message, senderName) {
  const attachments = parseAttachments(message);
  const attachLabel = attachments.length === 1
    ? t("thread.attachments", { n: 1 })
    : t("thread.attachments_plural", { n: attachments.length });

  const attachmentsHtml = attachments.length ? `
    <div class="thread-bubble-attachments">
      <div class="thread-attachments-label">${escapeHtml(attachLabel)}</div>
      ${attachments.map((a, i) => `
        <div class="thread-attachment-item">
          <span class="thread-attachment-name" title="${escapeHtml(a.filename || "attachment")}">${escapeHtml(a.filename || "attachment")}</span>
          <button class="thread-attachment-dl" data-attachment-index="${i}">${t("thread.download")}</button>
        </div>
      `).join("")}
    </div>
  ` : "";

  return `
    <div class="thread-bubble-header" role="button" tabindex="0" aria-expanded="true">
      <div class="thread-bubble-avatar"></div>
      <div class="thread-bubble-meta-expanded">
        <span class="thread-bubble-sender">${escapeHtml(senderName)}</span>
        <span class="thread-bubble-to">to ${escapeHtml(sanitizeUnicodeNoise(message.to_recipients || "me"))}</span>
      </div>
      <span class="thread-bubble-date">${escapeHtml(formatReadingDate(message.date))}</span>
    </div>
    <div class="thread-bubble-body">
      <div class="thread-bubble-content email-body-text">${sanitizeUnicodeNoise(message.body_html || `<pre>${escapeHtml(message.snippet || "")}</pre>`)}</div>
      ${attachmentsHtml}
    </div>
    <div class="thread-bubble-actions">
      <button class="thread-reply-btn" data-action="reply">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
        ${t("thread.reply")}
      </button>
      <button class="thread-reply-btn" data-action="forward">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>
        ${t("thread.forward")}
      </button>
    </div>
  `;
}


function toggleBubble(bubble, message, allMessages) {
  const isExpanded = expandedMessageIds.has(message.id);

  if (isExpanded) {
    if (expandedMessageIds.size <= 1) return;
    expandedMessageIds.delete(message.id);
    bubble.classList.remove("expanded");
    bubble.classList.add("collapsed");

    const senderName = sanitizeUnicodeNoise(message.sender || t("app.unknown_sender"))
      .replace(/<[^>]+>/g, "").replace(/['"]/g, "").trim();
    bubble.innerHTML = buildCollapsedBubble(message, senderName);

    const avatar = bubble.querySelector(".thread-bubble-avatar");
    if (avatar) applySenderAvatar(avatar, message.sender || "", "INBOX");
    bubble.querySelector(".thread-bubble-header")
      ?.addEventListener("click", () => toggleBubble(bubble, message, allMessages));
  } else {
    expandedMessageIds.add(message.id);
    bubble.classList.remove("collapsed");
    bubble.classList.add("expanded");

    const senderName = sanitizeUnicodeNoise(message.sender || t("app.unknown_sender"))
      .replace(/<[^>]+>/g, "").replace(/['"]/g, "").trim();
    bubble.innerHTML = buildExpandedBubble(message, senderName);

    const avatar = bubble.querySelector(".thread-bubble-avatar");
    if (avatar) applySenderAvatar(avatar, message.sender || "", "INBOX");
    bubble.querySelector(".thread-bubble-header")
      ?.addEventListener("click", () => toggleBubble(bubble, message, allMessages));

    bindBubbleButtons(bubble, message, allMessages);

    if (!message.is_read) {
      message.is_read = true;
      setEmailReadStatus(message.id, true).catch(() => {});
    }
  }
}


function bindBubbleButtons(bubble, message, allMessages) {
  bubble.querySelector('[data-action="reply"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    openComposeForReply(message);
  });

  bubble.querySelector('[data-action="forward"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    openComposeForForward(message);
  });

  bubble.querySelectorAll(".thread-attachment-dl").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const idx = Number(btn.getAttribute("data-attachment-index"));
      const attachments = parseAttachments(message);
      const attachment = attachments[idx];
      if (!attachment) return;

      btn.disabled = true;
      btn.textContent = t("thread.downloading");
      try {
        const response = await downloadAttachment(
          message.id,
          attachment.attachment_id,
          attachment.filename || "attachment",
          attachment.mime_type || "application/octet-stream"
        );
        const binary = atob(response.data_base64 || "");
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: response.content_type || attachment.mime_type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = response.filename || attachment.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast(t("app.attachment_downloaded", { name: response.filename || attachment.filename }));
      } catch {
        showToast(t("toast.attachment_failed"), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = t("thread.download");
      }
    });
  });
}


function parseAttachments(message) {
  if (!message?.attachments_json) return [];
  try {
    const parsed = JSON.parse(message.attachments_json);
    return Array.isArray(parsed) ? parsed.filter(a => a?.attachment_id) : [];
  } catch { return []; }
}


function updateThreadActionStates(thread) {
  const buttons = Array.from(document.querySelectorAll(".reading-actions .icon-btn"));
  buttons.forEach(btn => {
    const title = btn.getAttribute("title") || "";
    if (title === t("reading.star")) {
      btn.classList.toggle("active", !!thread?.starred);
    }
    if (title === t("reading.delete")) {
      btn.classList.add("danger");
    }
  });
}

export function bindThreadActions(onRefresh, onCountsRefresh) {
  onRefreshCallback = onRefresh;
  onCountsRefreshCallback = onCountsRefresh;

  const buttons = Array.from(document.querySelectorAll(".reading-actions .icon-btn"));

  for (const button of buttons) {
    const title = button.getAttribute("title") || "";

    button.onclick = async () => {
      if (title === t("reading.close")) {
        selectedThreadId = null;
        selectedThreadMessages = [];
        document.body.classList.add("reading-pane-hidden");
        document.querySelectorAll(".email-item").forEach(el => el.classList.remove("active"));
        return;
      }

      if (!selectedThreadId) return;

      const messageIds = Array.from(document.querySelectorAll(".thread-bubble"))
        .map(b => b.dataset.messageId).filter(Boolean);

      if (title === t("reading.archive")) {
        for (const id of messageIds) await archiveEmail(id).catch(() => {});
        resetReadingPane();
        showToast(t("toast.archived"));
        if (onRefreshCallback) await onRefreshCallback();
        return;
      }

      if (title === t("reading.delete")) {
        for (const id of messageIds) await trashEmail(id).catch(() => {});
        resetReadingPane();
        showToast(t("toast.trashed"));
        if (onRefreshCallback) await onRefreshCallback();
        return;
      }

      if (title === t("reading.mark_unread")) {
        // Mark all messages in thread as unread
        for (const id of messageIds) {
          await setEmailReadStatus(id, false).catch(() => {});
        }
        // Update the thread row in the list
        const row = document.querySelector(`.email-item[data-thread-id="${selectedThreadId}"]`);
        if (row) {
          row.classList.add("unread");
          if (!row.querySelector(".unread-dot")) {
            const dot = document.createElement("div");
            dot.className = "unread-dot";
            row.prepend(dot);
          }
        }
        showToast(t("toast.unread_marked"));
        if (onCountsRefreshCallback) onCountsRefreshCallback();
        return;
      }

      if (title === t("reading.star")) {
        for (const id of messageIds) await toggleStarred(id).catch(() => {});
        button.classList.toggle("active");
        showToast(t("toast.star_updated"));
        if (onCountsRefreshCallback) onCountsRefreshCallback();
        return;
      }

      if (title === t("reading.more")) {
        // "more" menu is handled by reading.js bindReadingActions for non-thread path;
        // for threads we just skip — no-op here since bindReadingActions also attaches to this button.
        return;
      }
    };
  }
}

function resetReadingPane() {
  selectedThreadId = null;
  selectedThreadMessages = [];
  const body = document.querySelector(".reading-body");
  const subject = document.querySelector(".reading-subject");
  const meta = document.querySelector(".reading-meta");
  if (body) body.innerHTML = "";
  if (subject) subject.textContent = "";
  if (meta) meta.style.display = "";
}


export function getSelectedThreadId() {
  return selectedThreadId;
}

export function clearSelectedThread() {
  selectedThreadId = null;
  selectedThreadMessages = [];
}
