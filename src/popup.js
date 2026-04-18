import { MESSAGE_TYPES } from "./constants.js";

const analyzeBtn = document.getElementById("analyzeBtn");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const analysisViewEl = document.getElementById("analysisView");
const actionsViewEl = document.getElementById("actionsView");
const viewActionsBtn = document.getElementById("viewActionsBtn");
const backToAnalysisBtn = document.getElementById("backToAnalysisBtn");
const actionsOutputEl = document.getElementById("actionsOutput");
const dataScopeBannerEl = document.getElementById("dataScopeBanner");
const dataScopeSummaryEl = document.getElementById("dataScopeSummary");
const dataScopeLastScanEl = document.getElementById("dataScopeLastScan");
let view = "analysis";
let latestAnalyticsResult = null;

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

  const senderQueryLine = senderQuery
    ? `<li>For deleting emails from a specific Sender - <code>${escapeHtml(senderQuery)}</code></li>`
    : "";
  const domainQueryLine = domainQuery
    ? `<li>For deleting emails from a specific Domain - <code>${escapeHtml(domainQuery)}</code></li>`
    : "";
  const queryListHtml =
    senderQueryLine || domainQueryLine ? `<ul class="action-list">${senderQueryLine}${domainQueryLine}</ul>` : "";
  const subscriptionQueryLine = subscriptionSearchQuery
    ? `<li>After unsubscribing, search for the sender and repeat bulk delete steps.</li>`
    : "";

  actionsOutputEl.innerHTML = `
    <div class="action-block">
      <p class="action-heading">Bulk Delete Emails from Top Sender or Domain</p>
      <p class="action-step">1. In Gmail search bar, type:</p>
      ${queryListHtml}
      <p class="action-step">2. Press Enter.</p>
      <p class="action-step">3. Switch sorting to "Most recent".</p>
      <p class="action-step">4. Click the top checkbox.</p>
      <p class="action-step">5. (To delete more than Gmail's default 50 visible emails at once) Click the link that says: "Select all conversations that match this search"</p>
      <p class="action-step">6. Click the Delete icon.</p>
      <p class="action-step">7. Confirm.</p>
    </div>
    <div class="action-block">
      <p class="action-heading">Unsubscribe from Subscription Senders</p>
      <p class="action-step">1. Open any recent email from the sender${subscriptionSender ? ` (<code>${escapeHtml(subscriptionSender)}</code>)` : ""}.</p>
      <p class="action-step">2. Look near the top of the email for: "Unsubscribe" OR "List-Unsubscribe" link.</p>
      <p class="action-step">3. Click unsubscribe and confirm.</p>
      ${subscriptionQueryLine ? `<ul class="action-list">${subscriptionQueryLine}</ul>` : ""}
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
  const domainConcentrationDisplay = normalized.domainConcentrationPercent.toFixed(1);
  const subscriptionPercentDisplay = normalized.subscriptionPercentOfInbox.toFixed(1);
  const senderLines =
    normalized.topSenders.length > 0
      ? normalized.topSenders.map((item) => {
          const sender = typeof item?.sender === "string" ? item.sender : "Unknown sender";
          const count = Number(item?.count) || 0;
          const percent = Number(item?.percent) || 0;
          return `- ${sender} — ${count} emails (${percent.toFixed(1)}%)`;
        })
      : ["- No sender data yet"];
  const domainLines =
    normalized.topDomains.length > 0
      ? normalized.topDomains.map((item) => {
          const domain = typeof item?.domain === "string" ? item.domain : "Unknown domain";
          const count = Number(item?.count) || 0;
          const percent = Number(item?.percent) || 0;
          return `- ${domain} — ${count} emails (${percent.toFixed(1)}%)`;
        })
      : ["- No domain data yet"];
  const subscriptionLines =
    normalized.topSubscriptionSenders.length > 0
      ? normalized.topSubscriptionSenders.map((item) => {
          const sender = typeof item?.sender === "string" ? item.sender : "Unknown sender";
          const count = Number(item?.count) || 0;
          const percentOfInbox = Number(item?.percentOfInbox) || 0;
          return `- ${sender} — ${count} emails (${percentOfInbox.toFixed(1)}% of inbox)`;
        })
      : ["- No subscription sender data yet"];

  outputEl.textContent = [
    "Sender Analysis",
    `- Unique Senders: ${normalized.uniqueSenders}`,
    `- Inbox Concentration: ${concentrationDisplay}% — ${normalized.concentrationLabel}`,
    `Top senders account for ${concentrationDisplay}% of your inbox.`,
    "",
    ...senderLines,
    "",
    "Domain Analysis",
    `- Unique Domains: ${normalized.uniqueDomains}`,
    `- Inbox Concentration: ${domainConcentrationDisplay}% — ${normalized.domainConcentrationLabel}`,
    `Top domains account for ${domainConcentrationDisplay}% of your inbox.`,
    "",
    ...domainLines,
    "",
    "Subscription Analysis",
    `- Subscription Emails: ${normalized.totalSubscriptionEmails}`,
    `- % of Inbox: ${subscriptionPercentDisplay}%`,
    `- Unique Subscription Senders: ${normalized.totalSubscriptionSenders}`,
    `Subscriptions account for ${subscriptionPercentDisplay}% of your inbox.`,
    "",
    ...subscriptionLines
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
    latestAnalyticsResult = null;
    statusEl.classList.remove("error");
    statusEl.textContent = "No scan yet";
    outputEl.textContent = "Run analysis to see insights";
    if (viewActionsBtn) {
      viewActionsBtn.disabled = true;
    }
    hideDataScopeBanner();
    return;
  }

  latestAnalyticsResult = analyticsResult;
  statusEl.classList.remove("error");
  statusEl.textContent = "Loaded latest analysis";
  renderDataScopeBanner(analyticsResult, lastScanTimestamp);
  renderDashboard(analyticsResult, lastScanTimestamp);
  if (viewActionsBtn) {
    viewActionsBtn.disabled = false;
  }
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

    latestAnalyticsResult = analyticsResult;
    analyzeBtn.disabled = false;
    statusEl.classList.remove("error");
    statusEl.textContent = "Analysis complete";
    renderDataScopeBanner(analyticsResult, lastScanTimestamp);
    renderDashboard(analyticsResult, lastScanTimestamp);
    if (viewActionsBtn) {
      viewActionsBtn.disabled = false;
    }
  } catch (error) {
    setErrorState(error?.message || "Analysis failed.");
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
    outputEl.textContent = "Run analysis to see insights";
    latestAnalyticsResult = null;
    if (viewActionsBtn) {
      viewActionsBtn.disabled = true;
    }
    hideDataScopeBanner();
  }

  renderView();
}

init();
