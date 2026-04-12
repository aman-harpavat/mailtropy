async function testGmailApi(token) {
  if (!token || typeof token !== "string") {
    throw new Error("Missing OAuth token.");
  }

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail API error ${response.status}: ${errorText || response.statusText}`);
  }

  const data = await response.json();
  console.log("[Mailtropy OAuth Test] Gmail API response:", data);
  return data;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "INBOXIQ_TEST_OAUTH") {
    testGmailApi(message.token)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Unknown error" }));
    return true;
  }
});
