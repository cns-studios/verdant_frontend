import { setEmailReadStatus, toggleStarred, archiveEmail, trashEmail } from "../api.js";
import { escapeHtml, sanitizeUnicodeNoise, formatReadingDate, formatAttachmentSize } from "../lib/format.js";
import { showToast } from "../lib/toast.js";
import { downloadAttachment } from "../api.js";
import { t } from "../lib/i18n.js";

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

export function applySenderAvatar(container, sender, mailbox = "") {
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
    if (img.naturalWidth <= 16 && img.naturalHeight <= 16) {
      idx += 1;
      if (idx < urls.length) { img.src = urls[idx]; return; }
      return;
    }
    container.classList.add("has-image");
    container.textContent = "";
    container.innerHTML = "";
    container.appendChild(img);
  };

  img.onerror = () => {
    idx += 1;
    if (idx < urls.length) img.src = urls[idx];
  };

  img.src = urls[idx];
}

function renderRecipientsLine(email) {
  const metaTo = document.querySelector(".meta-to");
  if (!metaTo) return;

  const toList = sanitizeUnicodeNoise(email.to_recipients || "")
    .split(",").map((v) => v.trim()).filter(Boolean);
  const ccList = sanitizeUnicodeNoise(email.cc_recipients || "")
    .split(",").map((v) => v.trim()).filter(Boolean);

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

function parseEmailAttachments(email) {
  if (!email?.attachments_json) return [];
  try {
    const parsed = JSON.parse(email.attachments_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function hasEmailAttachments(email) {
  const raw = email?.has_attachments;
  if (raw === true || raw === 1 || raw === "1") return true;
  if (typeof raw === "string" && raw.toLowerCase() === "true") return true;
  return parseEmailAttachments(email).length > 0;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function showAttachmentDownloadModal(filename) {
  document.getElementById("attachment-download-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "attachment-download-modal";
  modal.className = "attachment-download-modal";
  modal.innerHTML = `
    <div class="attachment-download-card" role="dialog" aria-live="polite">
      <div class="attachment-download-icon is-spinning"></div>
      <div class="attachment-download-text">${t("app.attachment_downloading", { name: escapeHtml(filename || "attachment") })}</div>
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
  if (text) text.textContent = t("app.attachment_downloaded", { name: filename || "attachment" });
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
    showToast(t("toast.attachment_unavailable"), "error", 2400);
    return;
  }
  showAttachmentDownloadModal(attachment.filename || "attachment");
  try {
    const response = await downloadAttachment(
      emailId,
      attachment.attachment_id,
      attachment.filename || "attachment",
      attachment.mime_type || "application/octet-stream"
    );
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
    <div class="email-attachments-title">${t("thread.attachments_plural", { n: attachments.length })}</div>
    <div class="email-attachment-list">
      ${attachments.map((a, index) => `
        <div class="email-attachment-item">
          <div class="email-attachment-meta">
            <div class="email-attachment-name" title="${escapeHtml(a.filename || "attachment")}">${escapeHtml(a.filename || "attachment")}</div>
            <div class="email-attachment-sub">${escapeHtml(a.mime_type || "file")} • ${escapeHtml(formatAttachmentSize(a.size))}</div>
          </div>
          <button class="email-attachment-download" data-attachment-index="${index}">${t("thread.download")}</button>
        </div>
      `).join("")}
    </div>
  `;

  const bodyText = readingBody.querySelector(".email-body-text");
  if (bodyText) readingBody.insertBefore(section, bodyText);
  else readingBody.appendChild(section);

  section.querySelectorAll(".email-attachment-download").forEach((button) => {
    button.addEventListener("click", async () => {
      const attachment = attachments[Number(button.getAttribute("data-attachment-index"))];
      if (!attachment) return;
      button.disabled = true;
      button.textContent = t("thread.downloading");
      try {
        await handleAttachmentDownload(email.id, attachment);
      } catch (error) {
        console.error("Attachment download failed", error);
        showToast(t("toast.attachment_failed"), "error", 2600);
      } finally {
        button.disabled = false;
        button.textContent = t("thread.download");
      }
    });
  });
}

export function renderReadingPane(email) {
  const subject = document.querySelector(".reading-subject");
  const from = document.querySelector(".meta-from");
  const date = document.querySelector(".meta-date");
  const body = document.querySelector(".email-body-text");
  const avatar = document.querySelector(".meta-avatar");

  const labelsContainer = document.querySelector(".reading-labels") || (() => {
    const div = document.createElement("div");
    div.className = "reading-labels";
    subject?.parentElement?.insertBefore(div, subject?.nextSibling);
    return div;
  })();
  labelsContainer.innerHTML = "";
  if (email.labels) {
    email.labels.split(",").filter(Boolean).forEach(label => {
      const span = document.createElement("span");
      span.className = "email-label-badge";
      span.innerHTML = `
        ${escapeHtml(label.trim())}
        <button class="label-remove-btn" title="${escapeHtml(t("reading.delete"))}">×</button>
      `;
      span.onclick = (e) => {
        if (e.target.classList.contains("label-remove-btn")) {
          e.stopPropagation();
          const { removeLabel } = import("../api.js").then(m => {
            m.removeLabel(email.id, label.trim()).then(() => {
               email.labels = email.labels.split(",").filter(l => l.trim() !== label.trim()).join(",");
               renderReadingPane(email);
            });
          });
          return;
        }
        // Browse label: click to search
        const searchInput = document.getElementById("search-input");
        if (searchInput) {
          searchInput.value = `label:${label.trim()}`;
          searchInput.dispatchEvent(new Event("input"));
        }
      };
      labelsContainer.appendChild(span);
    });
  }

  if (subject) subject.textContent = sanitizeUnicodeNoise(email.subject || t("app.no_subject"));
  if (from) from.textContent = sanitizeUnicodeNoise(email.sender || t("app.unknown_sender"));
  if (date) date.textContent = formatReadingDate(email.date || "");
  if (body) {
    const html = sanitizeUnicodeNoise(email.body_html || "");
    body.innerHTML = html || `<pre>${escapeHtml(sanitizeUnicodeNoise(email.snippet || ""))}</pre>`;
  }

  renderReadingAttachments(email);

  if (avatar) applySenderAvatar(avatar, email.sender || "", email.mailbox || "");

  renderRecipientsLine(email);
  updateTopActionStates(email);
}

export function updateTopActionStates(email) {
  const buttons = Array.from(document.querySelectorAll(".reading-actions .icon-btn"));
  buttons.forEach((btn) => {
    const title = btn.getAttribute("title") || "";
    if (title === t("reading.star")) btn.classList.toggle("active", !!email?.starred);
    if (title === t("reading.delete")) btn.classList.add("danger");
    if (title === t("reading.label")) btn.style.display = "none";
  });
}

export function setReadingPaneHidden(hidden) {
  document.body.classList.toggle("reading-pane-hidden", !!hidden);
}

export function bindReadingActions(getSelected, setSelected, onRefresh, openCompose, getCurrentMailbox, getThreadId) {
  const buttons = Array.from(document.querySelectorAll(".reading-actions .icon-btn"));

  for (const button of buttons) {
    const title = button.getAttribute("title") || "";

    button.addEventListener("click", async (event) => {
      const email = getSelected();
      const threadId = getThreadId?.();

      if (title === t("reading.archive")) {
        if (threadId) return;
        event.stopImmediatePropagation();
        if (email) {
          await archiveEmail(email.id);
        }
        showToast(t("toast.archived"));
        await onRefresh();
        return;
      }

      if (title === t("reading.delete")) {
        if (threadId) return;
        event.stopImmediatePropagation();
        if (email) {
          await trashEmail(email.id);
        }
        showToast(t("toast.trashed"));
        await onRefresh();
        return;
      }

      if (title === t("reading.mark_unread")) {
        if (threadId) return;
        event.stopImmediatePropagation();
        if (email) {
          const nextRead = !email.is_read;
          await setEmailReadStatus(email.id, nextRead);
          email.is_read = nextRead;
          showToast(nextRead ? t("toast.read_marked") : t("toast.unread_marked"));
          await onRefresh();
        }
        return;
      }

      if (title === t("reading.star")) {
        if (threadId) return;
        event.stopImmediatePropagation();
        if (email) {
          await toggleStarred(email.id);
          email.starred = !email.starred;
          showToast(t("toast.star_updated"));
          updateTopActionStates(email);
          await onRefresh();
        }
        return;
      }

      if (title === t("reading.more")) {
        event.stopImmediatePropagation();
        const mailbox = getCurrentMailbox?.() || "INBOX";
        const isDraft = email?.mailbox === "DRAFT";

        const entries = [
          {
            label: t("reading.mark_read"),
            onClick: async () => {
              if (email) {
                await setEmailReadStatus(email.id, true);
              } else {
                const threadId = getThreadId?.();
                if (threadId) {
                  const { markThreadRead } = await import("../api.js");
                  await markThreadRead(threadId);
                }
              }
            },
          },
          {
            label: t("reading.mark_unread_action"),
            onClick: async () => {
              if (email) {
                await setEmailReadStatus(email.id, false);
              }
            },
          },
          {
            label: t("reading.toggle_star"),
            onClick: async () => {
              if (email) await toggleStarred(email.id);
            },
          },
          ...(isDraft && email ? [
            {
              label: t("reading.edit_draft"),
              onClick: async () => openCompose(email),
            },
            {
              label: t("reading.send_draft"),
              onClick: async () => {
                if (!email.draft_id) { showToast(t("toast.draft_no_id"), "error"); return; }
                const { sendExistingDraft } = await import("../api.js");
                await sendExistingDraft(email.draft_id);
                showToast(t("toast.draft_sent"));
              },
            },
          ] : []),
        ];

        buildActionMenu(entries, button, onRefresh);
        return;
      }

      if (title === t("reading.close")) {
        setSelected(null);
        document.querySelectorAll(".email-item").forEach((el) => el.classList.remove("active"));
        setReadingPaneHidden(true);
      }
    });
  }
}

function buildActionMenu(entries, anchor, onRefresh) {
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
      await onRefresh();
    };
    menu.appendChild(b);
  });

  const rect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 5}px`;
  menu.style.left = `${rect.right - 160}px`;
  menu.style.zIndex = "2500";

  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener("click", () => menu.remove(), { once: true });
  }, 0);
}
