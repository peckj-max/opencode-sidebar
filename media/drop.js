/**
 * Reading a file drop, shared by the webview and the extension host.
 *
 * A drag from the Explorer reaches a webview with whatever the frame can read,
 * and that is rarely a path: Chromium keeps native file paths out of a sandboxed
 * frame, VS Code's own transfer types are often unreadable from inside it, and
 * `text/plain` carries a workspace-relative label rather than a URI. This module
 * turns each of those shapes into a candidate reference and resolves it, with no
 * DOM and no `vscode` dependency, so both sides agree on the answer and it can be
 * unit tested.
 *
 * Loaded as `OCDrop` in the webview and `require`d by the host.
 */
(function (root) {
  'use strict';

  /** Transfer types that mean "a file is being dragged"; plain text is not. */
  var DRAG_TYPES = [
    'files',
    'text/uri-list',
    'application/vnd.code.uri-list',
    'resourceurls',
    'codefiles'
  ];

  /** Candidates kept per drop: a drag of selected text can carry a whole page. */
  var MAX_CANDIDATES = 50;

  /**
   * Bounds on the fallback that reads a dropped file's bytes.
   *
   * A drag from outside VS Code gives the frame no path, only a `File`, so the
   * only way to honour it is to read the bytes and let the host stage a copy.
   * The limits have to clear a phone photo, since images are the common case;
   * they are still bounded so an accidental drop of a disk image cannot fill
   * memory. The bytes travel base64, so they cost about a third more on the wire.
   */
  var MAX_FILE_BYTES = 20 * 1024 * 1024;
  var MAX_TOTAL_BYTES = 60 * 1024 * 1024;
  var MAX_FILES = 20;

  function dragHasFiles(dt) {
    if (!dt) return false;
    var types = dt.types || [];
    for (var i = 0; i < types.length; i++) {
      if (DRAG_TYPES.indexOf(String(types[i]).toLowerCase()) >= 0) return true;
    }
    return false;
  }

  /**
   * What a candidate reference is.
   *
   * - `file-url`  a `file:` URL
   * - `absolute`  a native absolute path (drive letter, rooted, or UNC)
   * - `relative`  a workspace-relative label, which is what VS Code writes
   * - `other`     anything else with a scheme, e.g. `untitled:` or `https:`
   * - `none`      empty
   */
  function classify(raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return { kind: 'none', text: '' };
    // A drive letter reads as a URL scheme, so it is tested before one.
    if (/^[a-zA-Z]:[\\/]/.test(text)) return { kind: 'absolute', text: text };
    if (text.charAt(0) === '/' || text.slice(0, 2) === '\\\\') return { kind: 'absolute', text: text };
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) {
      return { kind: /^file:/i.test(text) ? 'file-url' : 'other', text: text };
    }
    return { kind: 'relative', text: text };
  }

  /** The segments of a label, split on either separator. */
  function segments(raw) {
    return String(raw == null ? '' : raw)
      .replace(/^\.\//, '')
      .split(/[\\/]+/)
      .filter(Boolean);
  }

  /** A folder path and label segments joined with `/`, which both sides accept. */
  function joinPath(folder, parts) {
    var base = String(folder == null ? '' : folder).replace(/[\\/]+$/, '');
    return base + '/' + parts.join('/');
  }

  /**
   * Every candidate reference a drop exposes, plus the transfer types and the
   * bare file names, so the host can say what actually arrived.
   *
   * @param {{types?:any[], files?:any[], getData:(type:string)=>string}} dt
   */
  function readDrop(dt) {
    if (!dt) return { uris: [], names: [], types: [] };
    var uris = [];
    var seen = Object.create(null);
    var names = [];

    function add(value) {
      var text = String(value == null ? '' : value).trim();
      if (!text || text.charAt(0) === '#' || seen[text] || uris.length >= MAX_CANDIDATES) return;
      seen[text] = true;
      uris.push(text);
    }

    function get(type) {
      try {
        return dt.getData(type) || '';
      } catch (e) {
        return '';
      }
    }

    function addLines(text) {
      var lines = String(text == null ? '' : text).split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) add(lines[i]);
    }

    // The full list VS Code writes for an in-window drag. `text/uri-list` is
    // capped at one URI by Chromium, so it is only a fallback.
    addLines(get('application/vnd.code.uri-list'));
    addLines(get('text/uri-list'));

    // The Explorer also sets the selected resources ("ResourceURLs") and, for
    // native paths, "CodeFiles"; either is enough when the list lost entries.
    ['ResourceURLs', 'CodeFiles'].forEach(function (type) {
      var raw = get(type);
      if (!raw) return;
      var parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }
      if (Array.isArray(parsed)) {
        for (var i = 0; i < parsed.length; i++) {
          if (typeof parsed[i] === 'string') add(parsed[i]);
        }
      } else {
        addLines(raw);
      }
    });

    // Chromium writes "<mime>:<name>:<url>" for the first file of a drag that
    // started outside the window — the one place an OS path survives.
    addLines(get('DownloadURL').split(/\r?\n/).map(function (line) {
      var parts = String(line).trim().split(':');
      return parts.length < 3 ? '' : parts.slice(2).join(':');
    }).join('\n'));

    // The labels VS Code writes, which are workspace-relative.
    addLines(get('text/plain'));

    var files = dt.files ? Array.prototype.slice.call(dt.files) : [];
    for (var f = 0; f < files.length; f++) {
      if (files[f] && files[f].name) names.push(String(files[f].name));
    }

    return { uris: uris, names: names, types: Array.from(dt.types || []) };
  }

  /**
   * A candidate as something openable: the `file:` URL or absolute path as it
   * stands, or a relative label resolved against the workspace folders.
   *
   * @param {string} raw
   * @param {Array<string|{fsPath?:string,uri?:{fsPath?:string}}>} folders
   * @param {(path:string)=>Promise<boolean>} exists
   * @returns {Promise<string|null>} a `file:` URL, an absolute path, or null
   */
  async function resolvePath(raw, folders, exists) {
    var found = classify(raw);
    if (found.kind === 'file-url' || found.kind === 'absolute') return found.text;
    if (found.kind !== 'relative') return null;
    var parts = segments(found.text);
    if (!parts.length) return null;
    var list = folders || [];
    for (var i = 0; i < list.length; i++) {
      var folder = typeof list[i] === 'string'
        ? list[i]
        : (list[i] && (list[i].fsPath || (list[i].uri && list[i].uri.fsPath))) || '';
      if (!folder) continue;
      var candidate = joinPath(folder, parts);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  /**
   * The shallowest of several matches, so a file name shared by many folders is
   * not resolved to an arbitrary deep copy.
   */
  function shallowest(matches) {
    var list = (matches || []).filter(Boolean).slice();
    list.sort(function (a, b) {
      var depthA = String(a).split(/[\\/]+/).length;
      var depthB = String(b).split(/[\\/]+/).length;
      return depthA - depthB || String(a).length - String(b).length;
    });
    return list.length ? list[0] : null;
  }

  /**
   * The `File` objects a drop carries, taken synchronously: a `DataTransfer`'s
   * contents stop being available once the event handler returns.
   *
   * @param {{files?:any}} dt
   * @returns {any[]}
   */
  function fileList(dt) {
    if (!dt || !dt.files) return [];
    return Array.prototype.slice.call(dt.files).filter(Boolean);
  }

  /** Base64, which survives a message to the host unchanged as text. */
  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return Buffer.from(bytes).toString('base64');
    }
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function toBytes(file) {
    if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
    // Older engines expose only `text()`; a text file is the common case here.
    if (typeof file.text === 'function') return new TextEncoder().encode(await file.text());
    throw new Error('not readable');
  }

  /**
   * The bytes of the dropped files, for the host to write out as a copy.
   *
   * @param {any[]} files
   * @param {{maxFileBytes?:number, maxTotalBytes?:number, maxFiles?:number}} [limits]
   * @returns {Promise<{entries:Array<{name:string,size:number,type:string,data:string}>, skipped:Array<{name:string,reason:string}>}>}
   */
  async function readFileData(files, limits) {
    var opts = limits || {};
    var maxFile = opts.maxFileBytes || MAX_FILE_BYTES;
    var maxTotal = opts.maxTotalBytes || MAX_TOTAL_BYTES;
    var maxFiles = opts.maxFiles || MAX_FILES;
    var list = files || [];
    var entries = [];
    var skipped = [];
    var total = 0;

    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      if (!file) continue;
      var name = String(file.name || 'dropped').trim() || 'dropped';
      if (entries.length >= maxFiles) {
        skipped.push({ name: name, reason: 'too many files' });
        continue;
      }
      // A folder dragged from the OS arrives as a zero-byte `File`; an empty
      // file would be staged as a context entry that says nothing.
      if (file.size === 0) {
        skipped.push({ name: name, reason: 'empty or a folder' });
        continue;
      }
      if (typeof file.size === 'number' && file.size > maxFile) {
        skipped.push({ name: name, reason: 'too large', size: file.size });
        continue;
      }
      if (total >= maxTotal) {
        skipped.push({ name: name, reason: 'too much data' });
        continue;
      }
      try {
        var bytes = await toBytes(file);
        if (!bytes.length) {
          skipped.push({ name: name, reason: 'empty' });
          continue;
        }
        if (total + bytes.length > maxTotal) {
          skipped.push({ name: name, reason: 'too much data' });
          continue;
        }
        total += bytes.length;
        entries.push({
          name: name,
          size: bytes.length,
          type: String(file.type || ''),
          data: toBase64(bytes)
        });
      } catch (e) {
        skipped.push({ name: name, reason: 'unreadable' });
      }
    }

    return { entries: entries, skipped: skipped };
  }

  var api = {
    DRAG_TYPES: DRAG_TYPES,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_FILES: MAX_FILES,
    MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
    classify: classify,
    dragHasFiles: dragHasFiles,
    fileList: fileList,
    joinPath: joinPath,
    readDrop: readDrop,
    readFileData: readFileData,
    resolvePath: resolvePath,
    segments: segments,
    shallowest: shallowest
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OCDrop = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
