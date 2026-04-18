import { MESSAGE_TYPES } from "./constants.js";

const analyzeBtn = document.getElementById("analyzeBtn");
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
  const senderAnalysisSource = source?.senderAnalysis && typeof source.senderAnalysis === "object" ? source.senderAnalysis : {};
  const topSenders = Array.isArray(senderAnalysisSource.topSenders) ? senderAnalysisSource.topSenders : [];
  const uniqueSenders = Number(senderAnalysisSource.uniqueSenders) || 0;
  const concentrationPercent = Number(senderAnalysisSource.concentrationPercent) || 0;
  const concentrationLabel =
    typeof senderAnalysisSource.concentrationLabel === "string" ? senderAnalysisSource.concentrationLabel : "Low Concentration";

  return { totalEmails, uniqueSenders, concentrationPercent, concentrationLabel, topSenders };
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
  const normalized = normalizeForDashboard(analyticsResult);
  const concentrationDisplay = normalized.concentrationPercent.toFixed(1);
  const senderLines =
    normalized.topSenders.length > 0
      ? normalized.topSenders.map((item) => {
          const sender = typeof item?.sender === "string" ? item.sender : "Unknown sender";
          const count = Number(item?.count) || 0;
          const percent = Number(item?.percent) || 0;
          return `- ${sender} — ${count} emails (${percent.toFixed(1)}%)`;
        })
      : ["- No sender data yet"];

  outputEl.textContent = [
    "Sender Analysis",
    `- Unique Senders: ${normalized.uniqueSenders}`,
    `- Inbox Concentration: ${concentrationDisplay}% — ${normalized.concentrationLabel}`,
    `Top senders account for ${concentrationDisplay}% of your inbox.`,
    "",
    ...senderLines
  ].join("\n");
}

export function setLoadingState() {
  analyzeBtn.disabled = true;
  statusEl.classList.remove("error");
  statusEl.textContent = "Analyzing inbox...";
}

export function setErrorState(message) {
  analyzeBtn.disabled = false;
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

  try {
    await loadExistingData();
  } catch (error) {
    setErrorState(error?.message || "Failed to load existing analysis.");
    outputEl.textContent = "Run analysis to see insights";
    hideDataScopeBanner();
  }
}

init();
