import { invoke } from "@tauri-apps/api/core";


export const authStatus = () => invoke("auth_status");
export const connectGmail = () => invoke("connect_gmail");
export const logout = () => invoke("logout");
export const getUserProfile = () => invoke("get_user_profile");


export const listAccounts = () => invoke("list_accounts");
export const switchAccount = (accountId) => invoke("switch_account", { accountId });
export const removeAccount = (accountId) => invoke("remove_account", { accountId });
export const addGmailAccount = () => invoke("add_gmail_account");
export const addImapAccount = (payload) => invoke("add_imap_account", { payload });
export const addGmxAccount = (payload) => invoke("add_gmx_account", { payload });
export const testImapCredentials = (payload) => invoke("test_imap_credentials", { payload });
export const getActiveAccountInfo = () => invoke("get_active_account_info");


export const syncEmails = () => invoke("sync_emails");
export const syncMailbox = (mailbox) => invoke("sync_mailbox", { mailbox });
export const syncMailboxPage = (mailbox, pageToken) => invoke("sync_mailbox_page", { mailbox, pageToken });
export const getEmails = (mailbox) => invoke("get_emails", { mailbox });
export const deepSearchEmails = (query) => invoke("deep_search_emails", { query });
export const setEmailReadStatus = (emailId, isRead) => invoke("set_email_read_status", { emailId, isRead });
export const toggleStarred = (emailId) => invoke("toggle_starred", { emailId });
export const archiveEmail = (emailId) => invoke("archive_email", { emailId });
export const trashEmail = (emailId) => invoke("trash_email", { emailId });
export const getMailboxCounts = () => invoke("get_mailbox_counts");
export const clearLocalData = () => invoke("clear_local_data");


export const sendEmail = (payload) => invoke("send_email", payload);
export const saveDraft = (payload) => invoke("save_draft", payload);
export const sendExistingDraft = (draftId) => invoke("send_existing_draft", { draftId });


export const downloadAttachment = (emailId, attachmentId, filename, contentType) =>
    invoke("download_attachment", { emailId, attachmentId, filename, contentType });


export const checkForUpdates = (channel) => invoke("check_for_updates", { channel });
export const downloadLatestUpdate = (channel) => invoke("download_latest_update", { channel });
export const installAndRelaunch = (filePath) => invoke("install_and_relaunch", { filePath });


export const getInboxThreads = () => invoke("get_inbox_threads");
export const getThreadMessages = (threadId) => invoke("get_thread_messages", { threadId });
export const markThreadRead = (threadId) => invoke("mark_thread_read", { threadId });
export const removeLabel = (emailId, label) => invoke("remove_label", { emailId, label });
