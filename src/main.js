import { invoke } from '@tauri-apps/api/core';

async function loadEmails() {
    try {
        await invoke('sync_emails');
        const emails = await invoke('get_emails');
        renderEmails(emails);
    } catch (e) {
        console.error(e);
    }
}

function renderEmails(emails) {
   const list = document.querySelector('.email-list');
   if(!list) return;
   list.innerHTML = '';
   for (const email of emails) {
      list.innerHTML += `
      <div class="email-item ${email.is_read ? '' : 'unread'}" onclick="selectEmail(this)">
        ${email.is_read ? '' : '<div class="unread-dot"></div>'}
        <div class="email-item-inner">
          <div class="email-top">
            <span class="email-sender">${email.sender}</span>
            <span class="email-time">${email.date}</span>
          </div>
          <div class="email-subject">${email.subject}</div>
          <div class="email-preview">${email.body_html.replace(/<[^>]*>?/gm, '').substring(0, 100)}</div>
        </div>
      </div>
      `;
   }
}

document.addEventListener('DOMContentLoaded', () => {
    loadEmails();
});

window.selectEmail = function(el) {
    document.querySelectorAll('.email-item').forEach(i => i.classList.remove('active'));
    el.classList.add('active');
    el.classList.remove('unread');
    const dot = el.querySelector('.unread-dot');
    if (dot) dot.remove();
}
