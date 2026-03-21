export function ensureStyles() {
  if (document.getElementById("verdant-dynamic-styles")) return;
  const style = document.createElement("style");
  style.id = "verdant-dynamic-styles";
  style.textContent = `
    .verdant-overlay { position: fixed; inset: 0; z-index: 2100; background: rgba(31,28,24,.42); backdrop-filter: blur(2px); display:flex; align-items:center; justify-content:center; opacity: 0; pointer-events: none; transition: opacity .18s ease; }
    .verdant-overlay.open { opacity: 1; pointer-events: auto; }
    .verdant-panel { width:min(640px, 94vw); max-height: 86vh; overflow:auto; background: var(--surface); border:1px solid var(--border); border-radius:14px; box-shadow: 0 22px 52px rgba(37,35,31,.18); padding: 20px; transform: translateY(12px) scale(.98); transition: transform .18s ease; }
    .verdant-overlay.open .verdant-panel { transform: translateY(0) scale(1); }
    .verdant-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .verdant-head h2 { font: 500 24px 'Fraunces', serif; color: var(--text); }
    .verdant-close { border:1px solid var(--border); background: var(--surface2); border-radius:8px; width:30px; height:30px; cursor:pointer; color:var(--text); }
    .verdant-panel p { font: 400 13px 'DM Sans', sans-serif; color: var(--text-mid); line-height:1.5; margin-bottom:12px; }
    .verdant-actions { display:flex; gap:10px; justify-content:flex-end; }
    .verdant-btn { padding:8px 14px; border-radius:8px; border:1px solid var(--border); background: var(--surface2); color: var(--text); font: 500 12px 'DM Sans', sans-serif; cursor:pointer; }
    .verdant-btn.primary { background: var(--green); color:#fff; border-color: var(--green); }
    .email-item-main { display:flex; align-items:flex-start; gap:10px; width:100%; }
    .email-item { position:relative; }
    .email-item-inner { position:relative; padding-right:76px; flex:1; min-width:0; }
    .email-top { display:block; min-height:16px; margin-bottom:3px; }
    .email-sender { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; -webkit-mask-image: linear-gradient(to right, #000 0%, #000 78%, transparent 100%); mask-image: linear-gradient(to right, #000 0%, #000 78%, transparent 100%); }
    .email-time { position:absolute; right:18px; top:13px; width:72px; text-align:right; white-space:nowrap; font-variant-numeric: tabular-nums; letter-spacing:.01em; z-index:2; }
    .sender-avatar { width:30px; height:30px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center; font:600 11px 'DM Sans', sans-serif; color:#fff; background: linear-gradient(135deg, var(--green-mid), var(--green-light)); overflow:hidden; }
    .sender-avatar img, .meta-avatar img { width:100%; height:100%; object-fit:cover; display:block; }
    .sender-avatar.has-image, .meta-avatar.has-image { background: var(--surface2); color: transparent; }
    .email-body-text pre { white-space: pre-wrap; word-break: break-word; background: var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
    .action-menu { position:absolute; right:0; top:34px; width:190px; background: var(--surface); border:1px solid var(--border); border-radius:10px; box-shadow:0 12px 26px rgba(0,0,0,.12); padding:6px; z-index:1300; }
    .action-menu button { width:100%; text-align:left; border:0; background:transparent; color:var(--text); padding:8px 10px; border-radius:8px; font:400 12px 'DM Sans', sans-serif; cursor:pointer; }
    .action-menu button:hover { background: var(--surface2); }
    .settings-grid { display:grid; gap:10px; margin-top:12px; }
    .settings-row { display:grid; grid-template-columns: 1fr 160px; align-items:center; gap:10px; }
    .settings-row input, .settings-row select { height:34px; border-radius:8px; border:1px solid var(--border); background: var(--bg); padding:0 10px; font:400 12px 'DM Sans', sans-serif; }
    .settings-switch { display:flex; align-items:center; gap:8px; font:400 12px 'DM Sans', sans-serif; color:var(--text); }
    .settings-tabs { display:flex; gap:8px; margin-top:10px; border-bottom:1px solid var(--border); padding-bottom:10px; }
    .settings-tab { border:1px solid var(--border); background: var(--surface2); color:var(--text-mid); border-radius:999px; padding:6px 12px; font:500 12px 'DM Sans', sans-serif; cursor:pointer; }
    .settings-tab.active { background: var(--green-pale); border-color: var(--green-muted); color: var(--green); }
    .settings-pane { display:none; margin-top:12px; }
    .settings-pane.active { display:grid; gap:10px; }
    .settings-card { border:1px solid var(--border); border-radius:10px; background: var(--bg); padding:12px; display:grid; gap:8px; }
    .settings-info-row { display:flex; justify-content:space-between; gap:12px; font:400 12px 'DM Sans', sans-serif; color:var(--text-mid); }
    .settings-info-row strong { color: var(--text); font-weight:500; }
    .settings-help { font:400 12px/1.5 'DM Sans', sans-serif; color:var(--text-mid); margin-top:2px; }
    .settings-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; }
    .settings-danger { color:#8a3b3b; border-color:#dcb9b9; }
    .settings-section-label { font: 500 10px 'DM Sans', sans-serif; letter-spacing: 0.7px; text-transform: uppercase; color: var(--text-muted); margin-top: 14px; margin-bottom: 4px; padding: 0 2px;}
    .settings-section-label:first-child { margin-top: 0; }
    .toast-wrap { position: fixed; top:12px; left:50%; transform: translateX(-50%); z-index:2400; display:grid; gap:8px; }
    .toast { min-width:220px; max-width:520px; padding:10px 14px; border-radius:10px; border:1px solid var(--border); background: var(--surface); color: var(--text); font:500 12px 'DM Sans', sans-serif; box-shadow:0 10px 28px rgba(0,0,0,.12); animation: toast-in .22s ease forwards; }
    .toast.info { border-color: var(--green-muted); }
    .toast.error { border-color: #c08d8d; color: #7a2d2d; }
    @keyframes toast-in { from { opacity:0; transform: translateY(-14px);} to { opacity:1; transform: translateY(0);} }
    .suppress-anim .email-item { animation:none !important; }
    .pager { display:flex; gap:6px; justify-content:center; padding:10px 12px 14px; border-top:1px solid var(--border); background: var(--surface); }
    .pager button { border:1px solid var(--border); background: var(--surface2); color: var(--text); border-radius:8px; padding:6px 10px; cursor:pointer; font:500 12px 'DM Sans', sans-serif; }
    .pager button.active { background: var(--green); color:#fff; border-color: var(--green); }
    .list-fetch-indicator { padding:10px 14px; text-align:center; color:var(--text-muted); font:500 12px 'DM Sans', sans-serif; border-top:1px dashed var(--border); }
    .search-bar { position: relative; }
    .search-bar.has-deep-btn { padding-right: 106px; }
    .deep-search-btn { position:absolute; right:6px; top:50%; transform:translateY(-50%); height:24px; display:inline-flex; align-items:center; border:1px solid var(--green-muted); background: var(--green-pale); color: var(--green); border-radius:999px; padding:0 10px; font:500 11px 'DM Sans', sans-serif; cursor:pointer; white-space:nowrap; }
    .deep-search-btn:disabled { opacity:.6; cursor:default; }
    .email-attachments { border:1px solid var(--border); border-radius:10px; background: var(--surface); padding:10px; margin-bottom:12px; }
    .email-attachments-title { font:600 12px 'DM Sans', sans-serif; color:var(--text-mid); margin-bottom:8px; }
    .email-attachment-list { display:grid; gap:6px; }
    .email-attachment-item { display:flex; align-items:center; justify-content:space-between; gap:10px; border:1px solid var(--border); background: var(--white); border-radius:8px; padding:8px 10px; }
    .email-attachment-meta { min-width:0; display:grid; gap:2px; }
    .email-attachment-name { font:500 12px 'DM Sans', sans-serif; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .email-attachment-sub { font:400 11px 'DM Sans', sans-serif; color:var(--text-muted); }
    .email-attachment-download { border:1px solid var(--border); background: var(--surface2); color: var(--text); border-radius:8px; padding:5px 9px; font:500 11px 'DM Sans', sans-serif; cursor:pointer; }
    .attachment-download-modal { position: fixed; inset: 0; z-index: 2500; background: rgba(31,28,24,.18); pointer-events:none; }
    .attachment-download-card { position:absolute; right:14px; top:14px; width:min(340px, calc(100vw - 28px)); background: var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px; box-shadow: 0 16px 34px rgba(37,35,31,.2); display:flex; align-items:center; gap:10px; transform: translateX(120%); opacity:0; transition: transform .24s ease, opacity .24s ease; }
    .attachment-download-modal.open .attachment-download-card { transform: translateX(0); opacity:1; }
    .attachment-download-icon { width:16px; height:16px; display:flex; align-items:center; justify-content:center; flex-shrink:0; color: var(--green); }
    .attachment-download-icon.is-spinning { border:2px solid var(--green-muted); border-top-color: var(--green); border-radius:50%; animation: verdant-spin .8s linear infinite; }
    .attachment-download-icon.is-success { border:0; animation:none; }
    .attachment-download-icon.is-success svg { width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; }
    .attachment-download-text { font:500 12px 'DM Sans', sans-serif; color: var(--text); }
    @keyframes verdant-spin { to { transform: rotate(360deg); } }
    body.reading-pane-hidden .reading-pane { display: none !important; }
    body.reading-pane-hidden .pane-resizer { display: none !important; }
    body.reading-pane-hidden .email-list-pane { flex:1 1 auto !important; width:auto !important; min-width:0 !important; max-width:none !important; border-right:0 !important; }
    .icon-btn.active { background: var(--green-pale); color: var(--green); border:1px solid var(--green-muted); }
    .icon-btn.danger:hover { background:#f5dede !important; color:#8a2e2e !important; border:1px solid #d79f9f; }
    .compose-maximized { width:min(1100px, 96vw) !important; height:min(90vh, 920px) !important; }
    .compose-maximized .modal-body { height: calc(100% - 190px); }
    #compose-max-btn { display:flex; align-items:center; justify-content:center; }
    #compose-max-btn svg { width:16px; height:16px; }
  `;
  document.head.appendChild(style);
}
