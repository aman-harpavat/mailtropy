import { fetchGmailMetadata, normalizeBatch } from "./gmailClient.js";
import { analyzeEmails } from "./analytics.js";
import { saveEmails, saveAnalyticsResult, saveLastScanTimestamp } from "./storage.js";

// Uses launchWebAuthFlow instead of getAuthToken to force account picker
// This allows users to switch between Google accounts
function getToken(interactive = true) {
  return new Promise((resolve, reject) => {
    if (!interactive) {
      // For non-interactive, still try getAuthToken for cached tokens
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(new Error("No cached token available"));
          return;
        }
        resolve(token);
      });
      return;
    }

    // For interactive flow, use launchWebAuthFlow to show account picker
    const manifest = chrome.runtime.getManifest();
    const clientId = manifest.oauth2.client_id;
    const scopes = manifest.oauth2.scopes.join(" ");
    const redirectUri = chrome.identity.getRedirectURL();

    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(clientId)}` +
      `&response_type=token` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&prompt=select_account`; // This forces account selection

    chrome.identity.launchWebAuthFlow(
      {
        url: authUrl,
        interactive: true
      },
      (redirectUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!redirectUrl) {
          reject(new Error("No redirect URL returned"));
          return;
        }

        // Extract access token from redirect URL
        const urlParams = new URLSearchParams(redirectUrl.split("#")[1]);
        const token = urlParams.get("access_token");

        if (!token) {
          reject(new Error("No access token in redirect URL"));
          return;
        }

        resolve(token);
      }
    );
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
