/**
 * @typedef {Object} NormalizedEmail
 * @property {string} id
 * @property {string} from
 * @property {string|null} listUnsubscribe
 */

/**
 * @typedef {Object} AnalyticsOutput
 * @property {number} totalMessages
 * @property {number} unsubscribeEligibleMessages
 * @property {Array<{ sender: string, count: number }>} topSenders
 */

/**
 * Pure analytics function: accepts NormalizedEmail[] and returns AnalyticsOutput.
 * @param {NormalizedEmail[]} emails
 * @returns {AnalyticsOutput}
 */
export function analyzeEmails(emails) {
  const safeEmails = Array.isArray(emails) ? emails : [];

  const senderCounts = safeEmails.reduce((acc, email) => {
    const sender = (email?.from || "unknown").trim() || "unknown";
    acc[sender] = (acc[sender] || 0) + 1;
    return acc;
  }, {});

  const topSenders = Object.entries(senderCounts)
    .map(([sender, count]) => ({ sender, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const unsubscribeEligibleMessages = safeEmails.filter(
    (email) => typeof email?.listUnsubscribe === "string" && email.listUnsubscribe.trim().length > 0
  ).length;

  return {
    totalMessages: safeEmails.length,
    unsubscribeEligibleMessages,
    topSenders
  };
}
