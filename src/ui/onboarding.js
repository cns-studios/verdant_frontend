import { connectGmail } from "../api.js";
import { escapeHtml } from "../lib/format.js";
import { showToast } from "../lib/toast.js";
import { t, getLang, setLang, getSupportedLanguages, initLang } from "../lib/i18n.js";

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
            <h1>${escapeHtml(cancelable ? t("accounts.title") : t("onboarding.title"))}</h1>
            <p>${escapeHtml(t("onboarding.subtitle"))}</p>
        </div>

        <div class="ob-providers">
            ${providerCardHtml("gmail", t("onboarding.provider.gmail.label"), t("onboarding.provider.gmail.desc"), mailIcon, true)}
            ${providerCardHtml("gmx", "GMX", t("onboarding.provider.gmx.desc"), globeIcon, true)}
            ${providerCardHtml("imap", t("onboarding.provider.smtp.label"), t("onboarding.provider.smtp.desc"), serverIcon, true)}
        </div>

        <div class="ob-error" id="ob-error"></div>

        ${cancelable ? `<div class="ob-cancel-row"><button class="ob-cancel-btn" id="ob-cancel-btn">${escapeHtml(t("accounts.cancel"))}</button></div>` : ""}
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
    document.getElementById("verdant-onboarding")?.remove();

    const root = document.createElement("div");
    root.id = "verdant-onboarding";
    root.className = `ob-root${cancelable ? " ob-modal" : " ob-has-header"}`;

    if (!cancelable) {
        const header = document.createElement("div");
        header.className = "ob-header";
        header.setAttribute("data-tauri-drag-region", "");
        header.innerHTML = `
            <div class="ob-header-left">
                <span class="ob-header-dot"></span>
                <span class="ob-header-title">Verdant</span>
            </div>
            <div class="ob-header-controls">
                <button class="ob-win-btn" id="ob-min-btn" aria-label="Minimize">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
                <button class="ob-win-btn" id="ob-max-btn" aria-label="Maximize">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>
                </button>
                <button class="ob-win-btn close" id="ob-close-btn" aria-label="Close">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        `;
        root.appendChild(header);

        import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
            const win = getCurrentWindow();
            header.querySelector("#ob-min-btn")?.addEventListener("click", () => win.minimize());
            header.querySelector("#ob-max-btn")?.addEventListener("click", () => win.toggleMaximize());
            header.querySelector("#ob-close-btn")?.addEventListener("click", () => win.close());
        }).catch(() => {});
    }

    const inner = document.createElement("div");
    inner.className = "ob-inner";
    root.appendChild(inner);

    document.getElementById("root").appendChild(root);
    renderOnboardingContent(root, onSuccess, cancelable);
}

export function hideOnboarding() {
    document.getElementById("verdant-onboarding")?.remove();
}
