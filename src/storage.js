const LAST_ANALYTICS_KEY = "lastAnalytics";

export async function getLastAnalytics() {
  const result = await chrome.storage.local.get(LAST_ANALYTICS_KEY);
  return result[LAST_ANALYTICS_KEY] ?? null;
}

export async function setLastAnalytics(value) {
  await chrome.storage.local.set({ [LAST_ANALYTICS_KEY]: value });
}
