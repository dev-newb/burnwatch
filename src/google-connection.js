'use strict';

// Authentication and Code Assist quota access are separate. Only pass these
// fixed status codes to the renderer, never a provider response or credential.
function googleQuotaIssue(response, hasLimits) {
  if (hasLimits) return null;
  const details = response?.error?.details;
  const reasons = Array.isArray(details) ? details.map(detail => detail?.reason) : [];
  if (reasons.includes('SUBSCRIPTION_REQUIRED')) return 'subscription-required';
  if (response?.httpStatus === 401 || response?.error?.status === 'UNAUTHENTICATED') return 'reauth-required';
  if (response?.httpStatus === 403) return 'access-denied';
  return 'quota-unavailable';
}

function googleConnectionStatus(tokens, quotaState) {
  const usageIssue = tokens && quotaState?.token === tokens.accessToken ? quotaState.issue : null;
  return { connected: !!tokens && usageIssue !== 'reauth-required', email: tokens?.email || null, usageIssue };
}

module.exports = { googleQuotaIssue, googleConnectionStatus };
