'use strict';

const SESSION_KEY = 'opencode.sessionId';
const SESSION_DIR_KEY = 'opencode.sessionDir';

function normalizeDir(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Thin wrapper around the opencode v2 session endpoints.
 */
class Chat {
  /**
   * @param {import('./server').OpenCodeServer} server
   * @param {import('vscode').Memento} memento
   * @param {(msg:string)=>void} log
   */
  constructor(server, memento, log) {
    this.server = server;
    this.memento = memento;
    this.log = log;
    this.sessionId = memento.get(SESSION_KEY, null);
    /** @type {{id:string, providerID:string, variant?:string}|null} */
    this.defaultModelRef = null;
    /** Primary agent chosen in the composer, kept for the next new session. */
    this.defaultAgent = null;
  }

  async ensureSession() {
    const dir = normalizeDir(this.server.dir);
    const storedDir = this.memento.get(SESSION_DIR_KEY, null);
    if (this.sessionId && storedDir !== dir) {
      // A session created under a different directory string can be stuck in a
      // permanent "instruction epoch missing" state; never reuse it.
      this.log('[chat] workspace directory changed; starting a fresh session');
      this.sessionId = null;
    }
    if (this.sessionId) {
      try {
        const r = await this.server.request('GET', `/api/session/${this.sessionId}`);
        const stored = (r && r.data) || r;
        if (stored && (stored.id || stored.data)) {
          this.adoptSessionDirectory(stored);
          await this.pinModel(this.sessionId, stored);
          return this.sessionId;
        }
      } catch (err) {
        this.log(`[chat] stored session unusable: ${err.message}`);
        this.sessionId = null;
      }
    }
    return this.newSession();
  }

  /**
   * A session can exist with no model of its own — made by another client, or
   * left over from before one was chosen — and the server then answers its
   * prompts with *its* default, which can be a free model that was never
   * selected. Such a session silently ignores the composer's model, so pin ours
   * to it before a prompt goes out.
   *
   * Posts directly rather than going through setModel(): that calls
   * ensureSession(), which calls back in here.
   * @param {string} id session to pin
   * @param {any} session its current state, to skip work when it has a model
   * @returns {Promise<boolean>} true when a model was applied
   */
  async pinModel(id, session) {
    if (session && session.model && session.model.id) return false;
    if (!this.defaultModelRef) return false;
    try {
      await this.server.request('POST', `/api/session/${id}/model`, {
        body: { model: this.defaultModelRef }
      });
      const ref = this.defaultModelRef;
      this.log(`[chat] session had no model; applied ${ref.providerID}/${ref.id}`);
      return true;
    } catch (err) {
      this.log(`[chat] could not apply the model: ${err.message}`);
      return false;
    }
  }

  async newSession() {
    // Deliberately no title: the server's title agent then names the session
    // from the first prompt. Passing one suppresses that.
    // The location is explicit because an adopted server (the desktop app's)
    // otherwise places the session in its own cwd, not our workspace.
    const r = await this.server.request('POST', '/api/session', {
      body: { location: { directory: this.server.dir } }
    });
    const session = r && r.data ? r.data : r;
    if (!session || !session.id) throw new Error('session create returned no id');
    this.adoptSessionDirectory(session);
    this.sessionId = session.id;
    await this.memento.update(SESSION_KEY, this.sessionId);
    await this.memento.update(SESSION_DIR_KEY, normalizeDir(this.server.dir));
    this.log(`[chat] session ${this.sessionId}`);
    // A fresh session has no model, and the server would answer it with its own
    // default — which may be an unauthenticated or free provider.
    await this.pinModel(this.sessionId, session);
    // Carry the composer's agent choice over; the server would otherwise reset
    // every new session to its own default ("build").
    if (this.defaultAgent) {
      try {
        await this.server.request('POST', `/api/session/${this.sessionId}/agent`, {
          body: { agent: this.defaultAgent }
        });
        this.log(`[chat] agent ${this.defaultAgent}`);
      } catch (err) {
        this.log(`[chat] setAgent failed: ${err.message}`);
      }
    }
    return this.sessionId;
  }

  /**
   * @param {string} text
   * @param {{uri:string,name?:string}[]} [files]
   */
  async send(text, files) {
    const id = await this.ensureSession();
    const body = { text: text || '', delivery: 'queue' };
    if (files && files.length) body.files = files;
    await this.server.request('POST', `/api/session/${id}/prompt`, { body });
    return id;
  }

  async setModel(ref) {
    const id = await this.ensureSession();
    await this.server.request('POST', `/api/session/${id}/model`, { body: { model: ref } });
  }

  async setAgent(agent) {
    const id = await this.ensureSession();
    await this.server.request('POST', `/api/session/${id}/agent`, { body: { agent } });
  }

  async listModels() {
    let models = await this.readModels();
    if (!models.length) {
      // The provider registry can still be warming up right after start.
      await new Promise((r) => setTimeout(r, 700));
      models = await this.readModels();
    }
    return models;
  }

  async readModels() {
    try {
      const r = await this.server.request('GET', '/api/model');
      return (r && r.data) || [];
    } catch (err) {
      this.log(`[chat] listModels failed: ${err.message}`);
      return [];
    }
  }

  async defaultModel() {
    try {
      const r = await this.server.request('GET', '/api/model/default');
      return (r && r.data) || null;
    } catch {
      return null;
    }
  }

  async listAgents() {
    try {
      const r = await this.server.request('GET', '/api/agent');
      return (r && r.data) || [];
    } catch {
      return [];
    }
  }

  async messages() {
    const id = await this.ensureSession();
    return this.rawMessages(id);
  }

  async rawMessages(id) {
    const r = await this.server.request('GET', `/api/session/${id}/message`);
    return (r && r.data) || [];
  }

  /**
   * Transcript and agent map for the stored session, or null when there is
   * nothing usable to restore (for example it was deleted elsewhere).
   */
  async restore() {
    if (!this.sessionId) return null;
    let session;
    try {
      session = await this.getSession(this.sessionId);
    } catch {
      return null;
    }
    const raw = await this.rawMessages(this.sessionId);
    return {
      transcript: toTranscript(raw),
      agents: agentsFromMessages(raw),
      selection: selectionFrom(session, raw)
    };
  }

  /** Delete a session; clears the current id when that session was the one. */
  async deleteSession(id) {
    await this.server.request('DELETE', `/api/session/${id}`);
    if (id === this.sessionId) {
      this.sessionId = null;
      await this.memento.update(SESSION_KEY, null);
    }
  }

  /**
   * The server decides where a session lives (its own cwd unless we asked for a
   * location). If it differs from what we are sending, follow it — otherwise
   * directory-scoped lookups like messages and title would 404.
   */
  adoptSessionDirectory(session) {
    const dir = session && session.location && session.location.directory;
    if (dir && this.server.dir && dir !== this.server.dir) {
      this.log(`[chat] server placed the session in ${dir}; following it`);
      this.server.dir = dir;
    }
  }

  async getSession(id) {
    const r = await this.server.request('GET', `/api/session/${id || this.sessionId}`);
    const session = (r && r.data) || r || null;
    this.adoptSessionDirectory(session);
    return session;
  }

  /** Rename a session (PATCH accepts a title; verified against 2.0.22). */
  async setTitle(title) {
    const id = await this.ensureSession();
    await this.server.request('PATCH', `/api/session/${id}`, { body: { title } });
    return id;
  }

  async listSessions() {
    const r = await this.server.request('GET', '/api/session');
    return (r && r.data) || [];
  }

  /** Switch to an existing session and return its transcript and agent map. */
  async switchTo(id) {
    this.sessionId = id;
    await this.memento.update(SESSION_KEY, id);
    await this.memento.update(SESSION_DIR_KEY, normalizeDir(this.server.dir));
    const raw = await this.rawMessages(id);
    let session = null;
    try {
      session = await this.getSession(id);
      // So the composer's model is true of the session, not just of the panel.
      if (await this.pinModel(id, session)) session = await this.getSession(id);
    } catch (err) {
      this.log(`[chat] could not read the session's agent/model: ${err.message}`);
    }
    return {
      transcript: toTranscript(raw),
      agents: agentsFromMessages(raw),
      selection: selectionFrom(session, raw)
    };
  }

  /** Transcript of the current session, newest last. */
  async history() {
    if (!this.sessionId) return [];
    try {
      return toTranscript(await this.rawMessages(this.sessionId));
    } catch (err) {
      this.log(`[chat] history failed: ${err.message}`);
      return [];
    }
  }

  /** Answer a structured question the agent asked (Form.Reply = { answer }). */
  async replyForm(formId, answer) {
    const id = await this.ensureSession();
    await this.server.request('POST', `/api/session/${id}/form/${formId}/reply`, { body: { answer } });
  }

  /** Decline to answer a form, optionally saying why. */
  async cancelForm(formId, message) {
    const id = await this.ensureSession();
    await this.server.request('POST', `/api/session/${id}/form/${formId}/cancel`, {
      body: message ? { message } : {}
    });
  }

  async replyPermission(requestId, decision, message) {
    const id = await this.ensureSession();
    const body = { decision };
    if (message) body.message = message;
    await this.server.request('POST', `/api/session/${id}/permission/${requestId}/reply`, { body });
  }

  async interrupt() {
    if (!this.sessionId) return;
    await this.server.request('POST', `/api/session/${this.sessionId}/interrupt`, { body: {} });
  }
}

/**
 * Reduce raw v2 messages to renderable turns. Shape (verified on 2.0.22):
 *   { id, type: "user"|"assistant"|"idle", content: [{ type: "text"|"reasoning", text }] }
 * "idle" entries are markers with no content; reasoning is not shown.
 */
function toTranscript(rows) {
  const out = [];
  for (const m of rows || []) {
    if (!m || m.type === 'idle') continue;
    // Assistant messages carry a content[] array of parts; user messages put
    // their text at the top level instead, so both shapes must be read.
    const parts = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : [];
    let text = parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (!text && typeof m.text === 'string') text = m.text;
    if (!text.trim()) continue;
    out.push({
      id: m.id,
      role: m.type === 'user' ? 'user' : 'assistant',
      text,
      files: Array.isArray(m.files)
        ? m.files.map((f) => ({ name: (f && (f.name || f.filename)) || '' })).filter((f) => f.name)
        : [],
      at: (m.time && m.time.created) || 0
    });
  }
  // The API returns messages newest-first; render them chronologically so the
  // conversation reads in order and the latest turn ends up at the bottom.
  if (out.length > 1 && out[0].at > out[out.length - 1].at) out.reverse();
  return out;
}

/**
 * What the composer's agent/model/variant pickers should show for a session.
 *
 * `session.model` is what the session will use for its next turn, so it wins.
 * A session can lack one — made by another client, or before anything was
 * chosen — and the picker would otherwise fall back to the configured model
 * rather than the one the session actually ran on. A session set without a
 * variant reports the literal "default".
 *
 * @param {any} session the session record
 * @param {any[]} [rows] its messages, newest or oldest first
 * @returns {{agent:string|null, model:{id:string,providerID:string,variant:string|null}|null}}
 */
function selectionFrom(session, rows) {
  const s = session || {};
  const m = s.model;
  return {
    agent: s.agent || null,
    model:
      m && m.id
        ? { id: m.id, providerID: m.providerID, variant: variantOf(m) }
        : lastUsedModel(rows)
  };
}

/**
 * The variant a model reference was set with. The server writes the literal
 * "default" when there is none, and omits the field entirely on a fresh
 * session; both mean "Default" in the picker.
 * @returns {string|null}
 */
function variantOf(model) {
  const v = model && model.variant;
  return v && v !== 'default' ? v : null;
}

/**
 * The model, and variant, that answered a session's most recent turn —
 * assistant messages record both. Compared by timestamp rather than position:
 * the message list's ordering is not guaranteed.
 * @returns {{id:string,providerID:string,variant:string|null}|null}
 */
function lastUsedModel(rows) {
  let best = null;
  for (const m of rows || []) {
    if (!m || m.type !== 'assistant' || !m.model || !m.model.id) continue;
    const at = (m.time && m.time.created) || 0;
    if (!best || at >= best.at) best = { at, model: m.model };
  }
  if (!best) return null;
  return { id: best.model.id, providerID: best.model.providerID, variant: variantOf(best.model) };
}

/**
 * Rebuild the agent map from a stored session, so restoring a session shows the
 * subagents that ran in it. Tool parts look like:
 *   { type:"tool", id, name:"subagent",
 *     state:{ status, input:{agent, description, prompt},
 *             content:[{type:"text", text:'<subagent sessionID="…" state="…">…'}] } }
 * @returns {{main: string|null, items: Array}}
 */
function agentsFromMessages(rows) {
  const items = [];
  let main = null;
  for (const m of rows || []) {
    if (!m) continue;
    if (m.agent) main = m.agent;
    const parts = Array.isArray(m.content) ? m.content : [];
    for (const p of parts) {
      if (!p || p.type !== 'tool' || p.name !== 'subagent') continue;
      const state = p.state || {};
      const input = state.input || {};
      if (!input.agent) continue;
      const text = Array.isArray(state.content)
        ? state.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('')
        : '';
      const child = text.match(/<subagent[^>]*\bsessionID="([^"]+)"/i);
      const blockState = text.match(/<subagent[^>]*\bstate="([a-z]+)"/i);
      items.push({
        id: p.id || `subagent-${items.length}`,
        agent: String(input.agent),
        description: String(input.description || ''),
        childSessionId: child ? child[1] : null,
        status: state.status || (blockState ? blockState[1] : 'completed')
      });
    }
  }
  return { main, items };
}

module.exports = { Chat, toTranscript, agentsFromMessages, selectionFrom };
