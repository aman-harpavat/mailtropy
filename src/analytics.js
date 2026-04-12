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
 * @typedef {Object} DomainStat
 * @property {string} domain
 * @property {number} count
 * @property {number} percentage
 */

/**
 * @typedef {Object} SenderStat
 * @property {string} email
 * @property {number} count
 */

/**
 * @typedef {Object} SubscriptionStat
 * @property {string} domain
 * @property {number} count
 * @property {number} lastSeenTimestamp
 * @property {"active" | "dormant"} status
 */

/**
 * @typedef {Object} MonthlyVolume
 * @property {string} yearMonth
 * @property {number} count
 */

/**
 * @typedef {Object} AnalyticsOutput
 * @property {number} totalEmails
 * @property {SenderStat[]} senderStats
 * @property {DomainStat[]} domainStats
 * @property {number} top5ConcentrationPercentage
 * @property {number} top10ConcentrationPercentage
 * @property {"Low" | "Moderate" | "High"} concentrationLevel
 * @property {SubscriptionStat[]} subscriptions
 * @property {MonthlyVolume[]} monthlyVolume
 * @property {DomainStat[]} dormantHighVolumeDomains
 */

/**
 * Pure analytics function: accepts NormalizedEmail[] and returns AnalyticsOutput.
 * @param {NormalizedEmail[]} emails
 * @returns {AnalyticsOutput}
 */
export function analyzeEmails(emails) {
  const safeEmails = Array.isArray(emails) ? emails : [];
  const totalEmails = safeEmails.length;
  const senderCounts = new Map();
  const domainCounts = new Map();
  const subscriptionByDomain = new Map();
  const monthlyCounts = new Map();
  const domainLastSeen = new Map();
  let maxTimestamp = 0;

  for (const email of safeEmails) {
    const fromEmail = typeof email?.fromEmail === "string" ? email.fromEmail : "";
    const fromDomain = typeof email?.fromDomain === "string" ? email.fromDomain : "";
    const yearMonth = typeof email?.yearMonth === "string" ? email.yearMonth : "";
    const timestamp = Number.isFinite(email?.timestamp) ? Number(email.timestamp) : 0;

    if (timestamp > maxTimestamp) {
      maxTimestamp = timestamp;
    }

    senderCounts.set(fromEmail, (senderCounts.get(fromEmail) || 0) + 1);
    domainCounts.set(fromDomain, (domainCounts.get(fromDomain) || 0) + 1);
    monthlyCounts.set(yearMonth, (monthlyCounts.get(yearMonth) || 0) + 1);
    const previousLastSeen = domainLastSeen.get(fromDomain) || 0;
    if (timestamp > previousLastSeen) {
      domainLastSeen.set(fromDomain, timestamp);
    }

    if (email?.hasUnsubscribeHeader === true) {
      const current = subscriptionByDomain.get(fromDomain) || { count: 0, lastSeenTimestamp: 0 };
      current.count += 1;
      if (timestamp > current.lastSeenTimestamp) {
        current.lastSeenTimestamp = timestamp;
      }
      subscriptionByDomain.set(fromDomain, current);
    }
  }

  const senderStats = Array.from(senderCounts.entries())
    .map(([email, count]) => ({ email, count }))
    .sort((a, b) => b.count - a.count || a.email.localeCompare(b.email));

  const domainStats = Array.from(domainCounts.entries())
    .map(([domain, count]) => ({
      domain,
      count,
      percentage: totalEmails > 0 ? (count / totalEmails) * 100 : 0
    }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  const top5ConcentrationPercentage = domainStats
    .slice(0, 5)
    .reduce((sum, stat) => sum + stat.percentage, 0);
  const top10ConcentrationPercentage = domainStats
    .slice(0, 10)
    .reduce((sum, stat) => sum + stat.percentage, 0);

  let concentrationLevel = "High";
  if (top10ConcentrationPercentage <= 30) {
    concentrationLevel = "Low";
  } else if (top10ConcentrationPercentage <= 60) {
    concentrationLevel = "Moderate";
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const dormantThresholdMs = 180 * dayMs;

  const subscriptions = Array.from(subscriptionByDomain.entries())
    .map(([domain, value]) => {
      const ageMs = maxTimestamp - value.lastSeenTimestamp;
      const status = ageMs > dormantThresholdMs ? "dormant" : "active";
      return {
        domain,
        count: value.count,
        lastSeenTimestamp: value.lastSeenTimestamp,
        status
      };
    })
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  const monthlyVolume = Array.from(monthlyCounts.entries())
    .map(([yearMonth, count]) => ({ yearMonth, count }))
    .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));

  const dormantHighVolumeDomains = domainStats
    .filter((stat) => {
      if (stat.count <= 50) {
        return false;
      }
      const lastSeen = domainLastSeen.get(stat.domain) || 0;
      const ageMs = maxTimestamp - lastSeen;
      return ageMs > dormantThresholdMs;
    })
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  return {
    totalEmails,
    senderStats,
    domainStats,
    top5ConcentrationPercentage,
    top10ConcentrationPercentage,
    concentrationLevel,
    subscriptions,
    monthlyVolume,
    dormantHighVolumeDomains
  };
}
