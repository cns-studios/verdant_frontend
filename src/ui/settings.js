import { logout, clearLocalData, getMailboxCounts, authStatus } from "../api.js";
import { checkForUpdates, downloadLatestUpdate } from "../api.js";
import { escapeHtml } from "../lib/format.js";
import { showToast } from "../lib/toast.js";
import { loadHotkeys, saveHotkeys, defaultHotkeys, normalizeCombo } from "../lib/hotkeys.js";
import { syncMailboxInBackground, lastSynced } from "../lib/sync.js";
import { t, getLang, setLang, getSupportedLanguages } from "../lib/i18n.js";
import { getVersion } from "@tauri-apps/api/app";

const UPDATE_PREFS_KEY = "verdant.updatePrefs";
const defaultUpdatePrefs = { autoCheck: true, autoDownload: false, channel: "stable" };
export let updatePrefs = loadUpdatePrefs();

function loadUpdatePrefs() {
  try {
    const raw = localStorage.getItem(UPDATE_PREFS_KEY);
    const parsed = raw ? { ...defaultUpdatePrefs, ...JSON.parse(raw) } : { ...defaultUpdatePrefs };
    parsed.channel = parsed.channel === "nightly" ? "nightly" : "stable";
    return parsed;
  } catch {
    return { ...defaultUpdatePrefs };
  }
}

export function saveUpdatePrefs(next) {
  updatePrefs = { ...defaultUpdatePrefs, ...next };
  updatePrefs.channel = updatePrefs.channel === "nightly" ? "nightly" : "stable";
  localStorage.setItem(UPDATE_PREFS_KEY, JSON.stringify(updatePrefs));
}

function setUpdateStatus(message, isError = false) {
  const el = document.getElementById("settings-update-status");
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? "#8a3b3b" : "";
}

function setDownloadButtonEnabled(enabled) {
  const btn = document.getElementById("settings-download-update");
  if (btn) btn.disabled = !enabled;
}

export async function checkForAppUpdates(options = {}) {
  const {
    silent = true,
    autoDownload = false,
    updateSettingsUi = false,
    channel = updatePrefs.channel,
  } = options;

  try {
    const info = await checkForUpdates(channel);
    const channelLabel = channel === "nightly" ? t("settings.app.channel.nightly") : t("settings.app.channel.stable");

    if (updateSettingsUi) {
      if (info.updateAvailable) {
        setUpdateStatus(t("settings.app.update_available_status", { channel: channelLabel, version: info.latestVersion }));
      } else {
        setUpdateStatus(t("settings.app.up_to_date", { channel: channelLabel, version: info.currentVersion }));
      }
      setDownloadButtonEnabled(!!info.updateAvailable);
    }

    if (!info.updateAvailable) {
      if (!silent) showToast(t("toast.no_update"));
      return info;
    }

    if (!silent) showToast(t("toast.update_available", { channel: channelLabel, version: info.latestVersion }));

    if (autoDownload) {
      const downloaded = await downloadLatestUpdate(channel);
      if (updateSettingsUi) setUpdateStatus(t("toast.update_downloaded", { file: downloaded.fileName }));
      showToast(t("toast.update_downloaded", { file: downloaded.fileName }));
    }

    return info;
  } catch (error) {
    if (updateSettingsUi) {
      setUpdateStatus(t("settings.app.check_failed"), true);
      setDownloadButtonEnabled(false);
    }
    if (!silent) showToast(`${t("settings.app.check_failed")}: ${String(error)}`, "error");
    return null;
  }
}

export async function runAutomaticUpdateFlow() {
  if (!updatePrefs.autoCheck) return;
  await checkForAppUpdates({
    silent: true,
    autoDownload: updatePrefs.autoDownload,
    updateSettingsUi: false,
    channel: updatePrefs.channel,
  });
}

let hotkeys = loadHotkeys();

export function isSettingsOpen() {
  return !!document.getElementById("verdant-overlay");
}

export function showOverlay(title, message, buttons) {
  closeOverlay(true);
  const overlay = document.createElement("div");
  overlay.id = "verdant-overlay";
  overlay.className = "verdant-overlay";
  overlay.innerHTML = `
    <div class="verdant-panel">
      <div class="verdant-head">
        <h2>${escapeHtml(title)}</h2>
        <button class="verdant-close" aria-label="Close">×</button>
      </div>
      <p>${escapeHtml(message)}</p>
      <div class="verdant-actions"></div>
    </div>
  `;
  overlay.querySelector(".verdant-close")?.addEventListener("click", () => closeOverlay());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(); });
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

export function closeOverlay(immediate = false) {
  const overlay = document.getElementById("verdant-overlay");
  if (!overlay) return;
  if (immediate) { overlay.remove(); return; }
  overlay.classList.remove("open");
  setTimeout(() => overlay.remove(), 180);
}

export async function openSettingsModal(profile, currentMailbox, onLogout, onSync) {
  let auth = { connected: true };
  let counts = { inbox_total: 0, inbox_unread: 0, starred_total: 0, sent_total: 0, drafts_total: 0, archive_total: 0 };

  try {
    [auth, counts] = await Promise.all([authStatus(), getMailboxCounts()]);
  } catch {}

  const lastInboxSync = lastSynced.get("INBOX")
    ? new Date(lastSynced.get("INBOX")).toLocaleString()
    : t("settings.account.not_synced");

  const langs = getSupportedLanguages();
  const currentLang = getLang();

  const { getActiveAccountInfo } = await import("../api.js");
  const activeAccount = await getActiveAccountInfo().catch(() => ({ provider: 'gmail' }));
  const isGmail = activeAccount.provider === 'gmail';

  showOverlay(t("settings.title"), `${t("settings.account.email")}: ${profile.email}`, []);
  const panel = document.querySelector("#verdant-overlay .verdant-panel");
  if (!panel) return;

  const grid = document.createElement("div");
  grid.className = "settings-grid";
  grid.innerHTML = `
    <div class="settings-tabs">
      <button class="settings-tab active" data-tab="account">${escapeHtml(t("settings.tab.account"))}</button>
      <button class="settings-tab" data-tab="shortcuts">${escapeHtml(t("settings.tab.shortcuts"))}</button>
      <button class="settings-tab" data-tab="app">${escapeHtml(t("settings.tab.app"))}</button>
    </div>

    <!-- Account tab -->
    <section class="settings-pane active" data-pane="account">
      <div class="settings-card">
        <div class="settings-info-row"><span>${escapeHtml(t("settings.account.name"))}</span><strong>${escapeHtml(profile.name || "User")}</strong></div>
        <div class="settings-info-row"><span>${escapeHtml(t("settings.account.email"))}</span><strong>${escapeHtml(profile.email || "-")}</strong></div>
        ${isGmail ? `
        <div class="settings-info-row"><span>${escapeHtml(t("settings.account.gmail_status"))}</span><strong>${auth.connected ? escapeHtml(t("settings.account.gmail_connected")) : escapeHtml(t("settings.account.gmail_disconnected"))}</strong></div>
        ` : ''}
        <div class="settings-info-row"><span>${escapeHtml(t("settings.account.inbox"))}</span><strong>${escapeHtml(t("settings.account.inbox_value", { unread: counts.inbox_unread, total: counts.inbox_total }))}</strong></div>
        <div class="settings-info-row"><span>${escapeHtml(t("settings.account.last_sync"))}</span><strong>${escapeHtml(lastInboxSync)}</strong></div>
      </div>
      <div class="settings-section-label">${escapeHtml(t("settings.language"))}</div>
      <div class="settings-row">
        <span>${escapeHtml(t("settings.language"))}</span>
        <select id="settings-lang-select">
          ${langs.map(l => `<option value="${l.code}" ${l.code === currentLang ? "selected" : ""}>${escapeHtml(l.label)}</option>`).join("")}
        </select>
      </div>
      <div class="settings-actions">
        <button class="verdant-btn settings-danger" id="settings-logout">${escapeHtml(t("settings.account.logout"))}</button>
      </div>
    </section>

    <!-- Shortcuts tab -->
    <section class="settings-pane" data-pane="shortcuts">
      <label class="settings-switch">
        <input type="checkbox" id="hk-enabled" ${hotkeys.enabled ? "checked" : ""}>
        ${escapeHtml(t("settings.shortcuts.enabled"))}
      </label>
      <div class="settings-row"><span>${escapeHtml(t("settings.shortcuts.compose"))}</span><input id="hk-compose" value="${escapeHtml(hotkeys.compose)}" /></div>
      <div class="settings-row"><span>${escapeHtml(t("settings.shortcuts.maximize"))}</span><input id="hk-compose-maximize" value="${escapeHtml(hotkeys.composeMaximize)}" /></div>
      <div class="settings-row"><span>${escapeHtml(t("settings.shortcuts.refresh"))}</span><input id="hk-refresh" value="${escapeHtml(hotkeys.refresh)}" /></div>
      <div class="settings-row"><span>${escapeHtml(t("settings.shortcuts.settings"))}</span><input id="hk-settings" value="${escapeHtml(hotkeys.settings)}" /></div>
      <div class="settings-row"><span>${escapeHtml(t("settings.shortcuts.search"))}</span><input id="hk-search" value="${escapeHtml(hotkeys.search)}" /></div>
      <div class="settings-actions">
        <button class="verdant-btn" id="settings-save">${escapeHtml(t("settings.shortcuts.save"))}</button>
      </div>
    </section>

    <!-- App tab -->
    <section class="settings-pane" data-pane="app">

      <div class="settings-section-label">Version</div>
      <div class="settings-card">
        <div class="settings-info-row">
          <span>${escapeHtml(t("settings.app.installed_version"))}</span>
          <strong id="settings-installed-version">${escapeHtml(t("app.version_loading"))}</strong>
        </div>
        <div class="settings-info-row">
          <span>${escapeHtml(t("settings.app.update_status"))}</span>
          <strong id="settings-update-status">${escapeHtml(t("settings.app.update_not_checked"))}</strong>
        </div>
      </div>

      <div class="settings-section-label">${escapeHtml(t("settings.app.update_channel"))}</div>
      <div class="settings-card">
        <div class="settings-row">
          <span>${escapeHtml(t("settings.app.update_channel"))}</span>
          <select id="update-channel">
            <option value="stable" ${updatePrefs.channel === "stable" ? "selected" : ""}>${escapeHtml(t("settings.app.channel.stable"))}</option>
            <option value="nightly" ${updatePrefs.channel === "nightly" ? "selected" : ""}>${escapeHtml(t("settings.app.channel.nightly"))}</option>
          </select>
        </div>
        <label class="settings-switch">
          <input type="checkbox" id="update-auto-check" ${updatePrefs.autoCheck ? "checked" : ""}>
          ${escapeHtml(t("settings.app.auto_check"))}
        </label>
        <label class="settings-switch">
          <input type="checkbox" id="update-auto-download" ${updatePrefs.autoDownload ? "checked" : ""}>
          ${escapeHtml(t("settings.app.auto_download"))}
        </label>
      </div>
      <div class="settings-actions">
        <button class="verdant-btn" id="settings-check-update">${escapeHtml(t("settings.app.check_update"))}</button>
        <button class="verdant-btn" id="settings-download-update" disabled>${escapeHtml(t("settings.app.download_update"))}</button>
      </div>

      <div class="settings-section-label">${escapeHtml(t("settings.tab.account"))}</div>
      <div class="settings-card">
        <div class="settings-help">${escapeHtml(t("settings.app.cache_info"))}</div>
      </div>
      <div class="settings-actions">
        <button class="verdant-btn" id="settings-sync">${escapeHtml(t("settings.app.sync_now"))}</button>
        <button class="verdant-btn" id="settings-clear">${escapeHtml(t("settings.app.clear_db"))}</button>
      </div>

    </section>
  `;
  panel.appendChild(grid);

  // Load version
  getVersion().then((v) => {
    const el = panel.querySelector("#settings-installed-version");
    if (el) el.textContent = `v${v}`;
  }).catch(() => {
    const el = panel.querySelector("#settings-installed-version");
    if (el) el.textContent = t("app.version_unknown");
  });

  // Tab switching
  const tabs = Array.from(panel.querySelectorAll(".settings-tab"));
  const panes = Array.from(panel.querySelectorAll(".settings-pane"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.getAttribute("data-tab");
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      panes.forEach((pane) => pane.classList.toggle("active", pane.getAttribute("data-pane") === target));
    });
  });

  // Language
  panel.querySelector("#settings-lang-select")?.addEventListener("change", (e) => {
    setLang(e.target.value);
    closeOverlay();
    openSettingsModal(profile, currentMailbox, onLogout, onSync);
  });

  // Shortcuts
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
    showToast(t("toast.shortcuts_saved"));
  });

  // Update channel
  panel.querySelector("#update-channel")?.addEventListener("change", (e) => {
    const value = e.target?.value === "nightly" ? "nightly" : "stable";
    saveUpdatePrefs({ ...updatePrefs, channel: value });
    const label = value === "nightly" ? t("settings.app.channel.nightly") : t("settings.app.channel.stable");
    setUpdateStatus(t("settings.app.channel_set", { channel: label }));
    setDownloadButtonEnabled(false);
  });

  panel.querySelector("#update-auto-check")?.addEventListener("change", (e) => {
    saveUpdatePrefs({ ...updatePrefs, autoCheck: !!e.target?.checked });
  });

  panel.querySelector("#update-auto-download")?.addEventListener("change", (e) => {
    saveUpdatePrefs({ ...updatePrefs, autoDownload: !!e.target?.checked });
  });

  panel.querySelector("#settings-check-update")?.addEventListener("click", async () => {
    setUpdateStatus(t("settings.app.checking"));
    await checkForAppUpdates({ silent: false, autoDownload: false, updateSettingsUi: true, channel: updatePrefs.channel });
  });

  // Download + install + relaunch
  panel.querySelector("#settings-download-update")?.addEventListener("click", async () => {
    const btn = panel.querySelector("#settings-download-update");
    if (btn) { btn.disabled = true; btn.textContent = t("settings.app.downloading"); }

    setUpdateStatus(t("settings.app.checking"));
    const info = await checkForAppUpdates({ silent: true, autoDownload: false, updateSettingsUi: true, channel: updatePrefs.channel });
    if (!info?.updateAvailable) {
      showToast(t("toast.no_update"));
      if (btn) { btn.disabled = false; btn.textContent = t("settings.app.download_update"); }
      return;
    }

    setUpdateStatus(t("settings.app.downloading"));
    try {
      const downloaded = await downloadLatestUpdate(updatePrefs.channel);
      setUpdateStatus(t("toast.update_downloaded", { file: downloaded.fileName }));
      showToast(t("toast.update_downloaded", { file: downloaded.fileName }));

      // Install
      if (btn) btn.textContent = t("update.installing");
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("install_and_relaunch", { filePath: downloaded.filePath });

      // Relaunch
      if (btn) btn.textContent = t("update.restarting");
      await new Promise(r => setTimeout(r, 600));
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      setUpdateStatus(t("settings.app.download_failed"), true);
      showToast(`${t("settings.app.download_failed")}: ${String(error)}`, "error");
      if (btn) { btn.disabled = false; btn.textContent = t("settings.app.download_update"); }
    }
  });

  panel.querySelector("#settings-sync")?.addEventListener("click", async () => {
    showToast(t("toast.fetching"));
    await onSync();
    showToast(t("toast.sync_complete"));
  });

  panel.querySelector("#settings-clear")?.addEventListener("click", async () => {
    await clearLocalData();
    closeOverlay();
    showToast(t("toast.db_cleared"));
    await onSync();
  });

  panel.querySelector("#settings-logout")?.addEventListener("click", async () => {
    await logout();
    closeOverlay();
    onLogout();
  });
}
