const analyzeBtn = document.getElementById("analyzeBtn");
const loadingPlaceholderEl = document.getElementById("loadingPlaceholder");
const statusEl = document.getElementById("status");
const analyticsContainerEl = document.getElementById("analyticsContainer");
const analysisViewEl = document.getElementById("analysisView");
const actionsViewEl = document.getElementById("actionsView");
const viewActionsBtn = document.getElementById("viewActionsBtn");
const backToAnalysisBtn = document.getElementById("backToAnalysisBtn");
const actionsOutputEl = document.getElementById("actionsOutput");
let view = "analysis";
let latestAnalyticsResult = null;
let jobStatePollTimer = null;
let isAnalyzing = false;
const START_ANALYSIS_MESSAGE = "START_ANALYSIS";
const CANCEL_ANALYSIS_MESSAGE = "CANCEL_ANALYSIS";
const ANALYSIS_JOB_STATE_KEY = "analysisJobState";
const SCAN_PROGRESS_STATE_KEY = "scanProgressState";
const JOB_POLL_INTERVAL_MS = 1500;

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
  const domainAnalysisSource = source?.domainAnalysis && typeof source.domainAnalysis === "object" ? source.domainAnalysis : {};
  const subscriptionAnalysisSource =
    source?.subscriptionAnalysis && typeof source.subscriptionAnalysis === "object" ? source.subscriptionAnalysis : {};
  const topSenders = Array.isArray(senderAnalysisSource.topSenders) ? senderAnalysisSource.topSenders : [];
  const topDomains = Array.isArray(domainAnalysisSource.topDomains) ? domainAnalysisSource.topDomains : [];
  const topSubscriptionSenders = Array.isArray(subscriptionAnalysisSource.topSubscriptionSenders)
    ? subscriptionAnalysisSource.topSubscriptionSenders
    : [];
  const uniqueSenders = Number(senderAnalysisSource.uniqueSenders) || 0;
  const concentrationPercent = Number(senderAnalysisSource.concentrationPercent) || 0;
  const concentrationLabel =
    typeof senderAnalysisSource.concentrationLabel === "string" ? senderAnalysisSource.concentrationLabel : "Low Concentration";
  const uniqueDomains = Number(domainAnalysisSource.uniqueDomains) || 0;
  const domainConcentrationPercent = Number(domainAnalysisSource.concentrationPercent) || 0;
  const domainConcentrationLabel =
    typeof domainAnalysisSource.concentrationLabel === "string" ? domainAnalysisSource.concentrationLabel : "Low Concentration";
  const totalSubscriptionEmails = Number(subscriptionAnalysisSource.totalSubscriptionEmails) || 0;
  const subscriptionPercentOfInbox = Number(subscriptionAnalysisSource.percentOfInbox) || 0;
  const totalSubscriptionSenders = Number(subscriptionAnalysisSource.totalSubscriptionSenders) || 0;

  return {
    totalEmails,
    uniqueSenders,
    concentrationPercent,
    concentrationLabel,
    topSenders,
    uniqueDomains,
    domainConcentrationPercent,
    domainConcentrationLabel,
    topDomains,
    totalSubscriptionEmails,
    subscriptionPercentOfInbox,
    totalSubscriptionSenders,
    topSubscriptionSenders
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderActionsView() {
  if (!actionsOutputEl) {
    return;
  }

  if (!latestAnalyticsResult) {
    actionsOutputEl.innerHTML = "<p class=\"actions-empty\">Run analysis first to see recommended actions.</p>";
    return;
  }

  const normalized = normalizeForDashboard(latestAnalyticsResult);
  const topSender = normalized.topSenders[0];
  const topDomain = normalized.topDomains[0];
  const topSubscriptionSender = normalized.topSubscriptionSenders[0];
  const senderQuery = typeof topSender?.sender === "string" && topSender.sender ? `from:${topSender.sender}` : "";
  const domainQuery = typeof topDomain?.domain === "string" && topDomain.domain ? `from:${topDomain.domain}` : "";
  const subscriptionSender = typeof topSubscriptionSender?.sender === "string" ? topSubscriptionSender.sender : "";
  const subscriptionSearchQuery = subscriptionSender ? `from:${subscriptionSender}` : "";

  const senderQueryBox = senderQuery
    ? `<p class="query-label">For Sender</p><div class="search-box">${escapeHtml(senderQuery)}</div>`
    : "";
  const domainQueryBox = domainQuery
    ? `<p class="query-label">For Domain</p><div class="search-box">${escapeHtml(domainQuery)}</div>`
    : "";
  
  const afterUnsubscribeLine = subscriptionSearchQuery
    ? `<p class="after-unsubscribe">After unsubscribing, search for the sender and repeat bulk delete steps</p>`
    : "";

  actionsOutputEl.innerHTML = `
    <h2 class="section-title">Bulk Delete Emails from Top Sender or Domain</h2>
    <div class="action-block">
      <ol class="action-list">
        <li class="action-step">In Gmail search bar, type:</li>
      </ol>
      ${senderQueryBox}
      ${domainQueryBox}
      <ol class="action-list" start="2">
        <li class="action-step">Press Enter</li>
        <li class="action-step">Switch sorting to <span class="inline-code">Most recent</span></li>
        <li class="action-step">Click the top checkbox</li>
        <li class="action-step">To delete more than Gmail's default 50 visible emails at once, click the link that says: "Select all conversations that match this search"</li>
        <li class="action-step">Click the Delete icon</li>
        <li class="action-step">Confirm</li>
      </ol>
    </div>
    <div class="section-divider"></div>
    <h2 class="section-title">Unsubscribe from Subscription Senders</h2>
    <div class="action-block">
      <ol class="action-list">
        <li class="action-step">Open any recent email from the sender</li>
        <li class="action-step">Look near the top of the email for "Unsubscribe" or "List-Unsubscribe" link</li>
        <li class="action-step">Click unsubscribe and confirm</li>
      </ol>
      ${afterUnsubscribeLine}
    </div>
  `;
}

function renderView() {
  if (analysisViewEl) {
    analysisViewEl.hidden = view !== "analysis";
  }
  if (actionsViewEl) {
    actionsViewEl.hidden = view !== "actions";
  }

  if (view === "actions") {
    renderActionsView();
  }
}

function setView(nextView) {
  view = nextView === "actions" ? "actions" : "analysis";
  if (view === "actions") {
    window.scrollTo(0, 0);
  }
  renderView();
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
  const existingBanner = document.getElementById("dataScopeBanner");
  if (existingBanner) {
    existingBanner.remove();
  }
}

function renderDataScopeBanner(analyticsResult, lastScanTimestamp) {
  // Remove existing banner if present
  const existingBanner = document.getElementById("dataScopeBanner");
  if (existingBanner) {
    existingBanner.remove();
  }

  const normalized = normalizeForDashboard(analyticsResult);

  // Create the banner section
  const bannerSection = document.createElement("section");
  bannerSection.id = "dataScopeBanner";
  bannerSection.className = "data-scope-banner";
  bannerSection.setAttribute("aria-label", "Data scope summary");

  const leftDiv = document.createElement("div");
  leftDiv.className = "data-scope-left";

  const summaryP = document.createElement("p");
  summaryP.id = "dataScopeSummary";
  summaryP.className = "data-scope-title";
  summaryP.textContent = `Mailtropy analyzed ${normalized.totalEmails.toLocaleString()} messages from All Mail`;
  leftDiv.appendChild(summaryP);

  // Add the subtext
  const subtitle = document.createElement("p");
  subtitle.className = "data-scope-subtitle";
  subtitle.textContent = "Gmail groups related messages into conversations, so the count shown may differ from the above total";
  leftDiv.appendChild(subtitle);

  const rightDiv = document.createElement("div");
  rightDiv.className = "data-scope-right";

  const lastScanP = document.createElement("p");
  lastScanP.id = "dataScopeLastScan";
  lastScanP.className = "data-scope-last-scan";
  lastScanP.textContent = `Last scan: ${formatBannerTimestamp(lastScanTimestamp)}`;
  rightDiv.appendChild(lastScanP);

  bannerSection.appendChild(leftDiv);
  bannerSection.appendChild(rightDiv);

  // Insert before analyticsContainerEl
  if (analyticsContainerEl && analyticsContainerEl.parentNode) {
    analyticsContainerEl.parentNode.insertBefore(bannerSection, analyticsContainerEl);
  }
}

function renderDashboard(analyticsResult, lastScanTimestamp) {
  if (!analyticsContainerEl) {
    return;
  }

  const normalized = normalizeForDashboard(analyticsResult);
  const concentrationPercent = Math.round(normalized.concentrationPercent);
  const domainConcentrationPercent = Math.round(normalized.domainConcentrationPercent);
  const subscriptionPercent = Math.round(normalized.subscriptionPercentOfInbox);

  const getConcentrationClass = (label) => {
    if (label.toLowerCase().includes('low')) return 'low';
    if (label.toLowerCase().includes('moderate')) return 'moderate';
    if (label.toLowerCase().includes('high')) return 'high';
    return 'low';
  };

  const buildBarRows = (items, total, labelKey) => {
    if (!Array.isArray(items) || items.length === 0) {
      return `<p class="empty-state-text">No data available</p>`;
    }

    return items.slice(0, 5).map((item) => {
      const label = typeof item?.[labelKey] === "string" ? item[labelKey] : "Unknown";
      const count = Number(item?.count) || 0;
      const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
      const safeLabel = escapeHtml(label);
      return `
        <div class="bar-row">
          <div class="bar-header">
            <span class="bar-label">${safeLabel}</span>
            <span class="bar-metrics">${count} emails • ${percentage}%</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="width: ${percentage}%"></div>
          </div>
        </div>
      `;
    }).join("");
  };

  const senderBars = buildBarRows(normalized.topSenders, normalized.totalEmails, "sender");
  const domainBars = buildBarRows(normalized.topDomains, normalized.totalEmails, "domain");
  const subscriptionBars = buildBarRows(normalized.topSubscriptionSenders, normalized.totalEmails, "sender");

  analyticsContainerEl.innerHTML = `
    <h2 class="section-title">Sender Insights</h2>
    <div class="analytics-block">
      <p class="metric">Unique Senders: <strong>${normalized.uniqueSenders}</strong></p>
      <div class="concentration-display">
        <div class="concentration-pill ${getConcentrationClass(normalized.concentrationLabel)}">${normalized.concentrationLabel}</div>
        <p class="concentration-text">Top senders account for ${concentrationPercent}% of your inbox</p>
      </div>
      ${senderBars}
    </div>
    <div class="section-divider"></div>

    <h2 class="section-title">Domain Insights</h2>
    <div class="analytics-block">
      <p class="metric">Unique Domains: <strong>${normalized.uniqueDomains}</strong></p>
      <div class="concentration-display">
        <div class="concentration-pill ${getConcentrationClass(normalized.domainConcentrationLabel)}">${normalized.domainConcentrationLabel}</div>
        <p class="concentration-text">Top domains account for ${domainConcentrationPercent}% of your inbox</p>
      </div>
      ${domainBars}
    </div>
    <div class="section-divider"></div>

    <h2 class="section-title">Subscription Insights</h2>
    <div class="analytics-block">
      <p class="metric">Subscription Emails: <strong>${normalized.totalSubscriptionEmails}</strong></p>
      <p class="metric">% of Inbox: <strong>${subscriptionPercent}%</strong></p>
      <p class="metric">Unique Subscription Senders: <strong>${normalized.totalSubscriptionSenders}</strong></p>
      ${subscriptionBars}
    </div>
  `;

  analyticsContainerEl.hidden = false;
}

function stopJobStatePolling() {
  if (jobStatePollTimer != null) {
    clearInterval(jobStatePollTimer);
    jobStatePollTimer = null;
  }
}

function startJobStatePolling() {
  stopJobStatePolling();
  pollAnalysisJobState().catch((error) => {
    console.error("Polling failed:", error?.message || error);
  });
  jobStatePollTimer = setInterval(() => {
    pollAnalysisJobState().catch((error) => {
      console.error("Polling failed:", error?.message || error);
    });
  }, JOB_POLL_INTERVAL_MS);
}

async function pollAnalysisJobState() {
  const stored = await getStorageValues([ANALYSIS_JOB_STATE_KEY, SCAN_PROGRESS_STATE_KEY, "lastScanTimestamp"]);
  const jobState = stored?.[ANALYSIS_JOB_STATE_KEY] || {};
  const scanProgress = stored?.[SCAN_PROGRESS_STATE_KEY] || {};
  const status = typeof jobState?.status === "string" ? jobState.status : "idle";
  const scanStatus = typeof scanProgress?.scanStatus === "string" ? scanProgress.scanStatus : "idle";

  if (scanStatus === "running" || status === "running") {
    if (!isAnalyzing) {
      setLoadingState();
    }
    analyzeBtn.textContent = "Stop Scan";
    console.log("Running...");
    return;
  }

  if (status === "complete") {
    stopJobStatePolling();
    const analyticsResult = jobState?.result ?? null;
    const lastScanTimestamp = Number.isFinite(stored?.lastScanTimestamp)
      ? stored.lastScanTimestamp
      : Number(jobState?.finishedAt) || Date.now();

    if (!analyticsResult) {
      throw new Error("Analysis completed but no result was stored.");
    }

    latestAnalyticsResult = analyticsResult;
    setAnalyzing(false);
    analyzeBtn.disabled = false;
    statusEl.classList.remove("error");
    statusEl.textContent = "Analysis complete";
    renderDataScopeBanner(analyticsResult, lastScanTimestamp);
    renderDashboard(analyticsResult, lastScanTimestamp);
    if (viewActionsBtn) {
      viewActionsBtn.disabled = false;
    }
    analyzeBtn.textContent = "Analyze Mail Box";
    console.log("Completed");
    return;
  }

  if (status === "timeout" || scanStatus === "timeout") {
    stopJobStatePolling();
    setAnalyzing(false);
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze Mail Box";
    statusEl.classList.add("error");
    statusEl.textContent = "Scan exceeded time limit.";
    console.log("Error: Scan exceeded time limit.");
    return;
  }

  if (status === "stopped" || scanStatus === "stopped") {
    stopJobStatePolling();
    setAnalyzing(false);
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze Mail Box";
    statusEl.classList.remove("error");
    statusEl.textContent = "Scan stopped.";
    return;
  }

  if (status === "error") {
    stopJobStatePolling();
    const message = typeof jobState?.error === "string" ? jobState.error : "Analysis failed.";
    setErrorState(message);
    analyzeBtn.textContent = "Analyze Mail Box";
    console.log(`Error: ${message}`);
    return;
  }

  setAnalyzing(false);
  analyzeBtn.textContent = "Analyze Mail Box";
  stopJobStatePolling();
}

function updateScanUI() {
  if (!viewActionsBtn || !analyticsContainerEl) {
    return;
  }

  const shouldShow = !isAnalyzing && latestAnalyticsResult != null;

  if (!shouldShow) {
    hideDataScopeBanner();
  }
  viewActionsBtn.hidden = !shouldShow;
  analyticsContainerEl.hidden = !shouldShow;
}

function updateLoadingState() {
  if (!loadingPlaceholderEl) {
    return;
  }

  if (isAnalyzing) {
    if (!loadingPlaceholderEl.hasChildNodes()) {
      loadingPlaceholderEl.innerHTML = `
        <div id="loadingState" class="loading-state" aria-live="polite" aria-busy="true">
          <div class="loading-indicator" aria-hidden="true"></div>
          <div class="loading-text">
            <p class="loading-title">Analyzing your inbox…</p>
            <p class="loading-description">This may take some time depending on your email volume.</p>
          </div>
        </div>
      `;
    }
  } else {
    if (loadingPlaceholderEl.hasChildNodes()) {
      loadingPlaceholderEl.innerHTML = "";
    }
  }
}

function setAnalyzing(value) {
  const nextState = value === true;
  if (isAnalyzing === nextState) {
    return;
  }
  isAnalyzing = nextState;
  updateLoadingState();
  updateScanUI();
}

export function setLoadingState() {
  setAnalyzing(true);
  analyzeBtn.disabled = false;
  analyzeBtn.textContent = "Stop Scan";
  statusEl.classList.remove("error");
  statusEl.textContent = "";
}

function setErrorState(message) {
  setAnalyzing(false);
  analyzeBtn.disabled = false;
  statusEl.classList.add("error");
  statusEl.textContent = message || "Analysis failed.";
}

export async function loadExistingData() {
  const stored = await getStorageValues([
    "analyticsResult",
    "lastScanTimestamp",
    ANALYSIS_JOB_STATE_KEY,
    SCAN_PROGRESS_STATE_KEY
  ]);
  const analyticsResult = stored?.analyticsResult ?? null;
  const lastScanTimestamp = stored?.lastScanTimestamp ?? null;
  const jobState = stored?.[ANALYSIS_JOB_STATE_KEY] || {};
  const scanProgress = stored?.[SCAN_PROGRESS_STATE_KEY] || {};
  const jobStatus = typeof jobState?.status === "string" ? jobState.status : "idle";
  const scanStatus = typeof scanProgress?.scanStatus === "string" ? scanProgress.scanStatus : "idle";

  if (scanStatus === "running" || jobStatus === "running") {
    latestAnalyticsResult = null;
    setLoadingState();
    if (analyticsContainerEl) {
      analyticsContainerEl.hidden = true;
    }
    if (viewActionsBtn) {
      viewActionsBtn.disabled = true;
    }
    hideDataScopeBanner();
    startJobStatePolling();
    console.log("Running...");
    return;
  }

  setAnalyzing(false);
  analyzeBtn.textContent = "Analyze Mail Box";

  if (!analyticsResult && jobStatus !== "complete") {
    latestAnalyticsResult = null;
    updateScanUI();
    statusEl.classList.remove("error");
    statusEl.textContent = "No scan yet";
    if (analyticsContainerEl) {
      analyticsContainerEl.hidden = true;
    }
    if (viewActionsBtn) {
      viewActionsBtn.disabled = true;
    }
    hideDataScopeBanner();
    return;
  }

  latestAnalyticsResult = analyticsResult;
  updateScanUI();
  statusEl.classList.remove("error");
  statusEl.textContent = "Loaded latest analysis";
  renderDataScopeBanner(analyticsResult, lastScanTimestamp);
  renderDashboard(analyticsResult, lastScanTimestamp);
  if (viewActionsBtn) {
    viewActionsBtn.disabled = false;
  }
}

export async function runAnalysis() {
  if (isAnalyzing) {
    try {
      await sendRuntimeMessage({ type: CANCEL_ANALYSIS_MESSAGE });
    } catch (error) {
      console.log(`Error: ${error?.message || "Failed to stop scan."}`);
    } finally {
      stopJobStatePolling();
      setAnalyzing(false);
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = "Analyze Mail Box";
      statusEl.classList.remove("error");
      statusEl.textContent = "Scan stopped.";
    }
    return;
  }

  setLoadingState();
  if (analyticsContainerEl) {
    analyticsContainerEl.hidden = true;
  }
  if (viewActionsBtn) {
    viewActionsBtn.disabled = true;
  }
  hideDataScopeBanner();
  console.log("Running...");

  try {
    const response = await sendRuntimeMessage({ type: START_ANALYSIS_MESSAGE });
    if (!response?.started) {
      throw new Error("Failed to start analysis job.");
    }
    startJobStatePolling();
  } catch (error) {
    stopJobStatePolling();
    setErrorState(error?.message || "Analysis failed.");
    console.log(`Error: ${error?.message || "Analysis failed."}`);
  }
}

export async function init() {
  analyzeBtn.addEventListener("click", runAnalysis);
  if (viewActionsBtn) {
    viewActionsBtn.addEventListener("click", () => setView("actions"));
  }
  if (backToAnalysisBtn) {
    backToAnalysisBtn.addEventListener("click", () => setView("analysis"));
  }

  try {
    await loadExistingData();
  } catch (error) {
    setErrorState(error?.message || "Failed to load existing analysis.");
    latestAnalyticsResult = null;
    if (analyticsContainerEl) {
      analyticsContainerEl.hidden = true;
    }
    if (viewActionsBtn) {
      viewActionsBtn.disabled = true;
    }
    hideDataScopeBanner();
  }

  renderView();
}

init();
