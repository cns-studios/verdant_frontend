import { connectGmail } from "../api.js";
import { escapeHtml } from "../lib/format.js";
import { showToast } from "../lib/toast.js";
import { t, getLang, setLang, getSupportedLanguages, initLang } from "../lib/i18n.js";

function buildOnboardingStyles() {
    if (document.getElementById("verdant-onboarding-styles")) return;
    const style = document.createElement("style");
    style.id = "verdant-onboarding-styles";
    style.textContent = `
        .ob-root {
            position: fixed; inset: 0;
            background: var(--bg);
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            z-index: 9000; padding: 24px;
        }
        .ob-root.ob-modal {
            background: rgba(30,33,25,.42);
            backdrop-filter: blur(4px);
        }
        .ob-root.ob-modal .ob-inner {
            background: var(--white);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 28px;
            box-shadow: 0 24px 56px rgba(37,35,31,.2);
        }
        .ob-inner { width: min(480px, 100%); display: flex; flex-direction: column; gap: 28px; }
        .ob-brand { display: flex; align-items: center; gap: 11px; }
        .ob-logo-mark {
            width: 34px; height: 34px; background: var(--green);
            border-radius: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        }
        .ob-logo-mark svg { width: 17px; height: 17px; }
        .ob-brand-name { font: 500 20px 'Fraunces', serif; color: var(--text); letter-spacing: -0.3px; }
        .ob-brand-row { display: flex; align-items: center; justify-content: space-between; }
        .ob-lang-picker { display: flex; align-items: center; gap: 7px; }
        .ob-lang-label { font: 400 12px 'DM Sans', sans-serif; color: var(--text-muted); }
        .ob-lang-select {
            height: 28px; border: 1px solid var(--border); border-radius: 7px;
            background: var(--surface2); color: var(--text);
            font: 400 12px 'DM Sans', sans-serif; padding: 0 8px; cursor: pointer; outline: none;
        }
        .ob-lang-select:focus { border-color: var(--green-light); }
        .ob-heading { display: flex; flex-direction: column; gap: 6px; }
        .ob-heading h1 { font: 400 28px/1.15 'Fraunces', serif; color: var(--text); letter-spacing: -0.5px; margin: 0; }
        .ob-heading p { font: 400 13px 'DM Sans', sans-serif; color: var(--text-muted); margin: 0; line-height: 1.5; }
        .ob-providers { display: flex; flex-direction: column; gap: 10px; }
        .ob-provider-card {
            display: flex; align-items: center; gap: 14px;
            padding: 14px 16px; border: 1px solid var(--border);
            border-radius: 11px; background: var(--white);
            transition: border-color 0.12s, box-shadow 0.12s; position: relative;
        }
        .ob-available { cursor: pointer; }
        .ob-available:hover { border-color: var(--green-light); box-shadow: 0 2px 10px rgba(74,94,69,0.09); }
        .ob-unavailable { background: var(--surface); cursor: not-allowed; opacity: 0.52; }
        .ob-provider-icon {
            width: 36px; height: 36px; border-radius: 8px;
            background: var(--surface2); border: 1px solid var(--border);
            display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 18px;
        }
        .ob-provider-info { flex: 1; min-width: 0; }
        .ob-provider-label { font: 500 13.5px 'DM Sans', sans-serif; color: var(--text); margin-bottom: 2px; }
        .ob-provider-desc { font: 400 12px 'DM Sans', sans-serif; color: var(--text-muted); }
        .ob-coming-soon {
            font: 500 10px 'DM Sans', sans-serif; color: var(--text-muted);
            background: var(--surface2); border: 1px solid var(--border);
            border-radius: 999px; padding: 2px 8px; white-space: nowrap; flex-shrink: 0;
        }
        .ob-error {
            font: 400 12px 'DM Sans', sans-serif; color: #8a3b3b;
            background: #f9ecec; border: 1px solid #dcb9b9;
            border-radius: 8px; padding: 10px 12px; display: none;
        }
        .ob-error.visible { display: block; }
        .ob-cancel-row { display: flex; justify-content: center; }
        .ob-cancel-btn {
            border: 1px solid var(--border); background: transparent;
            border-radius: 8px; padding: 7px 16px;
            font: 500 12px 'DM Sans', sans-serif; color: var(--text-muted);
            cursor: pointer; transition: background .12s, color .12s;
        }
        .ob-cancel-btn:hover { background: var(--surface2); color: var(--text); }
    `;
    document.head.appendChild(style);
}

function providerCardHtml(id, label, description, icon, available) {
    return `
        <div class="ob-provider-card ${available ? "ob-available" : "ob-unavailable"}" data-provider="${id}">
            <div class="ob-provider-icon">${icon}</div>
            <div class="ob-provider-info">
                <div class="ob-provider-label">${escapeHtml(label)}</div>
                <div class="ob-provider-desc">${escapeHtml(description)}</div>
            </div>
            ${available ? "" : `<span class="ob-coming-soon">${escapeHtml(t("onboarding.provider.coming_soon"))}</span>`}
        </div>
    `;
}

const mailIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`;
const serverIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`;
const globeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

function renderOnboardingContent(root, onSuccess, cancelable) {
    const langs = getSupportedLanguages();
    const currentLang = getLang();

    root.querySelector(".ob-inner").innerHTML = `
        <div class="ob-brand-row">
            <div class="ob-brand">
                <div class="ob-logo-mark">
                    <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                        <polyline points="22,6 12,13 2,6"/>
                    </svg>
                </div>
                <span class="ob-brand-name">Verdant</span>
            </div>
            <div class="ob-lang-picker">
                <span class="ob-lang-label">${escapeHtml(t("onboarding.language.label"))}</span>
                <select class="ob-lang-select" id="ob-lang-select">
                    ${langs.map(l => `<option value="${l.code}" ${l.code === currentLang ? "selected" : ""}>${escapeHtml(l.label)}</option>`).join("")}
                </select>
            </div>
        </div>

        <div class="ob-heading">
            <h1>${escapeHtml(cancelable ? "Add an account" : t("onboarding.title"))}</h1>
            <p>${escapeHtml(t("onboarding.subtitle"))}</p>
        </div>

        <div class="ob-providers">
            ${providerCardHtml("gmail", t("onboarding.provider.gmail.label"), t("onboarding.provider.gmail.desc"), mailIcon, true)}
            ${providerCardHtml("gmx", "GMX", "IMAP / SMTP with prefilled config", globeIcon, true)}
            ${providerCardHtml("imap", t("onboarding.provider.smtp.label"), t("onboarding.provider.smtp.desc"), serverIcon, true)}
        </div>

        <div class="ob-error" id="ob-error"></div>

        ${cancelable ? `<div class="ob-cancel-row"><button class="ob-cancel-btn" id="ob-cancel-btn">Cancel</button></div>` : ""}
    `;

    root.querySelector("#ob-lang-select")?.addEventListener("change", (e) => {
        setLang(e.target.value);
        renderOnboardingContent(root, onSuccess, cancelable);
    });

    root.querySelector("#ob-cancel-btn")?.addEventListener("click", () => {
        root.remove();
    });

    
    const gmailCard = root.querySelector('[data-provider="gmail"]');
    gmailCard?.addEventListener("click", async () => {
        gmailCard.style.opacity = "0.6";
        gmailCard.style.pointerEvents = "none";
        gmailCard.querySelector(".ob-provider-label").textContent = t("onboarding.connecting");
        const errorEl = root.querySelector("#ob-error");
        try {
            await connectGmail();
            root.remove();
            onSuccess();
        } catch (err) {
            gmailCard.style.opacity = "";
            gmailCard.style.pointerEvents = "";
            gmailCard.querySelector(".ob-provider-label").textContent = t("onboarding.provider.gmail.label");
            if (errorEl) { errorEl.textContent = String(err); errorEl.classList.add("visible"); }
        }
    });

    

    ["gmx", "imap"].forEach(provider => {
        const card = root.querySelector(`[data-provider="${provider}"]`);
        card?.addEventListener("click", () => {
            import("./accounts.js").then(({ openAddAccountModal }) => {
                root.remove();
                openAddAccountModal(null, () => onSuccess(), provider);
            }).catch(console.error);
        });
    });
}

export function showOnboarding(onSuccess, cancelable = false) {
    initLang();
    buildOnboardingStyles();
    document.getElementById("verdant-onboarding")?.remove();

    const root = document.createElement("div");
    root.id = "verdant-onboarding";
    root.className = `ob-root${cancelable ? " ob-modal" : ""}`;
    root.innerHTML = `<div class="ob-inner"></div>`;

    document.getElementById("root").appendChild(root);

    if (!cancelable) {
        import("./shell.js").then(({ renderShell }) => {
            import("./sidebar.js").then(({ bindAppHeaderControls }) => {
                renderShell();
                bindAppHeaderControls(() => false, () => false, () => "INBOX");
                const mainRoot = document.getElementById("root");
                mainRoot.appendChild(root);
            });
        });
    }

    renderOnboardingContent(root, onSuccess, cancelable);
}

export function hideOnboarding() {
    document.getElementById("verdant-onboarding")?.remove();
}
