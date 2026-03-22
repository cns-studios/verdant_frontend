import { authStatus, getUserProfile, getEmails, syncMailboxPage } from "./api.js";
import { setEmailReadStatus } from "./api.js";
import { ingestContactsFromEmails, ensureContactsLoaded } from "./lib/contacts.js";
import { loadHotkeys, saveHotkeys, normalizeCombo, eventCombo, canRunHotkey } from "./lib/hotkeys.js";
import { showToast } from "./lib/toast.js";
import { escapeHtml, sanitizeUnicodeNoise, formatListDate, mailboxTitle } from "./lib/format.js";
import { syncMailboxInBackground, startPeriodicSync, mailboxNextPageToken, knownInboxIds, setKnownInboxIds } from "./lib/sync.js";
import { ensureStyles } from "./ui/styles.js";
import { renderShell } from "./ui/shell.js";
import { showOnboarding } from "./ui/onboarding.js";
import {
  bindMailboxNav, bindPaneResizer, bindAppHeaderControls,
  refreshCounts, setUserProfile, bindUserRow, setListTitle, refreshAppHeaderSubtitle,
} from "./ui/sidebar.js";
import {
  renderReadingPane, bindReadingActions, setReadingPaneHidden,
  applySenderAvatar, hasEmailAttachments, updateTopActionStates,
} from "./ui/reading.js";
import {
  isComposeOpen, openCompose, closeCompose, openComposeForDraft,
  bindComposeRecipientInputs, bindComposeFormatting, bindComposeAttachments,
  bindComposeWindowControls, bindComposeSend, bindComposeDraftSave,
} from "./ui/compose.js";
import {
  openSettingsModal, isSettingsOpen, closeOverlay,
  updatePrefs,
} from "./ui/settings.js";
import { checkForUpdates, downloadLatestUpdate } from "./api.js";
import { getInboxThreads } from "./api.js";
import {
  renderThreadList, bindThreadActions,
  getSelectedThreadId, clearSelectedThread,
} from "./ui/thread.js";
import { t, initLang } from "./lib/i18n.js";


let currentMailbox = "INBOX";
let currentEmails = [];
let selectedEmail = null;
let activeFilter = "Important";
let searchQuery = "";
let isDeepSearchActive = false;
let isFetchingMore = false;
let hotkeys = loadHotkeys();

function injectUpdateModalStyles() {
  if (document.getElementById("verdant-update-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "verdant-update-modal-styles";
  style.textContent = `
    .update-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: min(360px, calc(100vw - 48px));
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 16px 40px rgba(30,33,25,.18);
      padding: 18px 18px 14px;
      z-index: 3000;
      transform: translateY(110%);
      opacity: 0;
      transition: transform .32s cubic-bezier(.34,1.56,.64,1), opacity .24s ease;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .update-toast.open {
      transform: translateY(0);
      opacity: 1;
    }
    .update-toast-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }
    .update-toast-title {
      font: 500 14px 'Fraunces', serif;
      color: var(--text);
      letter-spacing: -.2px;
    }
    .update-toast-sub {
      font: 400 12px 'DM Sans', sans-serif;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .update-toast-close {
      width: 24px;
      height: 24px;
      border: 1px solid var(--border);
      background: var(--surface2);
      border-radius: 6px;
      cursor: pointer;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }
    .update-toast-close:hover { background: var(--white); color: var(--text); }
    .update-toast-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .update-toast-btn {
      padding: 7px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface2);
      color: var(--text);
      font: 500 12px 'DM Sans', sans-serif;
      cursor: pointer;
    }
    .update-toast-btn.primary {
      background: var(--green);
      color: #fff;
      border-color: var(--green);
    }
    .update-toast-btn:disabled { opacity: .6; cursor: default; }
    .update-progress-wrap {
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .update-progress-wrap.visible { display: flex; }
    .update-progress-label {
      font: 400 12px 'DM Sans', sans-serif;
      color: var(--text-muted);
    }
    .update-progress-track {
      height: 6px;
      border-radius: 999px;
      background: var(--surface2);
      overflow: hidden;
    }
    .update-progress-bar {
      height: 100%;
      border-radius: 999px;
      background: var(--green);
      width: 0%;
      transition: width .4s ease;
    }
    .update-progress-bar.indeterminate {
      position: relative;
      width: 100% !important;
      animation: none;
      background: linear-gradient(
        90deg,
        var(--surface2) 0%,
        var(--green) 40%,
        var(--green-light) 60%,
        var(--surface2) 100%
      );
      background-size: 200% 100%;
      animation: verdant-shimmer 1.4s linear infinite;
    }
    @keyframes verdant-shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
  `;
  document.head.appendChild(style);
}

async function runStartupUpdateCheck() {
  try {
    const channel = updatePrefs?.channel || "stable";
    const info = await checkForUpdates(channel);
    if (!info?.updateAvailable) return;

    injectUpdateModalStyles();

    const toast = document.createElement("div");
    toast.className = "update-toast";
    toast.innerHTML = `
      <div class="update-toast-header">
        <div>
          <div class="update-toast-title">${t("update.title", { version: escapeHtml(info.latestVersion) })}</div>
          <div class="update-toast-sub">${escapeHtml(info.releaseName || "")}</div>
        </div>
        <button class="update-toast-close" id="update-toast-close" aria-label="Dismiss">×</button>
      </div>
      <div class="update-progress-wrap" id="update-progress-wrap">
        <div class="update-progress-label" id="update-progress-label">${t("update.downloading")}</div>
        <div class="update-progress-track">
          <div class="update-progress-bar indeterminate" id="update-progress-bar"></div>
        </div>
      </div>
      <div class="update-toast-actions" id="update-toast-actions">
        <button class="update-toast-btn" id="update-toast-dismiss">${t("update.later")}</button>
        <button class="update-toast-btn primary" id="update-toast-download">${t("update.download")}</button>
      </div>
    `;

    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("open"));

    const close = () => {
      toast.classList.remove("open");
      setTimeout(() => toast.remove(), 350);
    };

    toast.querySelector("#update-toast-close").onclick = close;
    toast.querySelector("#update-toast-dismiss").onclick = close;

    toast.querySelector("#update-toast-download").onclick = async () => {
      toast.querySelector("#update-toast-actions").style.display = "none";
      toast.querySelector("#update-toast-close").style.display = "none";
      const progressWrap = toast.querySelector("#update-progress-wrap");
      const progressLabel = toast.querySelector("#update-progress-label");
      progressWrap.classList.add("visible");

      try {
        progressLabel.textContent = t("update.downloading");
        const result = await downloadLatestUpdate(channel);

        progressLabel.textContent = t("update.installing");
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("install_and_relaunch", { filePath: result.filePath });

        progressLabel.textContent = t("update.restarting");
        await new Promise((r) => setTimeout(r, 800));
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch (err) {
        progressLabel.textContent = t("update.failed", { error: String(err) });
        toast.querySelector("#update-progress-bar").classList.remove("indeterminate");
        toast.querySelector("#update-progress-bar").style.background = "#c08d8d";
        setTimeout(() => {
          toast.querySelector("#update-toast-actions").style.display = "flex";
          toast.querySelector("#update-toast-close").style.display = "flex";
          toast.querySelector("#update-toast-dismiss").textContent = t("reading.close");
          toast.querySelector("#update-toast-download").style.display = "none";
        }, 1800);
      }
    };
  } catch {
  }
}

function isImportant(email) {
  const labels = (email.labels || "").split(",").map(l => l.trim());
  return !labels.some(l =>
    l === "SPAM" ||
    l === "TRASH" ||
    l === "CATEGORY_PROMOTIONS"
  );
}

function emailMatchesFilter(email) {
  if (activeFilter === "Important" && !isImportant(email)) return false;
  if (activeFilter === "Unread" && email.is_read) return false;
  if (activeFilter === "Attachments" && !hasEmailAttachments(email)) return false;
  if (searchQuery) {
    const hay = `${email.subject || ""} ${email.sender || ""} ${email.snippet || ""}`.toLowerCase();
    if (!hay.includes(searchQuery.toLowerCase())) return false;
  }
  return true;
}

function visibleEmails() {
  return (currentEmails || []).filter(emailMatchesFilter);
}

function renderEmailList(animate = false) {
  const list = document.getElementById("email-list");
  if (!list) return;

  list.innerHTML = "";
  list.classList.toggle("suppress-anim", !animate);

  const emails = visibleEmails();
  setListTitle(currentMailbox, emails.length);

  const selectedId = selectedEmail?.id || null;
  let selectedRow = null;
  let selectedRowEmail = null;

  for (const email of emails) {
    const row = document.createElement("div");
    row.className = `email-item ${email.is_read ? "" : "unread"}`.trim();
    row.innerHTML = `
      ${email.is_read ? "" : '<div class="unread-dot"></div>'}
      <div class="email-item-main">
        <div class="sender-avatar"></div>
        <div class="email-item-inner">
          <div class="email-top">
            <span class="email-sender">${escapeHtml(sanitizeUnicodeNoise(email.sender || t("app.unknown_sender")))}</span>
            <span class="email-time">${escapeHtml(formatListDate(email.date))}</span>
          </div>
          <div class="email-subject">${escapeHtml(sanitizeUnicodeNoise(email.subject || t("app.no_subject")))}</div>
          <div class="email-preview">${escapeHtml(sanitizeUnicodeNoise(email.snippet || ""))}</div>
        </div>
      </div>
    `;

    applySenderAvatar(row.querySelector(".sender-avatar"), email.sender || "", email.mailbox || "");
    row.addEventListener("click", () => selectEmail(email, row));

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
    if (first) selectEmail(emails[0], first);
  }
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

async function markSelectedAsReadIfNeeded() {
  if (!selectedEmail || selectedEmail.is_read) return;
  selectedEmail.is_read = true;
  await setEmailReadStatus(selectedEmail.id, true);
  await refreshCounts();
}

async function loadLocalMailbox(mailbox, animate = false) {
  const mailboxChanged = currentMailbox !== mailbox;
  if (mailboxChanged) {
    selectedEmail = null;
    clearSelectedThread();
    isDeepSearchActive = false;
  }
  currentMailbox = mailbox;

  if (mailbox === "INBOX") {
    const threads = await getInboxThreads();
    ingestContactsFromEmails([]);
    renderThreadList(threads, activeFilter, searchQuery);
  } else {
    currentEmails = await getEmails(mailbox);
    ingestContactsFromEmails(currentEmails);
    renderEmailList(animate);
  }

  refreshAppHeaderSubtitle(currentMailbox, isComposeOpen, isSettingsOpen);
  await refreshCounts();
}


async function openMailbox(mailbox, animate = false) {
  await loadLocalMailbox(mailbox, animate);
  syncMailboxInBackground(mailbox, false, onSynced).catch((err) => {
    console.error("Background sync failed:", err);
    showToast(String(err), "error", 2500);
  });
}

function onSynced(mailbox, latestEmails) {
  if (currentMailbox === mailbox) {
    if (mailbox === "INBOX") {
      getInboxThreads().then(threads => {
        renderThreadList(threads, activeFilter, searchQuery);
      }).catch(console.error);
    } else {
      currentEmails = latestEmails;
      renderEmailList(false);
    }
    refreshCounts().catch(console.error);
  }
}


async function refreshAfterAction() {
  await loadLocalMailbox(currentMailbox, false);
  syncMailboxInBackground(currentMailbox, false, onSynced).catch(() => {});
}

function bindInfiniteScroll() {
  const list = document.getElementById("email-list");
  if (!list) return;
  list.addEventListener("scroll", () => {
    const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (remaining < 80) fetchMoreCurrentMailbox().catch(console.error);
  });
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
  if (isFetchingMore || isDeepSearchActive || searchQuery.trim()) return;
  const token = mailboxNextPageToken.get(currentMailbox);
  if (!token) return;

  isFetchingMore = true;
  setListFetchIndicator(t("list.loading_more"));
  try {
    const next = await syncMailboxPage(currentMailbox, token);
    mailboxNextPageToken.set(currentMailbox, next || null);
    currentEmails = await getEmails(currentMailbox);
    renderEmailList(false);
    if (!next) {
      setListFetchIndicator(t("list.no_more"));
      setTimeout(() => setListFetchIndicator(""), 1000);
    }
  } catch (error) {
    console.error("Failed to fetch more emails", error);
    setListFetchIndicator("");
  } finally {
    isFetchingMore = false;
    if (mailboxNextPageToken.get(currentMailbox)) setListFetchIndicator("");
  }
}

function bindSearch() {
  const input = document.getElementById("search-input");
  if (!input) return;

  const searchBar = input.closest(".search-bar");
  let deepBtn = document.getElementById("deep-search-btn");
  if (!deepBtn && searchBar) {
    deepBtn = document.createElement("button");
    deepBtn.id = "deep-search-btn";
    deepBtn.className = "deep-search-btn";
    deepBtn.textContent = t("list.search.deep");
    searchBar.appendChild(deepBtn);
    searchBar.classList.add("has-deep-btn");
  }

  const updateDeepButtonVisibility = () => {
    if (deepBtn) deepBtn.hidden = !searchQuery.trim();
  };

  deepBtn?.addEventListener("click", async () => {
    if (!searchQuery.trim()) return;
    deepBtn.disabled = true;
    deepBtn.textContent = t("list.search.searching");
    try {
      const { deepSearchEmails } = await import("./api.js");
      const results = await deepSearchEmails(searchQuery.trim());
      isDeepSearchActive = true;
      currentEmails = results || [];
      renderEmailList(false);
      setListTitle(currentMailbox, currentEmails.length);
    } catch (error) {
      showToast(String(error), "error", 2600);
    } finally {
      deepBtn.disabled = false;
      deepBtn.textContent = t("list.search.deep");
      updateDeepButtonVisibility();
    }
  });

  input.addEventListener("input", () => {
    searchQuery = input.value || "";
    if (!searchQuery.trim()) isDeepSearchActive = false;

    if (currentMailbox === "INBOX") {
      getInboxThreads().then(threads => {
        renderThreadList(threads, activeFilter, searchQuery);
      }).catch(console.error);
    } else {
      renderEmailList(false);
    }

    updateDeepButtonVisibility();
  });

  updateDeepButtonVisibility();
}

function bindFilterChips() {
  const chips = Array.from(document.querySelectorAll(".filter-chips .chip"));
  chips.forEach((chip) => {
    chip.onclick = () => {
      chips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeFilter = chip.dataset.filter || "All";

      if (currentMailbox === "INBOX") {
        getInboxThreads().then(threads => {
          renderThreadList(threads, activeFilter, searchQuery);
        }).catch(console.error);
      } else {
        renderEmailList(false);
      }
    };
  });
}


function bindHotkeys() {
  document.addEventListener("keydown", async (event) => {
    const combo = normalizeCombo(eventCombo(event));

    if (combo === hotkeys.close) {
      if (isSettingsOpen()) { closeOverlay(); return; }
      if (isComposeOpen()) { closeCompose(); }
      return;
    }

    if (!hotkeys.enabled) return;

    if (combo === hotkeys.compose) {
      event.preventDefault();
      if (!canRunHotkey("compose")) return;
      openCompose();
      return;
    }

    if (combo === hotkeys.composeMaximize) {
      if (!isComposeOpen()) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      if (!canRunHotkey("composeMaximize")) return;
      if (typeof window.toggleComposeMaximized === "function") window.toggleComposeMaximized();
      return;
    }

    if (combo === hotkeys.refresh) {
      event.preventDefault();
      if (!canRunHotkey("refresh")) return;
      showToast(t("toast.fetching"));
      await syncMailboxInBackground(currentMailbox, true, onSynced);
      return;
    }

    if (combo === hotkeys.settings) {
      event.preventDefault();
      if (!canRunHotkey("settings")) return;
      const profile = await getUserProfile();
      await openSettingsModal(profile, currentMailbox, showOnboardingAndReset, onSync);
      return;
    }

    if (combo === hotkeys.search) {
      event.preventDefault();
      if (!canRunHotkey("search")) return;
      document.getElementById("search-input")?.focus();
    }
  });
}

async function onSync() {
  await syncMailboxInBackground(currentMailbox, true, onSynced);
  await refreshCounts();
}

function showOnboardingAndReset() {
  document.getElementById("root").innerHTML = "";
  initLang();
  showOnboarding(initializeConnectedUI);
}

async function initializeConnectedUI() {
  renderShell();

  bindAppHeaderControls(isComposeOpen, isSettingsOpen, () => currentMailbox);
  bindMailboxNav(async (mailbox) => {
    searchQuery = "";
    const input = document.getElementById("search-input");
    if (input) { input.value = ""; input.dispatchEvent(new Event("input")); }
    await openMailbox(mailbox, true);
  });
  bindReadingActions(
    () => selectedEmail,
    (v) => { selectedEmail = v; },
    refreshAfterAction,
    openComposeForDraft,
    () => currentMailbox,
    () => getSelectedThreadId(),
  );
  bindFilterChips();
  bindSearch();
  bindPaneResizer();
  bindInfiniteScroll();
  bindComposeWindowControls();
  bindComposeRecipientInputs();
  bindComposeFormatting();
  bindComposeAttachments();
  bindComposeSend(async () => { await openMailbox(currentMailbox, false); });
  bindComposeDraftSave(async () => { await openMailbox(currentMailbox, false); });
  bindHotkeys();
  bindThreadActions(
    refreshAfterAction,
    () => refreshCounts().catch(console.error)
  );

  const profile = await getUserProfile();
  setUserProfile(profile);
  bindUserRow(() =>
    openSettingsModal(profile, currentMailbox, showOnboardingAndReset, onSync).catch(console.error)
  );

  const inboxNow = await getEmails("INBOX");
  ingestContactsFromEmails(inboxNow);
  setKnownInboxIds(new Set((inboxNow || []).map((m) => m.id)));

  await openMailbox("INBOX", true);
  startPeriodicSync(onSynced);

  runStartupUpdateCheck().catch(() => {});
}

document.addEventListener("DOMContentLoaded", async () => {
  ensureStyles();
  initLang(); // must be before renderShell so all t() calls use correct language

  await ensureContactsLoaded().catch(() => {});

  try {
    const status = await authStatus();

    if (!status.has_client_id) {
      renderShell();
      document.getElementById("root").innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:'DM Sans',sans-serif;color:var(--text-mid);flex-direction:column;gap:12px;">
          <div style="font:500 15px 'Fraunces',serif;color:var(--text);">${t("app.config_required")}</div>
          <div style="font-size:13px;">${t("app.config_missing")}</div>
        </div>
      `;
      return;
    }

    if (!status.connected) {
      showOnboarding(initializeConnectedUI);
      return;
    }

    await initializeConnectedUI();
  } catch (error) {
    document.getElementById("root").innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:'DM Sans',sans-serif;color:var(--text-mid);flex-direction:column;gap:12px;">
        <div style="font:500 15px 'Fraunces',serif;color:var(--text);">${t("app.init_failed")}</div>
        <div style="font-size:13px;">${escapeHtml(String(error))}</div>
        <button onclick="window.location.reload()" style="margin-top:8px;padding:8px 16px;background:var(--green);color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:'DM Sans',sans-serif;">${t("app.retry")}</button>
      </div>
    `;
  }
});
