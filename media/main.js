(function () {
  const vscode = acquireVsCodeApi();

  const sessionTitleEl = document.getElementById('session-title');
  const messagesEl = document.getElementById('messages');
  const chipsEl = document.getElementById('chips');
  const inputEl = document.getElementById('input');
  const agentBtn = document.getElementById('agent-btn');
  const agentLabel = document.getElementById('agent-label');
  const agentMenu = document.getElementById('agent-menu');
  const modelBtn = document.getElementById('model-btn');
  const modelLabel = document.getElementById('model-label');
  const modelMenu = document.getElementById('model-menu');
  const variantBtn = document.getElementById('variant-btn');
  const variantLabel = document.getElementById('variant-label');
  const variantMenu = document.getElementById('variant-menu');
  const agentsBtn = document.getElementById('agents-btn');
  const agentsDot = document.getElementById('agents-dot');
  const agentsLabel = document.getElementById('agents-label');
  const agentsPanel = document.getElementById('agents-panel');
  const autopilotBtn = document.getElementById('autopilot-btn');
  const autopilotLabel = document.getElementById('autopilot-label');
  const statusEl = document.getElementById('status');
  const sessionsEl = document.getElementById('sessions');
  const sessionsListEl = document.getElementById('sessions-list');
  const sessionsSearchEl = document.getElementById('sessions-search');
  const bookmarksEl = document.getElementById('bookmarks');
  const bookmarksListEl = document.getElementById('bookmarks-list');
  const bookmarksSearchEl = document.getElementById('bookmarks-search');
  const sendBtn = document.getElementById('send');
  const btnBookmarks = document.getElementById('btn-bookmarks');
  const btnHistory = document.getElementById('btn-history');
  const btnNew = document.getElementById('btn-new');
  const dropzone = document.getElementById('dropzone');

  const ICON_COPY =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="5.6" y="5.6" width="7.9" height="7.9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M10.4 3.4H3.6a1 1 0 0 0-1 1v6.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  const ICON_BOOKMARK =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.2 2.6h7.6v10.8L8 10.5l-3.8 2.9z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const ICON_CHEVRON =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3.4 8.4l3 3 6.2-6.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /** Shell and search tools colour their output; the escape codes are noise here. */
  function stripAnsi(text) {
    // eslint-disable-next-line no-control-regex
    return String(text == null ? '' : text).replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  }

  /** Claude Code's spinner glyphs, run forward then back so it rocks rather than jumps. */
  const SPINNER_FRAMES = (() => {
    const base = ['·', '✢', '*', '✶', '✻', '✽'];
    return base.concat(base.slice(0, -1).reverse());
  })();

  let autoContext = null;
  let autoEnabled = true;
  let autoDismissed = false;
  let chips = [];
  let sessions = [];
  let currentSession = null;
  let models = [];
  let selectedModel = null;
  let agentOptions = [];
  let selectedAgent = null;
  // null is "Default": no variant field is sent, so the server's own default
  // applies. It reports that back as the literal string "default".
  let selectedVariant = null;
  let busy = false;
  let thinking = null;
  let thinkingTimer = null;
  let thinkingIndex = 0;
  let wordTimer = null;
  let bookmarkItems = [];
  let bookmarkedIds = new Set();
  let sessionFilter = '';
  let bookmarkFilter = '';
  let lastDateKey = null; // last day divider emitted
  const responseStarts = new Map(); // assistantMessageID -> start time
  let pendingPermission = null; // { el, requestId } while an approval is unanswered
  // Mirrors the `opencode.autopilot` setting; the host is the source of truth.
  let autopilot = false;
  let agentState = { main: null, items: [], running: false };
  const orderedBlocks = []; // { el, at, turn } — turns and day dividers, in order
  const turns = new Map(); // assistantMessageID -> { el, body, parts, tools, actions }
  const toolRows = new Map(); // tool call id -> its row, so a result finds its call
  const pendingRender = new Set();
  let renderScheduled = false;

  const THINKING_WORDS = [
    'Thinking',
    'Pondering',
    'Cogitating',
    'Noodling',
    'Percolating',
    'Mulling',
    'Ruminating',
    'Scheming',
    'Vibing',
    'Wrangling'
  ];

  // Markdown rendering lives in markdown.js, loaded before this script, so it
  // can be unit tested outside the webview.
  const renderMarkdown = window.OCMarkdown.renderMarkdown;

  function relativeTime(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 60000) return 'now';
    const m = Math.floor(diff / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** '2026-10-11' — used for the day divider. */
  function formatDate(ms) {
    const d = new Date(ms || Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** '4:33 PM' — shown against a prompt and the start of a response. */
  function formatTime(ms) {
    return new Date(ms || Date.now()).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  function formatDateTime(ms) {
    return ms ? formatDate(ms) + ' ' + formatTime(ms) : '';
  }

  // ------------------------------------------------------------ session title

  const DEFAULT_TITLE = 'OpenCode';

  function setSessionTitle(title) {
    const named = !!title;
    sessionTitleEl.textContent = title || DEFAULT_TITLE;
    sessionTitleEl.classList.toggle('named', named);
    sessionTitleEl.title = named ? title + ' — click to rename' : 'Click to rename this session';
  }

  /** Swap the title for an input; Enter or blur commits, Escape cancels. */
  function startRenaming() {
    if (document.querySelector('.title-input')) return;
    const current = sessionTitleEl.classList.contains('named') ? sessionTitleEl.textContent : '';
    const input = document.createElement('input');
    input.className = 'title-input';
    input.value = current;
    input.placeholder = 'Session title';
    input.maxLength = 200;
    sessionTitleEl.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      input.replaceWith(sessionTitleEl);
      if (commit) {
        const value = input.value.trim();
        setSessionTitle(value);
        vscode.postMessage({ type: 'renameSession', title: value });
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  /**
   * The day divider's label, e.g. "Fri, Oct 9". The year is added only when it
   * is not the current one, so a session spanning a year boundary stays clear.
   */
  function dateLabel(ms) {
    const d = new Date(ms || Date.now());
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-US', opts);
  }

  /**
   * Follow the newest content only while the reader is already at the bottom.
   * Scrolling up to re-read something is a deliberate act, and dragging the view
   * back down mid-sentence makes the transcript feel like it is fighting you.
   *
   * The flag is maintained from scroll events rather than measured here. Content
   * is appended *before* scrollToBottom() runs, so at that moment scrollHeight
   * already includes the new rows and asking "are we at the bottom?" would
   * always answer no. A scroll event fires before the next update arrives, so
   * the flag holds the reader's position as of *before* the update — which is
   * the question that actually matters.
   */
  const NEAR_BOTTOM_PX = 16;
  let stickToBottom = true;

  function atBottom() {
    return (
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= NEAR_BOTTOM_PX
    );
  }

  messagesEl.addEventListener('scroll', () => {
    stickToBottom = atBottom();
  });

  /**
   * Follow the newest content, unless the reader has scrolled away from the
   * bottom. `force` is for the cases the turn cannot proceed without: an
   * approval or a question left off-screen would block it with no visible cause.
   */
  function scrollToBottom(force) {
    if (!force && !stickToBottom) return;
    stickToBottom = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ------------------------------------------------------------------- timeline

  /**
   * A day divider whenever the day changes, so a restored session spanning
   * several days still reads in order. Drawn as wave | label | wave, the way
   * Claude Code does it — a masked sine rule rather than repeated characters.
   */
  function ensureDateSeparator(at) {
    const key = formatDate(at);
    if (key === lastDateKey) return;
    lastDateKey = key;
    const el = document.createElement('div');
    el.className = 'divider';
    const label = document.createElement('span');
    label.className = 'divider-label';
    label.textContent = dateLabel(at);
    el.appendChild(document.createElement('span')).className = 'wave';
    el.appendChild(label);
    el.appendChild(document.createElement('span')).className = 'wave';
    // Placed at the start of its day, so it heads every row of that day rather
    // than landing in the middle of them when something arrives out of order.
    const day = new Date(at || Date.now());
    day.setHours(0, 0, 0, 0);
    insertOrdered(el, day.getTime(), false);
  }

  /** The right-aligned time stamp, as Claude Code's `.line > .stamp`. */
  function timeLine(at) {
    const el = document.createElement('div');
    el.className = 'stamp';
    el.textContent = formatTime(at);
    return el;
  }

  // Turn wrappers, each tagged with the moment it belongs to and held in
  // chronological order. Placement is by that moment rather than by when the
  // events happened to arrive: a plan-mode preamble is answered before the first
  // prompt but can stream in after it, and ordering by arrival put the reply
  // above the thing it was replying to.

  function makeTurn() {
    const el = document.createElement('div');
    el.className = 'turn';
    return el;
  }

  /**
   * Place an element in the content area by the moment it belongs to, so turns
   * and day dividers stay in order however late their events arrive. Ties keep
   * insertion order, which is what puts a day's divider above its first row.
   */
  function insertOrdered(el, at, isTurn) {
    const entry = { el, at, turn: !!isTurn };
    const i = orderedBlocks.findIndex((b) => b.at > at);
    if (i < 0) {
      orderedBlocks.push(entry);
      messagesEl.appendChild(el);
    } else {
      orderedBlocks.splice(i, 0, entry);
      const next = orderedBlocks[i + 1];
      messagesEl.insertBefore(el, next ? next.el : null);
    }
    // The spinner always sits last, below everything else.
    if (thinking) messagesEl.appendChild(thinking.el);
    return el;
  }

  /**
   * The turn a moment belongs to: the newest turn at or before it. Anything
   * earlier than every turn gets one of its own, placed ahead of them — which
   * is where a plan-mode preamble belongs when it streams in late.
   */
  function turnContainer(at) {
    const t = at || Date.now();
    let host = null;
    for (const b of orderedBlocks) if (b.turn && b.at <= t) host = b;
    if (!host) return insertOrdered(makeTurn(), t, true);
    if (thinking) messagesEl.appendChild(thinking.el);
    return host.el;
  }

  /**
   * A row on the timeline: a dot drawn on the rail by CSS, then the body. The
   * user's own prompt is not a timeline row — see addUserMessage — which is why
   * the rail starts at the dot below it rather than running through it.
   *
   * @param {string} dot '' | 'dot-success' | 'dot-failure' | 'dot-warning' | 'dot-progress'
   */
  function addRow(dot, at) {
    const when = at || Date.now();
    ensureDateSeparator(when);
    const el = document.createElement('div');
    el.className = 'msg tl' + (dot ? ' ' + dot : '');
    const body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);
    turnContainer(when).appendChild(el);
    if (thinking) messagesEl.appendChild(thinking.el);
    return { el, body };
  }

  /** Point a row's dot at a state: working, done, failed or needing attention. */
  function setDot(el, dot) {
    el.classList.remove('dot-success', 'dot-failure', 'dot-warning', 'dot-progress');
    if (dot) el.classList.add(dot);
  }

  // --------------------------------------------------------- the assistant turn
  //
  // One assistant message produces several blocks — a "Thought for 12s", some
  // tool calls, the answer — and each gets its own row and its own dot, in the
  // order the model produced them. Claude Code does the same for the rows it
  // breaks out (its tool-result and fold rows each carry a dot).

  /**
   * A row belonging to the current message. Only the first carries the
   * timestamp, so a message split across several rows still reads as one moment.
   */
  function messageRow(rec, dot) {
    const { el, body } = addRow(dot, rec.at);
    el.dataset.messageId = rec.id;
    if (!rec.stamped) {
      body.appendChild(timeLine(rec.at));
      rec.stamped = true;
    }
    const row = { el, body, text: '' };
    rec.rows.push(row);
    return row;
  }

  function ensureTurn(messageID, at) {
    const key = messageID || 'assistant';
    if (turns.has(key)) return turns.get(key);
    // A new assistant message means the previous one is done, so its rows settle
    // now rather than blinking on until the whole turn ends.
    settleAllRows();
    // Prefer the step's own start over the first delta's time: a message that
    // streams in late still belongs where it began, not where it arrived.
    const when = responseStarts.get(key) || at || Date.now();
    responseStarts.delete(key);
    const rec = { id: key, at: when, stamped: false, rows: [], parts: new Map(), tools: new Map(), actions: null };
    turns.set(key, rec);
    return rec;
  }

  /** The prose block for a part id, created on first sight. */
  function textPart(rec, partID) {
    const key = 't' + partID;
    if (rec.parts.has(key)) return rec.parts.get(key);
    const row = messageRow(rec, 'dot-progress');
    const el = document.createElement('div');
    el.className = 'prose';
    row.body.appendChild(el);
    const part = { kind: 'text', row, el, text: '' };
    rec.parts.set(key, part);
    return part;
  }

  /**
   * The reasoning disclosure: "Thinking…" while it streams, then "Thought for
   * 12s", with the reasoning itself behind it. Collapsed by default, like
   * Claude Code's.
   */
  function reasoningPart(rec, partID) {
    const key = String(partID);
    if (rec.parts.has(key)) return rec.parts.get(key);
    const row = messageRow(rec, 'dot-progress');
    const el = document.createElement('details');
    el.className = 'thinking';
    const summary = document.createElement('summary');
    summary.className = 'thinking-summary';
    const label = document.createElement('span');
    label.textContent = 'Thinking…';
    const chev = document.createElement('span');
    chev.className = 'thinking-chev';
    chev.innerHTML = ICON_CHEVRON;
    summary.appendChild(label);
    summary.appendChild(chev);
    const content = document.createElement('div');
    content.className = 'thinking-content';
    el.appendChild(summary);
    el.appendChild(content);
    row.body.appendChild(el);
    const part = { kind: 'reasoning', row, el, label, content, text: '' };
    rec.parts.set(key, part);
    return part;
  }

  /** The server puts no duration on the end event, so an unknown one reads "Thinking". */
  function finishReasoning(part, ms) {
    const known = typeof ms === 'number' && isFinite(ms) && ms >= 0;
    part.label.textContent = known ? 'Thought for ' + Math.round(ms / 1000) + 's' : 'Thinking';
    // The thought is over, so its dot stops working and goes back to grey.
    settleRow(part.row);
  }

  function renderReasoning(part) {
    part.content.innerHTML = renderMarkdown(part.text);
  }

  function renderTextPart(part) {
    part.el.innerHTML = renderMarkdown(part.text);
  }

  function scheduleRender(rec) {
    pendingRender.add(rec);
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      for (const r of pendingRender) {
        for (const part of r.parts.values()) {
          if (part.kind === 'reasoning') renderReasoning(part);
          else renderTextPart(part);
        }
      }
      pendingRender.clear();
      scrollToBottom();
    });
  }

  function ensureActions(rec, text) {
    if (rec.actions) {
      rec.actions.dataset.text = text;
      return;
    }
    const row = document.createElement('div');
    row.className = 'actions';
    row.dataset.text = text;
    row.dataset.messageId = rec.id;
    row.innerHTML =
      '<button class="act" data-act="copy" title="Copy response" aria-label="Copy response">' +
      ICON_COPY +
      '</button>' +
      '<button class="act" data-act="bookmark" title="Bookmark response" aria-label="Bookmark response">' +
      ICON_BOOKMARK +
      '</button>';
    // Under the last row of the message — the answer the actions apply to.
    const last = rec.rows[rec.rows.length - 1];
    if (last) last.body.appendChild(row);
    rec.actions = row;
    applyBookmark(rec);
  }

  function applyBookmark(rec) {
    if (!rec.actions) return;
    const btn = rec.actions.querySelector('[data-act="bookmark"]');
    if (btn) btn.classList.toggle('on', bookmarkedIds.has(rec.actions.dataset.messageId));
  }

  /**
   * The user's own prompt: a bordered bubble, and deliberately *not* a timeline
   * row. Claude Code keeps it outside the rail, so the next row's rail starts at
   * its own dot rather than running through the prompt.
   */
  function addUserMessage(text, files, at) {
    const when = at || Date.now();
    ensureDateSeparator(when);
    // A prompt opens its own turn: everything the model does in response lands
    // in the same wrapper, which is what the prompt sticks within.
    const wrapEl = insertOrdered(makeTurn(), when, true);
    const el = document.createElement('div');
    el.className = 'msg user';
    el.appendChild(timeLine(when));
    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.textContent = text || '(attachment only)';
    el.appendChild(bubble);
    if (files && files.length) {
      const f = document.createElement('div');
      f.className = 'attachments';
      f.textContent = files.map((x) => x.name || x.uri).join(', ');
      el.appendChild(f);
    }
    wrapEl.appendChild(el);
    if (thinking) messagesEl.appendChild(thinking.el);
    scrollToBottom();
  }

  function addError(message) {
    hideThinking();
    const { el, body } = addRow('dot-failure');
    const t = document.createElement('div');
    t.className = 'error-message';
    t.textContent = message;
    body.appendChild(t);
    scrollToBottom();
  }

  // -- tools ----------------------------------------------------------------

  /**
   * A tool call inside its turn: one summary line, and behind it the labelled
   * body the caller asked for — the arguments, the result, and any exit code.
   */
  function ensureTool(rec, id, name, detail) {
    const key = id || name + ':' + rec.tools.size;
    if (rec.tools.has(key)) return rec.tools.get(key);
    const row = messageRow(rec, 'dot-progress');
    const el = document.createElement('div');
    el.className = 'tool running';
    const line = document.createElement('div');
    line.className = 'tool-line';
    const n = document.createElement('span');
    n.className = 'tool-name';
    n.textContent = name || 'tool';
    const d = document.createElement('span');
    d.className = 'tool-detail';
    d.textContent = detail || '';
    line.appendChild(n);
    line.appendChild(d);
    el.appendChild(line);
    row.body.appendChild(el);
    const tool = { row, el, detailEl: d, name: name || 'tool', input: null, result: '', exit: null, bodyEl: null };
    rec.tools.set(key, tool);
    if (id) toolRows.set(String(id), tool);
    return tool;
  }

  /** Build the expandable body, once there is something to put in it. */
  function renderToolBody(row) {
    const rows = [];
    const push = (label, value) => {
      if (value === null || value === undefined || value === '') return;
      rows.push({ label, value: String(value) });
    };
    if (row.input) {
      for (const [k, v] of Object.entries(row.input)) {
        if (v === null || v === undefined || v === '') continue;
        push(k, typeof v === 'object' ? JSON.stringify(v) : v);
      }
    }
    push('result', stripAnsi(row.result));
    if (typeof row.exit === 'number') push('exit', row.exit);
    if (!rows.length) return;

    const grid = document.createElement('div');
    grid.className = 'tool-grid';
    for (const r of rows) {
      const line = document.createElement('div');
      line.className = 'tool-row';
      const l = document.createElement('div');
      l.className = 'tool-label';
      l.textContent = r.label;
      const c = document.createElement('div');
      c.className = 'tool-content';
      c.textContent = r.value;
      line.appendChild(l);
      line.appendChild(c);
      grid.appendChild(line);
    }
    if (!row.bodyEl) {
      row.bodyEl = document.createElement('div');
      row.bodyEl.className = 'tool-body';
      row.el.appendChild(row.bodyEl);
    }
    row.bodyEl.innerHTML = '';
    row.bodyEl.appendChild(grid);
  }

  /**
   * Find the tool row a result belongs to: by call id first, then by name
   * within the same turn, then the newest unfinished one there.
   */
  function findTool(rec, msg) {
    if (msg.id && rec.tools.has(String(msg.id))) return rec.tools.get(String(msg.id));
    if (msg.id && toolRows.has(String(msg.id))) return toolRows.get(String(msg.id));
    const mine = [...rec.tools.values()];
    return mine.reverse().find((r) => r.name === (msg.name || 'tool') && r.el.classList.contains('running'))
      || mine.find((r) => r.el.classList.contains('running'))
      || null;
  }

  function addTool(msg) {
    // The tool belongs to the assistant message that called it, so its row lands
    // inside that turn rather than as a row of its own.
    const rec = ensureTurn(msg.messageID, msg.at);
    // A result can arrive with no call to match — the call event was missed, or
    // the stream reconnected mid-tool — so fall back to making the row.
    const tool = msg.state === 'running'
      ? ensureTool(rec, msg.id, msg.name, msg.detail)
      : findTool(rec, msg) || ensureTool(rec, msg.id, msg.name, msg.detail);

    if (msg.state === 'running') {
      if (msg.input) tool.input = msg.input;
      renderToolBody(tool);
    } else {
      const ok = msg.state === 'ok';
      tool.el.classList.remove('running', 'ok', 'error');
      tool.el.classList.add(ok ? 'ok' : 'error');
      if (msg.input) tool.input = msg.input;
      if (msg.result) tool.result = msg.result;
      if (typeof msg.exit === 'number') tool.exit = msg.exit;
      if (!ok && msg.error) tool.detailEl.textContent = msg.error;
      renderToolBody(tool);
      // Green once the call has run, red if it failed — Claude Code colours a
      // tool result the same way (is_error ? failure : success). A failing tool
      // is ordinary, so it colours its own row and not the turn.
      setDot(tool.row.el, ok ? 'dot-success' : 'dot-failure');
    }
    scrollToBottom();
  }

  function clearMessages() {
    messagesEl.innerHTML = '';
    // A session opens at its newest content, whatever the reader's position was
    // in the session they just left.
    stickToBottom = true;
    turns.clear();
    toolRows.clear();
    orderedBlocks.length = 0;
    thinking = null;
    pendingPermission = null;
    lastDateKey = null;
    responseStarts.clear();
    pendingRender.clear();
  }

  // --------------------------------------------------------------- busy/thinking

  /**
   * The working indicator: a glyph cycling through Claude Code's frames beside a
   * rotating verb. It is not a timeline row — no dot, no indent — because it
   * belongs to the turn being generated rather than being a turn of its own.
   */
  function showThinking() {
    if (thinking) return;
    thinkingIndex = Math.floor(Math.random() * THINKING_WORDS.length);
    const el = document.createElement('div');
    el.className = 'msg spinner-row';
    const glyph = document.createElement('span');
    glyph.className = 'spinner-glyph';
    glyph.textContent = SPINNER_FRAMES[0];
    const text = document.createElement('span');
    text.className = 'spinner-text';
    text.textContent = THINKING_WORDS[thinkingIndex] + '…';
    el.appendChild(glyph);
    el.appendChild(text);
    messagesEl.appendChild(el);
    thinking = { el, glyph, text, frame: 0 };
    thinkingTimer = setInterval(() => {
      thinking.frame = (thinking.frame + 1) % SPINNER_FRAMES.length;
      glyph.textContent = SPINNER_FRAMES[thinking.frame];
    }, 120);
    // The verb turns over far more slowly than the glyph.
    wordTimer = setInterval(() => {
      thinkingIndex = (thinkingIndex + 1) % THINKING_WORDS.length;
      text.textContent = THINKING_WORDS[thinkingIndex] + '…';
    }, 2400);
    scrollToBottom();
  }

  function hideThinking() {
    for (const t of [thinkingTimer, wordTimer]) if (t) clearInterval(t);
    thinkingTimer = null;
    wordTimer = null;
    if (thinking) {
      thinking.el.remove();
      thinking = null;
    }
  }

  const IDLE_PLACEHOLDER = 'Ask OpenCode…  (Ctrl+L adds the selection, or drop a file here)';

  /**
   * The button shows Stop only when a turn is running *and* there is nothing to
   * send. Typing anything flips it to Send, so Enter or a click queues the
   * message; clearing the input flips it back to Stop while the turn runs.
   */
  function updateSendButton() {
    const stop = busy && inputEl.value.trim().length === 0;
    sendBtn.classList.toggle('stopping', stop);
    sendBtn.title = stop ? 'Stop' : 'Send';
    inputEl.placeholder = busy ? 'Enter queues a message for after this turn' : IDLE_PLACEHOLDER;
  }

  function setBusy(on) {
    busy = on;
    updateSendButton();
    if (on) showThinking();
    else hideThinking();
  }

  /** The turn a finished response belongs to, for its dot and its actions. */
  function lastTurn() {
    const ids = Array.from(turns.keys());
    return ids.length ? turns.get(ids[ids.length - 1]) : null;
  }

  /**
   * Stop a row's dot working, for rows whose outcome is neither green nor red: a
   * finished thought, or the answer itself. Tool rows settle themselves — green
   * once the call has run, red if it failed.
   */
  function settleRow(row) {
    if (!row.el.classList.contains('dot-progress')) return;
    setDot(row.el, '');
  }

  /**
   * Settle anything still working, across every message in the turn. A message
   * produces several rows, and settling only the newest left the earlier ones
   * blinking after the turn had finished.
   */
  function settleAllRows() {
    for (const rec of turns.values()) for (const row of rec.rows) settleRow(row);
  }

  /**
   * The last message with prose in each turn wrapper, which is where the
   * response actions belong. `turns` holds insertion order, so a later message
   * overwrites an earlier one against the same wrapper.
   * @returns {Array<{rec: any, text: string}>}
   */
  function lastTextPerTurn() {
    const byTurn = new Map();
    for (const rec of turns.values()) {
      if (!rec.rows.length) continue;
      const text = turnText(rec);
      if (!text.trim()) continue;
      byTurn.set(rec.rows[0].el.parentNode, { rec, text });
    }
    return [...byTurn.values()];
  }

  /** The prose of a turn, which is what Copy and Bookmark act on. */
  function turnText(rec) {
    let out = '';
    for (const part of rec.parts.values()) if (part.kind === 'text') out += part.text;
    return out;
  }

  /**
   * Replay a restored message's blocks in the order the model produced them.
   * The transcript carries reasoning and tool blocks as well as prose; before
   * this the restored view showed only the prose, so a long working session
   * read as a few disconnected paragraphs.
   */
  function renderBlocks(rec, m) {
    const blocks = m.blocks || [];
    if (!blocks.length) {
      if (m.text && m.text.trim()) {
        const part = textPart(rec, '0');
        part.text = m.text;
        renderTextPart(part);
      }
      return;
    }
    let n = 0;
    for (const b of blocks) {
      if (b.kind === 'text') {
        const part = textPart(rec, String(n++));
        part.text = b.text || '';
        renderTextPart(part);
      } else if (b.kind === 'reasoning') {
        const part = reasoningPart(rec, 'r' + n++);
        part.text = b.text || '';
        finishReasoning(part, b.ms);
        renderReasoning(part);
      } else if (b.kind === 'tool') {
        const tool = ensureTool(rec, b.id, b.name, b.detail);
        tool.input = b.input;
        tool.result = b.result;
        tool.exit = b.exit;
        tool.el.classList.remove('running');
        tool.el.classList.add(b.status === 'failed' ? 'error' : 'ok');
        renderToolBody(tool);
        setDot(tool.row.el, b.status === 'failed' ? 'dot-failure' : 'dot-success');
      }
    }
  }

  function finishTurn() {
    const rec = lastTurn();
    if (rec) {
      const text = turnText(rec);
      if (text.trim()) ensureActions(rec, text);
    }
    settleAllRows();
    setBusy(false);
  }

  // ----------------------------------------------------------------------- chips

  function renderChips() {
    chipsEl.innerHTML = '';
    if (autoEnabled && autoContext && autoContext.uri && !autoDismissed) chipsEl.appendChild(makeChip(autoContext, true));
    for (const c of chips) chipsEl.appendChild(makeChip(c, false));
  }

  function makeChip(file, isAuto) {
    const el = document.createElement('span');
    el.className = 'chip' + (isAuto ? ' auto' : '');
    el.title = file.uri;
    const label = document.createElement('span');
    label.textContent = (isAuto ? 'context: ' : '') + (file.name || file.uri);
    el.appendChild(label);
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = isAuto ? 'Leave the current file out of this message' : 'Remove';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isAuto) autoDismissed = true;
      else chips = chips.filter((c) => c !== file);
      renderChips();
    });
    el.appendChild(x);
    return el;
  }

  function stage(file) {
    if (!file || !file.uri) return;
    if (autoContext && autoContext.uri === file.uri && !autoDismissed) return;
    if (chips.some((c) => c.uri === file.uri)) return;
    chips.push(file);
    renderChips();
  }

  // ----------------------------------------------------------------- autopilot
  // A toggle rather than a picker: it has no menu to open. What it changes is a
  // setting, so it reads loudly when on — what asks for permission (access
  // outside the workspace, reading .env files) is exactly what is worth seeing.

  function renderAutopilot() {
    autopilotBtn.classList.toggle('on', autopilot);
    autopilotBtn.setAttribute('aria-pressed', autopilot ? 'true' : 'false');
    autopilotBtn.title = autopilot
      ? 'Autopilot is on — permission requests are approved for you'
      : 'Autopilot: approve permission requests for you';
    autopilotLabel.textContent = autopilot ? 'Autopilot on' : 'Autopilot';
  }

  autopilotBtn.addEventListener('click', () => {
    closePickers(null);
    closePanels();
    // The setting is the source of truth, so the button does not flip itself:
    // the host writes the setting and posts the result back.
    vscode.postMessage({ type: 'setAutopilot', on: !autopilot });
  });

  // ------------------------------------------------- composer pickers
  // Three of them share one bar: agent, model, and the model's reasoning-effort
  // variant. Only one menu is ever open, so they all close each other.

  const PICKERS = [
    { menu: agentMenu, btn: agentBtn },
    { menu: modelMenu, btn: modelBtn },
    { menu: variantMenu, btn: variantBtn },
    { menu: agentsPanel, btn: agentsBtn }
  ];

  function closePickers(keep) {
    for (const p of PICKERS) {
      if (p.menu === keep) continue;
      p.menu.classList.add('hidden');
      p.btn.classList.remove('open');
    }
  }

  function openPicker(menu, btn, render) {
    closePickers(menu);
    closePanels();
    render();
    menu.classList.remove('hidden');
    btn.classList.add('open');
  }

  /** One row in any picker menu. `stacked` puts the description on its own line. */
  function pickerItem(main, meta, current, onPick, stacked) {
    const item = document.createElement('div');
    item.className = 'picker-item' + (stacked ? ' stacked' : '') + (current ? ' current' : '');
    const name = document.createElement('span');
    name.className = 'picker-name';
    name.textContent = main;
    const side = document.createElement('span');
    side.className = 'picker-meta';
    side.textContent = meta || '';
    const check = document.createElement('span');
    check.className = 'picker-check';
    check.textContent = '✓';
    item.appendChild(name);
    if (meta) item.appendChild(side);
    item.appendChild(check);
    item.addEventListener('click', onPick);
    return item;
  }

  function pickerEmpty(menu, text) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = text;
    menu.appendChild(empty);
  }

  // ------------------------------------------------------------------- agent

  function renderAgentMenu() {
    agentMenu.innerHTML = '';
    if (!agentOptions.length) {
      pickerEmpty(agentMenu, 'No primary agents reported by the server.');
      return;
    }
    for (const a of agentOptions) {
      agentMenu.appendChild(
        pickerItem(
          a.name || a.id,
          a.description,
          a.id === selectedAgent,
          () => {
            selectedAgent = a.id;
            agentLabel.textContent = a.name || a.id;
            closePickers();
            vscode.postMessage({ type: 'setAgent', agent: a.id });
          },
          // The description needs the full menu width, so it goes on its own line.
          true
        )
      );
    }
  }

  function toggleAgentMenu() {
    if (agentMenu.classList.contains('hidden')) openPicker(agentMenu, agentBtn, renderAgentMenu);
    else closePickers();
  }

  function fillAgents(list) {
    agentOptions = list || [];
    // Nothing chosen yet: show the server's own first primary agent, which is
    // what a new session actually gets.
    if (!selectedAgent && agentOptions.length) selectedAgent = agentOptions[0].id;
    const cur = agentOptions.find((a) => a.id === selectedAgent);
    agentLabel.textContent = cur ? cur.name || cur.id : 'Agent';
    if (!agentMenu.classList.contains('hidden')) renderAgentMenu();
  }

  // ------------------------------------------------------------------- model

  function isCurrent(m) {
    return !!selectedModel && selectedModel.id === m.id && selectedModel.providerID === m.providerID;
  }

  function modelLabelFor(ref) {
    const m = ref && models.find((x) => x.id === ref.id && x.providerID === ref.providerID);
    return m ? m.name || m.id : (ref && ref.id) || 'Model';
  }

  const PER_MTOK = 'per 1M tokens';

  /** Two decimals, which is what prices are quoted in; more only when tiny. */
  function money(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '?';
    if (n >= 0.01) return n.toFixed(2);
    return String(Number(n.toPrecision(2)));
  }

  /** 262144 -> "262K", 1048576 -> "1M", 2097152 -> "2.1M". */
  function shortTokens(n) {
    if (!n) return '';
    if (n >= 1000000) {
      const m = Math.round(n / 100000) / 10;
      return (Number.isInteger(m) ? m : m.toFixed(1)) + 'M';
    }
    return Math.round(n / 1000) + 'K';
  }

  /**
   * Hover text for a model. The server reports cost as an array of tiers in USD
   * per million tokens — the first is the base rate, any later ones apply above
   * their context size.
   */
  function priceTitle(m) {
    const lines = [m.name || m.id, m.providerID];
    const tiers = m.cost || [];
    const base = tiers[0];
    if (!base) {
      lines.push('No pricing reported by the server.');
    } else if (!base.input && !base.output) {
      lines.push('Free');
    } else {
      lines.push(`$${money(base.input)} in · $${money(base.output)} out ${PER_MTOK}`);
      const cache = [];
      if (base.cacheRead) cache.push(`$${money(base.cacheRead)} read`);
      if (base.cacheWrite) cache.push(`$${money(base.cacheWrite)} write`);
      if (cache.length) lines.push(`cache ${cache.join(' · ')} ${PER_MTOK}`);
    }
    for (const t of tiers.slice(1)) {
      const size = shortTokens(t.tier);
      lines.push(`over ${size ? size + ' context' : 'a larger context'}: $${money(t.input)} in · $${money(t.output)} out ${PER_MTOK}`);
    }
    const ctx = m.limit && m.limit.context;
    if (ctx) lines.push(`${shortTokens(ctx)} context window`);
    return lines.join('\n');
  }

  function renderModelMenu() {
    modelMenu.innerHTML = '';
    if (!models.length) {
      pickerEmpty(modelMenu, 'No models reported by the server.');
      return;
    }
    for (const m of models) {
      const item = pickerItem(m.name || m.id, m.providerID, isCurrent(m), () => {
        selectedModel = { id: m.id, providerID: m.providerID };
        // A variant belongs to its model, so one the new model does not offer
        // is dropped rather than carried across as a value it would ignore.
        const variants = m.variants || [];
        if (selectedVariant && !variants.includes(selectedVariant)) selectedVariant = null;
        if (selectedVariant) selectedModel.variant = selectedVariant;
        modelLabel.textContent = m.name || m.id;
        renderVariantLabel();
        closePickers();
        vscode.postMessage({ type: 'setModel', ref: selectedModel });
      });
      // A pin is an action, not a choice: it must not also pick the model.
      item.title = priceTitle(m);
      const pin = document.createElement('span');
      pin.className = 'model-pin' + (m.pinned ? ' on' : '');
      pin.textContent = m.pinned ? '★' : '☆';
      pin.title = m.pinned ? 'Unpin model' : 'Pin model to the top';
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'togglePinModel', id: m.id, providerID: m.providerID });
      });
      item.appendChild(pin);
      modelMenu.appendChild(item);
    }
  }

  function toggleModelMenu() {
    if (modelMenu.classList.contains('hidden')) {
      openPicker(modelMenu, modelBtn, renderModelMenu);
      // Refresh in the background; the menu re-renders when the list arrives.
      vscode.postMessage({ type: 'listModels' });
    } else {
      closePickers();
    }
  }

  function fillModels(list, selected) {
    models = list || [];
    if (selected && selected.id) {
      selectedModel = { id: selected.id, providerID: selected.providerID };
      // Authoritative: the host sends the current model's real variant, and an
      // absent one means Default rather than "keep whatever was showing".
      selectedVariant = selected.variant || null;
    }
    modelLabel.textContent = modelLabelFor(selectedModel);
    renderVariantLabel();
    if (!modelMenu.classList.contains('hidden')) renderModelMenu();
    if (!variantMenu.classList.contains('hidden')) renderVariantMenu();
  }

  // ----------------------------------------------------------------- variant

  /** The variants the selected model offers; empty when none is selected. */
  function currentVariants() {
    const m = models.find(isCurrent);
    return (m && m.variants) || [];
  }

  function variantText(id) {
    return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Default';
  }

  function renderVariantMenu() {
    variantMenu.innerHTML = '';
    variantMenu.appendChild(
      pickerItem('Default', 'the model’s own setting', !selectedVariant, () => pickVariant(null))
    );
    const variants = currentVariants();
    if (!variants.length) {
      pickerEmpty(variantMenu, 'This model offers no variants.');
      return;
    }
    for (const id of variants) {
      variantMenu.appendChild(pickerItem(variantText(id), '', id === selectedVariant, () => pickVariant(id)));
    }
  }

  function pickVariant(id) {
    selectedVariant = id || null;
    renderVariantLabel();
    closePickers();
    const ref = { id: selectedModel.id, providerID: selectedModel.providerID };
    if (selectedVariant) ref.variant = selectedVariant;
    vscode.postMessage({ type: 'setVariant', ref });
  }

  function renderVariantLabel() {
    variantLabel.textContent = variantText(selectedVariant);
  }

  function toggleVariantMenu() {
    if (variantMenu.classList.contains('hidden')) openPicker(variantMenu, variantBtn, renderVariantMenu);
    else closePickers();
  }

  // ---------------------------------------------------------------- agent map

  function renderAgents() {
    const items = agentState.items || [];
    const running = items.filter((i) => i.status === 'running').length;

    // Hidden until this session has actually used subagents; the number is the
    // live count of RUNNING ones and the dot shows whether any are running.
    agentsBtn.classList.toggle('hidden', items.length === 0);
    if (!items.length) closeAgents();
    agentsLabel.textContent = running + ' agent' + (running === 1 ? '' : 's');
    agentsDot.classList.toggle('running', running > 0);

    agentsPanel.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'panel-head';
    head.textContent = 'Agents';
    agentsPanel.appendChild(head);

    const main = agentState.main || { name: 'agent', description: '' };
    agentsPanel.appendChild(
      agentRow(main.name, main.description || 'main agent', running > 0 ? 'running' : 'idle', true)
    );

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = 'No subagents used in this session yet.';
      agentsPanel.appendChild(empty);
      return;
    }
    for (const a of items) {
      agentsPanel.appendChild(agentRow(a.agent, a.description || a.agentDescription || '', a.status, false));
    }
  }

  function agentRow(name, description, status, isMain) {
    const row = document.createElement('div');
    row.className = 'agent-row' + (isMain ? ' main' : ' sub');

    const dot = document.createElement('span');
    dot.className = 'agent-dot ' + status;

    const body = document.createElement('span');
    body.className = 'agent-body';

    const line = document.createElement('span');
    line.className = 'agent-name';
    line.textContent = name;
    const state = document.createElement('span');
    state.className = 'agent-state';
    state.textContent = status;
    line.appendChild(state);

    const desc = document.createElement('span');
    desc.className = 'agent-desc';
    desc.textContent = description;

    body.appendChild(line);
    if (description) body.appendChild(desc);
    row.appendChild(dot);
    row.appendChild(body);
    return row;
  }

  function closeAgents() {
    agentsPanel.classList.add('hidden');
    agentsBtn.classList.remove('open');
  }

  function toggleAgents() {
    if (agentsPanel.classList.contains('hidden')) openPicker(agentsPanel, agentsBtn, renderAgents);
    else closePickers();
  }

  // ------------------------------------------------------------------- sessions

  function renderSessions() {
    const term = sessionFilter.trim().toLowerCase();
    const items = term ? sessions.filter((s) => String(s.title || '').toLowerCase().indexOf(term) >= 0) : sessions;
    sessionsListEl.innerHTML = '';

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = term
        ? 'No sessions match "' + sessionFilter.trim() + '".'
        : 'No sessions for this workspace yet.';
      sessionsListEl.appendChild(empty);
      return;
    }

    for (const s of items) {
      const row = document.createElement('div');
      row.className = 'session-row' + (s.id === currentSession ? ' current' : '');

      const pin = document.createElement('span');
      pin.className = 'session-pin' + (s.pinned ? ' on' : '');
      pin.textContent = s.pinned ? '★' : '☆';
      pin.title = s.pinned ? 'Unpin session' : 'Pin session';
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'togglePin', id: s.id });
      });

      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = s.title || '(untitled)';
      title.title = title.textContent;

      const meta = document.createElement('span');
      meta.className = 'session-meta';
      meta.textContent = formatDateTime(s.updated);

      const del = document.createElement('span');
      del.className = 'session-del';
      del.textContent = '×';
      del.title = 'Delete session';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteSession', id: s.id });
      });

      row.appendChild(pin);
      row.appendChild(title);
      row.appendChild(meta);
      row.appendChild(del);
      row.addEventListener('click', () => {
        sessionsEl.classList.add('hidden');
        vscode.postMessage({ type: 'switchSession', id: s.id });
      });
      sessionsListEl.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ bookmarks

  function snippet(text) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return '(empty response)';
    return flat.length > 90 ? flat.slice(0, 90) + '…' : flat;
  }

  function renderBookmarks() {
    const term = bookmarkFilter.trim().toLowerCase();
    const items = term
      ? bookmarkItems.filter(
          (b) =>
            String(b.text || '').toLowerCase().indexOf(term) >= 0 ||
            String(b.title || '').toLowerCase().indexOf(term) >= 0
        )
      : bookmarkItems;
    bookmarksListEl.innerHTML = '';

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = term
        ? 'No bookmarks match "' + bookmarkFilter.trim() + '".'
        : 'No bookmarked responses yet. Use the bookmark icon under a response.';
      bookmarksListEl.appendChild(empty);
      return;
    }

    for (const b of items) {
      const row = document.createElement('div');
      row.className = 'session-row';

      const mark = document.createElement('span');
      mark.className = 'session-pin on';
      mark.textContent = '★';

      const wrap = document.createElement('span');
      wrap.className = 'bk-body';
      const text = document.createElement('span');
      text.className = 'bk-text';
      text.textContent = snippet(b.text);
      const meta = document.createElement('span');
      meta.className = 'bk-meta';
      meta.textContent = (b.current ? 'this session' : b.title) + ' · ' + relativeTime(b.at);
      wrap.appendChild(text);
      wrap.appendChild(meta);

      row.appendChild(mark);
      row.appendChild(wrap);
      row.addEventListener('click', () => {
        bookmarksEl.classList.add('hidden');
        vscode.postMessage({
          type: 'gotoBookmark',
          payload: { sessionId: b.sessionId, messageId: b.messageId }
        });
      });
      bookmarksListEl.appendChild(row);
    }
  }

  function closePanels(except) {
    if (except !== 'sessions') sessionsEl.classList.add('hidden');
    if (except !== 'bookmarks') bookmarksEl.classList.add('hidden');
  }

  // The overlay panels and the title-bar button each is toggled from. A click
  // outside both dismisses the panel.
  const PANELS = [
    { el: sessionsEl, btn: 'btn-history' },
    { el: bookmarksEl, btn: 'btn-bookmarks' }
  ];

  /** Scroll a response into view and flash it after a bookmark jump. */
  function focusMessage(messageId) {
    if (!messageId) return;
    const el = messagesEl.querySelector('[data-message-id="' + String(messageId).replace(/"/g, '') + '"]');
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }

  // --------------------------------------------------------------- input / send

  function autoSize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }

  function send() {
    const text = inputEl.value.trim();
    const files = [];
    const seen = new Set();
    if (autoEnabled && autoContext && autoContext.uri && !autoDismissed) {
      files.push({ uri: autoContext.uri, name: autoContext.name });
      seen.add(autoContext.uri);
    }
    for (const c of chips) {
      if (!seen.has(c.uri)) {
        files.push({ uri: c.uri, name: c.name });
        seen.add(c.uri);
      }
    }
    if (!text && !files.length) return;
    vscode.postMessage({ type: 'send', text: text, files: files });
    inputEl.value = '';
    autoSize();
    chips = [];
    renderChips();
    setBusy(true);
    // The reader asked for this turn, so follow it from wherever they had
    // scrolled to — the reply is what they are waiting on.
    scrollToBottom(true);
  }

  function setStatus(status, detail) {
    const labels = { connecting: 'Connecting…', ready: 'Ready', error: 'Error', disconnected: 'Disconnected' };
    statusEl.textContent = detail ? (labels[status] || status) + ' — ' + detail : labels[status] || status || '';
    statusEl.className = 'status' + (status === 'error' || status === 'disconnected' ? ' error' : '');
  }

  // -------------------------------------------------- interruptions (asks)

  function card(body) {
    const el = document.createElement('div');
    el.className = 'card';
    body.appendChild(el);
    return el;
  }

  function cardLines(el, lines) {
    for (const line of lines) {
      if (!line) continue;
      const d = document.createElement('div');
      d.className = 'card-detail';
      d.textContent = line;
      el.appendChild(d);
    }
  }

  /** Replace a card's actions with the decision that was taken. */
  function settleCard(itemEl, note) {
    if (!itemEl) return;
    const actions = itemEl.querySelector('.card-actions');
    if (actions) {
      actions.innerHTML = '';
      const done = document.createElement('div');
      done.className = 'card-settled';
      done.textContent = note;
      actions.appendChild(done);
    }
    itemEl.classList.remove('pending');
    itemEl.classList.add('settled');
  }

  /**
   * A permission request. `msg.auto` marks one Autopilot has already approved:
   * it is shown the same way but settled, with no buttons — an approval made on
   * your behalf stays on the record rather than being silently swallowed.
   */
  function addPermissionCard(msg) {
    const auto = msg.auto === true;
    hideThinking();
    // Green is the settled "it happened" colour, amber the one still waiting.
    const { el, body } = addRow(auto ? 'dot-success' : 'dot-warning');
    const c = card(body);
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = msg.action || 'Permission required';
    c.appendChild(title);
    cardLines(c, [
      msg.resources && msg.resources.length ? msg.resources.join('\n') : '',
      msg.tool ? 'tool: ' + msg.tool : '',
      // Autopilot answers `once`, so nothing is being remembered on its behalf.
      !auto && msg.save && msg.save.length
        ? '"Always allow" will remember: ' + msg.save.join(', ')
        : ''
    ]);

    if (auto) {
      el.classList.add('settled');
      const note = document.createElement('div');
      note.className = 'card-settled';
      note.textContent = 'Autopilot approved';
      c.appendChild(note);
      scrollToBottom();
      return;
    }

    const row = document.createElement('div');
    row.className = 'card-actions';
    const choices = [
      ['once', 'Allow once'],
      ['always', 'Always allow'],
      ['reject', 'Deny']
    ];
    choices.forEach(([decision, label], i) => {
      const b = document.createElement('button');
      b.textContent = (i + 1) + '. ' + label;
      if (decision === 'reject') b.className = 'secondary';
      b.addEventListener('click', () => answerPermission(el, msg.requestId, decision, label));
      row.appendChild(b);
    });
    c.appendChild(row);

    el.classList.add('pending');
    pendingPermission = { el, requestId: msg.requestId };
    // The turn is blocked until this is answered, so it must be seen.
    scrollToBottom(true);
  }

  function answerPermission(el, requestId, decision, label) {
    vscode.postMessage({ type: 'perm', requestId, decision });
    settleCard(el, 'You chose: ' + label);
    if (pendingPermission && pendingPermission.el === el) pendingPermission = null;
  }

  function closePermissionCard(requestId, reply) {
    if (!pendingPermission) return;
    if (requestId && pendingPermission.requestId !== requestId) return;
    const label = { once: 'Allowed once', always: 'Always allowed', reject: 'Denied' }[reply] || 'Answered';
    settleCard(pendingPermission.el, label);
    pendingPermission = null;
  }

  /** One selectable option: a radio or checkbox, its label, and its description. */
  function optionRow(option, multi, onPick) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'option';
    const mark = document.createElement('span');
    mark.className = 'option-mark ' + (multi ? 'checkbox' : 'radio');
    const content = document.createElement('span');
    content.className = 'option-content';
    const label = document.createElement('span');
    label.className = 'option-label';
    label.textContent = option.label;
    content.appendChild(label);
    if (option.description) {
      const desc = document.createElement('span');
      desc.className = 'option-description';
      desc.textContent = option.description;
      content.appendChild(desc);
    }
    row.appendChild(mark);
    row.appendChild(content);
    row.addEventListener('click', () => onPick());
    return { row, mark };
  }

  function addFormCard(form) {
    hideThinking();
    const { el, body } = addRow('dot-warning');
    const c = card(body);

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = form.title || form.name || 'OpenCode needs your input';
    c.appendChild(title);
    cardLines(c, [form.description || form.message || '']);

    // What Submit will send. The server reads a `questions` list positionally —
    // `answer.q0`, `answer.q1`, each holding the picked option labels — while a
    // keyed `fields` map is answered by its own keys.
    const answers = [];

    const questions = Array.isArray(form.questions) ? form.questions : null;
    if (questions && questions.length) {
      questions.forEach((q, index) => {
        const block = document.createElement('div');
        block.className = 'question-block';
        const head = document.createElement('div');
        head.className = 'question-header';
        if (q.header) {
          const h = document.createElement('div');
          h.className = 'question-header-label';
          h.textContent = q.header;
          head.appendChild(h);
        }
        const text = document.createElement('div');
        text.className = 'question-text';
        text.textContent = q.question || q.title || `Question ${index + 1}`;
        head.appendChild(text);
        block.appendChild(head);

        const options = (Array.isArray(q.options) ? q.options : []).filter((o) => o && typeof o.label === 'string');
        const multi = !!(q.multiSelect || q.multiple);

        if (options.length) {
          const list = document.createElement('div');
          list.className = 'options-container';
          const picked = new Set();
          const marks = [];
          const paint = () => {
            for (const m of marks) {
              const on = picked.has(m.label);
              m.row.classList.toggle('selected', on);
              m.mark.classList.toggle('on', on);
              m.mark.innerHTML = on ? (multi ? ICON_CHECK : '<span class="option-dot"></span>') : '';
              m.row.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
          };
          for (const o of options) {
            const made = optionRow(o, multi, () => {
              if (multi) {
                if (picked.has(o.label)) picked.delete(o.label);
                else picked.add(o.label);
              } else {
                picked.clear();
                picked.add(o.label);
              }
              paint();
            });
            marks.push({ row: made.row, mark: made.mark, label: o.label });
            list.appendChild(made.row);
          }
          block.appendChild(list);
          paint();
          answers.push({ key: `q${index}`, read: () => [...picked] });
        } else {
          // A question with no options is answered in words.
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'other-input';
          input.placeholder = q.placeholder || 'Type your answer';
          block.appendChild(input);
          answers.push({ key: `q${index}`, read: () => (input.value.trim() ? [input.value.trim()] : []) });
        }
        c.appendChild(block);
      });
    } else {
      const raw = form.fields || [];
      const fields = Array.isArray(raw) ? raw : Object.keys(raw).map((k) => ({ key: k, ...(raw[k] || {}) }));
      for (const f of fields) {
        const key = f.key || f.name || f.id || 'value';
        const wrap = document.createElement('label');
        wrap.className = 'card-field';
        const lbl = document.createElement('span');
        lbl.className = 'card-field-label';
        lbl.textContent = f.title || f.label || key;
        wrap.appendChild(lbl);

        const type = String(f.type || 'string').toLowerCase();
        const opts = Array.isArray(f.options) ? f.options : [];
        if (type === 'boolean') {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          wrap.appendChild(cb);
          answers.push({ key, read: () => !!cb.checked });
        } else if (opts.length) {
          const select = document.createElement('select');
          if (type === 'multiselect') select.multiple = true;
          for (const o of opts) {
            const opt = document.createElement('option');
            opt.value = String(o && typeof o === 'object' ? o.value ?? o.id ?? o.label : o);
            opt.textContent = String(o && typeof o === 'object' ? o.label ?? o.title ?? o.value ?? o.id : o);
            select.appendChild(opt);
          }
          wrap.appendChild(select);
          answers.push({
            key,
            read: () => (type === 'multiselect' ? Array.from(select.selectedOptions).map((o) => o.value) : select.value)
          });
        } else {
          const input = document.createElement('input');
          input.type = 'text';
          input.placeholder = f.placeholder || '';
          wrap.appendChild(input);
          answers.push({ key, read: () => input.value });
        }
        c.appendChild(wrap);
      }
    }

    const row = document.createElement('div');
    row.className = 'card-actions';

    const submit = document.createElement('button');
    submit.textContent = 'Submit';
    submit.addEventListener('click', () => {
      const answer = {};
      for (const a of answers) answer[a.key] = a.read();
      vscode.postMessage({ type: 'formReply', formId: form.id, answer });
      settleCard(el, 'Answer submitted');
    });
    row.appendChild(submit);

    const skip = document.createElement('button');
    skip.className = 'secondary';
    skip.textContent = 'Skip';
    skip.addEventListener('click', () => {
      vscode.postMessage({ type: 'formCancel', formId: form.id, message: 'Not answered' });
      settleCard(el, 'Skipped');
    });
    row.appendChild(skip);

    c.appendChild(row);
    el.dataset.formId = form.id || '';
    el.classList.add('pending');
    // The turn waits on the answer, so the question must be seen.
    scrollToBottom(true);
  }

  // --------------------------------------------------------------------- events

  window.addEventListener('message', function (event) {
    const msg = event.data || {};
    switch (msg.type) {
      case 'context': {
        const next = msg.context || null;
        const prevUri = autoContext && autoContext.uri;
        const nextUri = next && next.uri;
        if (nextUri !== prevUri) autoDismissed = false;
        if (typeof msg.auto === 'boolean') autoEnabled = msg.auto;
        autoContext = next;
        renderChips();
        break;
      }
      case 'autopilot':
        autopilot = msg.on === true;
        renderAutopilot();
        break;
      case 'stage':
        stage(msg.attachment);
        break;
      case 'user-message':
        // Keep the thinking indicator: the turn is only just starting here.
        addUserMessage(msg.text, msg.files);
        break;
      case 'response-start':
        // Arrives before any text, so the bubble can be stamped with the time
        // the response actually began rather than when the first token landed.
        if (msg.messageID) responseStarts.set(msg.messageID, msg.at || Date.now());
        break;
      case 'delta': {
        if (msg.hidden) break;
        hideThinking();
        const rec = ensureTurn(msg.messageID, msg.at);
        const part = textPart(rec, msg.partID);
        part.text += msg.text;
        scheduleRender(rec);
        break;
      }
      case 'part': {
        if (msg.hidden) break;
        const rec = ensureTurn(msg.messageID, msg.at);
        textPart(rec, msg.partID).text = msg.text;
        scheduleRender(rec);
        break;
      }
      case 'reasoning-start':
        if (msg.hidden) break;
        // The disclosure opens as soon as the model starts thinking, so it is
        // visible while it streams rather than only once it lands.
        hideThinking();
        reasoningPart(ensureTurn(msg.messageID, msg.at), msg.partID);
        scrollToBottom();
        break;
      case 'reasoning-delta': {
        if (msg.hidden) break;
        const rec = ensureTurn(msg.messageID, msg.at);
        const part = reasoningPart(rec, msg.partID);
        part.text += msg.text;
        scheduleRender(rec);
        break;
      }
      case 'reasoning-end': {
        if (msg.hidden) break;
        const rec = ensureTurn(msg.messageID, msg.at);
        const part = reasoningPart(rec, msg.partID);
        if (msg.text) part.text = msg.text;
        finishReasoning(part, msg.ms);
        scheduleRender(rec);
        break;
      }
      case 'tool':
        // Tools run while the agent is still working, so keep thinking visible.
        addTool(msg);
        break;
      case 'transcript':
        clearMessages();
        for (const m of msg.messages || []) {
          if (m.role === 'user') {
            addUserMessage(m.text, m.files, m.at);
          } else {
            const rec = ensureTurn(m.id, m.at);
            renderBlocks(rec, m);
            // A restored turn is finished by definition, so anything renderBlocks
            // left working settles here rather than blinking.
            for (const row of rec.rows) settleRow(row);
          }
        }
        // One set of actions per turn, under its last message that has prose —
        // where the live path puts them too. Adding them per message put copy
        // and bookmark buttons under every paragraph.
        for (const { rec, text } of lastTextPerTurn()) ensureActions(rec, text);
        // Land on the newest turn. Scrolling twice covers late layout shifts
        // (markdown, wrapped code blocks) that change the final height.
        scrollToBottom();
        requestAnimationFrame(() => scrollToBottom());
        break;
      case 'turn-start':
        // Authoritative: the server began an execution (a queued prompt gets
        // its own), which keeps the busy state right across several prompts.
        setBusy(true);
        break;
      case 'turn-end':
        finishTurn();
        break;
      case 'error':
        addError(msg.message || 'Unknown error');
        setBusy(false);
        break;
      case 'permission':
        addPermissionCard(msg);
        break;
      case 'permission-closed':
        closePermissionCard(msg.requestId, msg.reply);
        break;
      case 'form':
        addFormCard(msg.form || {});
        break;
      case 'form-closed': {
        const el = messagesEl.querySelector('[data-form-id="' + String(msg.formId || '').replace(/"/g, '') + '"]');
        if (el) settleCard(el, 'Closed');
        break;
      }
      case 'models':
        fillModels(msg.models, msg.selected || msg.default);
        break;
      case 'agent-options':
        fillAgents(msg.agents);
        break;
      case 'selection':
        // A restored or switched session's own agent/model, which may differ
        // from whatever the composer was last showing. A session that has set
        // neither falls back to "build" and the configured model, which is what
        // its next prompt will actually use.
        selectedAgent = msg.agent || (agentOptions[0] && agentOptions[0].id) || selectedAgent;
        fillAgents(agentOptions);
        if (msg.model && msg.model.id) {
          selectedModel = { id: msg.model.id, providerID: msg.model.providerID };
          selectedVariant = msg.model.variant || null;
          modelLabel.textContent = modelLabelFor(selectedModel);
          renderVariantLabel();
        }
        break;
      case 'bookmarks':
        bookmarkItems = msg.items || [];
        bookmarkedIds = new Set(bookmarkItems.map((b) => b.messageId));
        for (const rec of turns.values()) applyBookmark(rec);
        renderBookmarks();
        break;
      case 'focus-message':
        focusMessage(msg.messageId);
        break;
      case 'agents':
        agentState = { main: msg.main || null, items: msg.items || [], running: !!msg.running };
        renderAgents();
        break;
      case 'session-title':
        setSessionTitle(msg.title || '');
        break;
      case 'status':
        setStatus(msg.status, msg.detail);
        break;
      case 'sessions':
        sessions = msg.sessions || [];
        currentSession = msg.current || null;
        renderSessions();
        break;
      case 'clear':
        clearMessages();
        chips = [];
        pendingPermission = null;
        closePickers();
        setBusy(false);
        renderChips();
        break;
      default:
        break;
    }
  });

  sessionTitleEl.addEventListener('click', startRenaming);
  sessionTitleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      startRenaming();
    }
  });

  sendBtn.addEventListener('click', () => {
    // Stop only while a turn is running with an empty prompt; otherwise send.
    if (busy && inputEl.value.trim().length === 0) vscode.postMessage({ type: 'interrupt' });
    else send();
  });

  agentBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAgentMenu();
  });

  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelMenu();
  });

  variantBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleVariantMenu();
  });

  agentsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAgents();
  });

  btnNew.addEventListener('click', () => {
    closePanels();
    vscode.postMessage({ type: 'newSession' });
  });

  btnHistory.addEventListener('click', () => {
    const isHidden = sessionsEl.classList.toggle('hidden');
    if (!isHidden) {
      closePanels('sessions');
      sessionFilter = '';
      sessionsSearchEl.value = '';
      renderSessions();
      sessionsSearchEl.focus();
      vscode.postMessage({ type: 'listSessions' });
    }
  });

  btnBookmarks.addEventListener('click', () => {
    const isHidden = bookmarksEl.classList.toggle('hidden');
    if (!isHidden) {
      closePanels('bookmarks');
      bookmarkFilter = '';
      bookmarksSearchEl.value = '';
      renderBookmarks();
      bookmarksSearchEl.focus();
      vscode.postMessage({ type: 'listBookmarks' });
    }
  });

  sessionsSearchEl.addEventListener('input', () => {
    sessionFilter = sessionsSearchEl.value;
    renderSessions();
  });

  bookmarksSearchEl.addEventListener('input', () => {
    bookmarkFilter = bookmarksSearchEl.value;
    renderBookmarks();
  });

  document.addEventListener('click', (e) => {
    // Any click outside an open picker's menu or button closes it.
    for (const p of PICKERS) {
      if (p.menu.classList.contains('hidden')) continue;
      if (e.target.closest('#' + p.menu.id) || e.target.closest('#' + p.btn.id)) continue;
      closePickers();
      break;
    }
    // Same for the overlays, each with the title-bar button that toggles it.
    for (const p of PANELS) {
      if (p.el.classList.contains('hidden')) continue;
      if (e.target.closest('#' + p.el.id) || e.target.closest('#' + p.btn)) continue;
      closePanels();
      break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePickers();
      closePanels();
      return;
    }
    // Claude Code style: 1/2/3 answer a pending permission prompt, unless the
    // user is typing into a field.
    if (pendingPermission && /^[123]$/.test(e.key)) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      const decision = { '1': 'once', '2': 'always', '3': 'reject' }[e.key];
      const label = { once: 'Allow once', always: 'Always allow', reject: 'Deny' }[decision];
      const target = pendingPermission;
      answerPermission(target.el, target.requestId, decision, label);
    }
  });

  inputEl.addEventListener('input', () => {
    autoSize();
    updateSendButton();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Sending while a turn runs is allowed: the server queues the prompt and
      // runs it after the current turn. Stop (the button) cancels instead.
      send();
    }
  });

  messagesEl.addEventListener('click', (e) => {
    const act = e.target.closest('.act');
    if (act) {
      const row = act.closest('.actions');
      const text = (row && row.dataset.text) || '';
      if (act.dataset.act === 'copy') {
        vscode.postMessage({ type: 'copyText', text: text });
      } else {
        vscode.postMessage({ type: 'toggleBookmark', messageId: row.dataset.messageId, text: text });
      }
      return;
    }

    const link = e.target.closest('a[data-path], a[data-url]');
    if (!link) return;
    e.preventDefault();
    if (link.dataset.url) {
      vscode.postMessage({ type: 'openExternal', url: link.dataset.url });
    } else {
      vscode.postMessage({
        type: 'open',
        path: link.dataset.path,
        line: parseInt(link.dataset.line, 10) || 0,
        col: parseInt(link.dataset.col, 10) || 0,
        endLine: parseInt(link.dataset.endLine, 10) || 0
      });
    }
  });

  // Drag files from the Explorer (or anywhere) to add them as references.
  function readUris(dt) {
    const out = new Set();
    if (!dt) return [];
    const list = dt.getData('text/uri-list') || dt.getData('application/vnd.code.uri-list') || '';
    for (const line of list.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) out.add(t);
    }
    if (!out.size) {
      const text = dt.getData('text/plain') || '';
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t && (/^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('/') || t.startsWith('file:'))) out.add(t);
      }
    }
    return Array.from(out);
  }

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    dropzone.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropzone.classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.add('hidden');
    const uris = readUris(e.dataTransfer);
    if (uris.length) vscode.postMessage({ type: 'addUris', uris: uris });
  });

  autoSize();
  renderChips();
  renderAgents();
  setSessionTitle('');
  updateSendButton();
  vscode.postMessage({ type: 'ready' });
})();
