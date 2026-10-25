'use strict';

/**
 * What the panel does with server events it did not cause.
 *
 * A turn can be run by any client: this panel, the desktop app, a second window,
 * or a prompt sent from Telegram. The server reports all of them on the same event
 * stream, so the panel follows the stream instead of assuming it started every
 * turn — otherwise a session created elsewhere appears only after the list is
 * reopened, and its prompt and answer never show up in the transcript.
 */

/** Folder comparison the rest of the extension also uses. */
function normalizeDirectory(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether an event makes the session list in the panel stale. Sessions are created
 * and named by whichever client runs the turn.
 *
 * @param {string} type
 * @returns {boolean}
 */
function changesSessionList(type) {
  return type === 'session.created' || type === 'session.renamed';
}

/**
 * Whether the panel should follow a session another client created.
 *
 * Only with nothing open: the panel must not jump away from a conversation the
 * user is reading. A subagent's own session is skipped, and so is one placed
 * outside this workspace — an adopted server can put a session in its own cwd.
 *
 * @param {any} data the event payload
 * @param {{ sessionId?: string|null, directory?: string }} [context]
 * @returns {boolean}
 */
function shouldFollowSession(data, context = {}) {
  if (!data || data.parentID) return false;
  if (context.sessionId) return false;
  const id = String(data.sessionID || data.sessionId || '');
  if (!id) return false;
  const created = data.location && data.location.directory;
  if (created && normalizeDirectory(created) !== normalizeDirectory(context.directory)) return false;
  return true;
}

/**
 * Whether a queued item is a system reminder. The model's next message answers it,
 * so it is not a prompt the user typed.
 *
 * @param {any} data the `session.inbox.enqueued` payload
 * @returns {boolean}
 */
function isSystemQueuedItem(data) {
  const item = data && data.item;
  return !!item && (item.type === 'synthetic' || item.type === 'system');
}

/**
 * The prompt text a `session.inbox.enqueued` event carries, when it is a user
 * prompt that belongs in the transcript.
 *
 * @param {any} data the event payload
 * @returns {string|null}
 */
function queuedPrompt(data) {
  if (!data || isSystemQueuedItem(data)) return null;
  const text = data.item && data.item.payload && data.item.payload.text;
  return typeof text === 'string' && text.trim() ? text : null;
}

/**
 * Prompts this panel sent, kept so the server's echo of them does not draw a
 * second bubble. The bubble is on screen before the server reports the prompt, so
 * the match is by text within a short window; each remembered prompt is consumed
 * once, which keeps two identical prompts to two bubbles.
 *
 * @param {{ windowMs?: number }} [options]
 */
function createLocalPrompts({ windowMs = 15000 } = {}) {
  let entries = [];
  const prune = (now) => {
    entries = entries.filter((entry) => now - entry.at < windowMs);
  };
  return {
    /** @param {string} text @param {number} [at] */
    remember(text, at = Date.now()) {
      const value = String(text || '').trim();
      if (!value) return;
      prune(at);
      entries.push({ text: value, at });
    },
    /** @param {string} text @param {number} [at] @returns {boolean} whether it was ours */
    take(text, at = Date.now()) {
      const value = String(text || '').trim();
      if (!value) return false;
      prune(at);
      const found = entries.findIndex((entry) => entry.text === value);
      if (found < 0) return false;
      entries.splice(found, 1);
      return true;
    },
    get pending() {
      return entries.length;
    }
  };
}

module.exports = {
  changesSessionList,
  createLocalPrompts,
  isSystemQueuedItem,
  queuedPrompt,
  shouldFollowSession
};
