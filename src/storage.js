const NORMALIZED_EMAILS_KEY = "normalizedEmails";
const ANALYTICS_RESULT_KEY = "analyticsResult";
const LAST_SCAN_TIMESTAMP_KEY = "lastScanTimestamp";
const ANALYSIS_JOB_STATE_KEY = "analysisJobState";
const SCAN_PROGRESS_STATE_KEY = "scanProgressState";

function cloneValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function saveEmails(normalizedEmails) {
  const safeValue = Array.isArray(normalizedEmails) ? cloneValue(normalizedEmails) : [];
  await storageSet({ [NORMALIZED_EMAILS_KEY]: safeValue });
}

export async function getEmails() {
  const result = await storageGet(NORMALIZED_EMAILS_KEY);
  const value = result[NORMALIZED_EMAILS_KEY];
  return Array.isArray(value) ? cloneValue(value) : [];
}

export async function saveAnalyticsResult(analyticsResult) {
  const safeValue = analyticsResult == null ? null : cloneValue(analyticsResult);
  await storageSet({ [ANALYTICS_RESULT_KEY]: safeValue });
}

export async function getAnalyticsResult() {
  const result = await storageGet(ANALYTICS_RESULT_KEY);
  const value = result[ANALYTICS_RESULT_KEY];
  return value == null ? null : cloneValue(value);
}

export async function saveLastScanTimestamp(timestamp) {
  const safeValue = Number(timestamp);
  await storageSet({
    [LAST_SCAN_TIMESTAMP_KEY]: Number.isFinite(safeValue) ? safeValue : null
  });
}

export async function getLastScanTimestamp() {
  const result = await storageGet(LAST_SCAN_TIMESTAMP_KEY);
  const value = result[LAST_SCAN_TIMESTAMP_KEY];
  return Number.isFinite(value) ? value : null;
}

export async function saveAnalysisJobState(jobState) {
  const source = jobState && typeof jobState === "object" ? jobState : {};
  const safeStatus = typeof source.status === "string" ? source.status : "idle";
  const safeResult = source.result == null ? null : cloneValue(source.result);
  const safeError = typeof source.error === "string" ? source.error : null;
  const safeStartedAt = Number(source.startedAt);
  const safeFinishedAt = Number(source.finishedAt);

  await storageSet({
    [ANALYSIS_JOB_STATE_KEY]: {
      status: safeStatus,
      result: safeResult,
      error: safeError,
      startedAt: Number.isFinite(safeStartedAt) ? safeStartedAt : null,
      finishedAt: Number.isFinite(safeFinishedAt) ? safeFinishedAt : null
    }
  });
}

export async function getAnalysisJobState() {
  const result = await storageGet(ANALYSIS_JOB_STATE_KEY);
  const value = result[ANALYSIS_JOB_STATE_KEY];

  if (!value || typeof value !== "object") {
    return {
      status: "idle",
      result: null,
      error: null,
      startedAt: null,
      finishedAt: null
    };
  }

  return {
    status: typeof value.status === "string" ? value.status : "idle",
    result: value.result == null ? null : cloneValue(value.result),
    error: typeof value.error === "string" ? value.error : null,
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : null,
    finishedAt: Number.isFinite(value.finishedAt) ? value.finishedAt : null
  };
}

export async function saveScanProgressState(scanProgressState) {
  const source = scanProgressState && typeof scanProgressState === "object" ? scanProgressState : {};
  const safeStatus = typeof source.scanStatus === "string" ? source.scanStatus : "idle";
  const safeNextPageToken = typeof source.nextPageToken === "string" ? source.nextPageToken : null;
  const safeProcessedCount = Number(source.processedCount);
  const safeScanStartTime = Number(source.scanStartTime);

  await storageSet({
    [SCAN_PROGRESS_STATE_KEY]: {
      scanStatus: safeStatus,
      nextPageToken: safeNextPageToken,
      processedCount: Number.isFinite(safeProcessedCount) && safeProcessedCount >= 0 ? safeProcessedCount : 0,
      scanStartTime: Number.isFinite(safeScanStartTime) ? safeScanStartTime : null
    }
  });
}

export async function getScanProgressState() {
  const result = await storageGet(SCAN_PROGRESS_STATE_KEY);
  const value = result[SCAN_PROGRESS_STATE_KEY];

  if (!value || typeof value !== "object") {
    return {
      scanStatus: "idle",
      nextPageToken: null,
      processedCount: 0,
      scanStartTime: null
    };
  }

  return {
    scanStatus: typeof value.scanStatus === "string" ? value.scanStatus : "idle",
    nextPageToken: typeof value.nextPageToken === "string" ? value.nextPageToken : null,
    processedCount: Number.isFinite(value.processedCount) && value.processedCount >= 0 ? value.processedCount : 0,
    scanStartTime: Number.isFinite(value.scanStartTime) ? value.scanStartTime : null
  };
}
