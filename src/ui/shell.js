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
        <button class="app-win-btn" id="app-min-btn" aria-label="Minimize window" title="Minimize">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="app-win-btn" id="app-max-btn" aria-label="Maximize window" title="Maximize">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>
        </button>
        <button class="app-win-btn close" id="app-close-btn" aria-label="Close window" title="Close">
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
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
            <span class="list-count">0 ${t("list.count", { n: "" }).trim()}</span>
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

      <div class="pane-resizer" id="pane-resizer" role="separator" aria-orientation="vertical" aria-label="Resize inbox list"></div>

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
            <button class="modal-close" id="compose-max-btn" title="Maximize" aria-label="Maximize">
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
          <button class="compose-format-btn" type="button" data-format="bold">Bold</button>
          <button class="compose-format-btn" type="button" data-format="header">Header</button>
          <button class="compose-format-btn" type="button" data-format="italic">Cursive</button>
          <button class="compose-format-btn" type="button" data-format="list">List</button>
          <button class="compose-format-btn" type="button" data-format="quote">Quote</button>
          <button class="compose-format-btn" type="button" data-format="code">Code</button>
          <button class="compose-format-btn" type="button" data-format="clear">Clear formatting</button>
        </div>
        <div class="compose-attachments" id="compose-attachments"></div>
        <input id="compose-file-input" type="file" multiple hidden>
        <div class="modal-footer">
          <div class="modal-tools">
            <button class="modal-tool" id="compose-attach-btn" title="Attach file">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            </button>
            <button class="modal-tool" id="compose-format-btn" title="Format text">
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

  injectShellStyles();
}

function injectShellStyles() {
  if (document.getElementById("verdant-shell-styles")) return;
  const style = document.createElement("style");
  style.id = "verdant-shell-styles";
  style.textContent = `
    .app-header {
      height: 42px; min-height: 42px;
      background: linear-gradient(180deg, var(--surface), #ebe8e2);
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 10px 0 12px; gap: 12px;
    }
    .app-header-left { display:flex; align-items:center; gap:9px; min-width:0; }
    .app-dot { width:9px; height:9px; border-radius:50%; background:var(--green); box-shadow:0 0 0 3px var(--green-pale); flex-shrink:0; }
    .app-title { font:500 13px 'Fraunces', serif; color:var(--text); letter-spacing:-0.2px; white-space:nowrap; }
    .app-subtitle { font:400 11px 'DM Sans', sans-serif; color:var(--text-muted); white-space:nowrap; }
    .app-header-controls { display:flex; align-items:center; gap:6px; }
    .app-win-btn { width:28px; height:24px; border-radius:7px; border:1px solid var(--border); background:var(--surface2); color:var(--text-mid); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; transition:all .12s ease; }
    .app-win-btn:hover { background:var(--white); color:var(--text); }
    .app-win-btn.close:hover { background:#f3dfdf; border-color:#ddb5b5; color:#8a2e2e; }
    .app-win-btn svg { width:12px; height:12px; stroke-width:2.2; }
    .app-content { flex:1; min-height:0; display:flex; width:100%; overflow:hidden; height:calc(100vh - 42px); }
    .sidebar { width:220px; min-width:220px; background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; }
    .sidebar-header { padding:22px 20px 16px; border-bottom:1px solid var(--border); }
    .logo { display:flex; align-items:center; gap:9px; margin-bottom:18px; }
    .logo-mark { width:28px; height:28px; background:var(--green); border-radius:7px; display:flex; align-items:center; justify-content:center; }
    .logo-mark svg { width:14px; height:14px; }
    .logo-name { font-family:'Fraunces',serif; font-size:15px; font-weight:500; letter-spacing:-0.3px; color:var(--text); }
    .compose-btn { width:100%; padding:9px 14px; background:var(--green); color:var(--white); border:none; border-radius:8px; font-family:'DM Sans',sans-serif; font-size:13px; font-weight:500; cursor:pointer; display:flex; align-items:center; gap:7px; transition:background 0.15s, transform 0.1s; }
    .compose-btn:hover { background:var(--accent); transform:translateY(-1px); }
    .compose-btn svg { width:13px; height:13px; opacity:0.9; }
    .sidebar-section { padding:14px 12px 6px; flex:1; overflow-y:auto; }
    .section-label { font-size:10px; font-weight:500; letter-spacing:0.8px; text-transform:uppercase; color:var(--text-muted); padding:0 8px; margin-bottom:4px; }
    .nav-item { display:flex; align-items:center; gap:9px; padding:7px 10px; border-radius:7px; cursor:pointer; font-size:13.5px; color:var(--text-mid); transition:background 0.12s, color 0.12s; margin-bottom:1px; user-select:none; }
    .nav-item:hover { background:var(--surface2); color:var(--text); }
    .nav-item.active { background:var(--green-pale); color:var(--green); font-weight:500; }
    .nav-item svg { width:14px; height:14px; opacity:0.7; flex-shrink:0; }
    .nav-item.active svg { opacity:1; }
    .nav-badge { margin-left:auto; background:var(--green); color:white; font-size:10px; font-weight:500; padding:1px 6px; border-radius:20px; line-height:16px; }
    .sidebar-footer { padding:14px 16px; border-top:1px solid var(--border); }
    .user-row { display:flex; align-items:center; gap:10px; cursor:pointer; padding:6px; border-radius:8px; transition:background 0.12s; }
    .user-row:hover { background:var(--surface2); }
    .avatar { width:28px; height:28px; border-radius:50%; background:var(--green-mid); display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; color:white; flex-shrink:0; }
    .user-info { flex:1; min-width:0; }
    .user-name { font-size:12.5px; font-weight:500; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .user-email { font-size:10.5px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .email-list-pane { width:320px; min-width:320px; max-width:68vw; background:var(--white); border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; }
    .pane-resizer { width:8px; cursor:col-resize; background:linear-gradient(to right, transparent 0, transparent 3px, var(--border) 3px, var(--border) 5px, transparent 5px, transparent 8px); flex-shrink:0; transition:background .12s; }
    .pane-resizer:hover { background:linear-gradient(to right, transparent 0, transparent 3px, var(--green-light) 3px, var(--green-light) 5px, transparent 5px, transparent 8px); }
    body.resizing { cursor:col-resize; user-select:none; }
    .list-header { padding:18px 18px 12px; border-bottom:1px solid var(--border); }
    .list-title-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
    .list-title { font-family:'Fraunces',serif; font-size:18px; font-weight:400; letter-spacing:-0.4px; color:var(--text); }
    .list-count { font-size:12px; color:var(--text-muted); background:var(--surface2); padding:2px 8px; border-radius:20px; }
    .search-bar { display:flex; align-items:center; gap:8px; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:7px 11px; margin-bottom:10px; transition:border-color 0.15s, box-shadow 0.15s; }
    .search-bar:focus-within { border-color:var(--green-light); box-shadow:0 0 0 2px rgba(74,94,69,0.1); }
    .search-bar svg { width:13px; height:13px; color:var(--text-muted); flex-shrink:0; }
    .search-bar input { flex:1; border:none; background:none; font-family:'DM Sans',sans-serif; font-size:13px; color:var(--text); outline:none; }
    .search-bar input::placeholder { color:var(--text-muted); }
    .filter-chips { display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; padding-bottom:2px; }
    .filter-chips::-webkit-scrollbar { display:none; }
    .chip { padding:4px 10px; border-radius:20px; font-size:12px; white-space:nowrap; cursor:pointer; border:1px solid var(--border); background:transparent; color:var(--text-mid); transition:all 0.12s; }
    .chip:hover { background:var(--surface2); }
    .chip.active { background:var(--green-pale); border-color:var(--green-muted); color:var(--green); font-weight:500; }
    .email-list { flex:1; overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--border) transparent; }
    .email-item { padding:13px 18px; border-bottom:1px solid var(--surface); cursor:pointer; transition:background 0.1s; position:relative; }
    .email-item:hover { background:var(--surface); }
    .email-item.active { background:var(--green-pale); border-left:2px solid var(--green); }
    .email-item.unread .email-sender { font-weight:600; color:var(--text); }
    .email-item.unread .email-subject { font-weight:500; }
    .unread-dot { position:absolute; top:50%; left:8px; transform:translateY(-50%); width:5px; height:5px; background:var(--green); border-radius:50%; }
    .email-subject { font-size:13px; color:var(--text); margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .email-preview { font-size:12px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.4; }
    .email-sender { font-size:13px; color:var(--text-mid); }
    .email-time { font-size:11px; color:var(--text-muted); font-variant-numeric:tabular-nums; }
    .reading-pane { flex:1; display:flex; flex-direction:column; overflow:hidden; background:var(--white); }
    .reading-header { padding:20px 32px 16px; border-bottom:1px solid var(--border); }
    .reading-actions { display:flex; align-items:center; gap:8px; margin-bottom:18px; }
    .icon-btn { width:32px; height:32px; border-radius:7px; border:1px solid var(--border); background:transparent; display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--text-muted); transition:all 0.12s; }
    .icon-btn:hover { background:var(--surface); color:var(--text); }
    .icon-btn svg { width:14px; height:14px; }
    .reading-subject { font-family:'Fraunces',serif; font-size:22px; font-weight:400; letter-spacing:-0.5px; color:var(--text); margin-bottom:14px; line-height:1.3; }
    .reading-meta { display:flex; align-items:center; gap:12px; }
    .meta-avatar { width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, var(--green-mid), var(--green-light)); display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600; color:white; flex-shrink:0; overflow:hidden; }
    .meta-info { flex:1; }
    .meta-from { font-size:13.5px; font-weight:500; color:var(--text); }
    .meta-to { font-size:12px; color:var(--text-muted); margin-top:1px; }
    .meta-date { font-size:12px; color:var(--text-muted); }
    .reading-body { flex:1; overflow-y:auto; padding:28px 32px; scrollbar-width:thin; scrollbar-color:var(--border) transparent; }
    .email-body-text { font-size:14.5px; line-height:1.75; color:var(--text-mid); max-width:620px; }
    .email-body-text p { margin-bottom:16px; }
    .email-body-text p:last-child { margin-bottom:0; }
    .modal-overlay { position:fixed; inset:0; background:rgba(30,33,25,0.35); backdrop-filter:blur(4px); display:flex; align-items:flex-end; justify-content:flex-end; padding:24px; z-index:100; opacity:0; pointer-events:none; transition:opacity 0.2s; }
    .modal-overlay.open { opacity:1; pointer-events:all; }
    .compose-modal { width:480px; background:var(--white); border-radius:14px; box-shadow:var(--shadow-lg), 0 0 0 1px var(--border); display:flex; flex-direction:column; overflow:hidden; transform:translateY(16px) scale(0.98); transition:transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1); height:auto; }    .modal-overlay.open .compose-modal { transform:translateY(0) scale(1); }
    .modal-header { padding:14px 18px; background:var(--green); display:flex; align-items:center; justify-content:space-between; }
    .modal-title { font-family:'Fraunces',serif; font-size:14px; font-weight:400; color:white; letter-spacing:-0.2px; }
    .modal-close { width:24px; height:24px; border-radius:6px; border:none; background:rgba(255,255,255,0.15); color:white; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:16px; line-height:1; transition:background 0.12s; }
    .modal-close:hover { background:rgba(255,255,255,0.25); }
    .modal-header-actions { display:flex; align-items:center; gap:6px; }
    .modal-fields { padding:0 18px; }
    .modal-field { display:flex; align-items:center; gap:10px; padding:11px 0; border-bottom:1px solid var(--surface2); }
    .modal-field label { font-size:12px; color:var(--text-muted); width:36px; flex-shrink:0; }
    .modal-field input { flex:1; border:none; background:none; font-family:'DM Sans',sans-serif; font-size:13.5px; color:var(--text); outline:none; }
    .modal-field input::placeholder { color:var(--text-muted); }
    .compose-recipient-wrap { flex:1; position:relative; min-width:0; }
    .compose-recipient-input { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-height:24px; }
    .compose-recipient-input input { flex:1 1 140px; min-width:120px; }
    .compose-recipient-chip { display:inline-flex; align-items:center; gap:6px; max-width:100%; padding:2px 8px; border-radius:999px; border:1px solid var(--green-muted); background:var(--green-pale); color:var(--green); font:500 12px 'DM Sans',sans-serif; }
    .compose-recipient-chip-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:260px; }
    .compose-recipient-chip-remove { border:0; background:transparent; color:inherit; font:500 12px 'DM Sans',sans-serif; cursor:pointer; line-height:1; padding:0; }
    .compose-recipient-suggest { display:none; position:absolute; top:calc(100% + 6px); left:0; right:0; z-index:2600; background:var(--white); border:1px solid var(--border); border-radius:9px; box-shadow:0 10px 24px rgba(0,0,0,.14); max-height:180px; overflow-y:auto; }
    .compose-recipient-suggest.open { display:block; }
    .compose-recipient-option { width:100%; border:0; background:transparent; color:var(--text); text-align:left; padding:8px 10px; display:grid; gap:1px; cursor:pointer; }
    .compose-recipient-option:hover, .compose-recipient-option.active { background:var(--green-pale); }
    .compose-recipient-option-name { font:500 12px 'DM Sans',sans-serif; }
    .compose-recipient-option-email { font:400 11px 'DM Sans',sans-serif; color:var(--text-muted); }
    .modal-body { margin:4px 18px 0; min-height:140px; flex:1; overflow-y:auto; max-height:340px; }
    .compose-editor { width:100%; min-height:100px; max-height:320px; overflow-y:auto; border:none; background:none; font-family:'DM Sans',sans-serif; font-size:13.5px; color:var(--text); outline:none; line-height:1.65; padding:12px 0; white-space:pre-wrap; word-break:break-word; }
    .compose-editor:empty::before { content:attr(data-placeholder); color:var(--text-muted); pointer-events:none; }
    .compose-editor h2 { font:500 20px 'Fraunces',serif; color:var(--text); margin:8px 0; }
    .compose-editor blockquote { border-left:3px solid var(--green-light); background:var(--green-pale); margin:8px 0; padding:8px 10px; color:var(--text-mid); }
    .compose-editor pre { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:10px; margin:8px 0; overflow-x:auto; }
    .compose-editor ul { margin:8px 0 8px 18px; }
    .compose-format-toolbar { display:none; margin:4px 18px 0; padding:8px; border:1px solid var(--border); border-radius:8px; background:var(--surface); flex-wrap:wrap; gap:6px; }
    .compose-format-toolbar.open { display:flex; }
    .compose-format-btn { border:1px solid var(--border); background:var(--white); color:var(--text-mid); border-radius:6px; padding:5px 8px; font-family:'DM Sans',sans-serif; font-size:12px; cursor:pointer; transition:background 0.12s, color 0.12s; }
    .compose-format-btn:hover { background:var(--green-pale); color:var(--green); }
    .compose-attachments { margin:0 18px 10px; display:flex; flex-wrap:wrap; gap:6px; min-height:20px; }
    .compose-attachment { display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:999px; border:1px solid var(--green-muted); background:var(--green-pale); color:var(--green); font-size:11px; max-width:100%; }
    .compose-attachment-name { max-width:180px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .compose-attachment-remove { border:none; background:transparent; color:var(--green); font-size:12px; line-height:1; cursor:pointer; }
    .modal-footer { padding:12px 18px; border-top:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
    .modal-tools { display:flex; gap:6px; }
    .modal-tool { width:30px; height:30px; border-radius:6px; border:1px solid transparent; background:transparent; color:var(--text-muted); cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.12s; }
    .modal-tool:hover { background:var(--surface); border-color:var(--border); color:var(--text); }
    .modal-tool svg { width:14px; height:14px; }
    .modal-tool.active { background:var(--green-pale); border-color:var(--green-muted); color:var(--green); }
    .send-btn { padding:8px 18px; background:var(--green); color:white; border:none; border-radius:8px; font-family:'DM Sans',sans-serif; font-size:13px; font-weight:500; cursor:pointer; display:flex; align-items:center; gap:7px; transition:background 0.15s, transform 0.1s; }
    .send-btn:hover { background:var(--accent); transform:translateY(-1px); }
    .send-btn svg { width:13px; height:13px; }
    @keyframes fadeSlideIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    .email-item { animation:fadeSlideIn 0.2s ease both; }
    .reading-labels { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px; }
    .email-label-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 500; background: var(--surface2); color: var(--text-mid); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border); cursor: pointer; }
    .email-label-badge:hover { background: var(--surface); color: var(--text); }
    .label-remove-btn { border: none; background: transparent; color: var(--text-muted); font-size: 12px; line-height: 1; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
    .label-remove-btn:hover { color: #8a2e2e; }
    .compose-format-btn.active { background: var(--green-pale); color: var(--green); border-color: var(--green-muted); }
  `;
  document.head.appendChild(style);
}
