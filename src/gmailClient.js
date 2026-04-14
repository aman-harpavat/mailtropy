const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const LIST_PAGE_SIZE = 500;
const MAX_MESSAGES = 20000;
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 400;
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

function getHeaders(rawMessage) {
  const headers = rawMessage?.payload?.headers;
  return Array.isArray(headers) ? headers : [];
}

function getHeaderValue(headers, headerName) {
  const lowerName = String(headerName || "").toLowerCase();
  const header = headers.find(
    (item) => typeof item?.name === "string" && item.name.toLowerCase() === lowerName
  );
  return typeof header?.value === "string" ? header.value : "";
}

function hasHeader(headers, headerName) {
  const lowerName = String(headerName || "").toLowerCase();
  return headers.some((item) => typeof item?.name === "string" && item.name.toLowerCase() === lowerName);
}

function extractEmailAddress(fromHeader) {
  if (typeof fromHeader !== "string") {
    return "";
  }

  const input = fromHeader.trim().toLowerCase();
  if (!input) {
    return "";
  }

  const angleMatch = input.match(/<\s*([^<>]+)\s*>/);
  const candidate = angleMatch?.[1] || input;
  const emailMatch = candidate.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i);
  const email = emailMatch ? emailMatch[0].toLowerCase() : "";

  if (!email) {
    return "";
  }

  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].includes("/")) {
    return "";
  }

  return email;
}

function toTimestamp(internalDate) {
  const value = Number(internalDate);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function toYearMonth(timestamp) {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * @typedef {Object} NormalizedEmail
 * @property {string} messageId
 * @property {string} threadId
 * @property {string} fromEmail
 * @property {string} fromDomain
 * @property {number} timestamp
 * @property {string} yearMonth
 * @property {string[]} labelIds
 * @property {boolean} hasUnsubscribeHeader
 */

/**
 * @param {object} rawMessage
 * @returns {NormalizedEmail}
 */
export function normalizeMessage(rawMessage) {
  const headers = getHeaders(rawMessage);
  const fromEmail = extractEmailAddress(getHeaderValue(headers, "From"));
  const fromDomain = fromEmail.includes("@") ? fromEmail.split("@")[1] : "";
  const timestamp = toTimestamp(rawMessage?.internalDate);

  return {
    messageId: typeof rawMessage?.id === "string" ? rawMessage.id : "",
    threadId: typeof rawMessage?.threadId === "string" ? rawMessage.threadId : "",
    fromEmail,
    fromDomain,
    timestamp,
    yearMonth: toYearMonth(timestamp),
    labelIds: Array.isArray(rawMessage?.labelIds) ? [...rawMessage.labelIds] : [],
    hasUnsubscribeHeader: hasHeader(headers, "List-Unsubscribe")
  };
}

/**
 * @param {object[]} rawMessages
 * @returns {NormalizedEmail[]}
 */
export function normalizeBatch(rawMessages) {
  if (!Array.isArray(rawMessages)) {
    return [];
  }
  return rawMessages.map((rawMessage) => normalizeMessage(rawMessage));
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
