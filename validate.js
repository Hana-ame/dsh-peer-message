/**
 * Shared validation and sanitization helpers for dsh-peer-message.
 *
 * Both the agent tool (`tool.js`) and the browser panel (`client.js`) enforce
 * the same peer-ID format and text limits. This module is imported by the
 * Node side (`tool.js`) and the tests; the browser `client.js` keeps an inline
 * copy so its lazy factory stays a single self-contained module.
 */

/** Legal peer ID prefix. */
export const PEER_ID_PREFIX = 'dsh-pm-';

/** Legal peer ID body charset: lowercase base36 plus the dash separator. */
const PEER_ID_BODY_RE = /^[a-z0-9-]+$/;

/**
 * Legal peer ID length bounds. Real IDs look like `dsh-pm-<8rand>-<6ts>`
 * (~24 chars), so the lower bound of 16 rejects a bare 7-char prefix.
 */
export const PEER_ID_MIN_LEN = 16;
export const PEER_ID_MAX_LEN = 64;

/** Maximum single-message text length (truncated before send/render). */
export const MAX_TEXT_LEN = 4096;

/**
 * Whether a string is a well-formed peer ID (correct prefix, in length bounds).
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidPeerId(id) {
  if (!id || typeof id !== 'string') return false;
  if (!id.startsWith(PEER_ID_PREFIX)) return false;
  const len = id.length;
  if (len < PEER_ID_MIN_LEN || len > PEER_ID_MAX_LEN) return false;
  // Reject any character outside the legal lowercase-base36/dash body: this
  // blocks HTML/JS injection payloads, path traversal, spaces, and other
  // unexpected bytes that a well-formed PeerJS ID never contains.
  if (!PEER_ID_BODY_RE.test(id.slice(PEER_ID_PREFIX.length))) return false;
  return true;
}

/**
 * Strip control characters and truncate to the message limit.
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return clean.slice(0, MAX_TEXT_LEN);
}
