import { MESSAGE_TYPES } from "./constants.js";

const analyzeBtn = document.getElementById("analyzeBtn");
const refreshBtn = document.getElementById("refreshBtn");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const dataScopeBannerEl = document.getElementById("dataScopeBanner");
const dataScopeSummaryEl = document.getElementById("dataScopeSummary");
const dataScopeLastScanEl = document.getElementById("dataScopeLastScan");

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function getStorageValues(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function normalizeForDashboard(analyticsResult) {
  const source = analyticsResult && typeof analyticsResult === "object" ? analyticsResult : {};
  const totalEmails = Number(source.totalEmails) || 0;
  const uniqueSenders = Number(source.uniqueSenders) || (Array.isArray(source.senderStats) ? source.senderStats.length : 0);
  const unsubscribeEligible =
    Number(source.unsubscribeEligible) || (Array.isArray(source.subscriptions) ? source.subscriptions.length : 0);
  const topSendersRaw = Array.isArray(source.topSenders)
    ? source.topSenders
    : Array.isArray(source.domainStats)
      ? source.domainStats.map((item) => ({ domain: item?.domain, count: item?.count }))
      : [];

  const topSenders = topSendersRaw
    .map((item) => ({
      domain: typeof item?.domain === "string" ? item.domain : "",
      count: Number(item?.count) || 0
    }))
    .filter((item) => item.domain)
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, 5);

  return { totalEmails, uniqueSenders, unsubscribeEligible, topSenders };
}

export function renderOverview(analyticsResult) {
  const normalized = normalizeForDashboard(analyticsResult);
  return [
    "Overview",
    `- Total Emails: ${normalized.totalEmails}`,
    `- Unique Senders: ${normalized.uniqueSenders}`,
    `- Unsubscribe Eligible Senders: ${normalized.unsubscribeEligible}`
  ].join("\n");
}

export function renderTopSenders(analyticsResult) {
  const normalized = normalizeForDashboard(analyticsResult);
  if (normalized.topSenders.length === 0) {
    return "Top Senders\n- No sender data yet";
  }

  return [
    "Top Senders",
    ...normalized.topSenders.map((item) => `- ${item.domain} — ${item.count} emails`)
  ].join("\n");
}

export function renderTimestamp(lastScanTimestamp) {
  const numeric = Number(lastScanTimestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "Last Scan: Not available";
  }
  return `Last Scan: ${new Date(numeric).toLocaleString()}`;
}

function formatBannerTimestamp(lastScanTimestamp) {
  const numeric = Number(lastScanTimestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "Not available";
  }

  const date = new Date(numeric);
  const datePart = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
  const timePart = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });

  return `${datePart}, ${timePart}`;
}

function hideDataScopeBanner() {
  if (dataScopeBannerEl) {
    dataScopeBannerEl.hidden = true;
  }
}

function renderDataScopeBanner(analyticsResult, lastScanTimestamp) {
  if (!dataScopeBannerEl || !dataScopeSummaryEl || !dataScopeLastScanEl) {
    return;
  }

  const normalized = normalizeForDashboard(analyticsResult);
  dataScopeSummaryEl.textContent = `Mailtropy analyzed ${normalized.totalEmails.toLocaleString()} messages from All Mail`;
  dataScopeLastScanEl.textContent = `Last scan: ${formatBannerTimestamp(lastScanTimestamp)}`;
  dataScopeBannerEl.hidden = false;
}

function renderDashboard(analyticsResult, lastScanTimestamp) {
  outputEl.textContent = [
    renderOverview(analyticsResult),
    "",
    renderTopSenders(analyticsResult),
    "",
    renderTimestamp(lastScanTimestamp)
  ].join("\n");
}

export function setLoadingState() {
  analyzeBtn.disabled = true;
  if (refreshBtn) {
    refreshBtn.disabled = true;
  }
  statusEl.classList.remove("error");
  statusEl.textContent = "Analyzing inbox...";
}

export function setErrorState(message) {
  analyzeBtn.disabled = false;
  if (refreshBtn) {
    refreshBtn.disabled = false;
  }
  statusEl.classList.add("error");
  statusEl.textContent = message || "Analysis failed.";
}

export async function loadExistingData() {
  const stored = await getStorageValues(["analyticsResult", "lastScanTimestamp"]);
  const analyticsResult = stored?.analyticsResult ?? null;
  const lastScanTimestamp = stored?.lastScanTimestamp ?? null;

  if (!analyticsResult) {
    statusEl.classList.remove("error");
    statusEl.textContent = "No scan yet";
    outputEl.textContent = "Run analysis to see insights";
    hideDataScopeBanner();
    return;
  }

  statusEl.classList.remove("error");
  statusEl.textContent = "Loaded latest analysis";
  renderDataScopeBanner(analyticsResult, lastScanTimestamp);
  renderDashboard(analyticsResult, lastScanTimestamp);
}

export async function runAnalysis() {
  setLoadingState();

  try {
    const response = await sendRuntimeMessage({ type: MESSAGE_TYPES.RUN_ANALYTICS });
    if (!response?.ok) {
      throw new Error(response?.error || "Analysis failed.");
    }

    const analyticsResult = response?.analyticsResult ?? null;
    const lastScanTimestamp = response?.lastScanTimestamp ?? Date.now();

    if (!analyticsResult) {
      throw new Error("No analytics result returned.");
    }

    analyzeBtn.disabled = false;
    if (refreshBtn) {
      refreshBtn.disabled = false;
    }
    statusEl.classList.remove("error");
    statusEl.textContent = "Analysis complete";
    renderDataScopeBanner(analyticsResult, lastScanTimestamp);
    renderDashboard(analyticsResult, lastScanTimestamp);
  } catch (error) {
    setErrorState(error?.message || "Analysis failed.");
  }
}

export async function init() {
  analyzeBtn.addEventListener("click", runAnalysis);
  if (refreshBtn) {
    refreshBtn.addEventListener("click", runAnalysis);
  }

  try {
    await loadExistingData();
  } catch (error) {
    setErrorState(error?.message || "Failed to load existing analysis.");
    outputEl.textContent = "Run analysis to see insights";
    hideDataScopeBanner();
  }
}

init();
