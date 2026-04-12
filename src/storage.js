const NORMALIZED_EMAILS_KEY = "normalizedEmails";
const ANALYTICS_RESULT_KEY = "analyticsResult";
const LAST_SCAN_TIMESTAMP_KEY = "lastScanTimestamp";

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
