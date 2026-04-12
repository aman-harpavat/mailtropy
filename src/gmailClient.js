const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

function buildUrl(path, params = {}) {
  const url = new URL(path, GMAIL_BASE_URL + "/");
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

async function gmailFetch(url, token, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Gmail API error (${response.status})`);
  }

  return response.json();
}

function readHeader(headers, headerName) {
  const match = (headers || []).find(
    (h) => typeof h?.name === "string" && h.name.toLowerCase() === headerName.toLowerCase()
  );
  return match?.value ?? null;
}

/**
 * Gmail API wrapper. Only reads metadata headers needed by product constraints.
 * @param {{ getToken: () => Promise<string>, fetchImpl?: typeof fetch }} deps
 */
export function createGmailClient({ getToken, fetchImpl = fetch }) {
  if (typeof getToken !== "function") {
    throw new Error("createGmailClient requires getToken()");
  }

  async function listMessageIds(maxResults = 50) {
    const token = await getToken();
    const url = buildUrl("", {
      maxResults,
      fields: "messages/id"
    });

    const data = await gmailFetch(url, token, fetchImpl);
    return Array.isArray(data.messages) ? data.messages.map((m) => m.id).filter(Boolean) : [];
  }

  async function getMessageMetadata(messageId) {
    const token = await getToken();
    const url = buildUrl(messageId, {
      format: "metadata",
      metadataHeaders: "From",
      fields: "id,payload/headers"
    });

    // Add second header key explicitly to ensure only required metadata is fetched.
    const urlObj = new URL(url);
    urlObj.searchParams.append("metadataHeaders", "List-Unsubscribe");

    const data = await gmailFetch(urlObj.toString(), token, fetchImpl);
    const headers = data?.payload?.headers || [];

    return {
      id: data?.id || messageId,
      from: readHeader(headers, "From") || "unknown",
      listUnsubscribe: readHeader(headers, "List-Unsubscribe")
    };
  }

  async function fetchNormalizedEmails(maxResults = 50) {
    const ids = await listMessageIds(maxResults);
    const emails = await Promise.all(ids.map((id) => getMessageMetadata(id)));
    return emails;
  }

  return {
    fetchNormalizedEmails
  };
}
