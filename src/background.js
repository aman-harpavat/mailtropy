import { fetchGmailMetadata, normalizeBatch } from "./gmailClient.js";
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

let activeScanController = null;
let activeScanPromise = null;

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

async function runAnalyzePipeline({ signal, scanStartTime, onProgress }) {
  const token = await getToken(true);
  const fetchResult = await fetchGmailMetadata(token, {
    signal,
    scanStartTime,
    onProgress
  });

  const normalizedEmails = normalizeBatch(fetchResult.rawMessages);
  const analyticsResult = analyzeEmails(normalizedEmails);
  const nextScanTimestamp = Date.now();

  await saveEmails(normalizedEmails);
  await saveAnalyticsResult(analyticsResult);
  await saveLastScanTimestamp(nextScanTimestamp);

  return {
    analyticsResult,
    processedCount: fetchResult.processedCount
  };
}

async function runAnalysisJob() {
  if (activeScanPromise) {
    return activeScanPromise;
  }

  activeScanController = new AbortController();
  const scanStartTime = Date.now();

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
        await saveScanProgressState({
          scanStatus: "idle",
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
    sendResponse({ started: true });
    runAnalysisJob().catch(async (error) => {
      await saveAnalysisJobState({
        status: "error",
        result: null,
        error: error?.message || "Unknown error",
        startedAt: Date.now(),
        finishedAt: Date.now()
      });
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
  console.error("Failed to initialize scan state:", error?.message || error);
});
