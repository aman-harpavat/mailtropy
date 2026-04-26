const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const LIST_PAGE_SIZE = 500;
const MAX_MESSAGES = 50000;
const CONCURRENT_REQUESTS = 50;
const INITIAL_CONCURRENCY = 30;
const MIN_CONCURRENCY = 10;
const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 300;
const REQUEST_TIMEOUT_MS = 10000;
const GLOBAL_SCAN_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BACKOFF_MS = 30000;
const MAX_RETRY_AFTER_MS = 120000;

let quotaBackoffUntil = 0;

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

function getRetryAfterMs(headers) {
  const value = headers?.get?.("retry-after");
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(0, asDate - Date.now()), MAX_RETRY_AFTER_MS);
  }

  return null;
}

async function sleepWithSignal(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timerId = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timerId);
      reject(createError("Scan aborted", "SCAN_ABORTED"));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function setQuotaBackoff(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }
  quotaBackoffUntil = Math.max(quotaBackoffUntil, Date.now() + delayMs);
}

async function waitForQuotaCooldown(signal, scanStartTime) {
  for (;;) {
    throwIfAborted(signal);
    if (Number.isFinite(scanStartTime)) {
      assertGlobalScanWindow(scanStartTime);
    }

    const remaining = quotaBackoffUntil - Date.now();
    if (remaining <= 0) {
      return;
    }

    await sleepWithSignal(Math.min(remaining, 1000), signal);
  }
}

async function fetchWithTimeout(url, options, timeout = REQUEST_TIMEOUT_MS, fetchImpl = fetch) {
  const timeoutController = new AbortController();
  const upstreamSignal = options?.signal;
  let timerId = null;
  let timeoutTriggered = false;
  let removeAbortListener = null;

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      timeoutController.abort();
    } else {
      const onAbort = () => timeoutController.abort();
      upstreamSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => upstreamSignal.removeEventListener("abort", onAbort);
    }
  }

  timerId = setTimeout(() => {
    timeoutTriggered = true;
    timeoutController.abort();
  }, timeout);

  try {
    return await fetchImpl(url, {
      ...options,
      signal: timeoutController.signal
    });
  } catch (error) {
    if (timeoutTriggered) {
      throw createError("Request timeout", "REQUEST_TIMEOUT");
    }
    throw error;
  } finally {
    if (timerId) {
      clearTimeout(timerId);
    }
    if (typeof removeAbortListener === "function") {
      removeAbortListener();
    }
  }
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

async function gmailGet(
  url,
  accessToken,
  { fetchImpl = fetch, signal, scanStartTime, onQuotaRetry } = {}
) {
  for (let retry = 0; ; retry += 1) {
    throwIfAborted(signal);
    if (Number.isFinite(scanStartTime)) {
      assertGlobalScanWindow(scanStartTime);
    }
    await waitForQuotaCooldown(signal, scanStartTime);

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
      const isTimeout = error?.code === "REQUEST_TIMEOUT";
      const isNetworkError =
        error?.name === "TypeError" ||
        String(error?.message || "").toLowerCase().includes("network");
      const isRetryableFailure = isTimeout || isNetworkError;
      const canRetryFailure = isRetryableFailure && retry < MAX_RETRIES;

      if (canRetryFailure) {
        const jitter = Math.floor(Math.random() * 201);
        const delay = Math.min(BACKOFF_BASE_MS * (2 ** retry), MAX_BACKOFF_MS) + jitter;
        await sleepWithSignal(delay, signal);
        continue;
      }
      if (isTimeout) {
        throw createError("Request timeout", "REQUEST_TIMEOUT");
      }
      throw new Error(error?.message || "Network error while calling Gmail API");
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

    const isQuotaRetry = response.status === 429 || (response.status === 403 && isQuotaRelated403(payload));
    const retryable =
      isQuotaRetry ||
      response.status >= 500 ||
      response.status === 408;

    if (response.ok) {
      return payload;
    }

    const canRetry = retryable && (isQuotaRetry || retry < MAX_RETRIES);

    if (canRetry) {
      const retryAfterMs = getRetryAfterMs(response.headers);
      const jitter = Math.floor(Math.random() * 201);
      const exponentialBackoffMs = Math.min(BACKOFF_BASE_MS * (2 ** retry), MAX_BACKOFF_MS);
      const delay = Math.max(retryAfterMs || 0, exponentialBackoffMs) + jitter;

      if (isQuotaRetry) {
        if (typeof onQuotaRetry === "function") {
          onQuotaRetry();
        }
        setQuotaBackoff(delay);
      }

      await sleepWithSignal(delay, signal);
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
  url.searchParams.set("fields", "id,threadId,internalDate,labelIds,payload/headers");
  return url.toString();
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
 * Fetches and normalizes Gmail metadata responses for up to MAX_MESSAGES unique messages.
 * @param {string} accessToken
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   scanStartTime?: number | null,
 *   onProgress?: (progress: { nextPageToken: string | null, processedCount: number, scanStartTime: number }) => Promise<void> | void
 * }} options
 * @returns {Promise<{ normalizedEmails: NormalizedEmail[], nextPageToken: string | null, processedCount: number }>}
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
  const normalizedEmails = [];
  let processedCount = 0;
  let dynamicConcurrency = Math.min(CONCURRENT_REQUESTS, Math.max(MIN_CONCURRENCY, INITIAL_CONCURRENCY));

  do {
    throwIfAborted(signal);
    assertGlobalScanWindow(scanStartTime);

    let pageQuotaRetryCount = 0;
    const trackQuotaRetry = () => {
      pageQuotaRetryCount += 1;
    };

    const page = await gmailGet(buildListUrl(nextPageToken), accessToken, {
      fetchImpl,
      signal,
      scanStartTime,
      onQuotaRetry: trackQuotaRetry
    });
    const messages = Array.isArray(page?.messages) ? page.messages : [];
    const queue = [];
    const remainingSlots = Math.max(0, MAX_MESSAGES - processedCount);

    for (const message of messages) {
      if (queue.length >= remainingSlots) {
        break;
      }
      if (typeof message?.id === "string" && !processedIds.has(message.id)) {
        queue.push(message.id);
      }
    }

    const workerCount = Math.min(dynamicConcurrency, queue.length);

    async function worker() {
      while (queue.length > 0) {
        throwIfAborted(signal);
        assertGlobalScanWindow(scanStartTime);

        if (processedCount >= MAX_MESSAGES) {
          return;
        }

        const id = queue.pop();
        if (!id || processedIds.has(id)) {
          continue;
        }

        const metadata = await gmailGet(buildMetadataUrl(id), accessToken, {
          fetchImpl,
          signal,
          scanStartTime,
          onQuotaRetry: trackQuotaRetry
        });
        processedIds.add(id);
        normalizedEmails.push(normalizeMessage(metadata));
        processedCount += 1;
      }
    }

    if (workerCount > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    if (typeof onProgress === "function") {
      await onProgress({
        nextPageToken: typeof page?.nextPageToken === "string" ? page.nextPageToken : null,
        processedCount,
        scanStartTime
      });
    }

    if (pageQuotaRetryCount > 0) {
      dynamicConcurrency = Math.max(MIN_CONCURRENCY, Math.floor(dynamicConcurrency * 0.75));
    } else {
      dynamicConcurrency = Math.min(CONCURRENT_REQUESTS, dynamicConcurrency + 1);
    }

    nextPageToken = typeof page?.nextPageToken === "string" ? page.nextPageToken : null;
  } while (nextPageToken && processedCount < MAX_MESSAGES);

  return {
    normalizedEmails,
    nextPageToken: null,
    processedCount
  };
}
