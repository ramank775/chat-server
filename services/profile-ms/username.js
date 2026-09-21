/**
 * Username rules, AUTH_CONTRACT 2.4 / 4.5.
 */

const USERNAME_REGEX = /^[a-z][a-z0-9._]{2,29}$/;

const RESERVED = new Set([
  'admin',
  'administrator',
  'root',
  'support',
  'help',
  'vartalap',
  'system',
  'null',
  'undefined',
  'me',
  'security',
  'abuse',
  'moderator',
  'postmaster'
  // ponytail: no profanity blocklist yet. Drop a curated word list in here
  // (one require of a json file) when the operator has one.
]);

// The operator's TLD blocklist: a username ending in one of these reads as a domain.
const DOMAIN_SUFFIXES = ['.com', '.net', '.org', '.io', '.in', '.app', '.dev', '.co', '.me'];

/**
 * Validate a candidate username.
 * @param {string} username the lower cased wire value
 * @returns {'INVALID_USERNAME'|'USERNAME_RESERVED'|null} null when acceptable
 */
function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_REGEX.test(username)) return 'INVALID_USERNAME';
  if (username.includes('..') || username.includes('__')) return 'INVALID_USERNAME';
  if (username.startsWith('www.')) return 'INVALID_USERNAME';
  if (DOMAIN_SUFFIXES.some((suffix) => username.endsWith(suffix))) return 'INVALID_USERNAME';
  if (RESERVED.has(username)) return 'USERNAME_RESERVED';
  return null;
}

module.exports = {
  USERNAME_REGEX,
  RESERVED,
  validateUsername
};
