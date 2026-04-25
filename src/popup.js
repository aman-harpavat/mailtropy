const analyzeBtn = document.getElementById("analyzeBtn");
const loadingPlaceholderEl = document.getElementById("loadingPlaceholder");
const statusEl = document.getElementById("status");
const analyticsContainerEl = document.getElementById("analyticsContainer");
const analysisViewEl = document.getElementById("analysisView");
const actionsViewEl = document.getElementById("actionsView");
const viewActionsBtn = document.getElementById("viewActionsBtn");
const backToAnalysisBtn = document.getElementById("backToAnalysisBtn");
const actionsOutputEl = document.getElementById("actionsOutput");
const privacyBtn = document.getElementById("privacyBtn");
const reconnectBtn = document.getElementById("reconnectBtn");
let view = "analysis";
let latestAnalyticsResult = null;
let jobStatePollTimer = null;
const STATE_IDLE = "idle";
const STATE_AUTHENTICATING = "authenticating";
const STATE_ANALYZING = "analyzing";
const STATE_ERROR = "error";
let currentState = STATE_IDLE;
let pendingScan = false;
let copyFeedbackTimerId = null;
let copyFeedbackButton = null;
const START_ANALYSIS_MESSAGE = "START_ANALYSIS";
const CANCEL_ANALYSIS_MESSAGE = "CANCEL_ANALYSIS";
const ANALYSIS_JOB_STATE_KEY = "analysisJobState";
const SCAN_PROGRESS_STATE_KEY = "scanProgressState";
const JOB_POLL_INTERVAL_MS = 1500;
const EMPTY_INBOX_MESSAGE = "No emails found. Mailtropy requires at least one email to generate analytics.";
const AUTH_FAILURE_MESSAGE = "Authentication failed. Please reconnect Gmail.";

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

function getAuthToken(interactive) {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        resolve(null);
        return;
      }
      resolve(token);
    });
  });
}

async function getAuthTokenWithFallback() {
  const silentToken = await getAuthToken(false);
  if (silentToken) {
    return silentToken;
  }
  return getAuthToken(true);
}

function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    if (!token || typeof token !== "string") {
      resolve();
      return;
    }
    chrome.identity.removeCachedAuthToken({ token }, () => {
      resolve();
    });
  });
}

async function forceInteractiveReauth() {
  try {
    const cachedToken = await getAuthToken(false);
    await removeCachedAuthToken(cachedToken);
  } catch (_error) {
    // No cached token is fine; proceed to interactive auth.
  }
  return getAuthToken(true);
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

function setStorageValues(items) {
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

function isScanning() {
  return currentState === STATE_ANALYZING;
}

function setAppState(nextState) {
  if (currentState === nextState) {
    return;
  }

  currentState = nextState;

  if (currentState === STATE_IDLE) {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze Mail Box";
    setStatusMessage("");
    updateLoadingState();
    updateScanUI();
    return;
  }

  if (currentState === STATE_AUTHENTICATING) {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "Analyze Mail Box";
    hideResultSections();
    setStatusMessage("Connecting to Gmail...");
    updateLoadingState();
    updateScanUI();
    return;
  }

  if (currentState === STATE_ANALYZING) {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Stop Scan";
    hideResultSections();
    setStatusMessage("");
    updateLoadingState();
    updateScanUI();
    return;
  }

  if (currentState === STATE_ERROR) {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze Mail Box";
    updateLoadingState();
    updateScanUI();
  }
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

function setStatusMessage(message, { isError = false, isEmpty = false } = {}) {
  const hasMessage = typeof message === "string" && message.trim().length > 0;
  if (hasMessage && !statusEl.isConnected && analysisViewEl) {
    if (analyticsContainerEl && analyticsContainerEl.parentNode === analysisViewEl) {
      analysisViewEl.insertBefore(statusEl, analyticsContainerEl);
    } else if (viewActionsBtn && viewActionsBtn.parentNode === analysisViewEl) {
      analysisViewEl.insertBefore(statusEl, viewActionsBtn);
    } else {
      analysisViewEl.appendChild(statusEl);
    }
  }

  if (!hasMessage) {
    statusEl.classList.remove("error", "empty");
    statusEl.textContent = "";
    if (statusEl.isConnected) {
      statusEl.remove();
    }
    return;
  }

  statusEl.classList.toggle("error", Boolean(isError));
  statusEl.classList.toggle("empty", Boolean(isEmpty));
  statusEl.textContent = message;
}

function hideResultSections() {
  if (analyticsContainerEl) {
    analyticsContainerEl.hidden = true;
    analyticsContainerEl.innerHTML = "";
  }
  if (viewActionsBtn) {
    viewActionsBtn.hidden = true;
    viewActionsBtn.disabled = true;
  }
  hideDataScopeBanner();
}

function isMeaningfulAnalyticsResult(analyticsResult) {
  if (!analyticsResult || typeof analyticsResult !== "object") {
    return false;
  }

  const normalized = normalizeForDashboard(analyticsResult);
  return (
    normalized.totalEmails > 0 ||
    normalized.uniqueSenders > 0 ||
    normalized.uniqueDomains > 0 ||
    normalized.totalSubscriptionEmails > 0 ||
    normalized.totalSubscriptionSenders > 0 ||
    normalized.topSenders.length > 0 ||
    normalized.topDomains.length > 0 ||
    normalized.topSubscriptionSenders.length > 0
  );
}

function isEmptyAnalysisState({ analyticsResult, normalizedEmails, processedCount }) {
  const safeProcessedCount = Number(processedCount);
  const hasZeroProcessed = Number.isFinite(safeProcessedCount) && safeProcessedCount === 0;
  const hasNoNormalizedEmails = Array.isArray(normalizedEmails) && normalizedEmails.length === 0;
  const hasNoMeaningfulAnalytics = !isMeaningfulAnalyticsResult(analyticsResult);

  return hasZeroProcessed || hasNoNormalizedEmails || hasNoMeaningfulAnalytics;
}

function showEmptyState() {
  stopJobStatePolling();
  setAppState(STATE_IDLE);
  latestAnalyticsResult = null;
  hideResultSections();
  setStatusMessage(EMPTY_INBOX_MESSAGE, { isEmpty: true });
}

function normalizeFailureMessage(rawMessage) {
  const message = String(rawMessage || "").toLowerCase();
  const isLikelyNetworkFailure =
    message.includes("network") ||
    message.includes("failed to fetch") ||
    message.includes("timeout") ||
    message.includes("request timeout") ||
    message.includes("gmail api error");
  const isLikelyAuthFailure =
    message.includes("auth") ||
    message.includes("oauth") ||
    message.includes("token") ||
    message.includes("401") ||
    message.includes("invalid_grant") ||
    message.includes("reconnect gmail");

  if (isLikelyAuthFailure || isLikelyNetworkFailure) {
    return AUTH_FAILURE_MESSAGE;
  }

  return AUTH_FAILURE_MESSAGE;
}

async function clearStoredResults() {
  await setStorageValues({
    analyticsResult: null,
    normalizedEmails: [],
    [ANALYSIS_JOB_STATE_KEY]: {
      status: "idle",
      result: null,
      error: null,
      startedAt: null,
      finishedAt: null
    },
    [SCAN_PROGRESS_STATE_KEY]: {
      scanStatus: "idle",
      nextPageToken: null,
      processedCount: 0,
      scanStartTime: null
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function copyTextToClipboard(value) {
  const text = String(value || "");
  if (!text) {
    return false;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  return copied;
}

function setCopyFeedback(button, isSuccess) {
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const defaultAriaLabel = button.getAttribute("data-default-aria-label") || "Copy full sender address";

  if (copyFeedbackButton && copyFeedbackButton !== button) {
    copyFeedbackButton.classList.remove("copied", "copy-failed");
    copyFeedbackButton.textContent = "Copy";
    const previousDefaultAriaLabel =
      copyFeedbackButton.getAttribute("data-default-aria-label") || "Copy full sender address";
    copyFeedbackButton.setAttribute("aria-label", previousDefaultAriaLabel);
  }

  if (copyFeedbackTimerId) {
    clearTimeout(copyFeedbackTimerId);
    copyFeedbackTimerId = null;
  }
  copyFeedbackButton = button;

  if (isSuccess) {
    button.classList.add("copied");
    button.textContent = "Done";
    button.setAttribute("aria-label", "Copied");
  } else {
    button.classList.add("copy-failed");
    button.textContent = "Error";
    button.setAttribute("aria-label", "Copy failed");
  }

  copyFeedbackTimerId = window.setTimeout(() => {
    button.classList.remove("copied", "copy-failed");
    button.textContent = "Copy";
    button.setAttribute("aria-label", defaultAriaLabel);
    copyFeedbackTimerId = null;
    copyFeedbackButton = null;
  }, 1200);
}

async function handleCopyButtonClick(event) {
  const copyButton = event.target instanceof Element ? event.target.closest(".copy-value-btn") : null;
  if (!copyButton) {
    return;
  }

  event.preventDefault();
  const fullValue = copyButton.getAttribute("data-copy-value") || "";
  try {
    const copied = await copyTextToClipboard(fullValue);
    setCopyFeedback(copyButton, copied);
  } catch (error) {
    console.error("Copy failed:", error?.message || "Unknown error");
    setCopyFeedback(copyButton, false);
  }
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
  const buildCopyableSearchBox = (value, ariaLabel) => {
    const safeValue = escapeHtml(value);
    const safeAriaLabel = escapeHtml(ariaLabel);
    return `
      <div class="search-box-row">
        <div class="search-box">${safeValue}</div>
        <button
          type="button"
          class="bar-copy-btn copy-value-btn"
          data-copy-value="${safeValue}"
          title="Copy full value"
          aria-label="${safeAriaLabel}"
          data-default-aria-label="${safeAriaLabel}"
        >Copy</button>
      </div>
    `;
  };

  const senderQueryBox = senderQuery
    ? `<p class="query-label">For Sender</p>${buildCopyableSearchBox(senderQuery, "Copy sender query")}`
    : "";
  const domainQueryBox = domainQuery
    ? `<p class="query-label">For Domain</p>${buildCopyableSearchBox(domainQuery, "Copy domain query")}`
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
            <div class="bar-label-wrap">
              <span class="bar-label" data-full-label="${safeLabel}" title="${safeLabel}" tabindex="0">${safeLabel}</span>
              <button
                type="button"
                class="bar-copy-btn copy-value-btn"
                data-copy-value="${safeLabel}"
                title="Copy full value"
                aria-label="Copy full sender address"
                data-default-aria-label="Copy full sender address"
              >Copy</button>
            </div>
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

function showResultsState(analyticsResult, lastScanTimestamp) {
  latestAnalyticsResult = analyticsResult;
  setAppState(STATE_IDLE);
  setStatusMessage("");
  renderDataScopeBanner(analyticsResult, lastScanTimestamp);
  renderDashboard(analyticsResult, lastScanTimestamp);
  if (viewActionsBtn) {
    viewActionsBtn.hidden = false;
    viewActionsBtn.disabled = false;
  }
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
  const stored = await getStorageValues([
    ANALYSIS_JOB_STATE_KEY,
    SCAN_PROGRESS_STATE_KEY,
    "lastScanTimestamp",
    "normalizedEmails"
  ]);
  const jobState = stored?.[ANALYSIS_JOB_STATE_KEY] || {};
  const scanProgress = stored?.[SCAN_PROGRESS_STATE_KEY] || {};
  const status = typeof jobState?.status === "string" ? jobState.status : "idle";
  const scanStatus = typeof scanProgress?.scanStatus === "string" ? scanProgress.scanStatus : "idle";
  const normalizedEmails = Array.isArray(stored?.normalizedEmails) ? stored.normalizedEmails : [];
  const processedCount = Number(scanProgress?.processedCount);

  if (status === "error") {
    stopJobStatePolling();
    const message = typeof jobState?.error === "string" ? jobState.error : "Analysis failed.";
    setErrorState(message);
    return;
  }

  if (status === "timeout" || scanStatus === "timeout") {
    setErrorState("Scan exceeded time limit.");
    return;
  }

  if (scanStatus === "running" || status === "running") {
    if (currentState !== STATE_ANALYZING) {
      setLoadingState();
    }
    analyzeBtn.textContent = "Stop Scan";
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

    if (isEmptyAnalysisState({ analyticsResult, normalizedEmails, processedCount })) {
      showEmptyState();
      return;
    }

    showResultsState(analyticsResult, lastScanTimestamp);
    return;
  }

  if (status === "stopped" || scanStatus === "stopped") {
    stopJobStatePolling();
    setAppState(STATE_IDLE);
    setStatusMessage("Scan stopped.");
    return;
  }

  setAppState(STATE_IDLE);
  stopJobStatePolling();
}

function updateScanUI() {
  if (!viewActionsBtn || !analyticsContainerEl) {
    return;
  }

  const shouldShow = currentState !== STATE_ANALYZING && currentState !== STATE_AUTHENTICATING && latestAnalyticsResult != null;

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

  if (currentState === STATE_ANALYZING) {
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
  const nextState = value === true ? STATE_ANALYZING : STATE_IDLE;
  if (currentState === nextState) {
    return;
  }
  setAppState(nextState);
}

export function setLoadingState() {
  latestAnalyticsResult = null;
  setAppState(STATE_ANALYZING);
}

function setErrorState(message) {
  stopJobStatePolling();
  latestAnalyticsResult = null;
  hideResultSections();
  setAppState(STATE_ERROR);
  setStatusMessage(normalizeFailureMessage(message || "Analysis failed."), { isError: true });
}

export async function loadExistingData() {
  const stored = await getStorageValues([
    "analyticsResult",
    "normalizedEmails",
    "lastScanTimestamp",
    ANALYSIS_JOB_STATE_KEY,
    SCAN_PROGRESS_STATE_KEY
  ]);
  const analyticsResult = stored?.analyticsResult ?? null;
  const normalizedEmails = Array.isArray(stored?.normalizedEmails) ? stored.normalizedEmails : [];
  const lastScanTimestamp = stored?.lastScanTimestamp ?? null;
  const jobState = stored?.[ANALYSIS_JOB_STATE_KEY] || {};
  const scanProgress = stored?.[SCAN_PROGRESS_STATE_KEY] || {};
  const jobStatus = typeof jobState?.status === "string" ? jobState.status : "idle";
  const scanStatus = typeof scanProgress?.scanStatus === "string" ? scanProgress.scanStatus : "idle";
  const processedCount = Number(scanProgress?.processedCount);

  if (jobStatus === "error") {
    setErrorState(typeof jobState?.error === "string" ? jobState.error : "Analysis failed.");
    return;
  }

  if (jobStatus === "timeout" || scanStatus === "timeout") {
    setErrorState("Scan exceeded time limit.");
    return;
  }

  if (jobStatus === "complete" && isEmptyAnalysisState({ analyticsResult, normalizedEmails, processedCount })) {
    showEmptyState();
    return;
  }

  if (scanStatus === "running" || jobStatus === "running") {
    latestAnalyticsResult = null;
    setLoadingState();
    startJobStatePolling();
    return;
  }

  setAppState(STATE_IDLE);

  if (!analyticsResult && jobStatus !== "complete") {
    latestAnalyticsResult = null;
    hideResultSections();
    setStatusMessage("No scan yet");
    return;
  }

  if (isEmptyAnalysisState({ analyticsResult, normalizedEmails, processedCount })) {
    showEmptyState();
    return;
  }

  showResultsState(analyticsResult, lastScanTimestamp);
}

export async function runAnalysis() {
  if (currentState === STATE_ANALYZING) {
    try {
      await sendRuntimeMessage({ type: CANCEL_ANALYSIS_MESSAGE });
    } catch (error) {
      console.error("Failed to stop scan:", error?.message || "Unknown error");
    } finally {
      stopJobStatePolling();
      setAppState(STATE_IDLE);
      setStatusMessage("Scan stopped.");
    }
    return;
  }

  stopJobStatePolling();
  pendingScan = true;

  try {
    let token = await getAuthToken(false);
    if (!token) {
      setAppState(STATE_AUTHENTICATING);
      token = await getAuthToken(true);
    }

    if (!token) {
      pendingScan = false;
      setAppState(STATE_IDLE);
      return;
    }

    if (!pendingScan) {
      setAppState(STATE_IDLE);
      return;
    }

    await clearStoredResults();
    setLoadingState();
    const response = await sendRuntimeMessage({ type: START_ANALYSIS_MESSAGE });
    if (!response?.started) {
      throw new Error(response?.error || "Failed to start analysis job.");
    }
    startJobStatePolling();
  } catch (error) {
    stopJobStatePolling();
    setErrorState(error?.message || "Analysis failed.");
    console.error("Failed to start analysis:", error?.message || "Unknown error");
  } finally {
    pendingScan = false;
  }
}

export async function init() {
  analyzeBtn.addEventListener("click", runAnalysis);
  if (analyticsContainerEl) {
    analyticsContainerEl.addEventListener("click", handleCopyButtonClick);
  }
  if (actionsOutputEl) {
    actionsOutputEl.addEventListener("click", handleCopyButtonClick);
  }
  if (reconnectBtn) {
    reconnectBtn.addEventListener("click", async () => {
      setView("analysis");
      window.scrollTo(0, 0);
      stopJobStatePolling();
      setAppState(STATE_IDLE);
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = "Analyze Mail Box";
      hideResultSections();
      setStatusMessage("Reconnecting Gmail...");
      reconnectBtn.disabled = true;

      let reconnectMessageError = null;
      try {
        await sendRuntimeMessage({ type: "RECONNECT_GMAIL" });
      } catch (error) {
        reconnectMessageError = error;
      }

      try {
        await forceInteractiveReauth();
        setStatusMessage("Gmail reconnected. You can start a new scan.");
      } catch (error) {
        setErrorState(error?.message || "Reconnect failed. Please try again.");
        if (reconnectMessageError) {
          console.error("Reconnect reset failed:", reconnectMessageError?.message || "Unknown error");
        }
        console.error("Reconnect Gmail failed:", error?.message || "Unknown error");
      } finally {
        reconnectBtn.disabled = false;
      }
    });
  }
  if (privacyBtn) {
    privacyBtn.addEventListener("click", () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL("privacy.html")
      });
    });
  }
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
