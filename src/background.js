import { fetchGmailMetadata, normalizeBatch } from "./gmailClient.js";
import { analyzeEmails } from "./analytics.js";
import { saveEmails, saveAnalyticsResult, saveLastScanTimestamp } from "./storage.js";

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

function getCachedToken() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        resolve(null);
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve, reject) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function revokeTokenServerSide(token) {
  const revokeUrl = `https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`;
  const response = await fetch(revokeUrl, { method: "POST" });

  if (!response.ok) {
    throw new Error(`Server token revoke failed (${response.status})`);
  }
}

function clearLocalStorage() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.clear(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function revokeTokenAndSignOut() {
  const token = await getCachedToken();
  const warnings = [];

  if (token) {
    try {
      await removeCachedToken(token);
    } catch (error) {
      warnings.push(`Token cache remove failed: ${error.message}`);
    }

    try {
      await revokeTokenServerSide(token);
    } catch (error) {
      warnings.push(`Server revoke failed: ${error.message}`);
    }
  }

  await clearLocalStorage();

  return {
    warning: warnings.length > 0 ? warnings.join(" | ") : null
  };
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

  if (message.type === "INBOXIQ_RUN_ANALYTICS") {
    runAnalyzePipeline()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Unknown error" }));
    return true;
  }

  if (message.type === "REVOKE_TOKEN") {
    revokeTokenAndSignOut()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to sign out." }));
    return true;
  }
});
