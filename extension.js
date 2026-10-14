'use strict';

const vscode = require('vscode');
const crypto = require('crypto');

const { OpenCodeServer } = require('./src/server');
const { Chat, textOfContent, summarizeTool } = require('./src/session');
const { runEvents } = require('./src/events');
const { ActiveFileTracker, describeEditor, toAttachment, openReference } = require('./src/context');

const VIEW_TYPE = 'opencode.chat';
const CONTAINER_ID = 'opencode-sidebar';

let output;
let server;
let chat;
let tracker;
let provider;
/** Pinned models are a user preference, not a per-workspace one. */
let globalState;
let aborted = false;
let started = false;
/** Last prompt sent, so an instruction-initialization failure can be retried. */
let lastSend = null;
let retryArmed = false;

function log(msg) {
  if (output) output.appendLine(msg);
}

function autoAttachEnabled() {
  return vscode.workspace.getConfiguration('opencode').get('autoAttach.enabled') !== false;
}

/**
 * Model applied to new sessions, from the `opencode.model` setting
 * ("providerID/modelID"). A freshly spawned server otherwise defaults to an
 * unauthenticated provider, which fails with provider.auth.
 */
function configuredModelRef() {
  const raw = vscode.workspace.getConfiguration('opencode').get('model');
  if (!raw || typeof raw !== 'string') return null;
  const idx = raw.indexOf('/');
  if (idx <= 0) return null;
  return { providerID: raw.slice(0, idx), id: raw.slice(idx + 1) };
}

/**
 * The model the composer should be showing: whatever the current session uses,
 * or the configured one before anything has been chosen. Re-posting the
 * configured model would drag the picker off a session that differs from it.
 */
function currentModelRef() {
  return chat.defaultModelRef || configuredModelRef();
}

/**
 * The models the webview can choose from, pinned ones first. Variants travel
 * with them: the composer's reasoning-effort picker is built from the selected
 * model's own list, which differs per model ("low/high/max" here,
 * "none/low/…/max" there).
 */
function modelOptions(list) {
  const pinned = pinnedModelIds();
  // The server reports models the user disabled in its config as enabled:false;
  // offering them would let the composer pick something that cannot run.
  const usable = (list || []).filter((m) => m && m.enabled !== false);
  const options = usable.map((m) => ({
    id: m.id,
    providerID: m.providerID,
    name: m.name || m.id,
    variants: (m.variants || []).map((v) => (typeof v === 'string' ? v : v && v.id)).filter(Boolean),
    pinned: pinned.includes(modelKey(m.providerID, m.id)),
    // USD per million tokens. Later entries are the higher-context tiers, each
    // tagged with the context size it kicks in above.
    cost: Array.isArray(m.cost)
      ? m.cost.map((t) => ({
          input: t.input,
          output: t.output,
          cacheRead: t.cache && t.cache.read,
          cacheWrite: t.cache && t.cache.write,
          tier: (t.tier && t.tier.size) || null
        }))
      : [],
    limit: m.limit ? { context: m.limit.context, output: m.limit.output } : null
  }));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  // Pinned first, then alphabetical within each group.
  return options.filter((m) => m.pinned).sort(byName).concat(options.filter((m) => !m.pinned).sort(byName));
}

/** Same "providerID/modelID" form as the `opencode.model` setting. */
function modelKey(providerID, id) {
  return `${providerID}/${id}`;
}

const PINNED_MODELS_KEY = 'opencode.pinnedModels';

function pinnedModelIds() {
  return (globalState && globalState.get(PINNED_MODELS_KEY, [])) || [];
}

async function togglePinModel(providerID, id) {
  const key = modelKey(providerID, id);
  const current = pinnedModelIds();
  const next = current.includes(key) ? current.filter((x) => x !== key) : current.concat([key]);
  await globalState.update(PINNED_MODELS_KEY, next);
  await postModels();
}

/** The model list, with the composer's current pick. */
async function postModels() {
  const list = await chat.listModels();
  const selected = currentModelRef();
  // Only ask the server for its own default when there is nothing better to
  // show, rather than on every menu open.
  const def = selected ? null : await chat.defaultModel();
  provider.post({
    type: 'models',
    models: modelOptions(list),
    default: def ? { id: def.id, providerID: def.providerID } : null,
    selected
  });
}

/**
 * Agents the composer may offer. The server reports seven, but only the
 * non-hidden `primary` ones can front a session — the rest are subagents
 * (explore, general) or internal (title, summary, compaction).
 *
 * The description is passed through whole: the menu gives it a full-width line
 * of its own and wraps it, so there is nothing to truncate here.
 */
async function postAgentOptions() {
  const list = await chat.listAgents();
  provider.post({
    type: 'agent-options',
    agents: list
      .filter((a) => a && a.mode === 'primary' && !a.hidden)
      .map((a) => ({ id: a.id, name: a.name || a.id, description: a.description || '' }))
  });
}

function normalizeDir(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function activate(context) {
  output = vscode.window.createOutputChannel('OpenCode');
  context.subscriptions.push(output);

  globalState = context.globalState;

  server = new OpenCodeServer(output, context.secrets);
  chat = new Chat(server, context.workspaceState, log);
  chat.defaultModelRef = configuredModelRef();
  // Advertise the configured endpoint for other opencode clients, in the file
  // the desktop app also keeps (~/.config/opencode/service.json).
  server.publishConfiguredService();
  provider = new ChatViewProvider(context.extensionUri);
  provider.onMessage = handleWebviewMessage;

  tracker = new ActiveFileTracker(() => sendContext());
  tracker.init();

  server.onExit = (code) => {
    started = false;
    provider.post({ type: 'status', status: 'error', detail: `opencode server exited (${code})` });
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('opencode.addToChat', addToChat),
    vscode.commands.registerCommand('opencode.newSession', newSession),
    vscode.commands.registerCommand('opencode.restartServer', restart),
    vscode.commands.registerCommand('opencode.showConnection', showConnection),
    vscode.commands.registerCommand('opencode.openWebUI', openWebUI),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('opencode.model')) chat.defaultModelRef = configuredModelRef();
      const endpointChanged =
        e.affectsConfiguration('opencode.server.hostname') ||
        e.affectsConfiguration('opencode.server.port') ||
        e.affectsConfiguration('opencode.server.password');
      if (!endpointChanged) return;
      // Keep the advertised endpoint in step with the settings, as at activation.
      // A port of 0 configures no address, so fall back to the running server's.
      if (!server.publishConfiguredService() && server.isRunning) server.publishLiveService();
      if (server.isRunning) {
        vscode.window
          .showInformationMessage('OpenCode: server settings changed — restart the server to apply.', 'Restart Server')
          .then((choice) => {
            if (choice === 'Restart Server') restart();
          });
      }
    }),
    {
      dispose() {
        aborted = true;
        stopTurnWatchdog();
        stopTitlePoll();
        tracker.dispose();
        server.stop();
      }
    }
  );
}

function deactivate() {
  aborted = true;
  stopTurnWatchdog();
  if (tracker) tracker.dispose();
  if (server) server.stop();
}

function sendContext() {
  const desc = tracker ? tracker.describe() : null;
  provider.post({
    type: 'context',
    context: desc ? toAttachment(desc) : null,
    auto: autoAttachEnabled()
  });
}

/** Finish the current turn in the UI and stop waiting for more events. */
function endTurn() {
  stopTurnWatchdog();
  provider.post({ type: 'turn-end' });
  scheduleTitleRefresh();
}

let lastSessionTitle = null;

/**
 * The server names a session from its first prompt (verified: creating a
 * session without a title yields e.g. "Making a Good Cup of Filter Coffee").
 * The title agent runs alongside the turn and can land slightly later, so
 * check a few times rather than once.
 */
let titlePoll = null;

function scheduleTitleRefresh() {
  // A session is named once, from its first prompt. Once it has a name, never
  // look again — later prompts must not rename it.
  if (lastSessionTitle) return;
  stopTitlePoll();
  const deadline = Date.now() + 30 * 1000;
  refreshTitle();
  titlePoll = setInterval(() => {
    if (Date.now() > deadline || lastSessionTitle) {
      stopTitlePoll();
      return;
    }
    refreshTitle();
  }, 1500);
}

function stopTitlePoll() {
  if (titlePoll) {
    clearInterval(titlePoll);
    titlePoll = null;
  }
}

/** Re-open the stored session's transcript after a window reload. */
async function restoreSession() {
  try {
    const restored = await chat.restore();
    if (!restored) return;
    postSelection(restored.selection);
    if (!restored.transcript.length) return;
    provider.post({ type: 'clear' });
    provider.post({ type: 'transcript', messages: restored.transcript });
    adoptAgents(restored.agents);
    log(`[ext] restored ${restored.transcript.length} turns from the stored session`);
  } catch (err) {
    log(`[ext] session restore failed: ${err.message}`);
  }
}

/**
 * Point the composer's pickers at what a session is actually using. The choice
 * also becomes the default for the sessions that follow it, matching the
 * composer's own behaviour when the user picks one by hand.
 */
function postSelection(selection) {
  if (!selection) return;
  // Remember the session's own choice for the sessions that follow it.
  if (selection.agent) chat.defaultAgent = selection.agent;
  if (selection.model) chat.defaultModelRef = selection.model;
  provider.post({
    type: 'selection',
    agent: selection.agent,
    // A session that has no model of its own inherits the configured one, which
    // is what its next prompt will use — better than leaving the previous
    // session's model on screen.
    model: selection.model || configuredModelRef()
  });
}

/** Delete a session, with a modal confirmation because it cannot be undone. */
async function deleteSession(id) {
  if (!id) return;
  const target = sessionsCache.find((s) => s.id === id);
  const label = (target && target.title) || 'this session';
  const choice = await vscode.window.showWarningMessage(
    `Delete "${label}"? This cannot be undone.`,
    { modal: true },
    'Delete'
  );
  if (choice !== 'Delete') return;

  const wasCurrent = id === chat.sessionId;
  let gone = false;
  try {
    await chat.deleteSession(id);
    gone = true;
    log(`[ext] deleted session ${id}`);
  } catch (err) {
    // A 404 means it is already absent — that is a successful delete from the
    // user's point of view. Treating it as an error left a stale row in the
    // list that could never be removed.
    gone = /-> 404\b|SessionNotFound/.test(err.message);
    log(`[ext] delete failed (${gone ? 'already gone' : 'error'}): ${err.message}`);
    if (!gone) {
      vscode.window.showErrorMessage(`OpenCode: could not delete the session — ${err.message}`);
    } else {
      // Hide it even if the list still reports it.
      deletedSessions.add(id);
    }
  }

  // Bookmarks pointing at the deleted session would never resolve again.
  if (gone) {
    const remaining = bookmarks().filter((b) => b.sessionId !== id);
    if (remaining.length !== bookmarks().length) {
      await chat.memento.update(BOOKMARK_KEY, remaining);
    }
  }

  if (wasCurrent && gone) {
    // Deliberately do NOT spawn a replacement session: an eager new session
    // shows up as a stray "(untitled)" entry. One is created lazily by
    // ensureSession() when the next prompt is actually sent.
    stopTitlePoll();
    provider.post({ type: 'clear' });
    resetAgents();
    lastSessionTitle = null;
    provider.post({ type: 'session-title', title: '' });
    sendContext();
  }
  await postSessions();
  await postBookmarks();
}

async function refreshTitle() {
  if (!chat.sessionId) return;
  try {
    const session = await chat.getSession(chat.sessionId);
    const title = (session && session.title) || '';
    if (title === lastSessionTitle) return;
    lastSessionTitle = title;
    provider.post({ type: 'session-title', title });
    if (title) await postSessions();
  } catch (err) {
    log(`[ext] title refresh failed: ${err.message}`);
  }
}

let turnWatchdog = null;
let lastEventAt = 0; // last server event, so the watchdog only fires on real silence

/**
 * Safety net for a lost terminal event. An SSE reconnect can drop the
 * session.execution.* event that ends a turn, which would otherwise leave the
 * UI stuck on "Stop" forever. The transcript always gains a
 * `{type:"idle", outcome:...}` marker when a turn completes, so poll for a
 * fresh one and then re-sync, which also recovers any text we missed.
 */
function startTurnWatchdog() {
  stopTurnWatchdog();
  const startedAt = Date.now();
  const deadline = startedAt + 10 * 60 * 1000;
  turnWatchdog = setInterval(async () => {
    if (Date.now() > deadline) {
      log('[ext] watchdog gave up on this turn');
      stopTurnWatchdog();
      return;
    }
    if (!chat.sessionId) return;
    // Only a genuinely silent turn counts as lost. A queued prompt produces its
    // own idle marker before the next execution starts, and firing in that gap
    // would rebuild the view mid-flight.
    if (Date.now() - lastEventAt < 8000) return;
    try {
      const rows = await chat.rawMessages(chat.sessionId);
      const finished = (rows || []).some((m) => m && m.type === 'idle' && m.time && m.time.created >= startedAt);
      if (!finished) return;
      log('[ext] turn finished without a terminal event; re-syncing transcript');
      stopTurnWatchdog();
      provider.post({ type: 'clear' });
      provider.post({ type: 'transcript', messages: await chat.history() });
      provider.post({ type: 'turn-end' });
    } catch (err) {
      log(`[ext] watchdog check failed: ${err.message}`);
    }
  }, 4000);
}

function stopTurnWatchdog() {
  if (turnWatchdog) {
    clearInterval(turnWatchdog);
    turnWatchdog = null;
  }
}

async function ensureStarted() {
  if (started) return;
  started = true;
  try {
    provider.post({ type: 'status', status: 'connecting', detail: 'starting opencode server' });
    await server.start(server.directory());
    aborted = false;
    runEvents(server.baseUrl + '/api/event', server.headers(), onEvent, () => aborted, log).catch((err) =>
      log(`[ext] event loop stopped: ${err.message}`)
    );
    await postModels();
    await postAgentOptions();
    await loadAgentDescriptions();
    postAgents();
    sendContext();
    provider.post({ type: 'status', status: 'ready' });
  } catch (err) {
    log(`[ext] start failed: ${err.message}`);
    provider.post({ type: 'status', status: 'error', detail: err.message });
    started = false;
  }
}

function onEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  const data = ev.data || {};

  // Note: events are NOT filtered by directory. A server can place a session
  // outside our workspace (the desktop app's server uses its own cwd), and
  // dropping those events left the panel silent with no response. The session
  // id check below is what actually isolates our conversation.
  lastEventAt = Date.now();

  const sessionId = data.sessionID || data.sessionId;
  const ours = !sessionId || !chat.sessionId || sessionId === chat.sessionId;
  // A child session announces itself with parentID = our session.
  const childOfOurs = !!data.parentID && data.parentID === chat.sessionId;

  if (!ours && !childOfOurs) {
    // Events from a subagent's own session must not be rendered into the main
    // transcript — only their lifecycle is used, for the agent map.
    if (sessionId && subagentBySession(sessionId)) {
      if (ev.type === 'session.execution.succeeded') setSubagentStatus(sessionId, 'completed');
      else if (ev.type === 'session.execution.failed') setSubagentStatus(sessionId, 'error');
      else if (ev.type === 'session.execution.interrupted') setSubagentStatus(sessionId, 'cancelled');
    }
    return;
  }

  // Event vocabulary of the opencode v2 server (verified against 2.0.22).
  switch (ev.type) {
    // The model's reasoning, streamed before the answer it produces. A message
    // can reason more than once, so blocks are keyed by ordinal as well.
    case 'session.reasoning.started': {
      const started = ev.created || Date.now();
      reasoningStarted.set(reasoningKey(data), started);
      provider.post({
        type: 'reasoning-start',
        hidden: isSystemReply(data),
        messageID: data.assistantMessageID || data.messageID || 'assistant',
        partID: reasoningPartId(data),
        at: started
      });
      break;
    }
    case 'session.reasoning.delta':
      provider.post({
        type: 'reasoning-delta',
        hidden: isSystemReply(data),
        messageID: data.assistantMessageID || data.messageID || 'assistant',
        partID: reasoningPartId(data),
        text: data.delta || ''
      });
      break;
    case 'session.reasoning.ended':
      provider.post({
        type: 'reasoning-end',
        hidden: isSystemReply(data),
        messageID: data.assistantMessageID || data.messageID || 'assistant',
        partID: reasoningPartId(data),
        text: data.text || '',
        ms: takeReasoningMs(data, ev)
      });
      break;
    case 'session.text.delta':
      provider.post({
        type: 'delta',
        hidden: isSystemReply(data),
        messageID: data.assistantMessageID || data.messageID || 'assistant',
        partID: String(data.ordinal === undefined ? 'text' : data.ordinal),
        text: data.delta || '',
        at: ev.created || 0
      });
      break;
    case 'session.text.ended':
      provider.post({
        type: 'part',
        hidden: isSystemReply(data),
        messageID: data.assistantMessageID || data.messageID || 'assistant',
        partID: String(data.ordinal === undefined ? 'text' : data.ordinal),
        text: data.text || ''
      });
      break;
    case 'session.execution.started':
      // A queued prompt starts its own execution, so this is what keeps the
      // busy state correct when several prompts are waiting.
      provider.post({ type: 'turn-start' });
      break;
    case 'session.execution.succeeded':
    case 'session.idle':
      // A reminder that was never answered must not keep the next real answer
      // hidden, so the pending flag dies with the turn.
      pendingSystemReply = false;
      systemReplies.clear();
      endTurn();
      break;
    case 'session.execution.failed':
      log(`[ext] execution failed: ${JSON.stringify(data.error || data).slice(0, 900)}`);
      if (!retryAfterInstructionBlock(data)) {
        provider.post({ type: 'error', message: extractError(data) });
      }
      endTurn();
      break;
    case 'session.execution.interrupted':
      // Stopping, or the server cancelling, ends the turn without an error.
      log('[ext] execution interrupted');
      endTurn();
      break;
    case 'session.step.failed':
      log(`[ext] step failed: ${JSON.stringify(data.error || data).slice(0, 900)}`);
      if (!retryAfterInstructionBlock(data)) {
        provider.post({ type: 'error', message: extractError(data) });
      }
      break;
    case 'session.step.started':
      if (data.agent && data.sessionID === chat.sessionId && mainAgent !== data.agent) {
        mainAgent = data.agent;
        postAgents();
      }
      // Anchor the response's start time to its bubble in the timeline.
      if (data.assistantMessageID) {
        provider.post({
          type: 'response-start',
          messageID: data.assistantMessageID,
          at: data.started || ev.created || Date.now()
        });
      }
      break;
    case 'session.created':
      noteChildSession(data);
      break;
    case 'session.inbox.enqueued':
      // A system reminder (the plan-mode preamble is one) is queued as a
      // `synthetic` item; the model's next message answers it, not the user.
      if (data.item && (data.item.type === 'synthetic' || data.item.type === 'system')) {
        pendingSystemReply = true;
      }
      break;
    case 'session.tool.input.started':
      // Remember call id -> tool name so a permission request can name its tool.
      if (data.id && data.name) toolNames.set(data.id, String(data.name));
      break;
    case 'session.tool.called': {
      if (data.id && data.name) toolNames.set(data.id, String(data.name));
      registerSubagent(data);
      // The tool's arguments are what make the row readable ("grep renderMarkdown").
      const tName = toolNames.get(toolId(data)) || toolName(data);
      provider.post({
        type: 'tool',
        state: 'running',
        id: toolId(data),
        name: tName,
        detail: summarizeTool(tName, data.input),
        // Behind the row: the labelled body, same fields the transcript carries.
        input: data.input && typeof data.input === 'object' ? data.input : null
      });
      break;
    }
    case 'session.tool.progress':
      updateSubagentProgress(data);
      break;
    case 'session.tool.success':
      finishSubagent(data, 'completed');
      provider.post({
        type: 'tool',
        state: 'ok',
        id: toolId(data),
        name: toolNames.get(toolId(data)) || toolName(data),
        result: textOfContent(data.content),
        exit: toolExit(data)
      });
      break;
    case 'session.tool.failed':
      finishSubagent(data, 'error');
      provider.post({
        type: 'tool',
        state: 'error',
        id: toolId(data),
        name: toolNames.get(toolId(data)) || toolName(data),
        error: extractError(data),
        result: textOfContent(data.content),
        exit: toolExit(data)
      });
      break;
    // The agent waiting on the user. Both of these block the turn until
    // answered, so they must always surface.
    case 'permission.asked':
      log(`[ext] permission asked: ${JSON.stringify(data).slice(0, 500)}`);
      // `source.id` is a tool CALL id; resolve it to the tool's name.
      provider.post({
        type: 'permission',
        requestId: data.id,
        action: data.action || 'Permission required',
        resources: Array.isArray(data.resources) ? data.resources : [],
        tool: (data.source && toolNames.get(data.source.id)) || '',
        save: Array.isArray(data.save) ? data.save : []
      });
      break;
    case 'permission.replied':
      provider.post({ type: 'permission-closed', requestId: data.requestID, reply: data.reply });
      break;
    case 'form.created':
      log(`[ext] form created: ${JSON.stringify(data.form || {}).slice(0, 700)}`);
      provider.post({ type: 'form', form: data.form || {} });
      break;
    case 'form.replied':
    case 'form.cancelled':
      provider.post({ type: 'form-closed', formId: data.id });
      break;
    default:
      if (typeof ev.type === 'string' && ev.type.indexOf('session.execution.') === 0) {
        // Any further execution outcome we do not know about is still terminal;
        // leaving the UI in the busy state forever is worse than ending early.
        log(`[ext] unhandled terminal execution event: ${ev.type}`);
        endTurn();
      }
      break;
  }
}

function extractError(data) {
  if (!data) return 'Unknown error';
  if (typeof data.message === 'string') return data.message;
  if (data.error && typeof data.error.message === 'string') return data.error.message;
  if (data.error && typeof data.error === 'string') return data.error;
  return JSON.stringify(data).slice(0, 300);
}

function toolId(data) {
  return data.toolCallID || data.toolCallId || data.callID || data.callId || data.id || '';
}

/**
 * Was this event part of the model's answer to a system reminder? The server
 * injects those as `synthetic` inbox items — the plan-mode preamble is one — and
 * the reply is not part of the conversation the user had. It is hidden rather
 * than ordered because it cannot be placed reliably: its message is created
 * before the user's first prompt but may finish streaming after it, so it lands
 * on whichever side of that prompt the timing happens to give.
 */
function isSystemReply(data) {
  const id = data.assistantMessageID || data.messageID;
  if (!id) return false;
  if (systemReplies.has(id)) return true;
  if (!pendingSystemReply) return false;
  // The first message to start after a system reminder is its reply.
  pendingSystemReply = false;
  systemReplies.add(id);
  log(`[ext] hiding the model's reply to a system reminder (${id})`);
  return true;
}

/** The exit code a tool reported, when it ran a process. */
function toolExit(data) {
  const meta = data && data.metadata;
  return meta && typeof meta.exit === 'number' ? meta.exit : null;
}

/** Reasoning blocks are keyed by ordinal — one message can reason more than once. */
function reasoningPartId(data) {
  return `r${data.ordinal === undefined ? 0 : data.ordinal}`;
}

function reasoningKey(data) {
  return `${data.assistantMessageID || data.messageID || 'assistant'}:${reasoningPartId(data)}`;
}

/**
 * How long the model reasoned, from the start and end event timestamps — the
 * server puts no duration on these events. A window reload mid-turn loses the
 * start, in which case the row shows plain "Thinking" rather than a wrong number.
 * @returns {number|null} milliseconds
 */
function takeReasoningMs(data, ev) {
  const key = reasoningKey(data);
  const started = reasoningStarted.get(key);
  reasoningStarted.delete(key);
  if (!started || !ev.created || ev.created < started) return null;
  return ev.created - started;
}

/**
 * A short human summary of what a tool call is doing, taken from its arguments.
 * Turns "grep  done" into "grep  renderMarkdown in media/…  done".
 */

function toolName(data) {
  const raw = data.tool || data.name || data.toolName || data.toolID;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return raw.name || raw.id || 'tool';
  return 'tool';
}

// ------------------------------------------------------------------ agent map

/**
 * Sub-agents surface three ways (verified against 2.0.22):
 *  - session.tool.called with input {agent, description} — the delegation itself
 *  - session.tool.progress with metadata {sessionID, status} — the child session
 *  - session.created with parentID = our session, title = the description
 * Completion comes back either as session.tool.success/failed or as a
 * `<subagent sessionID="..." state="completed">` block in the tool result.
 */
let sessionsCache = []; // last list sent to the webview (for the delete prompt)
// Sessions the server reported as already gone on delete. Hidden locally so a
// row that cannot be removed can never get stuck in the list.
const deletedSessions = new Set();

const subagents = new Map(); // tool call id -> {id, agent, description, childSessionId, status}
const toolNames = new Map(); // tool call id -> tool name (permission requests carry only the id)
/** Reasoning block ("messageID:ordinal") -> its start time, for "Thought for Ns". */
const reasoningStarted = new Map();
/** A system reminder is waiting for its reply — the next message is that reply. */
let pendingSystemReply = false;
/** Messages that answered a system reminder, which the panel does not show. */
const systemReplies = new Set();
let mainAgent = null;
let agentDescriptions = {};

function registerSubagent(data) {
  const input = data.input || {};
  if (!input.agent || !input.description) return;
  const id = toolId(data) || `subagent-${Date.now()}-${subagents.size}`;
  subagents.set(id, {
    id,
    agent: String(input.agent),
    description: String(input.description),
    childSessionId: null,
    status: 'running'
  });
  log(`[ext] subagent started: ${input.agent} — ${input.description}`);
  postAgents();
}

function updateSubagentProgress(data) {
  const row = subagents.get(toolId(data));
  if (!row || !data.metadata) return;
  let changed = false;
  if (data.metadata.sessionID && row.childSessionId !== data.metadata.sessionID) {
    row.childSessionId = data.metadata.sessionID;
    changed = true;
  }
  if (data.metadata.status && row.status !== data.metadata.status) {
    row.status = data.metadata.status;
    changed = true;
  }
  if (changed) postAgents();
}

function finishSubagent(data, fallback) {
  const row = subagents.get(toolId(data));
  if (!row) return;
  const text = Array.isArray(data.content)
    ? data.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('')
    : '';
  const m = text.match(/<subagent[^>]*\bstate="([a-z]+)"/i);
  row.status = m ? m[1] : fallback;
  log(`[ext] subagent ${row.agent} -> ${row.status}`);
  postAgents();
}

function subagentBySession(childSessionId) {
  for (const row of subagents.values()) {
    if (row.childSessionId === childSessionId) return row;
  }
  return null;
}

function setSubagentStatus(childSessionId, status) {
  const row = subagentBySession(childSessionId);
  if (!row || row.status === status) return;
  row.status = status;
  log(`[ext] subagent ${row.agent} -> ${status}`);
  postAgents();
}

function noteChildSession(data) {
  if (!data || !data.parentID || data.parentID !== chat.sessionId) return;
  for (const row of subagents.values()) {
    if (!row.childSessionId && row.description === data.title) {
      row.childSessionId = data.sessionID;
      postAgents();
      return;
    }
  }
}

function resetAgents() {
  subagents.clear();
  mainAgent = null;
  postAgents();
}

/** Replace the agent map with one reconstructed from a stored session. */
function adoptAgents(agents) {
  subagents.clear();
  mainAgent = (agents && agents.main) || null;
  for (const a of (agents && agents.items) || []) subagents.set(a.id, a);
  log(`[ext] restored ${subagents.size} subagent(s) from session history`);
  postAgents();
}

function postAgents() {
  const items = Array.from(subagents.values()).map((r) => ({
    id: r.id,
    agent: r.agent,
    description: r.description,
    status: r.status,
    childSessionId: r.childSessionId,
    agentDescription: agentDescriptions[r.agent] || ''
  }));
  provider.post({
    type: 'agents',
    main: { name: mainAgent || 'agent', description: agentDescriptions[mainAgent] || '' },
    items,
    running: items.some((i) => i.status === 'running')
  });
}

async function loadAgentDescriptions() {
  try {
    for (const a of await chat.listAgents()) {
      const key = a.id || a.name;
      if (key) agentDescriptions[key] = a.description || '';
    }
  } catch (err) {
    log(`[ext] agent descriptions unavailable: ${err.message}`);
  }
}

const BOOKMARK_KEY = 'opencode.bookmarks';

function bookmarks() {
  return chat.memento.get(BOOKMARK_KEY, []) || [];
}

async function toggleBookmark(payload) {
  const list = bookmarks();
  const exists = list.some((b) => b.messageId === payload.messageId);
  const next = exists
    ? list.filter((b) => b.messageId !== payload.messageId)
    : list.concat([
        {
          messageId: payload.messageId,
          sessionId: chat.sessionId,
          text: String(payload.text || '').slice(0, 20000),
          at: Date.now()
        }
      ]);
  await chat.memento.update(BOOKMARK_KEY, next);
  log(`[ext] bookmark ${exists ? 'removed' : 'added'}: ${payload.messageId} (${next.length} total)`);
  await postBookmarks();
}

/** Send the bookmarked responses, newest first, with their session titles. */
async function postBookmarks() {
  const titles = {};
  try {
    for (const s of await chat.listSessions()) titles[s.id] = s.title || '(untitled)';
  } catch (err) {
    log(`[ext] bookmark session titles unavailable: ${err.message}`);
  }
  provider.post({
    type: 'bookmarks',
    items: bookmarks()
      .map((b) => ({
        messageId: b.messageId,
        sessionId: b.sessionId,
        text: b.text || '',
        at: b.at || 0,
        title: titles[b.sessionId] || 'another session',
        current: b.sessionId === chat.sessionId
      }))
      .sort((a, b) => (b.at || 0) - (a.at || 0))
  });
}

/** Jump to a bookmarked response, switching session first if needed. */
async function gotoBookmark(payload) {
  if (!payload || !payload.messageId) return;
  await ensureStarted();
  if (payload.sessionId && payload.sessionId !== chat.sessionId) {
    const { transcript, agents } = await chat.switchTo(payload.sessionId);
    provider.post({ type: 'clear' });
    provider.post({ type: 'transcript', messages: transcript });
    adoptAgents(agents);
    lastSessionTitle = null;
    await refreshTitle();
    sendContext();
    await postSessions();
    log(`[ext] bookmark jump: switched to ${payload.sessionId}`);
  }
  provider.post({ type: 'focus-message', messageId: payload.messageId });
}

/**
 * A session can end up permanently stuck in "Instruction initialization blocked
 * by unavailable sources: core/instructions" — a session created under a
 * differently-cased directory never builds an instruction epoch, and every
 * subsequent prompt to it fails. Re-sending the same prompt is useless; only a
 * fresh session recovers. Nothing has run when this fires, so it is safe.
 * @returns {boolean} true when a recovery was scheduled (caller should stay quiet)
 */
function retryAfterInstructionBlock(data) {
  const message = extractError(data);
  if (!/Instruction initialization blocked/i.test(message)) return false;
  if (!retryArmed || !lastSend) return false;
  retryArmed = false;
  log('[ext] instruction init blocked; starting a fresh session and resending once');
  provider.post({ type: 'status', status: 'connecting', detail: 'recovering with a new session' });
  setTimeout(async () => {
    try {
      await chat.newSession();
      await chat.send(lastSend.text, lastSend.files);
      startTurnWatchdog();
      provider.post({ type: 'status', status: 'ready' });
    } catch (err) {
      log(`[ext] recovery failed: ${err.message}`);
      provider.post({ type: 'error', message: err.message });
    }
  }, 1000);
  return true;
}

async function handleWebviewMessage(msg) {
  if (!msg || !msg.type) return;
  try {
    switch (msg.type) {
      case 'ready':
        sendContext();
        await ensureStarted();
        await restoreSession();
        await refreshTitle();
        await postBookmarks();
        break;
      case 'copyText':
        await vscode.env.clipboard.writeText(String(msg.text || ''));
        vscode.window.setStatusBarMessage('OpenCode: response copied', 2000);
        break;
      case 'toggleBookmark':
        await toggleBookmark(msg);
        break;
      case 'listBookmarks':
        await ensureStarted();
        await postBookmarks();
        break;
      case 'gotoBookmark':
        await gotoBookmark(msg.payload || msg);
        break;
      case 'openExternal':
        if (msg.url) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'send': {
        await ensureStarted();
        lastSend = { text: msg.text || '', files: msg.files || [] };
        retryArmed = true;
        provider.post({ type: 'user-message', text: lastSend.text, files: lastSend.files, at: Date.now() });
        await chat.send(lastSend.text, lastSend.files);
        startTurnWatchdog();
        break;
      }
      case 'open':
        await openReference(msg);
        break;
      case 'setModel':
        await chat.setModel(msg.ref);
        chat.defaultModelRef = msg.ref;
        await vscode.workspace
          .getConfiguration('opencode')
          .update('model', `${msg.ref.providerID}/${msg.ref.id}`, vscode.ConfigurationTarget.Global);
        provider.post({ type: 'model-changed', ref: msg.ref });
        break;
      case 'setAgent':
        await chat.setAgent(msg.agent);
        chat.defaultAgent = msg.agent;
        provider.post({ type: 'agent-changed', agent: msg.agent });
        break;
      case 'setVariant': {
        const ref = msg.ref;
        if (!ref || !ref.id) break;
        await chat.setModel(ref);
        // Remembered for the next new session, but deliberately not written to
        // `opencode.model`: that setting is providerID/modelID, so rewriting it
        // here would only drop the variant again.
        chat.defaultModelRef = ref;
        break;
      }
      case 'perm':
        await chat.replyPermission(msg.requestId, msg.decision, msg.message);
        break;
      case 'renameSession': {
        const title = String(msg.title || '').trim();
        // A poll still in flight must not overwrite what the user just typed.
        stopTitlePoll();
        await chat.setTitle(title);
        lastSessionTitle = title;
        provider.post({ type: 'session-title', title });
        await postSessions();
        break;
      }
      case 'formReply':
        await chat.replyForm(msg.formId, msg.answer || {});
        break;
      case 'formCancel':
        await chat.cancelForm(msg.formId, msg.message);
        break;
      case 'listModels':
        await ensureStarted();
        await postModels();
        break;
      case 'togglePinModel':
        await togglePinModel(msg.providerID, msg.id);
        break;
      case 'listSessions':
        await ensureStarted();
        await postSessions();
        break;
      case 'switchSession':
        await switchSession(msg.id);
        break;
      case 'deleteSession':
        await deleteSession(msg.id);
        break;
      case 'togglePin':
        await togglePin(msg.id);
        break;
      case 'addUris':
        await addUris(msg.uris || []);
        break;
      case 'interrupt':
        await chat.interrupt();
        break;
      case 'newSession':
        await newSession();
        break;
      case 'restart':
        await restart();
        break;
      default:
        log(`[ext] unknown webview message: ${msg.type}`);
    }
  } catch (err) {
    log(`[ext] ${msg.type} failed: ${err.message}`);
    provider.post({ type: 'error', message: err.message });
  }
}

async function addToChat() {
  const editor = vscode.window.activeTextEditor || (tracker && tracker.current());
  const desc = describeEditor(editor) || (tracker && tracker.describe());
  if (!desc) {
    vscode.window.showWarningMessage('OpenCode: nothing to attach — open a saved file in the editor.');
    return;
  }
  const attachment = toAttachment(desc);
  try {
    await vscode.commands.executeCommand(`workbench.view.extension.${CONTAINER_ID}`);
  } catch {
    /* container id may differ across builds */
  }
  try {
    await vscode.commands.executeCommand('workbench.action.focusSecondarySideBar');
  } catch {
    /* best effort */
  }
  provider.post({ type: 'stage', attachment });
}

async function newSession() {
  await ensureStarted();
  await chat.newSession();
  // The new session carries the composer's standing choice; keep the pickers on it.
  postSelection({ agent: chat.defaultAgent, model: chat.defaultModelRef });
  provider.post({ type: 'clear' });
  resetAgents();
  stopTitlePoll();
  lastSessionTitle = null;
  provider.post({ type: 'session-title', title: '' });
  sendContext();
  await postSessions();
}

const PIN_KEY = 'opencode.pinnedSessions';

function pinnedIds() {
  return chat.memento.get(PIN_KEY, []) || [];
}

/** Recent sessions for this workspace, pinned first then most recently updated. */
async function postSessions() {
  try {
    const all = await chat.listSessions();
    const dir = normalizeDir(server.dir);
    const pinned = pinnedIds();
    // Keep the server's order (most recent activity first). Re-sorting by
    // `time.updated` scrambled it — the server does not order by that field.
    for (const id of Array.from(deletedSessions)) {
      if (!all.some((s) => s.id === id)) deletedSessions.delete(id);
    }
    const sessions = all
      .filter((s) => !deletedSessions.has(s.id))
      .filter((s) => !s.location || !s.location.directory || normalizeDir(s.location.directory) === dir)
      .map((s) => ({
        id: s.id,
        title: s.title || '(untitled)',
        updated: (s.time && (s.time.updated || s.time.created)) || 0,
        pinned: pinned.includes(s.id)
      }));
    sessionsCache = sessions;
    provider.post({ type: 'sessions', sessions, current: chat.sessionId });
  } catch (err) {
    log(`[ext] listSessions failed: ${err.message}`);
    provider.post({ type: 'error', message: err.message });
  }
}

async function switchSession(id) {
  if (!id) return;
  await ensureStarted();
  const { transcript, agents, selection } = await chat.switchTo(id);
  postSelection(selection);
  provider.post({ type: 'clear' });
  provider.post({ type: 'transcript', messages: transcript });
  adoptAgents(agents);
  stopTitlePoll();
  lastSessionTitle = null;
  await refreshTitle();
  sendContext();
  await postSessions();
  log(`[ext] switched to ${id} (${transcript.length} turns, ${agents.items.length} subagent(s))`);
}

async function togglePin(id) {
  const current = pinnedIds();
  const next = current.includes(id) ? current.filter((x) => x !== id) : current.concat([id]);
  await chat.memento.update(PIN_KEY, next);
  await postSessions();
}

/** Turn dropped/pasted URIs into staged attachments. */
async function addUris(uris) {
  let added = 0;
  for (const raw of uris) {
    const attachment = uriToAttachment(raw);
    if (attachment) {
      provider.post({ type: 'stage', attachment });
      added++;
    }
  }
  if (!added && uris.length) {
    vscode.window.showWarningMessage('OpenCode: dropped items must be local files or folders.');
  }
}

function uriToAttachment(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let uri;
  try {
    uri = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? vscode.Uri.parse(raw) : vscode.Uri.file(raw);
  } catch {
    return null;
  }
  if (uri.scheme !== 'file') return null;
  const relative = vscode.workspace.asRelativePath(uri, false) || uri.fsPath;
  return toAttachment({ fsPath: uri.fsPath, relative, start: null, end: null });
}

async function openWebUI() {
  if (!server || !server.baseUrl) {
    vscode.window.showWarningMessage('OpenCode: no server running yet — open the OpenCode panel first.');
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(server.baseUrl));
}

/**
 * Reveal the address and Basic credentials of the server this extension owns.
 * The password is random per start unless `opencode.server.password` is set.
 */
async function showConnection() {
  if (!server || !server.baseUrl) {
    vscode.window.showWarningMessage('OpenCode: no server running yet — open the OpenCode panel first.');
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `OpenCode server: ${server.baseUrl} (user "opencode")`,
    'Copy password',
    'Open Web UI'
  );
  if (choice === 'Copy password') {
    await vscode.env.clipboard.writeText(server.password || '');
    vscode.window.showInformationMessage('OpenCode server password copied to the clipboard.');
  } else if (choice === 'Open Web UI') {
    await vscode.env.openExternal(vscode.Uri.parse(server.baseUrl));
  }
}

async function restart() {
  stopTurnWatchdog();
  aborted = true;
  server.stop();
  started = false;
  await new Promise((r) => setTimeout(r, 400));
  provider.post({ type: 'clear' });
  resetAgents();
  await ensureStarted();
}

class ChatViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
    this.pending = [];
    this.onMessage = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.extensionUri]
    };
    webview.html = this.getHtml(webview);
    webview.onDidReceiveMessage((msg) => {
      if (this.onMessage) this.onMessage(msg);
    });
    view.onDidDispose(() => {
      this.view = null;
    });
    const queued = this.pending.splice(0);
    for (const msg of queued) this.post(msg);
  }

  post(msg) {
    if (this.view) {
      this.view.webview.postMessage(msg);
    } else if (this.pending.length < 50) {
      this.pending.push(msg);
    }
  }

  getHtml(webview) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const markdownUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'markdown.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>OpenCode</title>
</head>
<body>
<header class="titlebar">
  <span id="session-title" class="brand" title="Click to rename this session" tabindex="0" role="button">OpenCode</span>
  <span class="spacer"></span>
  <button id="btn-bookmarks" class="iconbtn" title="Bookmarks">
    <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true"><path d="M4 2.2h8v11.6L8 10.9l-4 2.9z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
  </button>
  <button id="btn-history" class="iconbtn" title="Session history">
    <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true"><circle cx="8" cy="8" r="5.9" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 4.4V8l2.5 1.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
  </button>
  <button id="btn-new" class="iconbtn" title="New session">
    <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
  </button>
</header>
<div id="sessions" class="panel hidden">
  <input id="sessions-search" class="panel-search" type="text" placeholder="Search sessions" aria-label="Search sessions" />
  <div id="sessions-list" class="panel-list"></div>
</div>
<div id="bookmarks" class="panel hidden">
  <input id="bookmarks-search" class="panel-search" type="text" placeholder="Search bookmarks" aria-label="Search bookmarks" />
  <div id="bookmarks-list" class="panel-list"></div>
</div>
<div id="status" class="status"></div>
<main id="messages" class="messages"></main>
<footer class="composer">
  <div class="composer-panel">
    <div id="chips" class="chips"></div>
    <textarea id="input" rows="1" placeholder="Ask OpenCode…  (Ctrl+L adds the selection, or drop a file here)"></textarea>
    <div class="row">
      <button id="agent-btn" class="picker-btn" title="Choose the primary agent">
        <span id="agent-label" class="picker-label">Agent</span>
        <svg class="chev" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6.5L8 10.5l4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button id="model-btn" class="picker-btn wide" title="Choose model">
        <span id="model-label" class="picker-label">Model</span>
        <svg class="chev" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6.5L8 10.5l4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button id="variant-btn" class="picker-btn" title="Choose the model's reasoning effort">
        <span id="variant-label" class="picker-label">Default</span>
        <svg class="chev" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6.5L8 10.5l4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button id="agents-btn" class="agents-btn hidden" title="Agents">
        <span id="agents-dot" class="agents-dot"></span>
        <span id="agents-label">0 agents</span>
      </button>
      <span class="spacer"></span>
      <button id="send" class="sendbtn" title="Send">
        <svg class="ico-send" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 13.2V3.4M8 3.4L4.1 7.3M8 3.4l3.9 3.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <svg class="ico-stop" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.4" fill="currentColor"/></svg>
      </button>
    </div>
    <div id="agent-menu" class="picker-menu hidden"></div>
    <div id="model-menu" class="picker-menu hidden"></div>
    <div id="variant-menu" class="picker-menu hidden"></div>
    <div id="agents-panel" class="picker-menu agents-panel hidden"></div>
  </div>
</footer>
<div id="dropzone" class="dropzone hidden">Drop files to add as context</div>
<script nonce="${nonce}" src="${markdownUri}"></script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

module.exports = { activate, deactivate };
