'use strict';

const vscode = require('vscode');
const { pathToFileURL } = require('url');

const MAX_BYTES = 1024 * 1024;

/**
 * Describe the document in an editor, or null when it cannot be referenced
 * (untitled, non-file scheme, or too large).
 * @param {vscode.TextEditor|null|undefined} editor
 */
function describeEditor(editor) {
  if (!editor) return null;
  const doc = editor.document;
  if (!doc || doc.uri.scheme !== 'file' || doc.isUntitled) return null;
  if (doc.getText().length > MAX_BYTES) return null;
  const sel = editor.selection;
  const hasSelection = sel && !sel.isEmpty;
  return {
    fsPath: doc.uri.fsPath,
    relative: vscode.workspace.asRelativePath(doc.uri, false),
    languageId: doc.languageId,
    start: hasSelection ? sel.start.line + 1 : null,
    end: hasSelection ? sel.end.line + 1 : null
  };
}

/**
 * Turn a description into an opencode attachment: { uri, name }.
 * A selection becomes a one-based ?start=/&end= range on the file: URL.
 * @param {{fsPath:string,relative:string,start:number|null,end:number|null}} desc
 */
function toAttachment(desc) {
  const url = pathToFileURL(desc.fsPath);
  if (desc.start) {
    url.searchParams.set('start', String(desc.start));
    url.searchParams.set('end', String(desc.end || desc.start));
  }
  const label = desc.start ? `${desc.relative}:${desc.start}-${desc.end || desc.start}` : desc.relative;
  return { uri: url.href, name: label };
}

/**
 * Tracks the last editor the user was in. Focusing the webview clears
 * vscode.window.activeTextEditor, so we cache the last known editor and fall
 * back to the first visible one.
 */
class ActiveFileTracker {
  /** @param {(desc:ReturnType<typeof describeEditor>)=>void} onChange */
  constructor(onChange) {
    this.onChange = onChange;
    this.last = null;
    this.disposables = [];
  }

  init() {
    if (vscode.window.activeTextEditor) this.last = vscode.window.activeTextEditor;
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) this.last = e;
        this.emit();
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        this.last = e.textEditor;
        this.emit();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.last && e.document === this.last.document) this.emit();
      }),
      // Closing a tab changes the visible set; focusing the webview does not.
      vscode.window.onDidChangeVisibleTextEditors(() => this.emit())
    );
  }

  /**
   * The editor to use as context.
   *
   * Focusing the webview clears `activeTextEditor`, but the editor is still
   * ON SCREEN — so the cached editor is kept. Closing the editor also clears
   * `activeTextEditor`, but it leaves `visibleTextEditors` — so the cache is
   * only trusted while the document is still visible.
   */
  current() {
    const active = vscode.window.activeTextEditor;
    if (active) return active;
    const visible = vscode.window.visibleTextEditors;
    if (this.last) {
      const key = this.last.document.uri.toString();
      if (visible.some((e) => e.document.uri.toString() === key)) return this.last;
    }
    return visible[0] || null;
  }

  describe() {
    return describeEditor(this.current());
  }

  emit() {
    if (this.onChange) this.onChange(this.describe());
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

/**
 * Open a file referenced by the assistant. Bogus paths fail silently.
 * @param {{path:string,line?:number,col?:number,endLine?:number}} ref
 */
/**
 * Rescue a partially-written path — typically the tail of one whose parent
 * folder has a space ("Changes/x.txt" for "Database Changes/x.txt"). Searches
 * the workspace for a file ending with that path and opens the shortest match.
 */
async function findBySuffix(rawPath, isAbsolute) {
  if (isAbsolute) return null;
  if (/[*?[\]{}]/.test(rawPath)) return null; // not a safe glob
  const rel = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return null;
  try {
    const hits = await vscode.workspace.findFiles(`**/${rel}`, undefined, 10);
    if (!hits.length) return null;
    hits.sort((a, b) => a.path.length - b.path.length);
    const doc = await vscode.workspace.openTextDocument(hits[0]);
    vscode.window.setStatusBarMessage(
      `OpenCode: matched ${vscode.workspace.asRelativePath(hits[0], false)}`,
      4000
    );
    return doc;
  } catch {
    return null;
  }
}

async function openReference(ref) {
  if (!ref || !ref.path) return;
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(ref.path);
  let uri;
  if (isAbsolute) {
    uri = vscode.Uri.file(ref.path);
  } else {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!folder) return;
    uri = vscode.Uri.joinPath(folder.uri, ref.path.replace(/\\/g, '/'));
  }
  let doc;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    doc = await findBySuffix(ref.path, isAbsolute);
    if (!doc) {
      // Most likely a path the model invented; say so rather than doing nothing.
      vscode.window.setStatusBarMessage(`OpenCode: cannot open ${ref.path}`, 4000);
      return;
    }
  }
  // No line at all: just open the file, leaving the cursor where it was.
  const options = { preview: true };
  if (ref.line) {
    const line = Math.max(0, ref.line - 1);
    if (ref.endLine) {
      // A range highlights every line it spans.
      options.selection = new vscode.Range(line, 0, Math.max(line, ref.endLine - 1), Number.MAX_SAFE_INTEGER);
    } else if (ref.col) {
      // A column puts the caret there without selecting the line.
      const col = Math.max(0, ref.col - 1);
      options.selection = new vscode.Range(line, col, line, col);
    } else {
      // A single line highlights that whole line.
      options.selection = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
    }
  }
  await vscode.window.showTextDocument(doc, options);
}

module.exports = { describeEditor, toAttachment, ActiveFileTracker, openReference, MAX_BYTES };
