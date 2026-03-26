import {
    listAccounts, switchAccount, removeAccount,
    addGmailAccount, addImapAccount, addGmxAccount, testImapCredentials,
} from "../api.js";
import { escapeHtml } from "../lib/format.js";
import { showToast } from "../lib/toast.js";
import { t } from "../lib/i18n.js";



function injectAccountStyles() {
    if (document.getElementById("verdant-account-styles")) return;
    const style = document.createElement("style");
    style.id = "verdant-account-styles";
    style.textContent = `
        .account-popover-backdrop {
            position: fixed; inset: 0; z-index: 1900;
        }
        .account-popover {
            position: fixed;
            bottom: 72px;
            left: 12px;
            width: 260px;
            background: var(--white);
            border: 1px solid var(--border);
            border-radius: 12px;
            box-shadow: 0 16px 40px rgba(30,33,25,.18);
            z-index: 2000;
            overflow: hidden;
            transform-origin: bottom left;
            animation: popover-in .16s cubic-bezier(.34,1.56,.64,1) forwards;
        }
        @keyframes popover-in {
            from { opacity: 0; transform: scale(.94) translateY(8px); }
            to   { opacity: 1; transform: scale(1)  translateY(0); }
        }
        .account-popover-section {
            padding: 6px;
            border-bottom: 1px solid var(--border);
        }
        .account-popover-section:last-child { border-bottom: 0; }
        .account-popover-label {
            font: 500 10px 'DM Sans', sans-serif;
            letter-spacing: .6px;
            text-transform: uppercase;
            color: var(--text-muted);
            padding: 6px 8px 4px;
        }
        .account-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 10px;
            border-radius: 8px;
            cursor: pointer;
            transition: background .1s;
        }
        .account-item:hover { background: var(--surface2); }
        .account-item.is-active { background: var(--green-pale); }
        .account-avatar {
            width: 28px; height: 28px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--green-mid), var(--green-light));
            display: flex; align-items: center; justify-content: center;
            font: 600 10px 'DM Sans', sans-serif;
            color: white; flex-shrink: 0;
        }
        .account-avatar.imap {
            background: linear-gradient(135deg, #7a6d5a, #a89880);
        }
        .account-item-info { flex: 1; min-width: 0; }
        .account-item-email {
            font: 500 12px 'DM Sans', sans-serif;
            color: var(--text);
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .account-item-provider {
            font: 400 10px 'DM Sans', sans-serif;
            color: var(--text-muted);
            text-transform: capitalize;
        }
        .account-active-dot {
            width: 7px; height: 7px;
            border-radius: 50%;
            background: var(--green);
            flex-shrink: 0;
        }
        .account-remove-btn {
            width: 20px; height: 20px;
            border: 1px solid transparent;
            background: transparent;
            border-radius: 5px;
            color: var(--text-muted);
            cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            font-size: 14px; line-height: 1;
            flex-shrink: 0;
            opacity: 0;
            transition: opacity .1s, background .1s, color .1s;
        }
        .account-item:hover .account-remove-btn { opacity: 1; }
        .account-remove-btn:hover { background: #f3dfdf; color: #8a2e2e; border-color: #ddb5b5; }
        .account-popover-action {
            display: flex;
            align-items: center;
            gap: 9px;
            padding: 9px 10px;
            border-radius: 8px;
            cursor: pointer;
            font: 500 12px 'DM Sans', sans-serif;
            color: var(--text-mid);
            transition: background .1s, color .1s;
        }
        .account-popover-action:hover { background: var(--surface2); color: var(--text); }
        .account-popover-action svg { width: 14px; height: 14px; flex-shrink: 0; }

        /* ── Add account modal ── */
        .add-account-overlay {
            position: fixed; inset: 0;
            background: rgba(30,33,25,.38);
            backdrop-filter: blur(3px);
            z-index: 2100;
            display: flex; align-items: center; justify-content: center;
            padding: 24px;
            opacity: 0;
            animation: fade-in .18s ease forwards;
        }
        @keyframes fade-in { to { opacity: 1; } }
        .add-account-panel {
            width: min(480px, 100%);
            background: var(--white);
            border: 1px solid var(--border);
            border-radius: 14px;
            box-shadow: 0 22px 52px rgba(37,35,31,.2);
            overflow: hidden;
            transform: translateY(12px) scale(.98);
            animation: panel-in .2s cubic-bezier(.34,1.56,.64,1) forwards;
        }
        @keyframes panel-in { to { transform: translateY(0) scale(1); } }
        .add-account-header {
            padding: 16px 20px;
            border-bottom: 1px solid var(--border);
            display: flex; align-items: center; justify-content: space-between;
            background: var(--surface);
        }
        .add-account-title {
            font: 500 15px 'Fraunces', serif;
            color: var(--text);
            letter-spacing: -.2px;
        }
        .add-account-close {
            width: 26px; height: 26px;
            border: 1px solid var(--border);
            background: var(--surface2);
            border-radius: 7px;
            cursor: pointer;
            color: var(--text-muted);
            display: flex; align-items: center; justify-content: center;
            font-size: 16px;
        }
        .add-account-close:hover { background: var(--white); color: var(--text); }
        .add-account-body { padding: 20px; }
        .provider-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            margin-bottom: 16px;
        }
        .provider-card {
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 14px 12px;
            cursor: pointer;
            transition: border-color .12s, box-shadow .12s, background .12s;
            background: var(--white);
        }
        .provider-card:hover {
            border-color: var(--green-light);
            box-shadow: 0 2px 10px rgba(74,94,69,.09);
        }
        .provider-card.selected {
            border-color: var(--green);
            background: var(--green-pale);
        }
        .provider-card.disabled {
            opacity: .5; cursor: not-allowed;
        }
        .provider-card-icon { font-size: 22px; margin-bottom: 6px; }
        .provider-card-name {
            font: 600 12px 'DM Sans', sans-serif;
            color: var(--text);
        }
        .provider-card-desc {
            font: 400 11px 'DM Sans', sans-serif;
            color: var(--text-muted);
            margin-top: 2px;
        }
        .add-account-form { display: grid; gap: 10px; }
        .add-account-field { display: grid; gap: 4px; }
        .add-account-field label {
            font: 500 11px 'DM Sans', sans-serif;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: .5px;
        }
        .add-account-field input {
            height: 36px;
            border: 1px solid var(--border);
            border-radius: 8px;
            background: var(--bg);
            padding: 0 10px;
            font: 400 13px 'DM Sans', sans-serif;
            color: var(--text);
            outline: none;
            transition: border-color .12s;
        }
        .add-account-field input:focus { border-color: var(--green-light); }
        .add-account-row { display: grid; grid-template-columns: 1fr 90px; gap: 8px; }
        .add-account-footer {
            display: flex; gap: 8px; justify-content: flex-end;
            margin-top: 16px;
        }
        .add-account-error {
            font: 400 12px 'DM Sans', sans-serif;
            color: #8a3b3b;
            background: #f9ecec;
            border: 1px solid #dcb9b9;
            border-radius: 8px;
            padding: 8px 10px;
            display: none;
        }
        .add-account-error.visible { display: block; }
        .add-account-advanced-toggle {
            font: 500 12px 'DM Sans', sans-serif;
            color: var(--green);
            cursor: pointer;
            margin-top: 4px;
            display: inline-block;
        }
        .add-account-advanced { display: none; margin-top: 8px; }
        .add-account-advanced.open { display: grid; gap: 10px; }
    `;
    document.head.appendChild(style);
}



let _popoverOpen = false;

export function isAccountPopoverOpen() { return _popoverOpen; }

export async function openAccountPopover(onSwitch, onAddAccount) {
    closeAccountPopover();
    injectAccountStyles();

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
        label.textContent = t("accounts.title");
        accSection.appendChild(label);

        for (const acc of accounts) {
            const item = document.createElement("div");
            item.className = `account-item${acc.is_active ? " is-active" : ""}`;

            const initials = (acc.display_name || acc.email).slice(0, 2).toUpperCase();
            item.innerHTML = `
                <div class="account-avatar ${acc.provider === 'imap' ? 'imap' : ''}">${escapeHtml(initials)}</div>
                <div class="account-item-info">
                    <div class="account-item-email" title="${escapeHtml(acc.email)}">${escapeHtml(acc.email)}</div>
                    <div class="account-item-provider">${escapeHtml(acc.provider === 'imap' ? t("accounts.imap") : t("accounts.gmail"))}</div>
                </div>
                ${acc.is_active ? '<div class="account-active-dot"></div>' : ''}
                ${!acc.is_active ? `<button class="account-remove-btn" title="${escapeHtml(t("reading.delete"))}">×</button>` : ''}
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
                    if (!confirm(t("accounts.remove_confirm", { email: acc.email }))) return;
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
        ${t("accounts.add")}
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

const PROVIDERS = () => [
    { id: "gmail", name: t("accounts.gmail"),       icon: mailIcon,   desc: "Google OAuth" },
    { id: "gmx",   name: t("accounts.gmx"),         icon: globeIcon,  desc: t("accounts.gmx_desc") },
    { id: "imap",  name: t("accounts.imap_custom"), icon: serverIcon, desc: t("accounts.imap_desc") },
];

export function openAddAccountModal(onSwitch, onAfterAdd, initialProvider = null) {
    injectAccountStyles();
    document.getElementById("add-account-overlay")?.remove();

    let selectedProvider = null;

    const overlay = document.createElement("div");
    overlay.className = "add-account-overlay";
    overlay.id = "add-account-overlay";

    const panel = document.createElement("div");
    panel.className = "add-account-panel";

    panel.innerHTML = `
        <div class="add-account-header">
            <span class="add-account-title">${t("accounts.add")}</span>
            <button class="add-account-close" id="add-account-close-btn">×</button>
        </div>
        <div class="add-account-body" id="add-account-body">
            <div class="provider-grid" id="provider-grid">
                ${PROVIDERS().map(p => `
                    <div class="provider-card" data-provider="${p.id}">
                        <div class="provider-card-icon">${p.icon}</div>
                        <div class="provider-card-name">${escapeHtml(p.name)}</div>
                        <div class="provider-card-desc">${escapeHtml(p.desc)}</div>
                    </div>
                `).join("")}
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
                    ${t("accounts.gmail_desc")}
                </div>
                <div class="add-account-error" id="add-gmail-error"></div>
            </div>
            <div class="add-account-footer">
                <button class="verdant-btn" id="add-gmail-cancel">${t("accounts.cancel")}</button>
                <button class="verdant-btn primary" id="add-gmail-btn">${t("accounts.gmail_connect")}</button>
            </div>
        `;

        panel.querySelector("#add-gmail-cancel").onclick = closeModal;
        panel.querySelector("#add-gmail-btn").onclick = async () => {
            const btn = panel.querySelector("#add-gmail-btn");
            const errEl = panel.querySelector("#add-gmail-error");
            btn.disabled = true;
            btn.textContent = t("onboarding.connecting");
            errEl.classList.remove("visible");
            try {
                const acc = await addGmailAccount();
                closeModal();
                showToast(t("accounts.gmail_connected", { email: acc.email }));
                if (onAfterAdd) onAfterAdd(acc);
            } catch (err) {
                btn.disabled = false;
                btn.textContent = t("accounts.gmail_connect");
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
                    <label>${t("accounts.email")}</label>
                    <input id="gmx-email" type="email" placeholder="you@gmx.com" autocomplete="email">
                </div>
                <div class="add-account-field">
                    <label>${t("accounts.display_name")}</label>
                    <input id="gmx-name" type="text" placeholder="Your Name">
                </div>
                <div class="add-account-field">
                    <label>${t("accounts.password")}</label>
                    <input id="gmx-password" type="password" placeholder="GMX password">
                </div>
                <div class="add-account-error" id="gmx-error"></div>
                <div class="add-account-footer">
                    <button class="verdant-btn" id="gmx-cancel">${t("accounts.cancel")}</button>
                    <button class="verdant-btn" id="gmx-test">${t("accounts.test")}</button>
                    <button class="verdant-btn primary" id="gmx-save">${t("accounts.add")}</button>
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
                    <label>${t("accounts.email")}</label>
                    <input id="imap-email" type="email" placeholder="you@example.com" autocomplete="email">
                </div>
                <div class="add-account-field">
                    <label>${t("accounts.display_name")}</label>
                    <input id="imap-name" type="text" placeholder="Your Name">
                </div>
                <div class="add-account-field">
                    <label>${t("accounts.username_optional")}</label>
                    <input id="imap-username" type="text" placeholder="${t("accounts.username_placeholder")}">
                </div>
                <div class="add-account-field">
                    <label>${t("accounts.password")}</label>
                    <input id="imap-password" type="password" placeholder="Password or app password">
                </div>
                <span class="add-account-advanced-toggle" id="imap-advanced-toggle">▸ ${t("accounts.server_settings")}</span>
                <div class="add-account-advanced" id="imap-advanced">
                    <div class="add-account-field">
                        <label>${t("accounts.imap_host")}</label>
                        <div class="add-account-row">
                            <input id="imap-host" type="text" placeholder="imap.example.com">
                            <input id="imap-port" type="number" placeholder="993" value="993">
                        </div>
                    </div>
                    <div class="add-account-field">
                        <label>${t("accounts.smtp_host")}</label>
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
                    <button class="verdant-btn primary" id="imap-save">${t("accounts.add")}</button>
                </div>
            </div>
        `;

        
        panel.querySelector("#imap-advanced-toggle").onclick = () => {
            const adv = panel.querySelector("#imap-advanced");
            const toggle = panel.querySelector("#imap-advanced-toggle");
            adv.classList.toggle("open");
            toggle.textContent = adv.classList.contains("open") ? `▾ ${t("accounts.server_settings")}` : `▸ ${t("accounts.server_settings")}`;
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
            errEl.textContent = t("accounts.required");
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
            errEl.textContent = t("accounts.success");
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
            errEl.textContent = t("accounts.required");
            errEl.classList.add("visible");
            return;
        }

        btn.disabled = true;
        btn.textContent = t("accounts.adding");
        errEl.classList.remove("visible");

        try {
            const addFn = prefix === "gmx" ? addGmxAccount : addImapAccount;
            const acc = await addFn(payload);
            closeModal();
            showToast(t("accounts.gmail_connected", { email: acc.email }));
            if (onAfterAdd) onAfterAdd(acc);
        } catch (err) {
            errEl.textContent = String(err);
            errEl.classList.add("visible");
            btn.disabled = false;
            btn.textContent = t("accounts.add");
        }
    };
}
