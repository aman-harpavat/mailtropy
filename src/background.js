import { fetchGmailMetadata, normalizeBatch } from "./gmailClient.js";
import { analyzeEmails } from "./analytics.js";
import { saveEmails, saveAnalyticsResult, saveLastScanTimestamp } from "./storage.js";
import { MESSAGE_TYPES } from "./constants.js";

function getToken(interactive = true) {
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

async function runAnalyzePipeline() {
  const token = await getToken(true);
  const rawMessages = await fetchGmailMetadata(token);
  const normalizedEmails = normalizeBatch(rawMessages);
  const analyticsResult = analyzeEmails(normalizedEmails);
  const nextScanTimestamp = Date.now();

  await saveEmails(normalizedEmails);
  await saveAnalyticsResult(analyticsResult);
  await saveLastScanTimestamp(nextScanTimestamp);

  return {
    analyticsResult,
    lastScanTimestamp: nextScanTimestamp
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === MESSAGE_TYPES.RUN_ANALYTICS) {
    runAnalyzePipeline()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Unknown error" }));
    return true;
  }
});


