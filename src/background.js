import { fetchGmailMetadata, normalizeBatch } from "./gmailClient.js";
import { analyzeEmails } from "./analytics.js";
import {
  saveEmails,
  saveAnalyticsResult,
  saveLastScanTimestamp,
  saveAnalysisJobState
} from "./storage.js";

const START_ANALYSIS_MESSAGE = "START_ANALYSIS";

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

async function runAnalysisJob() {
  const startedAt = Date.now();
  await saveAnalysisJobState({
    status: "running",
    result: null,
    error: null,
    startedAt,
    finishedAt: null
  });

  try {
    const result = await runAnalyzePipeline();
    await saveAnalysisJobState({
      status: "complete",
      result: result.analyticsResult,
      error: null,
      startedAt,
      finishedAt: Date.now()
    });
  } catch (error) {
    await saveAnalysisJobState({
      status: "error",
      result: null,
      error: error?.message || "Unknown error",
      startedAt,
      finishedAt: Date.now()
    });
  }
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
  }
});
