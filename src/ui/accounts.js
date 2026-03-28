import {
    listAccounts, switchAccount, removeAccount,
    addGmailAccount, addImapAccount, addGmxAccount, testImapCredentials,
} from "../api.js";
import { escapeHtml } from "../lib/format.js";
import { showToast } from "../lib/toast.js";
import { t } from "../lib/i18n.js";



let _popoverOpen = false;

export function isAccountPopoverOpen() { return _popoverOpen; }

export async function openAccountPopover(onSwitch, onAddAccount) {
    closeAccountPopover();

    let accounts = [];
    try { accounts = await listAccounts(); } catch {}

    _popoverOpen = true;

    
    const backdrop = document.createElement("div");
    backdrop.className = "account-popover-backdrop";
    backdrop.onclick = closeAccountPopover;
    document.body.appendChild(backdrop);

    
    const pop = document.createElement("div");
    pop.className = "account-popover";
    pop.id = "account-popover";

    
    const accSection = document.createElement("div");
    accSection.className = "account-popover-section";

    if (accounts.length > 0) {
        const label = document.createElement("div");
        label.className = "account-popover-label";
        label.textContent = t("sidebar.accounts");
        accSection.appendChild(label);

        for (const acc of accounts) {
            const item = document.createElement("div");
            item.className = `account-item${acc.is_active ? " is-active" : ""}`;

            const initials = (acc.display_name || acc.email).slice(0, 2).toUpperCase();
            item.innerHTML = `
                <div class="account-avatar ${acc.provider === 'imap' ? 'imap' : ''}">${escapeHtml(initials)}</div>
                <div class="account-item-info">
                    <div class="account-item-email" title="${escapeHtml(acc.email)}">${escapeHtml(acc.email)}</div>
                    <div class="account-item-provider">${escapeHtml(acc.provider === 'imap' ? 'IMAP' : 'Gmail')}</div>
                </div>
                ${acc.is_active ? '<div class="account-active-dot"></div>' : ''}
                ${!acc.is_active ? `<button class="account-remove-btn" title="${t("reading.delete")}">×</button>` : ''}
            `;

            if (!acc.is_active) {
                item.addEventListener("click", async (e) => {
                    if (e.target.classList.contains("account-remove-btn")) return;
                    closeAccountPopover();
                    try {
                        await switchAccount(acc.id);
                        onSwitch(acc.id);
                    } catch (err) {
                        showToast(String(err), "error");
                    }
                });

                const removeBtn = item.querySelector(".account-remove-btn");
                removeBtn?.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    if (!confirm(t("accounts.confirm_remove", { email: acc.email }))) return;
                    closeAccountPopover();
                    try {
                        await removeAccount(acc.id);
                        showToast(t("accounts.removed"));
                        onSwitch(null); 
                    } catch (err) {
                        showToast(String(err), "error");
                    }
                });
            }

            accSection.appendChild(item);
        }
    }

    pop.appendChild(accSection);

    
    const actSection = document.createElement("div");
    actSection.className = "account-popover-section";

    const addBtn = document.createElement("div");
    addBtn.className = "account-popover-action";
    addBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
        ${t("sidebar.add_account")}
    `;
    addBtn.onclick = () => {
        closeAccountPopover();
        openAddAccountModal(onSwitch, onAddAccount);
    };
    actSection.appendChild(addBtn);

    const settingsBtn = document.createElement("div");
    settingsBtn.className = "account-popover-action";
    settingsBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        ${t("settings.title")}
    `;
    settingsBtn.onclick = () => {
        closeAccountPopover();
        
        window.dispatchEvent(new CustomEvent("verdant-open-settings"));
    };
    actSection.appendChild(settingsBtn);
    pop.appendChild(actSection);

    document.body.appendChild(pop);
}

export function closeAccountPopover() {
    document.getElementById("account-popover")?.remove();
    document.querySelector(".account-popover-backdrop")?.remove();
    _popoverOpen = false;
}



const mailIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`;
const globeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
const serverIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`;

const PROVIDERS = [
    { id: "gmail", name: "Gmail",       icon: mailIcon,   desc: "Google OAuth" },
    { id: "gmx",   name: "GMX",         icon: globeIcon,  desc: "IMAP / SMTP" },
    { id: "imap",  name: "Custom SMTP", icon: serverIcon, desc: "Any mail server" },
];

export function openAddAccountModal(onSwitch, onAfterAdd, initialProvider = null) {
    document.getElementById("add-account-overlay")?.remove();

    let selectedProvider = null;

    const overlay = document.createElement("div");
    overlay.className = "add-account-overlay";
    overlay.id = "add-account-overlay";

    const panel = document.createElement("div");
    panel.className = "add-account-panel";

    panel.innerHTML = `
        <div class="add-account-header">
            <span class="add-account-title">${t("accounts.title")}</span>
            <button class="add-account-close" id="add-account-close-btn">×</button>
        </div>
        <div class="add-account-body" id="add-account-body">
            <div class="provider-grid" id="provider-grid">
                ${PROVIDERS.map(p => {
                    const desc = p.id === "gmail" ? t("onboarding.provider.gmail.desc") :
                                 p.id === "gmx"   ? t("onboarding.provider.gmx.desc") :
                                 t("onboarding.provider.smtp.desc");
                    const name = p.id === "imap" ? t("onboarding.provider.smtp.label") : p.name;
                    return `
                    <div class="provider-card" data-provider="${p.id}">
                        <div class="provider-card-icon">${p.icon}</div>
                        <div class="provider-card-name">${escapeHtml(name)}</div>
                        <div class="provider-card-desc">${escapeHtml(desc)}</div>
                    </div>
                `}).join("")}
            </div>
            <div id="account-form-area"></div>
        </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const closeModal = () => overlay.remove();

    panel.querySelector("#add-account-close-btn").onclick = closeModal;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

    
    panel.querySelectorAll(".provider-card").forEach(card => {
        card.addEventListener("click", () => {
            panel.querySelectorAll(".provider-card").forEach(c => c.classList.remove("selected"));
            card.classList.add("selected");
            selectedProvider = card.dataset.provider;
            renderForm(selectedProvider, panel, closeModal, onSwitch, onAfterAdd);
        });
    });
        if (initialProvider) {
        const card = panel.querySelector(`[data-provider="${initialProvider}"]`);
        if (card) {
            card.classList.add("selected");
            selectedProvider = initialProvider;
            renderForm(initialProvider, panel, closeModal, onSwitch, onAfterAdd);
        }
    }
}

function renderForm(provider, panel, closeModal, onSwitch, onAfterAdd) {
    const area = panel.querySelector("#account-form-area");

    if (provider === "gmail") {
        area.innerHTML = `
            <div style="text-align:center; padding: 16px 0 8px;">
                <div style="font: 400 13px 'DM Sans', sans-serif; color: var(--text-mid); margin-bottom: 14px;">
                    ${t("accounts.gmail_oauth")}
                </div>
                <div class="add-account-error" id="add-gmail-error"></div>
            </div>
            <div class="add-account-footer">
                <button class="verdant-btn" id="add-gmail-cancel">${t("accounts.cancel")}</button>
                <button class="verdant-btn primary" id="add-gmail-btn">${t("accounts.connect_gmail")}</button>
            </div>
        `;

        panel.querySelector("#add-gmail-cancel").onclick = closeModal;
        panel.querySelector("#add-gmail-btn").onclick = async () => {
            const btn = panel.querySelector("#add-gmail-btn");
            const errEl = panel.querySelector("#add-gmail-error");
            btn.disabled = true;
            btn.textContent = t("accounts.connecting");
            errEl.classList.remove("visible");
            try {
                const acc = await addGmailAccount();
                closeModal();
                showToast(`Connected ${acc.email}`);
                if (onAfterAdd) onAfterAdd(acc);
            } catch (err) {
                btn.disabled = false;
                btn.textContent = t("accounts.connect_gmail");
                errEl.textContent = String(err);
                errEl.classList.add("visible");
            }
        };
        return;
    }

    if (provider === "gmx") {
        area.innerHTML = `
            <div class="add-account-form" id="gmx-form">
                <div class="add-account-field">
                    <label>${t("accounts.gmx.name")}</label>
                    <input id="gmx-email" type="email" placeholder="you@gmx.com" autocomplete="email">
                </div>
                <div class="add-account-field">
                    <label>${t("accounts.imap.name")}</label>
                    <input id="gmx-name" type="text" placeholder="${t("settings.account.name")}">
                </div>
                <div class="add-account-field">
                    <label>${t("accounts.gmx.password")}</label>
                    <input id="gmx-password" type="password" placeholder="${t("accounts.gmx.password")}">
                </div>
                <div class="add-account-error" id="gmx-error"></div>
                <div class="add-account-footer">
                    <button class="verdant-btn" id="gmx-cancel">${t("accounts.cancel")}</button>
                    <button class="verdant-btn" id="gmx-test">${t("accounts.test")}</button>
                    <button class="verdant-btn primary" id="gmx-save">${t("sidebar.add_account")}</button>
                </div>
            </div>
        `;
        bindImapForm(panel, "gmx", closeModal, onSwitch, onAfterAdd);
        return;
    }

    if (provider === "imap") {
        area.innerHTML = `
            <div class="add-account-form">
                <div class="add-account-field">
                    <label>${t("accounts.imap.email")}</label>
                    <input id="imap-email" type="email" placeholder="you@example.com" autocomplete="email">
                </div>
                <div class="add-account-field">
                    <label>${t("accounts.imap.name")}</label>
                    <input id="imap-name" type="text" placeholder="${t("settings.account.name")}">
                </div>
                <div class="add-account-field">
                    <label>${t("accounts.imap.username")}</label>
                    <input id="imap-username" type="text" placeholder="${t("accounts.imap.username")}">
                </div>
                <div class="add-account-field">
                    <label>${t("accounts.imap.password")}</label>
                    <input id="imap-password" type="password" placeholder="${t("accounts.imap.password")}">
                </div>
                <span class="add-account-advanced-toggle" id="imap-advanced-toggle">▸ ${t("accounts.imap.advanced")}</span>
                <div class="add-account-advanced" id="imap-advanced">
                    <div class="add-account-field">
                        <label>IMAP Host</label>
                        <div class="add-account-row">
                            <input id="imap-host" type="text" placeholder="imap.example.com">
                            <input id="imap-port" type="number" placeholder="993" value="993">
                        </div>
                    </div>
                    <div class="add-account-field">
                        <label>SMTP Host</label>
                        <div class="add-account-row">
                            <input id="smtp-host" type="text" placeholder="smtp.example.com">
                            <input id="smtp-port" type="number" placeholder="587" value="587">
                        </div>
                    </div>
                </div>
                <div class="add-account-error" id="imap-error"></div>
                <div class="add-account-footer">
                    <button class="verdant-btn" id="imap-cancel">${t("accounts.cancel")}</button>
                    <button class="verdant-btn" id="imap-test">${t("accounts.test")}</button>
                    <button class="verdant-btn primary" id="imap-save">${t("sidebar.add_account")}</button>
                </div>
            </div>
        `;

        
        panel.querySelector("#imap-advanced-toggle").onclick = () => {
            const adv = panel.querySelector("#imap-advanced");
            const toggle = panel.querySelector("#imap-advanced-toggle");
            adv.classList.toggle("open");
            toggle.textContent = adv.classList.contains("open") ? `▾ ${t("accounts.imap.advanced")}` : `▸ ${t("accounts.imap.advanced")}`;
        };

        
        panel.querySelector("#imap-email").addEventListener("blur", (e) => {
            const email = e.target.value.trim();
            const domain = email.split("@")[1] || "";
            if (!domain) return;
            const imapHost = panel.querySelector("#imap-host");
            const smtpHost = panel.querySelector("#smtp-host");
            if (!imapHost.value) imapHost.value = `imap.${domain}`;
            if (!smtpHost.value) smtpHost.value = `smtp.${domain}`;
        });

        bindImapForm(panel, "imap", closeModal, onSwitch, onAfterAdd);
    }
}

function collectImapPayload(panel, prefix) {
    const email = panel.querySelector(`#${prefix}-email`)?.value.trim() || "";
    const displayName = panel.querySelector(`#${prefix}-name`)?.value.trim() || null;
    const password = panel.querySelector(`#${prefix}-password`)?.value || "";

    if (prefix === "gmx") {
        return {
            email, displayName, password,
            imapHost: "imap.gmx.com", imapPort: 993,
            smtpHost: "mail.gmx.com", smtpPort: 587,
            username: email,
        };
    }

    const username = (panel.querySelector("#imap-username")?.value.trim() || email);
    const imapHost = panel.querySelector("#imap-host")?.value.trim() || `imap.${email.split("@")[1] || ""}`;
    const imapPort = parseInt(panel.querySelector("#imap-port")?.value || "993", 10);
    const smtpHost = panel.querySelector("#smtp-host")?.value.trim() || `smtp.${email.split("@")[1] || ""}`;
    const smtpPort = parseInt(panel.querySelector("#smtp-port")?.value || "587", 10);

    return { email, displayName, password, username, imapHost, imapPort, smtpHost, smtpPort };
}

function bindImapForm(panel, prefix, closeModal, onSwitch, onAfterAdd) {
    panel.querySelector(`#${prefix}-cancel`).onclick = closeModal;

    panel.querySelector(`#${prefix}-test`).onclick = async () => {
        const btn = panel.querySelector(`#${prefix}-test`);
        const errEl = panel.querySelector(`#${prefix}-error`);
        const payload = collectImapPayload(panel, prefix);

        if (!payload.email || !payload.password) {
            errEl.textContent = "Email and password are required.";
            errEl.classList.add("visible");
            return;
        }

        btn.disabled = true;
        btn.textContent = t("accounts.testing");
        errEl.classList.remove("visible");

        try {
            await testImapCredentials(payload);
            errEl.textContent = "";
            errEl.style.color = "var(--green)";
            errEl.style.background = "var(--green-pale)";
            errEl.style.borderColor = "var(--green-muted)";
            errEl.textContent = "Connection successful!";
            errEl.classList.add("visible");
        } catch (err) {
            errEl.style.color = "";
            errEl.style.background = "";
            errEl.style.borderColor = "";
            errEl.textContent = String(err);
            errEl.classList.add("visible");
        } finally {
            btn.disabled = false;
            btn.textContent = t("accounts.test");
        }
    };

    panel.querySelector(`#${prefix}-save`).onclick = async () => {
        const btn = panel.querySelector(`#${prefix}-save`);
        const errEl = panel.querySelector(`#${prefix}-error`);
        const payload = collectImapPayload(panel, prefix);

        if (!payload.email || !payload.password) {
            errEl.textContent = "Email and password are required.";
            errEl.classList.add("visible");
            return;
        }

        btn.disabled = true;
        btn.textContent = t("onboarding.connecting");
        errEl.classList.remove("visible");

        try {
            const addFn = prefix === "gmx" ? addGmxAccount : addImapAccount;
            const acc = await addFn(payload);
            closeModal();
            showToast(`Connected ${acc.email}`);
            if (onAfterAdd) onAfterAdd(acc);
        } catch (err) {
            errEl.textContent = String(err);
            errEl.classList.add("visible");
            btn.disabled = false;
            btn.textContent = t("sidebar.add_account");
        }
    };
}
