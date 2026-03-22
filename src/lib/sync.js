import { syncMailboxPage, getEmails } from "../api.js";
import { ingestContactsFromEmails } from "./contacts.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";

const SYNC_INTERVAL_MS = 45000;
const RESYNC_COOLDOWN_MS = 5 * 60 * 1000;

export const mailboxNextPageToken = new Map();
export const lastSynced = new Map();
export let knownInboxIds = new Set();

export function setKnownInboxIds(ids) {
  knownInboxIds = ids;
}

let syncTimer = null;

export async function notifyNewEmails(nextInbox) {
  const nextIds = new Set((nextInbox || []).map((m) => m.id));
  const unseen = (nextInbox || []).filter((m) => !knownInboxIds.has(m.id) && !m.is_read);
  knownInboxIds = nextIds;

  if (!unseen.length) return;
  const subject = (unseen[0].subject || t("app.no_subject")).replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "");
  showToast(`${t("toast.new_email")}: ${subject}`);

  if (!("Notification" in window)) return;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission === "granted") {
    const first = unseen[0];
    new Notification(t("toast.new_email"), {
      body: `${first.sender} - ${first.subject}`,
    });
  }
}

export async function syncMailboxInBackground(mailbox, force = false, onSynced = null) {
  const key = mailbox;
  const now = Date.now();
  const last = lastSynced.get(key) || 0;

  if (!force && now - last < RESYNC_COOLDOWN_MS) return;
  lastSynced.set(key, now);

  if (mailbox !== "STARRED" && mailbox !== "ARCHIVE") {
    showToast(t("toast.fetching"), "info", 1200);
    const next = await syncMailboxPage(mailbox, null);
    mailboxNextPageToken.set(mailbox, next || null);
  }

  const latest = await getEmails(mailbox);
  ingestContactsFromEmails(latest);

  if (mailbox === "INBOX") {
    await notifyNewEmails(latest);
  }

  if (onSynced) {
    onSynced(mailbox, latest);
  }
}

export function startPeriodicSync(onSynced) {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    syncMailboxInBackground("INBOX", false, onSynced).catch((e) =>
      console.error("Periodic sync failed", e)
    );
  }, SYNC_INTERVAL_MS);
}

export function stopPeriodicSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}
