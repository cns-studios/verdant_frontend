const { invoke } = window.__TAURI__.core;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await invoke('sync_emails');
        const emails = await invoke('get_emails');
        renderEmails(emails);
    } catch (e) {
        console.error("Failed to load emails: ", e);
    }
});

function renderEmails(emails) {
    const listContainer = document.querySelector('.email-list');
    if (!listContainer) return;
    listContainer.innerHTML = ''; // clear mock emails

    emails.forEach(email => {
        const item = document.createElement('div');
        item.className = `email-item ${email.is_read ? '' : 'unread'}`;
        item.onclick = function() { selectRealEmail(this, email); };

        item.innerHTML = `
            <div class="unread-dot"></div>
            <div class="email-item-inner">
                <div class="email-top">
                <span class="email-sender">${escapeHtml(email.sender)}</span>
                <span class="email-time">${formatDate(email.date)}</span>
                </div>
                <div class="email-subject">${escapeHtml(email.subject)}</div>
                <div class="email-preview">${escapeHtml(email.body_html.substring(0, 100))}...</div>
            </div>
        `;
        listContainer.appendChild(item);
    });
}

function selectRealEmail(node, email) {
    const items = document.querySelectorAll('.email-item');
    items.forEach(i => i.classList.remove('active'));
    node.classList.add('active');
    node.classList.remove('unread');

    // Update reading pane
    document.querySelector('.reading-title').innerText = email.subject;
    document.querySelector('.email-body').innerHTML = email.body_html;
    document.querySelector('.reading-sender-name').innerText = email.sender;
    document.querySelector('.reading-date-full').innerText = email.date;
}

function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

function formatDate(ds) {
    try {
        const d = new Date(ds);
        if (isNaN(d)) return ds;
        return d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    } catch (e) {
        return ds;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const sendBtn = document.querySelector('.send-btn');
    if (sendBtn) {
        sendBtn.addEventListener('click', async () => {
            const inputs = document.querySelectorAll('.modal-field input');
            const to = inputs[0].value;
            const subject = inputs[2].value;
            const body = document.querySelector('.modal-body textarea').value;
            
            try {
                await invoke('send_email', { to, subject, body });
                closeCompose();
                alert("Email sent successfully!");
                document.querySelectorAll('.modal-field input').forEach(i => i.value = '');
                document.querySelector('.modal-body textarea').value = '';
            } catch (e) {
                alert("Failed to send email: " + e);
            }
        });
    }
});
