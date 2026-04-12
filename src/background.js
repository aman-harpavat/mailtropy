import { createGmailClient } from "./gmailClient.js";
import { analyzeEmails } from "./analytics.js";
import { setLastAnalytics, getLastAnalytics } from "./storage.js";

const MAX_RESULTS = 50;

function getToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!token) {
        reject(new Error("No OAuth token returned."));
        return;
      }
      resolve(token);
    });
  });
}

const gmailClient = createGmailClient({
  getToken: () => getToken(true)
});

async function runAnalytics() {
  const emails = await gmailClient.fetchNormalizedEmails(MAX_RESULTS);
  const analytics = analyzeEmails(emails);
  await setLastAnalytics(analytics);
  return analytics;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "INBOXIQ_RUN_ANALYTICS") {
    runAnalytics()
      .then((analytics) => sendResponse({ ok: true, analytics }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Unknown error" }));
    return true;
  }

  if (message.type === "INBOXIQ_GET_LAST_ANALYTICS") {
    getLastAnalytics()
      .then((analytics) => sendResponse({ ok: true, analytics }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Unknown error" }));
    return true;
  }
});
