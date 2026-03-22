import { sendEmail, saveDraft, sendExistingDraft } from "../api.js";
import { escapeHtml, sanitizeUnicodeNoise } from "../lib/format.js";
import { showToast } from "../lib/toast.js";
import { t } from "../lib/i18n.js";
import {
  contactsByEmail,
  upsertContact,
  normalizeEmailAddress,
  parseContactToken,
  parseContactsFromHeader,
} from "../lib/contacts.js";

export let composeAttachments = [];
export let composeSendMode = "plain";
export let composeDraftId = null;
let _suppressNextReset = false;

const composeRecipients = { to: [], cc: [] };
const recipientSuggestState = {
  to: { items: [], activeIndex: -1 },
  cc: { items: [], activeIndex: -1 },
};

let composeRecipientUiBound = false;

export let composeInReplyTo = null;
export let composeReferences = null;

export function isComposeOpen() {
  return document.getElementById("composeModal")?.classList.contains("open");
}

export function openCompose() {
  const modal = document.getElementById("composeModal");
  if (modal) modal.classList.add("open");
  window.dispatchEvent(new CustomEvent("verdant-compose-opened"));
}

export function closeCompose() {
  const modal = document.getElementById("composeModal");
  if (modal) modal.classList.remove("open");
  window.dispatchEvent(new CustomEvent("verdant-compose-closed"));
}

export function openComposeForDraft(email) {
  if (!email) return;
  openCompose();

  setComposeRecipientsFromHeader("to", email.to_recipients || "");
  setComposeRecipientsFromHeader("cc", email.cc_recipients || "");

  const toInput = recipientFieldNodes("to").input;
  const ccInput = recipientFieldNodes("cc").input;
  const subjectInput = document.getElementById("compose-subject");
  const bodyInput = document.getElementById("compose-body");

  if (toInput) toInput.value = "";
  if (ccInput) ccInput.value = "";
  if (subjectInput) subjectInput.value = email.subject || "";
  if (bodyInput) bodyInput.innerHTML = email.body_html || "";

  composeSendMode = "html";
  composeDraftId = email.draft_id || null;
}

function recipientFieldNodes(field) {
  return {
    input: document.getElementById(`compose-${field}`),
    wrap: document.getElementById(`compose-${field}-input-wrap`),
    suggest: document.getElementById(`compose-${field}-suggest`),
  };
}

export function openComposeForReply(email) {
  if (!email) return;
  const rawId = email.id.includes(':') ? email.id.split(':').slice(1).join(':') : email.id;
  composeInReplyTo = rawId;
  composeReferences = rawId;

  setComposeRecipientsFromHeader("to", email.sender || "");
  setComposeRecipientsFromHeader("cc", "");

  const subjectInput = document.getElementById("compose-subject");
  const bodyInput = document.getElementById("compose-body");

  _suppressNextReset = true;
  
  const rawSubject = email.subject || "";
  const reSubject = /^re:/i.test(rawSubject.trim())
    ? rawSubject
    : `Re: ${rawSubject}`;

  if (subjectInput) subjectInput.value = reSubject;

  const quotedHtml = buildQuotedHtml(email);
  if (bodyInput) {
    bodyInput.innerHTML = `<div><br></div>${quotedHtml}`;
    const sel = window.getSelection();
    const range = document.createRange();
    const firstDiv = bodyInput.querySelector("div");
    if (firstDiv && sel) {
      range.setStart(firstDiv, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  composeSendMode = "html";
  composeDraftId = null;

  openCompose();
  bodyInput?.focus();
}

export function openComposeForForward(email) {
  if (!email) return;

  setComposeRecipientsFromHeader("to", "");
  setComposeRecipientsFromHeader("cc", "");

  const subjectInput = document.getElementById("compose-subject");
  const bodyInput = document.getElementById("compose-body");

  _suppressNextReset = true;
  
  const rawSubject = email.subject || "";
  const fwdSubject = /^fwd:/i.test(rawSubject.trim())
    ? rawSubject
    : `Fwd: ${rawSubject}`;

  if (subjectInput) subjectInput.value = fwdSubject;

  const fwdHtml = buildForwardHtml(email);
  if (bodyInput) {
    bodyInput.innerHTML = `<div><br></div>${fwdHtml}`;
    const sel = window.getSelection();
    const range = document.createRange();
    const firstDiv = bodyInput.querySelector("div");
    if (firstDiv && sel) {
      range.setStart(firstDiv, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  composeSendMode = "html";
  composeDraftId = null;

  openCompose();
  document.getElementById("compose-to")?.focus();
}

function buildQuotedHtml(email) {
  const sender = escapeHtml(sanitizeUnicodeNoise(email.sender || "Unknown"));
  const date = escapeHtml(email.date || "");
  const originalHtml = email.body_html || `<pre>${escapeHtml(email.snippet || "")}</pre>`;

  return `
    <div style="border-left: 3px solid #c8d5c4; padding-left: 12px; margin-top: 16px; color: #4a4d45;">
      <div style="font-size: 12px; color: #8a8d84; margin-bottom: 8px;">
        On ${date}, ${sender} wrote:
      </div>
      <div style="font-size: 13px;">
        ${originalHtml}
      </div>
    </div>
  `;
}

function buildForwardHtml(email) {
  const sender = escapeHtml(sanitizeUnicodeNoise(email.sender || "Unknown"));
  const date = escapeHtml(email.date || "");
  const to = escapeHtml(sanitizeUnicodeNoise(email.to_recipients || ""));
  const subject = escapeHtml(sanitizeUnicodeNoise(email.subject || ""));
  const originalHtml = email.body_html || `<pre>${escapeHtml(email.snippet || "")}</pre>`;

  return `
    <div style="border-left: 3px solid #c8d5c4; padding-left: 12px; margin-top: 16px; color: #4a4d45;">
      <div style="font-size: 12px; color: #8a8d84; margin-bottom: 8px; line-height: 1.6;">
        ———— Forwarded message ————<br>
        From: ${sender}<br>
        Date: ${date}<br>
        Subject: ${subject}<br>
        To: ${to}
      </div>
      <div style="font-size: 13px;">
        ${originalHtml}
      </div>
    </div>
  `;
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

  suggest.innerHTML = items.map((item, idx) => `
    <button class="compose-recipient-option ${idx === activeIndex ? "active" : ""}" type="button" data-idx="${idx}">
      <span class="compose-recipient-option-name">${escapeHtml(item.name || item.email)}</span>
      <span class="compose-recipient-option-email">${escapeHtml(item.email)}</span>
    </button>
  `).join("");

  suggest.classList.add("open");
  suggest.querySelectorAll(".compose-recipient-option").forEach((btn) => {
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const item = items[Number(btn.getAttribute("data-idx"))];
      if (item) addComposeRecipient(field, item);
    });
  });
}

function addComposeRecipient(field, contactLike) {
  const parsed = typeof contactLike === "string" ? parseContactToken(contactLike) : {
    email: normalizeEmailAddress(contactLike?.email || ""),
    name: sanitizeUnicodeNoise(contactLike?.name || ""),
  };

  if (!parsed?.email) return false;
  if ((composeRecipients[field] || []).some((e) => e.email === parsed.email)) return false;

  const known = contactsByEmail.get(parsed.email);
  const next = { email: parsed.email, name: parsed.name || known?.name || "" };
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
  if (!raw) { hideRecipientSuggestions(field); return; }

  const parts = parseContactsFromHeader(raw);
  if (!parts.length) {
    const fallback = parseContactToken(raw);
    if (fallback) addComposeRecipient(field, fallback);
    else hideRecipientSuggestions(field);
    return;
  }

  let changed = false;
  parts.forEach((contact) => { changed = addComposeRecipient(field, contact) || changed; });
  if (!changed) hideRecipientSuggestions(field);
}

function pickActiveRecipientSuggestion(field) {
  const state = recipientSuggestState[field];
  const item = state.items[state.activeIndex];
  if (!item) return false;
  return addComposeRecipient(field, item);
}

function setComposeRecipientsFromHeader(field, headerValue) {
  composeRecipients[field] = parseContactsFromHeader(headerValue).map((contact) => ({
    email: contact.email,
    name: contact.name || contactsByEmail.get(contact.email)?.name || "",
  }));
  renderRecipientChips(field);
  hideRecipientSuggestions(field);
}

function recipientString(field) {
  return (composeRecipients[field] || []).map((c) => c.email).join(", ");
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
      if (!pickActiveRecipientSuggestion(field)) commitRecipientInput(field);
      return;
    }
    if (event.key === "Tab" && open) {
      event.preventDefault();
      if (!pickActiveRecipientSuggestion(field)) commitRecipientInput(field);
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

  input.addEventListener("focus", () => renderRecipientSuggestions(field));
}

export function bindComposeRecipientInputs() {
  if (composeRecipientUiBound) return;
  composeRecipientUiBound = true;
  bindComposeRecipientField("to");
  bindComposeRecipientField("cc");
  renderRecipientChips("to");
  renderRecipientChips("cc");
}

function normalizeComposeHtml(rawHtml) {
  const trimmed = (rawHtml || "").trim();
  if (!trimmed || trimmed === "<br>" || trimmed === "<div><br></div>") return "";
  return rawHtml;
}

function collectComposePayload() {
  commitRecipientInput("to");
  commitRecipientInput("cc");

  const bodyInput = document.getElementById("compose-body");
  const subjectInput = document.getElementById("compose-subject");
  const bodyHtml = normalizeComposeHtml(bodyInput?.innerHTML || "");
  const body = bodyInput?.innerText || "";

  return {
    to: recipientString("to"),
    cc: recipientString("cc"),
    subject: subjectInput?.value?.trim() || "",
    body,
    bodyHtml,
  };
}

export function resetComposeState() {
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
  composeInReplyTo = null;
  composeReferences = null;
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
  element.replaceWith(document.createTextNode(element.textContent || ""));
}

function applyFormatToComposer(formatType) {
  const editor = document.getElementById("compose-body");
  if (!editor) return;
  editor.focus();

  if (formatType === "bold") { document.execCommand("bold"); }
  else if (formatType === "italic") { document.execCommand("italic"); }
  else if (formatType === "header") { document.execCommand("formatBlock", false, closestInEditor(editor, "h2") ? "p" : "h2"); }
  else if (formatType === "list") { document.execCommand("insertUnorderedList"); }
  else if (formatType === "quote") { document.execCommand("formatBlock", false, closestInEditor(editor, "blockquote") ? "p" : "blockquote"); }
  else if (formatType === "code") {
    const existingPre = closestInEditor(editor, "pre");
    if (existingPre) unwrapElementToText(existingPre);
    else { const selected = window.getSelection()?.toString() || "code"; document.execCommand("insertHTML", false, `<pre><code>${escapeHtml(selected)}</code></pre>`); }
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

export function bindComposeFormatting() {
  const formatToggle = document.getElementById("compose-format-btn");
  const toolbar = document.getElementById("compose-format-toolbar");
  if (!formatToggle || !toolbar) return;

  formatToggle.addEventListener("click", () => {
    toolbar.classList.toggle("open");
    formatToggle.classList.toggle("active", toolbar.classList.contains("open"));
    if (toolbar.classList.contains("open")) composeSendMode = "html";
  });

  toolbar.querySelectorAll("[data-format]").forEach((button) => {
    button.addEventListener("click", () => applyFormatToComposer(button.getAttribute("data-format") || "bold"));
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
      <button class="compose-attachment-remove" aria-label="Remove attachment">x</button>
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
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function bindComposeAttachments() {
  const attachBtn = document.getElementById("compose-attach-btn");
  const fileInput = document.getElementById("compose-file-input");
  if (!attachBtn || !fileInput) return;

  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    for (const file of files) {
      const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
      composeAttachments.push({ filename: file.name, contentType: file.type || "application/octet-stream", dataBase64 });
    }
    fileInput.value = "";
    renderComposeAttachments();
  });

  window.addEventListener("verdant-compose-opened", () => {
    if (_suppressNextReset) {
      _suppressNextReset = false;
      return;
    }
    if (!composeDraftId) resetComposeState();
  });
  window.addEventListener("verdant-compose-closed", () => resetComposeState());
}

export function bindComposeWindowControls() {
  const maxBtn = document.getElementById("compose-max-btn");
  const closeBtn = document.getElementById("compose-close-btn");
  const modal = document.getElementById("composeModal");
  if (!modal) return;

  const toggleMaximized = () => {
    const dialog = modal.querySelector(".compose-modal");
    if (!dialog) return;
    dialog.classList.toggle("compose-maximized");
  };

  if (maxBtn) maxBtn.onclick = toggleMaximized;
  if (closeBtn) closeBtn.onclick = closeCompose;
  window.toggleComposeMaximized = toggleMaximized;

  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeCompose();
  });

  document.getElementById("compose-open-btn")?.addEventListener("click", openCompose);
}

export function bindComposeSend(onAfterSend) {
  const sendBtn = document.getElementById("compose-send-btn");
  if (!sendBtn) return;

  const doSend = async () => {
    if (sendBtn.disabled) return;
    const payload = collectComposePayload();
    if (!payload.to) { showToast(t("toast.recipient_required"), "error"); return; }

    sendBtn.disabled = true;
    showToast(t("toast.sending"));
    try {
      if (composeDraftId) {
        const saved = await saveDraft({
          to: payload.to, cc: payload.cc, subject: payload.subject,
          body: payload.body, mode: composeSendMode,
          bodyHtml: composeSendMode === "html" ? payload.bodyHtml : null,
          attachments: composeAttachments, draftId: composeDraftId,
        });
        await sendExistingDraft(saved.draft_id || composeDraftId);
      } else {
        await sendEmail({
          to: payload.to, cc: payload.cc, subject: payload.subject,
          body: payload.body, mode: composeSendMode,
          bodyHtml: composeSendMode === "html" ? payload.bodyHtml : null,
          attachments: composeAttachments,
          inReplyTo: composeInReplyTo || null,
          references: composeReferences || null,
        });
      }
      parseContactsFromHeader(payload.to).forEach((c) => upsertContact(c.email, c.name));
      parseContactsFromHeader(payload.cc).forEach((c) => upsertContact(c.email, c.name));
      showToast(t("toast.sent"));
      closeCompose();
      await onAfterSend();
    } catch (err) {
      showToast(String(err), "error", 4000);
    } finally {
      sendBtn.disabled = false;
    }
  };

  sendBtn.addEventListener("click", doSend);

  document.getElementById("composeModal")?.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      doSend();
    }
  });
}

export function bindComposeDraftSave(onAfterSave) {
  const draftBtn = document.getElementById("compose-save-draft-btn");
  if (!draftBtn) return;

  draftBtn.addEventListener("click", async () => {
    const payload = collectComposePayload();
    showToast(t("toast.draft_saving"));
    const result = await saveDraft({
      to: payload.to, cc: payload.cc, subject: payload.subject,
      body: payload.body, mode: composeSendMode,
      bodyHtml: composeSendMode === "html" ? payload.bodyHtml : null,
      attachments: composeAttachments, draftId: composeDraftId,
    });
    composeDraftId = result.draft_id || composeDraftId;
    showToast(t("toast.draft_saved"));
    await onAfterSave();
  });
}
