import { fetchGmailMetadata } from "./gmailClient.js";
import { analyzeEmails } from "./analytics.js";
import {
  getScanProgressState,
  saveAnalysisJobState,
  saveAnalyticsResult,
  saveEmails,
  saveLastScanTimestamp,
  saveScanProgressState
} from "./storage.js";

const START_ANALYSIS_MESSAGE = "START_ANALYSIS";
const CANCEL_ANALYSIS_MESSAGE = "CANCEL_ANALYSIS";
const RECONNECT_GMAIL_MESSAGE = "RECONNECT_GMAIL";
const AUTH_EXPIRED_ERROR = "Authentication expired. Please reconnect Gmail.";
const AUTHENTICATION_FAILED_ERROR = "Authentication failed. Please reconnect Gmail.";

let activeScanController = null;
let activeScanPromise = null;
let activeAccessToken = null;

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

async function getTokenWithFallback() {
  try {
    return await getToken(false);
  } catch (_error) {
    try {
      return await getToken(true);
    } catch (_error2) {
      return null;
    }
  }
}

async function clearAuthToken(token) {
  if (!token || typeof token !== "string") {
    return;
  }

  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      resolve();
    });
  });
}

async function clearStoredAuthState() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(["authState", "oauthToken", "gmailAuthState"], () => {
      resolve();
    });
  });
}

function isInvalidGrantError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("invalid_grant");
}

function createCodedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isTokenAuthError(error) {
  return error?.code === "TOKEN_EXPIRED" || isInvalidGrantError(error);
}

async function tryRecoverAuthToken(token) {
  await clearAuthToken(token);
  await clearStoredAuthState();
  return getTokenWithFallback();
}

async function triggerReauthFlow() {
  try {
    await getTokenWithFallback();
  } catch (error) {
    console.error("Re-authentication failed:", error?.message || "Unknown error");
  }
}

async function initializeStaleRunningState() {
  const scanProgress = await getScanProgressState();
  if (scanProgress.scanStatus === "running") {
    await saveScanProgressState({
      scanStatus: "stopped",
      nextPageToken: null,
      processedCount: 0,
      scanStartTime: null
    });
  }
}

async function runAnalyzePipeline({ token, signal, scanStartTime, onProgress }) {
  activeAccessToken = token;
  try {
    const fetchResult = await fetchGmailMetadata(token, {
      signal,
      scanStartTime,
      onProgress
    }).catch(async (error) => {
      if (!isTokenAuthError(error)) {
        throw error;
      }

      const recoveredToken = await tryRecoverAuthToken(token);
      if (!recoveredToken) {
        throw createCodedError(AUTH_EXPIRED_ERROR, "TOKEN_EXPIRED");
      }
      activeAccessToken = recoveredToken;

      return fetchGmailMetadata(recoveredToken, {
        signal,
        scanStartTime,
        onProgress
      });
    });

    const normalizedEmails = Array.isArray(fetchResult?.normalizedEmails) ? fetchResult.normalizedEmails : [];
    const analyticsResult = analyzeEmails(normalizedEmails);
    const nextScanTimestamp = Date.now();

    await saveEmails(normalizedEmails);
    await saveAnalyticsResult(analyticsResult);
    await saveLastScanTimestamp(nextScanTimestamp);

    return {
      analyticsResult,
      processedCount: fetchResult.processedCount
    };
  } finally {
    activeAccessToken = null;
  }
}

async function runAnalysisJob(prevalidatedToken = null) {
  if (activeScanPromise) {
    return activeScanPromise;
  }

  if (!prevalidatedToken) {
    throw new Error("Missing OAuth token for analysis.");
  }

  activeScanController = new AbortController();
  const scanStartTime = Date.now();
  const token = prevalidatedToken;

  await saveScanProgressState({
    scanStatus: "running",
    nextPageToken: null,
    processedCount: 0,
    scanStartTime
  });
  await saveAnalysisJobState({
    status: "running",
    result: null,
    error: null,
    startedAt: scanStartTime,
    finishedAt: null
  });

  activeScanPromise = (async () => {
    try {
      const result = await runAnalyzePipeline({
        token,
        signal: activeScanController.signal,
        scanStartTime,
        onProgress: async (progress) => {
          await saveScanProgressState({
            scanStatus: "running",
            nextPageToken: progress.nextPageToken,
            processedCount: progress.processedCount,
            scanStartTime: progress.scanStartTime
          });
        }
      });

      await saveScanProgressState({
        scanStatus: "completed",
        nextPageToken: null,
        processedCount: result.processedCount,
        scanStartTime
      });
      await saveAnalysisJobState({
        status: "complete",
        result: result.analyticsResult,
        error: null,
        startedAt: scanStartTime,
        finishedAt: Date.now()
      });
    } catch (error) {
      const code = error?.code;
      const message = error?.message || "Unknown error";

      if (code === "SCAN_ABORTED") {
        await saveScanProgressState({
          scanStatus: "stopped",
          nextPageToken: null,
          processedCount: 0,
          scanStartTime: null
        });
        await saveAnalysisJobState({
          status: "stopped",
          result: null,
          error: null,
          startedAt: scanStartTime,
          finishedAt: Date.now()
        });
        return;
      }

      if (code === "SCAN_TIMEOUT") {
        await saveScanProgressState({
          scanStatus: "timeout",
          nextPageToken: null,
          processedCount: 0,
          scanStartTime: null
        });
        await saveAnalysisJobState({
          status: "timeout",
          result: null,
          error: "Scan exceeded time limit.",
          startedAt: scanStartTime,
          finishedAt: Date.now()
        });
        return;
      }

      if (code === "TOKEN_EXPIRED") {
        await clearAuthToken(activeAccessToken);
        await clearStoredAuthState();
        await saveScanProgressState({
          scanStatus: "stopped",
          nextPageToken: null,
          processedCount: 0,
          scanStartTime: null
        });
        await saveAnalysisJobState({
          status: "stopped",
          result: null,
          error: AUTH_EXPIRED_ERROR,
          startedAt: scanStartTime,
          finishedAt: Date.now()
        });
        await triggerReauthFlow();
        return;
      }

      if (isInvalidGrantError(error)) {
        await clearAuthToken(activeAccessToken);
        await clearStoredAuthState();
        await saveScanProgressState({
          scanStatus: "stopped",
          nextPageToken: null,
          processedCount: 0,
          scanStartTime: null
        });
        await saveAnalysisJobState({
          status: "stopped",
          result: null,
          error: AUTH_EXPIRED_ERROR,
          startedAt: scanStartTime,
          finishedAt: Date.now()
        });
        await triggerReauthFlow();
        return;
      }

      if (code === "REQUEST_TIMEOUT") {
        await saveScanProgressState({
          scanStatus: "stopped",
          nextPageToken: null,
          processedCount: 0,
          scanStartTime: null
        });
        await saveAnalysisJobState({
          status: "error",
          result: null,
          error: "Request timeout. Scan stopped.",
          startedAt: scanStartTime,
          finishedAt: Date.now()
        });
        return;
      }

      await saveScanProgressState({
        scanStatus: "stopped",
        nextPageToken: null,
        processedCount: 0,
        scanStartTime: null
      });
      await saveAnalysisJobState({
        status: "error",
        result: null,
        error: message,
        startedAt: scanStartTime,
        finishedAt: Date.now()
      });
    } finally {
      activeScanController = null;
      activeScanPromise = null;
    }
  })();

  return activeScanPromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === START_ANALYSIS_MESSAGE) {
    (async () => {
      try {
        const providedToken = typeof message.token === "string" && message.token ? message.token : null;
        const token = providedToken || (await getTokenWithFallback());
        if (!token) {
          await Promise.all([
            saveScanProgressState({
              scanStatus: "stopped",
              nextPageToken: null,
              processedCount: 0,
              scanStartTime: null
            }),
            saveAnalysisJobState({
              status: "error",
              result: null,
              error: AUTHENTICATION_FAILED_ERROR,
              startedAt: null,
              finishedAt: Date.now()
            })
          ]);
          sendResponse({ started: false, error: AUTHENTICATION_FAILED_ERROR });
          return;
        }

        runAnalysisJob(token).catch(async (error) => {
          await Promise.all([
            saveScanProgressState({
              scanStatus: "stopped",
              nextPageToken: null,
              processedCount: 0,
              scanStartTime: null
            }),
            saveAnalysisJobState({
              status: "error",
              result: null,
              error: error?.message || "Unknown error",
              startedAt: null,
              finishedAt: Date.now()
            })
          ]);
        });
        sendResponse({ started: true });
      } catch (error) {
        await Promise.all([
          saveScanProgressState({
            scanStatus: "stopped",
            nextPageToken: null,
            processedCount: 0,
            scanStartTime: null
          }),
          saveAnalysisJobState({
            status: "error",
            result: null,
            error: error?.message || "Unknown error",
            startedAt: null,
            finishedAt: Date.now()
          })
        ]);
        sendResponse({ started: false, error: error?.message || "Unknown error" });
      }
    })().catch(async (error) => {
      await Promise.all([
        saveScanProgressState({
          scanStatus: "stopped",
          nextPageToken: null,
          processedCount: 0,
          scanStartTime: null
        }),
        saveAnalysisJobState({
          status: "error",
          result: null,
          error: error?.message || "Unknown error",
          startedAt: null,
          finishedAt: Date.now()
        })
      ]);
      sendResponse({ started: false, error: error?.message || "Unknown error" });
    });
    return true;
  }

  if (message.type === RECONNECT_GMAIL_MESSAGE) {
    sendResponse({ started: true });
    (async () => {
      if (activeScanController) {
        activeScanController.abort();
      }

      await clearAuthToken(activeAccessToken);
      activeAccessToken = null;
      try {
        const cachedToken = await getToken(false);
        await clearAuthToken(cachedToken);
      } catch (error) {
        console.error("No cached token available to clear:", error?.message || "Unknown error");
      }

      await clearStoredAuthState();
      await saveScanProgressState({
        scanStatus: "stopped",
        nextPageToken: null,
        processedCount: 0,
        scanStartTime: null
      });
      await saveAnalysisJobState({
        status: "stopped",
        result: null,
        error: null,
        startedAt: null,
        finishedAt: Date.now()
      });
      await triggerReauthFlow();
    })().catch((error) => {
      console.error("Reconnect failed:", error?.message || "Unknown error");
    });
    return;
  }

  if (message.type === CANCEL_ANALYSIS_MESSAGE) {
    if (activeScanController) {
      activeScanController.abort();
    }

    Promise.all([
      saveScanProgressState({
        scanStatus: "stopped",
        nextPageToken: null,
        processedCount: 0,
        scanStartTime: null
      }),
      saveAnalysisJobState({
        status: "stopped",
        result: null,
        error: null,
        startedAt: null,
        finishedAt: Date.now()
      })
    ]).finally(() => {
      sendResponse({ stopped: true });
    });
    return true;
  }
});

initializeStaleRunningState().catch((error) => {
  console.error("Failed to initialize scan state:", error?.message || "Unknown error");
});
