import { getLang, t } from "./i18n.js";

export function escapeHtml(input) {
  if (!input) return "";
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function sanitizeUnicodeNoise(input) {
  if (!input) return "";
  return input
    .replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function stripMailTimezone(raw) {
  return String(raw || "")
    .replace(/\s(?:GMT|UTC)?[+-]\d{4}\b/gi, "")
    .replace(/\s+\((?:GMT|UTC)[^)]*\)/gi, "")
    .trim();
}

export function formatListDate(raw) {
  const cleanedRaw = stripMailTimezone(raw);
  const d = new Date(cleanedRaw);
  if (Number.isNaN(d.getTime())) return cleanedRaw;

  const lang = getLang();
  const locale = lang === "de" ? "de-DE" : "en-US";

  const now = new Date();
  const dayNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMail = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((dayNow - dayMail) / 86400000);

  if (diff === 0) {
    return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  if (diff === 1) {
    return lang === "de" ? "Gestern" : "Yesterday";
  }
  return d.toLocaleDateString(locale);
}

export function formatReadingDate(raw) {
  const cleanedRaw = stripMailTimezone(raw);
  const d = new Date(cleanedRaw);
  if (Number.isNaN(d.getTime())) return cleanedRaw;

  const locale = getLang() === "de" ? "de-DE" : "en-US";
  const now = new Date();
  const sameYear = now.getFullYear() === d.getFullYear();
  return d.toLocaleString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatAttachmentSize(size) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return "Unknown size";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function mailboxTitle(mailbox) {
  switch (mailbox) {
    case "INBOX": return t("sidebar.inbox");
    case "STARRED": return t("sidebar.starred");
    case "ARCHIVE": return t("sidebar.archive");
    case "SENT": return t("sidebar.sent");
    case "DRAFT": return t("sidebar.drafts");
    default: return t("sidebar.inbox");
  }
}
