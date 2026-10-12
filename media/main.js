(function () {
  const vscode = acquireVsCodeApi();

  const sessionTitleEl = document.getElementById('session-title');
  const messagesEl = document.getElementById('messages');
  const chipsEl = document.getElementById('chips');
  const inputEl = document.getElementById('input');
  const modelBtn = document.getElementById('model-btn');
  const modelLabel = document.getElementById('model-label');
  const modelMenu = document.getElementById('model-menu');
  const agentsBtn = document.getElementById('agents-btn');
  const agentsDot = document.getElementById('agents-dot');
  const agentsLabel = document.getElementById('agents-label');
  const agentsPanel = document.getElementById('agents-panel');
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

  let autoContext = null;
  let autoEnabled = true;
  let autoDismissed = false;
  let chips = [];
  let sessions = [];
  let currentSession = null;
  let models = [];
  let selectedModel = null;
  let busy = false;
  let thinking = null;
  let thinkingTimer = null;
  let thinkingIndex = 0;
  let runningTools = [];
  let bookmarkItems = [];
  let bookmarkedIds = new Set();
  let sessionFilter = '';
  let bookmarkFilter = '';
  let lastDateKey = null; // last day divider emitted
  const responseStarts = new Map(); // assistantMessageID -> start time
  let pendingPermission = null; // { el, requestId } while an approval is unanswered
  let agentState = { main: null, items: [], running: false };
  const bubbles = new Map(); // messageID -> record
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

  function atBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  }

  function scrollToBottom(force) {
    if (force || atBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ------------------------------------------------------------------- timeline

  /**
   * Emit a `~~~~~~ 2026-10-11 ~~~~~~` divider whenever the day changes, so a
   * restored session spanning several days reads in order.
   */
  function ensureDateSeparator(at) {
    const key = formatDate(at);
    if (key === lastDateKey) return;
    lastDateKey = key;
    const el = document.createElement('div');
    el.className = 'tl-date';
    el.textContent = dateLabel(at);
    messagesEl.appendChild(el);
    if (thinking) messagesEl.appendChild(thinking.el);
  }

  function timeLine(at) {
    const el = document.createElement('div');
    el.className = 'tl-time';
    el.textContent = formatTime(at);
    return el;
  }

  function addItem(kind, at) {
    ensureDateSeparator(at || Date.now());
    const el = document.createElement('div');
    el.className = 'tl kind-' + kind;
    const dot = document.createElement('span');
    dot.className = 'tl-dot';
    const body = document.createElement('div');
    body.className = 'tl-body';
    el.appendChild(dot);
    el.appendChild(body);
    messagesEl.appendChild(el);
    // Keep the thinking row pinned to the bottom as new entries stream in.
    if (thinking) messagesEl.appendChild(thinking.el);
    return { el, body };
  }

  function ensureBubble(id, kind, at) {
    const key = id || 'assistant';
    if (bubbles.has(key)) return bubbles.get(key);
    const when = at || responseStarts.get(key) || Date.now();
    responseStarts.delete(key);
    const { el, body } = addItem(kind || 'assistant', when);
    el.dataset.messageId = key;
    body.appendChild(timeLine(when));
    const textEl = document.createElement('div');
    textEl.className = 'tl-text md';
    body.appendChild(textEl);
    const rec = { id: key, el, body, textEl, parts: new Map(), raw: '', actions: null };
    bubbles.set(key, rec);
    return rec;
  }

  function renderBubble(rec) {
    let out = '';
    for (const part of rec.parts.values()) out += part.text;
    rec.raw = out;
    rec.textEl.innerHTML = renderMarkdown(out);
  }

  function scheduleRender(rec) {
    pendingRender.add(rec);
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      for (const r of pendingRender) renderBubble(r);
      pendingRender.clear();
      scrollToBottom(false);
    });
  }

  function ensureActions(rec, text) {
    if (rec.actions) {
      rec.actions.dataset.text = text;
      return;
    }
    const row = document.createElement('div');
    row.className = 'tl-actions';
    row.dataset.text = text;
    row.dataset.messageId = rec.id;
    row.innerHTML =
      '<button class="act" data-act="copy" title="Copy response" aria-label="Copy response">' +
      ICON_COPY +
      '</button>' +
      '<button class="act" data-act="bookmark" title="Bookmark response" aria-label="Bookmark response">' +
      ICON_BOOKMARK +
      '</button>';
    rec.body.appendChild(row);
    rec.actions = row;
    applyBookmark(rec);
  }

  function applyBookmark(rec) {
    if (!rec.actions) return;
    const btn = rec.actions.querySelector('[data-act="bookmark"]');
    if (btn) btn.classList.toggle('on', bookmarkedIds.has(rec.actions.dataset.messageId));
  }

  function addUserMessage(text, files, at) {
    const { body } = addItem('user', at);
    body.appendChild(timeLine(at || Date.now()));
    const t = document.createElement('div');
    t.className = 'tl-text plain';
    t.textContent = text || '(attachment only)';
    body.appendChild(t);
    if (files && files.length) {
      const f = document.createElement('div');
      f.className = 'tl-files';
      f.textContent = files.map((x) => x.name || x.uri).join(', ');
      body.appendChild(f);
    }
    scrollToBottom(true);
  }

  function addError(message) {
    hideThinking();
    const { body } = addItem('error');
    const t = document.createElement('div');
    t.className = 'tl-text plain';
    t.textContent = message;
    body.appendChild(t);
    scrollToBottom(true);
  }

  /** Build one tool row: name, what it is doing, and its state. */
  function toolRow(name, detail, state) {
    const { el, body } = addItem('tool tool-running');
    const inner = document.createElement('div');
    inner.className = 'tl-tool';
    const n = document.createElement('span');
    n.className = 'tool-name';
    n.textContent = name;
    const d = document.createElement('span');
    d.className = 'tool-detail';
    d.textContent = detail || '';
    const s = document.createElement('span');
    s.className = 'tool-state';
    s.textContent = state || 'running…';
    inner.appendChild(n);
    inner.appendChild(d);
    inner.appendChild(s);
    body.appendChild(inner);
    return { el, stateEl: s, detailEl: d, name, id: null };
  }

  function addTool(msg) {
    const name = msg.name || 'tool';
    let row = null;

    if (msg.state === 'running') {
      row = toolRow(name, msg.detail, 'running…');
      row.id = msg.id;
      runningTools.push(row);
    } else {
      row =
        (msg.id && runningTools.find((r) => r.id === msg.id)) ||
        runningTools.find((r) => r.name === name) ||
        runningTools[runningTools.length - 1] ||
        null;
      if (row) runningTools = runningTools.filter((r) => r !== row);
      if (!row) row = toolRow(name, msg.detail, '');
    }

    const ok = msg.state === 'ok';
    const bad = msg.state === 'error';
    row.el.className = 'tl kind-tool' + (ok ? ' tool-ok' : bad ? ' tool-error' : ' tool-running');
    row.stateEl.textContent = ok ? 'done' : bad ? 'failed' : 'running…';
    if (bad && msg.error && row.detailEl) row.detailEl.textContent = msg.error;
    scrollToBottom(false);
  }

  function clearMessages() {
    messagesEl.innerHTML = '';
    bubbles.clear();
    runningTools = [];
    thinking = null;
    pendingPermission = null;
    lastDateKey = null;
    responseStarts.clear();
    pendingRender.clear();
  }

  // --------------------------------------------------------------- busy/thinking

  function paintWord(animate) {
    const el = thinking && thinking.inner.querySelector('.thinking-word');
    if (!el) return;
    el.textContent = THINKING_WORDS[thinkingIndex];
    if (animate) {
      el.classList.remove('swap');
      void el.offsetWidth;
      el.classList.add('swap');
    }
  }

  function showThinking() {
    if (thinking) return;
    thinkingIndex = Math.floor(Math.random() * THINKING_WORDS.length);
    const { el, body } = addItem('thinking');
    const inner = document.createElement('div');
    inner.className = 'tl-thinking';
    inner.innerHTML =
      '<span class="dots"><i></i><i></i><i></i></span><span class="thinking-word"></span><span class="thinking-ellipsis">…</span>';
    body.appendChild(inner);
    thinking = { el, inner };
    paintWord(false);
    thinkingTimer = setInterval(() => {
      thinkingIndex = (thinkingIndex + 1) % THINKING_WORDS.length;
      paintWord(true);
    }, 1700);
    scrollToBottom(false);
  }

  function hideThinking() {
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
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

  function lastAssistantRec() {
    const ids = Array.from(bubbles.keys());
    for (let i = ids.length - 1; i >= 0; i--) {
      const rec = bubbles.get(ids[i]);
      if (rec && rec.el.classList.contains('kind-assistant')) return rec;
    }
    return null;
  }

  function finishTurn() {
    const rec = lastAssistantRec();
    if (rec && rec.raw) ensureActions(rec, rec.raw);
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

  // -------------------------------------------------------------- model picker

  function isCurrent(m) {
    return !!selectedModel && selectedModel.id === m.id && selectedModel.providerID === m.providerID;
  }

  function renderModelMenu() {
    modelMenu.innerHTML = '';
    if (!models.length) {
      const empty = document.createElement('div');
      empty.className = 'model-empty';
      empty.textContent = 'No models reported by the server.';
      modelMenu.appendChild(empty);
      return;
    }
    for (const m of models) {
      const item = document.createElement('div');
      item.className = 'model-item' + (isCurrent(m) ? ' current' : '');
      const name = document.createElement('span');
      name.className = 'model-name';
      name.textContent = m.name || m.id;
      const prov = document.createElement('span');
      prov.className = 'model-prov';
      prov.textContent = m.providerID;
      const check = document.createElement('span');
      check.className = 'model-check';
      check.textContent = '✓';
      item.appendChild(name);
      item.appendChild(prov);
      item.appendChild(check);
      item.addEventListener('click', () => {
        selectedModel = { id: m.id, providerID: m.providerID };
        modelLabel.textContent = m.name || m.id;
        closeModelMenu();
        vscode.postMessage({ type: 'setModel', ref: selectedModel });
      });
      modelMenu.appendChild(item);
    }
  }

  function closeModelMenu() {
    modelMenu.classList.add('hidden');
    modelBtn.classList.remove('open');
  }

  function toggleModelMenu() {
    if (modelMenu.classList.contains('hidden')) {
      closeAgents();
      renderModelMenu();
      modelMenu.classList.remove('hidden');
      modelBtn.classList.add('open');
      vscode.postMessage({ type: 'listModels' });
    } else {
      closeModelMenu();
    }
  }

  function fillModels(list, selected) {
    models = list || [];
    if (selected && selected.id) selectedModel = { id: selected.id, providerID: selected.providerID };
    const cur = models.find(isCurrent);
    modelLabel.textContent = cur ? cur.name || cur.id : selectedModel ? selectedModel.id : 'Model';
    if (!modelMenu.classList.contains('hidden')) renderModelMenu();
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
    if (agentsPanel.classList.contains('hidden')) {
      closeModelMenu();
      renderAgents();
      agentsPanel.classList.remove('hidden');
      agentsBtn.classList.add('open');
    } else {
      closeAgents();
    }
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

  function addPermissionCard(msg) {
    hideThinking();
    const { el, body } = addItem('permission');
    const c = card(body);
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = msg.action || 'Permission required';
    c.appendChild(title);
    cardLines(c, [
      msg.resources && msg.resources.length ? msg.resources.join('\n') : '',
      msg.tool ? 'tool: ' + msg.tool : '',
      msg.save && msg.save.length ? '"Always allow" will remember: ' + msg.save.join(', ') : ''
    ]);

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

  function addFormCard(form) {
    hideThinking();
    const { el, body } = addItem('form');
    const c = card(body);

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = form.title || form.name || 'OpenCode needs your input';
    c.appendChild(title);
    cardLines(c, [form.description || form.message || '']);

    // Fields: an array or a map, each { key|name|id, type, title|label, options }.
    const raw = form.fields || form.questions || [];
    const fields = Array.isArray(raw) ? raw : Object.keys(raw).map((k) => ({ key: k, ...(raw[k] || {}) }));

    const inputs = [];
    for (const f of fields) {
      const key = f.key || f.name || f.id || 'value';
      const wrap = document.createElement('label');
      wrap.className = 'card-field';
      const lbl = document.createElement('span');
      lbl.className = 'card-field-label';
      lbl.textContent = f.title || f.label || key;
      wrap.appendChild(lbl);

      const type = String(f.type || 'string').toLowerCase();
      const options = Array.isArray(f.options) ? f.options : [];
      const optValue = (o) => (o && typeof o === 'object' ? o.value ?? o.id ?? o.label : o);
      const optLabel = (o) => (o && typeof o === 'object' ? o.label ?? o.title ?? o.value ?? o.id : o);

      if (type === 'multiselect' || type === 'select' || options.length) {
        const multi = type === 'multiselect';
        const control = multi || type === 'select' ? document.createElement('select') : document.createElement('div');
        if (multi) control.multiple = true;
        const target = control.tagName === 'SELECT' ? control : control;
        for (const o of options) {
          const opt = document.createElement('option');
          opt.value = String(optValue(o));
          opt.textContent = String(optLabel(o));
          target.appendChild(opt);
        }
        wrap.appendChild(target);
        inputs.push({ key, type: multi ? 'multiselect' : 'select', el: target });
      } else if (type === 'boolean') {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        wrap.appendChild(cb);
        inputs.push({ key, type: 'boolean', el: cb });
      } else {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = f.placeholder || '';
        wrap.appendChild(inp);
        inputs.push({ key, type: 'string', el: inp });
      }
      c.appendChild(wrap);
    }

    const row = document.createElement('div');
    row.className = 'card-actions';

    const submit = document.createElement('button');
    submit.textContent = 'Submit';
    submit.addEventListener('click', () => {
      const answer = {};
      for (const i of inputs) {
        if (i.type === 'boolean') answer[i.key] = !!i.el.checked;
        else if (i.type === 'multiselect') answer[i.key] = Array.from(i.el.selectedOptions).map((o) => o.value);
        else answer[i.key] = i.el.value;
      }
      vscode.postMessage({ type: 'formReply', formId: form.id, answer: answer });
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
        hideThinking();
        const rec = ensureBubble(msg.messageID, 'assistant', msg.at);
        const part = rec.parts.get(msg.partID) || { text: '', delta: false };
        part.text += msg.text;
        part.delta = true;
        rec.parts.set(msg.partID, part);
        scheduleRender(rec);
        break;
      }
      case 'part': {
        const rec = ensureBubble(msg.messageID, 'assistant', msg.at);
        rec.parts.set(msg.partID, { text: msg.text, delta: false });
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
            const rec = ensureBubble(m.id, 'assistant', m.at);
            rec.parts.set('text', { text: m.text, delta: false });
            renderBubble(rec);
            ensureActions(rec, m.text);
          }
        }
        // Land on the newest turn. Scrolling twice covers late layout shifts
        // (markdown, wrapped code blocks) that change the final height.
        scrollToBottom(true);
        requestAnimationFrame(() => scrollToBottom(true));
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
      case 'bookmarks':
        bookmarkItems = msg.items || [];
        bookmarkedIds = new Set(bookmarkItems.map((b) => b.messageId));
        for (const rec of bubbles.values()) applyBookmark(rec);
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
        closeModelMenu();
        closeAgents();
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

  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelMenu();
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
    if (!modelMenu.classList.contains('hidden') && !e.target.closest('#model-menu') && !e.target.closest('#model-btn')) {
      closeModelMenu();
    }
    if (!agentsPanel.classList.contains('hidden') && !e.target.closest('#agents-panel') && !e.target.closest('#agents-btn')) {
      closeAgents();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModelMenu();
      closeAgents();
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
      const row = act.closest('.tl-actions');
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
