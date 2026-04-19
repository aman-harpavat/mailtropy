const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const LIST_PAGE_SIZE = 500;
const MAX_MESSAGES = 20000;
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 400;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const REQUEST_TIMEOUT_MS = 15000;
const GLOBAL_SCAN_TIMEOUT_MS = 30 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "SCAN_ABORTED";
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createError("Scan aborted", "SCAN_ABORTED");
  }
}

function fetchWithTimeout(url, options, timeout = REQUEST_TIMEOUT_MS, fetchImpl = fetch) {
  let timerId;

  return Promise.race([
    fetchImpl(url, options),
    new Promise((_, reject) => {
      timerId = setTimeout(() => {
        reject(createError("Request timeout", "REQUEST_TIMEOUT"));
      }, timeout);
    })
  ]).finally(() => {
    if (timerId) {
      clearTimeout(timerId);
    }
  });
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

async function gmailGet(url, accessToken, { fetchImpl = fetch, signal } = {}) {
  let timeoutRetryCount = 0;

  for (let retry = 0; ; retry += 1) {
    throwIfAborted(signal);

    let response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json"
          },
          signal
        },
        REQUEST_TIMEOUT_MS,
        fetchImpl
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw createError("Scan aborted", "SCAN_ABORTED");
      }
      if (error?.code === "REQUEST_TIMEOUT") {
        if (timeoutRetryCount < 1) {
          timeoutRetryCount += 1;
          continue;
        }
        throw createError("Request timeout", "REQUEST_TIMEOUT");
      }
      throw error;
    }

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }

    if (response.status === 401) {
      throw createError("Authentication expired. Please re-authenticate.", "TOKEN_EXPIRED");
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

function assertGlobalScanWindow(scanStartTime) {
  if (Date.now() - scanStartTime > GLOBAL_SCAN_TIMEOUT_MS) {
    throw createError("Scan exceeded time limit.", "SCAN_TIMEOUT");
  }
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
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   scanStartTime?: number | null,
 *   onProgress?: (progress: { nextPageToken: string | null, processedCount: number, scanStartTime: number }) => Promise<void> | void
 * }} options
 * @returns {Promise<{ rawMessages: object[], nextPageToken: string | null, processedCount: number }>}
 */
export async function fetchGmailMetadata(
  accessToken,
  {
    fetchImpl = fetch,
    signal,
    scanStartTime: initialScanStartTime = null,
    onProgress
  } = {}
) {
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("fetchGmailMetadata requires a valid accessToken string.");
  }

  const scanStartTime =
    Number.isFinite(Number(initialScanStartTime)) && Number(initialScanStartTime) > 0
      ? Number(initialScanStartTime)
      : Date.now();
  let nextPageToken = null;
  const processedIds = new Set();
  const results = [];
  let processedCount = 0;

  do {
    throwIfAborted(signal);
    assertGlobalScanWindow(scanStartTime);

    const page = await gmailGet(buildListUrl(nextPageToken), accessToken, { fetchImpl, signal });
    const messages = Array.isArray(page?.messages) ? page.messages : [];
    const ids = [];

    for (const message of messages) {
      if (processedCount >= MAX_MESSAGES) {
        break;
      }
      if (typeof message?.id === "string" && !processedIds.has(message.id)) {
        ids.push(message.id);
      }
    }

    const batches = chunk(ids, BATCH_SIZE);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      throwIfAborted(signal);
      assertGlobalScanWindow(scanStartTime);

      const batch = batches[batchIndex];
      const batchResults = await Promise.all(
        batch.map(async (id) => {
          throwIfAborted(signal);
          if (processedIds.has(id)) {
            return null;
          }
          const metadata = await gmailGet(buildMetadataUrl(id), accessToken, { fetchImpl, signal });
          processedIds.add(id);
          return metadata;
        })
      );

      results.push(...batchResults.filter(Boolean));
      processedCount = results.length;

      if (typeof onProgress === "function") {
        await onProgress({
          nextPageToken: typeof page?.nextPageToken === "string" ? page.nextPageToken : null,
          processedCount,
          scanStartTime
        });
      }

      if (batchIndex < batches.length - 1) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    nextPageToken = typeof page?.nextPageToken === "string" ? page.nextPageToken : null;
  } while (nextPageToken && processedCount < MAX_MESSAGES);

  return {
    rawMessages: results,
    nextPageToken: null,
    processedCount
  };
}
