const analyzeBtn = document.getElementById("analyzeBtn");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");

function sendMessage(type) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function renderAnalytics(analytics) {
  if (!analytics) {
    outputEl.textContent = "No analysis yet.";
    return;
  }
  outputEl.textContent = JSON.stringify(analytics, null, 2);
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

async function loadLastAnalytics() {
  try {
    const response = await sendMessage("INBOXIQ_GET_LAST_ANALYTICS");
    if (response?.ok) {
      renderAnalytics(response.analytics);
      setStatus("Ready");
      return;
    }
    setStatus(response?.error || "Failed to load previous analytics.", true);
  } catch (error) {
    setStatus(error.message || "Failed to load previous analytics.", true);
  }
}

async function onAnalyzeClick() {
  analyzeBtn.disabled = true;
  setStatus("Analyzing...");

  try {
    const response = await sendMessage("INBOXIQ_RUN_ANALYTICS");
    if (!response?.ok) {
      throw new Error(response?.error || "Analysis failed.");
    }
    renderAnalytics(response.analytics);
    setStatus("Analysis complete");
  } catch (error) {
    setStatus(error.message || "Analysis failed.", true);
  } finally {
    analyzeBtn.disabled = false;
  }
}

analyzeBtn.addEventListener("click", onAnalyzeClick);
loadLastAnalytics();
