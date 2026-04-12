const analyzeBtn = document.getElementById("analyzeBtn");
const statusEl = document.getElementById("status");

function getAuthToken(interactive = true) {
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

function sendMessage(type, token) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, token }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

async function onAnalyzeClick() {
  analyzeBtn.disabled = true;
  setStatus("Requesting OAuth token...");

  try {
    const token = await getAuthToken(true);
    setStatus("Validating Gmail access...");

    const response = await sendMessage("INBOXIQ_TEST_OAUTH", token);
    if (!response?.ok) {
      throw new Error(response?.error || "OAuth test failed.");
    }
    setStatus("OAuth validation successful.");
  } catch (error) {
    setStatus(error.message || "OAuth test failed.", true);
  } finally {
    analyzeBtn.disabled = false;
  }
}

analyzeBtn.addEventListener("click", onAnalyzeClick);
setStatus("Ready");
