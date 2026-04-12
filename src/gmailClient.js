const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const LIST_PAGE_SIZE = 500;
const MAX_MESSAGES = 20000;
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 150;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaRelated403(errorPayload) {
  const reasons = errorPayload?.error?.errors
    ?.map((item) => item?.reason)
    .filter((reason) => typeof reason === "string");

  if (!Array.isArray(reasons)) {
    return false;
  }

  return reasons.some((reason) =>
    ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"].includes(reason)
  );
}

async function gmailGet(url, accessToken, fetchImpl = fetch) {
  for (let retry = 0; ; retry += 1) {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }
    const retryable = response.status === 429 || (response.status === 403 && isQuotaRelated403(payload));

    if (response.ok) {
      return payload;
    }

    if (retryable && retry < MAX_RETRIES) {
      const delay = BACKOFF_BASE_MS * (2 ** retry);
      await sleep(delay);
      continue;
    }

    throw new Error(`Gmail API error (${response.status}): ${text || response.statusText}`);
  }
}

function buildListUrl(pageToken) {
  const url = new URL(GMAIL_MESSAGES_URL);
  url.searchParams.set("maxResults", String(LIST_PAGE_SIZE));
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  return url.toString();
}

function buildMetadataUrl(messageId) {
  const url = new URL(`${GMAIL_MESSAGES_URL}/${messageId}`);
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "From");
  url.searchParams.append("metadataHeaders", "List-Unsubscribe");
  url.searchParams.set("fields", "id,threadId,internalDate,labelIds,sizeEstimate,payload/headers");
  return url.toString();
}

function chunk(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/**
 * Fetches raw Gmail metadata responses for up to 20,000 unique messages.
 * @param {string} accessToken
 * @param {{ fetchImpl?: typeof fetch }} options
 * @returns {Promise<object[]>}
 */
export async function fetchGmailMetadata(accessToken, { fetchImpl = fetch } = {}) {
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("fetchGmailMetadata requires a valid accessToken string.");
  }

  const uniqueMessageIds = new Set();
  let nextPageToken;

  do {
    const page = await gmailGet(buildListUrl(nextPageToken), accessToken, fetchImpl);
    const messages = Array.isArray(page?.messages) ? page.messages : [];

    for (const message of messages) {
      if (typeof message?.id === "string") {
        uniqueMessageIds.add(message.id);
      }
      if (uniqueMessageIds.size >= MAX_MESSAGES) {
        break;
      }
    }

    nextPageToken = page?.nextPageToken;
  } while (nextPageToken && uniqueMessageIds.size < MAX_MESSAGES);

  const ids = Array.from(uniqueMessageIds);
  const batches = chunk(ids, BATCH_SIZE);
  const results = [];
  const processedIds = new Set();

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const batchResults = await Promise.all(
      batch.map(async (id) => {
        if (processedIds.has(id)) {
          return null;
        }
        const metadata = await gmailGet(buildMetadataUrl(id), accessToken, fetchImpl);
        processedIds.add(id);
        return metadata;
      })
    );

    results.push(...batchResults.filter(Boolean));

    if (batchIndex < batches.length - 1) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return results;
}
