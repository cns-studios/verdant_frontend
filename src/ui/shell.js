import { t } from "../lib/i18n.js";

export function renderShell() {
  const root = document.getElementById("root");
  root.innerHTML = `
    <header class="app-header" id="app-header">
      <div class="app-header-left" id="app-header-left">
        <span class="app-dot"></span>
        <span class="app-title">${t("app.title")}</span>
        <span class="app-subtitle">- ${t("sidebar.inbox")}</span>
      </div>
      <div class="app-header-controls" id="app-header-controls">
        <button class="app-win-btn" id="app-min-btn" aria-label="${t("app.minimize_window")}" title="${t("app.minimize")}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="app-win-btn" id="app-max-btn" aria-label="${t("app.maximize_window")}" title="${t("app.maximize")}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>
        </button>
        <button class="app-win-btn close" id="app-close-btn" aria-label="${t("app.close_window")}" title="${t("app.close")}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </header>

    <div class="app-content">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="logo">
            <div class="logo-mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                <polyline points="22,6 12,13 2,6"/>
              </svg>
            </div>
            <span class="logo-name">Verdant</span>
          </div>
          <button class="compose-btn" id="compose-open-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            ${t("sidebar.compose")}
          </button>
        </div>

        <div class="sidebar-section">
          <div class="section-label">${t("sidebar.mailboxes")}</div>
          <div class="nav-item active" data-mailbox="INBOX">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8"/><polyline points="22,6 12,13 2,6"/></svg>
            ${t("sidebar.inbox")}
          </div>
          <div class="nav-item" data-mailbox="STARRED">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            ${t("sidebar.starred")}
          </div>
          <div class="nav-item" data-mailbox="ARCHIVE">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
            ${t("sidebar.archive")}
          </div>
          <div class="nav-item" data-mailbox="SENT">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            ${t("sidebar.sent")}
          </div>
          <div class="nav-item" data-mailbox="DRAFT">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            ${t("sidebar.drafts")}
          </div>
          <div class="nav-item" data-mailbox="TRASH">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            ${t("sidebar.trash")}
          </div>
        </div>

        <div class="sidebar-footer">
          <div class="user-row" id="user-row">
            <div class="avatar" id="user-avatar">?</div>
            <div class="user-info">
              <div class="user-name" id="user-name">${t("app.version_loading")}</div>
              <div class="user-email" id="user-email"></div>
            </div>
          </div>
        </div>
      </aside>

      <div class="email-list-pane">
        <div class="list-header">
          <div class="list-title-row">
            <span class="list-title">${t("sidebar.inbox")}</span>
            <span class="list-count">0 ${t("list.count", { n: 0 })}</span>
          </div>
          <div class="search-bar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" placeholder="${t("list.search.placeholder")}" id="search-input">
          </div>
          <div class="filter-chips">
            <div class="chip active" data-filter="Important">${t("list.filter.important")}</div>
            <div class="chip" data-filter="All">${t("list.filter.all")}</div>
            <div class="chip" data-filter="Unread">${t("list.filter.unread")}</div>
            <div class="chip" data-filter="Attachments">${t("list.filter.attachments")}</div>
          </div>
        </div>

        <div class="email-list" id="email-list"></div>
      </div>

      <div class="pane-resizer" id="pane-resizer" role="separator" aria-orientation="vertical" aria-label="${t("list.resize_label")}"></div>

      <div class="reading-pane">
        <div class="reading-header">
          <div class="reading-actions">
            <button class="icon-btn" title="${t("reading.archive")}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
            </button>
            <button class="icon-btn" title="${t("reading.delete")}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>
            <button class="icon-btn" title="${t("reading.mark_unread")}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </button>
            <button class="icon-btn" title="${t("reading.star")}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </button>
            <button class="icon-btn" title="${t("reading.more")}" style="margin-left:auto">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            </button>
            <button class="icon-btn" title="${t("reading.close")}" aria-label="${t("reading.close")}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>

          <div class="reading-subject"></div>

          <div class="reading-meta">
            <div class="meta-avatar"></div>
            <div class="meta-info">
              <div class="meta-from"></div>
              <div class="meta-to"></div>
            </div>
            <div class="meta-date"></div>
          </div>
        </div>

        <div class="reading-body">
          <div class="email-body-text"></div>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="composeModal">
      <div class="compose-modal">
        <div class="modal-header">
          <span class="modal-title">${t("compose.title")}</span>
          <div class="modal-header-actions">
            <button class="modal-close" id="compose-max-btn" title="${t("app.maximize")}" aria-label="${t("app.maximize")}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="1"></rect></svg>
            </button>
            <button class="modal-close" id="compose-close-btn">×</button>
          </div>
        </div>
        <div class="modal-fields">
          <div class="modal-field">
            <label>${t("compose.to")}</label>
            <div class="compose-recipient-wrap">
              <div class="compose-recipient-input" id="compose-to-input-wrap">
                <input id="compose-to" type="text" placeholder="${t("compose.recipient_placeholder")}" autocomplete="off">
              </div>
              <div class="compose-recipient-suggest" id="compose-to-suggest"></div>
            </div>
          </div>
          <div class="modal-field">
            <label>${t("compose.cc")}</label>
            <div class="compose-recipient-wrap">
              <div class="compose-recipient-input" id="compose-cc-input-wrap">
                <input id="compose-cc" type="text" placeholder="${t("compose.cc_placeholder")}" autocomplete="off">
              </div>
              <div class="compose-recipient-suggest" id="compose-cc-suggest"></div>
            </div>
          </div>
          <div class="modal-field">
            <label>${t("compose.subject")}</label>
            <input id="compose-subject" type="text" placeholder="${t("compose.subject_placeholder")}">
          </div>
        </div>
        <div class="modal-body">
          <div id="compose-body" class="compose-editor" contenteditable="true" data-placeholder="${t("compose.placeholder")}"></div>
        </div>
        <div class="compose-format-toolbar" id="compose-format-toolbar">
          <button class="compose-format-btn" type="button" data-format="bold">${t("compose.format.bold")}</button>
          <button class="compose-format-btn" type="button" data-format="header">${t("compose.format.header")}</button>
          <button class="compose-format-btn" type="button" data-format="italic">${t("compose.format.italic")}</button>
          <button class="compose-format-btn" type="button" data-format="list">${t("compose.format.list")}</button>
          <button class="compose-format-btn" type="button" data-format="quote">${t("compose.format.quote")}</button>
          <button class="compose-format-btn" type="button" data-format="code">${t("compose.format.code")}</button>
          <button class="compose-format-btn" type="button" data-format="clear">${t("compose.format.clear")}</button>
        </div>
        <div class="compose-attachments" id="compose-attachments"></div>
        <input id="compose-file-input" type="file" multiple hidden>
        <div class="modal-footer">
          <div class="modal-tools">
            <button class="modal-tool" id="compose-attach-btn" title="${t("compose.tool.attach")}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            </button>
            <button class="modal-tool" id="compose-format-btn" title="${t("compose.tool.format")}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
            </button>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="verdant-btn" id="compose-save-draft-btn">${t("compose.save_draft")}</button>
            <button class="send-btn" id="compose-send-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              ${t("compose.send")}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}
