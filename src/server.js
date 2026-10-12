'use strict';

const vscode = require('vscode');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXE_NAMES =
  process.platform === 'win32'
    ? ['opencode.exe', 'opencode-cli.exe', 'opencode.cmd', 'opencode.bat']
    : ['opencode'];

/** Endpoint file other opencode clients look up (the desktop app writes it too). */
const SERVICE_FILE = path.join(os.homedir(), '.config', 'opencode', 'service.json');

/**
 * Publish the server endpoint in the shape the desktop app writes:
 *   { "hostname": "127.0.0.1", "port": 4096, "password": "..." }
 * Two-space JSON with LF endings, matching the file already on disk — this is
 * opencode's own data file, not one of this project's CRLF sources.
 */
function writeServiceFile(values) {
  const dir = path.dirname(SERVICE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  // Replace atomically: another opencode client may read the file at any moment.
  const tmp = `${SERVICE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SERVICE_FILE);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the opencode CLI without hard-coding any machine's layout: search the
 * PATH, the usual install directories, and the desktop app's versioned
 * `cli/<version>/` folder (newest version first).
 * @returns {string[]} candidate executable paths, most likely first
 */
function findOpenCodeBinaries() {
  const found = [];
  const add = (p) => {
    if (p && isFile(p) && !found.includes(p)) found.push(p);
  };

  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of EXE_NAMES) add(path.join(dir, name));
  }

  const home = os.homedir();
  for (const dir of [
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cache', 'opencode', 'bin')
  ]) {
    for (const name of EXE_NAMES) add(path.join(dir, name));
  }

  if (process.env.APPDATA) {
    const root = path.join(process.env.APPDATA, 'ai.opencode.desktop', 'cli');
    let versions = [];
    try {
      versions = fs.readdirSync(root);
    } catch {
      /* desktop app not installed here */
    }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      for (const name of EXE_NAMES) add(path.join(root, version, name));
    }
  }

  return found;
}

/**
 * Passwords the opencode desktop app records for its own server. It stores one
 * in each of these files; both authenticate against a running instance.
 * Only read when we need to adopt an already-running server.
 */
function storedServiceCredentials() {
  const home = os.homedir();
  const files = [
    path.join(home, '.local', 'state', 'opencode', 'service.json'),
    path.join(home, '.config', 'opencode', 'service.json')
  ];
  const out = [];
  for (const file of files) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (json && typeof json.password === 'string' && json.password) {
        out.push({ file, password: json.password, url: typeof json.url === 'string' ? json.url : '' });
      }
    } catch {
      /* no service file, or not readable — nothing to offer */
    }
  }
  return out;
}

/**
 * A wildcard bind address is not reliably dialable, so connect probes and URLs
 * use loopback for it while the server itself still binds the wildcard.
 */
function dialHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '*' ? '127.0.0.1' : host;
}

function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Is nothing listening on this port? Uses a connect probe rather than a bind
 * probe: Windows lets a process bind an address another process already holds,
 * so `listen()` would wrongly report an in-use port as free.
 */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(800);
    socket.once('connect', () => finish(false)); // something answered
    socket.once('timeout', () => finish(true)); // no listener responded
    socket.once('error', () => finish(true)); // ECONNREFUSED
  });
}

/**
 * Owns the `opencode serve` child process and issues authenticated requests
 * against its v2 HTTP API (everything lives under /api/*).
 */
class OpenCodeServer {
  /**
   * @param {vscode.OutputChannel} log
   * @param {vscode.SecretStorage} secrets
   */
  constructor(log, secrets) {
    this.log = log;
    this.secrets = secrets;
    this.proc = null;
    this.baseUrl = null;
    this.auth = null;
    this.dir = null;
    /** The password this server accepts (Basic user "opencode"). */
    this.password = null;
    /** True when we adopted a server we do not own, so stop() must not kill it. */
    this.attached = false;
    /** @type {((code:number|null)=>void)|null} */
    this.onExit = null;
  }

  resolveExe() {
    const configured = vscode.workspace.getConfiguration('opencode').get('cliPath');
    if (configured && isFile(configured)) return configured;
    if (process.env.OPENCODE_CLI && isFile(process.env.OPENCODE_CLI)) return process.env.OPENCODE_CLI;
    const discovered = findOpenCodeBinaries();
    if (discovered.length) {
      this.log.appendLine(`[server] using CLI: ${discovered[0]}`);
      return discovered[0];
    }
    // Last resort: let the OS resolve it from the PATH at spawn time.
    return 'opencode';
  }

  directory() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const p = folder ? folder.uri.fsPath : process.cwd();
    // VS Code hands back a lowercase drive letter ("d:\\..."). Canonicalise it so
    // the server's project identity matches sessions created elsewhere.
    return p.replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':');
  }

  /** Interface to bind and connect to; loopback unless the user overrides it. */
  hostname() {
    const configured = vscode.workspace.getConfiguration('opencode').get('server.hostname');
    const host = String(configured || '').trim();
    return host || '127.0.0.1';
  }

  /** Port the server should use; 0 means "any free port". */
  configuredPort() {
    return Number(vscode.workspace.getConfiguration('opencode').get('server.port')) || 0;
  }

  /** Password the server should use; empty means "generate a random one". */
  configuredPassword() {
    return String(vscode.workspace.getConfiguration('opencode').get('server.password') || '');
  }

  /**
   * Write the service file, reporting rather than throwing: a failure to publish
   * the endpoint must not stop the server from working.
   */
  publishServiceFile(values) {
    try {
      writeServiceFile(values);
      this.log.appendLine(`[server] service file: ${SERVICE_FILE} -> ${values.hostname}:${values.port}`);
      return true;
    } catch (err) {
      this.log.appendLine(`[server] could not write the service file: ${err.message}`);
      return false;
    }
  }

  /**
   * Advertise the configured endpoint, at activation. A port of 0 is not an
   * address, so that case waits until start() knows the real one.
   */
  publishConfiguredService() {
    const port = this.configuredPort();
    if (!port) {
      this.log.appendLine('[server] server.port is 0, so the service file waits for the chosen port');
      return false;
    }
    return this.publishServiceFile({
      hostname: this.hostname(),
      port,
      password: this.configuredPassword()
    });
  }

  /**
   * Advertise the endpoint actually in use, once connected. Keeps the file
   * honest when the configured port was taken (an adopted server may have a
   * different password) or when the port was left free to choose.
   *
   * The hostname stays the configured one. `normalizeBaseUrl` rewrites a
   * wildcard bind to loopback so requests can be dialled, but that is a detail
   * of how we connect, not what the file should advertise.
   */
  publishLiveService() {
    if (!this.baseUrl) return false;
    let live;
    try {
      live = new URL(this.baseUrl);
    } catch {
      return false;
    }
    const port = Number(live.port);
    if (!port) return false;

    const configured = this.hostname();
    // An adopted server is not ours and need not be bound where we configured,
    // so advertise the address we actually reached. Our own server is reached
    // at the configured host, wildcard and all.
    const hostname =
      !this.attached && dialHost(configured) === live.hostname ? configured : live.hostname;

    return this.publishServiceFile({
      hostname,
      port,
      password: this.password || this.configuredPassword()
    });
  }

  get isRunning() {
    return !!(this.proc || this.baseUrl);
  }

  /** Password candidates for adopting a server on `port`, best guess first. */
  credentialCandidates(port) {
    const seen = new Set();
    const out = [];
    const push = (p) => {
      if (typeof p === 'string' && p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    };
    const env = process.env.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_PASSWORD;
    if (env) push(env);
    const stored = storedServiceCredentials();
    // The file whose recorded url matches the port is the likeliest one.
    for (const c of stored) if (c.url && c.url.endsWith(`:${port}`)) push(c.password);
    for (const c of stored) push(c.password);
    return out;
  }

  /**
   * Adopt a server already listening on `port` — typically the desktop app's
   * own opencode.exe on 4096 — instead of failing because the port is taken.
   * @returns {Promise<boolean>} true when connected
   */
  async adoptRunningServer(port, host = '127.0.0.1') {
    const baseUrl = `http://${dialHost(host)}:${port}`;
    // Finally try with no auth at all, in case the instance is unprotected.
    const candidates = this.credentialCandidates(port).concat([null]);
    for (const password of candidates) {
      try {
        const res = await fetch(`${baseUrl}/api/info`, {
          headers: password ? { Authorization: basicAuth(password) } : {},
          signal: AbortSignal.timeout(4000)
        });
        if (!res.ok) continue;
        this.baseUrl = baseUrl;
        this.auth = password ? basicAuth(password) : null;
        this.password = password || null;
        this.attached = true;
        this.log.appendLine(`[server] adopted the server already running on port ${port}`);
        return true;
      } catch {
        /* try the next candidate */
      }
    }
    return false;
  }

  /**
   * Attach to an externally-managed server, or spawn our own.
   * @param {string} dir workspace directory to scope requests to
   */
  async start(dir) {
    this.dir = dir || this.directory();

    const attachUrl = vscode.workspace.getConfiguration('opencode').get('attach.url');
    if (attachUrl) {
      this.baseUrl = attachUrl.replace(/\/+$/, '');
      let password = await this.secrets.get('opencode.attachPassword');
      if (!password) {
        password = await vscode.window.showInputBox({
          title: 'OpenCode server password',
          prompt: `Password for ${this.baseUrl} (Basic auth user "opencode")`,
          password: true,
          ignoreFocusOut: true
        });
        if (!password) throw new Error('No password supplied for the attach server.');
        await this.secrets.store('opencode.attachPassword', password);
      }
      this.auth = basicAuth(password);
      this.password = password;
      await this.probe();
      this.publishLiveService();
      return;
    }

    if (this.proc) return;

    // Re-assert the configured endpoint as the server comes up: the settings are
    // the authority on where it should be, and they may have changed in another
    // window, or the file may have been removed since. Skipped entirely for the
    // attach.url case above, where the endpoint is somebody else's.
    this.publishConfiguredService();

    const host = this.hostname();
    const configuredPort = this.configuredPort();
    let port = 0;
    if (configuredPort > 0) {
      if (await isPortFree(configuredPort, dialHost(host))) {
        port = configuredPort;
      } else if (await this.adoptRunningServer(configuredPort, host)) {
        // Something was already there — typically the desktop app's own
        // opencode.exe on 4096. Use it instead of refusing to start.
        this.publishLiveService();
        return;
      } else {
        this.log.appendLine(
          `[server] port ${configuredPort} is in use and could not be adopted; using a free port instead`
        );
      }
    }
    if (!port) port = await findFreePort(host);
    const exe = this.resolveExe();
    const extra = vscode.workspace.getConfiguration('opencode').get('server.extraArgs') || [];
    const args = ['serve', `--hostname=${host}`, `--port=${port}`, ...extra];

    const env = { ...process.env };
    const fixedPassword = this.configuredPassword();
    if (fixedPassword) {
      // Use a password the user chose (stable across restarts, e.g. for a browser).
      env.OPENCODE_SERVER_PASSWORD = fixedPassword;
      env.OPENCODE_SERVER_USERNAME = 'opencode';
    } else {
      // Otherwise make the server generate one and print it in the banner.
      delete env.OPENCODE_PASSWORD;
      delete env.OPENCODE_SERVER_PASSWORD;
      delete env.OPENCODE_SERVER_USERNAME;
    }

    this.log.appendLine(`[server] spawning: ${exe} ${args.join(' ')}`);
    const child = spawn(exe, args, {
      cwd: this.dir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc = child;

    child.on('error', (err) => {
      this.log.appendLine(`[server] spawn error: ${err.message}`);
      this.proc = null;
      this.baseUrl = null;
      if (this.onExit) this.onExit(-1);
    });
    child.on('exit', (code) => {
      this.log.appendLine(`[server] exited with code ${code}`);
      this.proc = null;
      this.baseUrl = null;
      if (this.onExit) this.onExit(code);
    });

    const banner = await this._readBanner(child, 20000, !!fixedPassword);
    this.baseUrl = normalizeBaseUrl(banner.url, host);
    this.password = fixedPassword || banner.password;
    this.auth = basicAuth(this.password);
    this.log.appendLine(`[server] connected: ${this.baseUrl}`);
    await this.probe();
    this.publishLiveService();
  }

  _readBanner(child, timeoutMs, passwordKnown) {
    return new Promise((resolve, reject) => {
      let buf = '';
      let url = null;
      let password = null;
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for the opencode server banner'));
      }, timeoutMs);

      const done = () => {
        // When the password was supplied via env, the banner omits it.
        if (url && (password || passwordKnown)) {
          clearTimeout(timer);
          resolve({ url, password });
        }
      };

      child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        let m;
        if (!url && (m = buf.match(/server listening on (https?:\/\/\S+)/))) url = m[1];
        if (!password && (m = buf.match(/server password (\S+)/))) password = m[1];
        if (!url || !password) {
          for (const line of buf.split('\n')) {
            if (line.trim() && !/^\s*$/.test(line)) this.log.appendLine(`[server:out] ${line.trim()}`);
          }
        }
        done();
      });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) this.log.appendLine(`[server:err] ${text}`);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode serve exited early (code ${code})`));
      });
    });
  }

  /**
   * @param {string} method
   * @param {string} apiPath e.g. "/api/session"
   * @param {{body?:any, query?:Record<string,any>}} [opts]
   */
  async request(method, apiPath, opts = {}) {
    // An adopted server may be unprotected, so auth is optional.
    if (!this.baseUrl) throw new Error('OpenCode server is not connected.');
    const url = new URL(this.baseUrl + apiPath);
    for (const [k, v] of Object.entries(opts.query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers = {
      'Content-Type': 'application/json',
      'x-opencode-directory': encodeURIComponent(this.dir || '')
    };
    if (this.auth) headers.Authorization = this.auth;
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${apiPath} -> ${res.status}: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async probe() {
    const info = await this.request('GET', '/api/info');
    this.log.appendLine(`[server] info ok: ${JSON.stringify(info)}`);
    return info;
  }

  headers() {
    const h = { 'x-opencode-directory': encodeURIComponent(this.dir || '') };
    if (this.auth) h.Authorization = this.auth;
    return h;
  }

  async restart() {
    this.stop();
    await this.start(this.dir);
  }

  stop() {
    if (this.proc) {
      this.log.appendLine('[server] stopping');
      try {
        this.proc.kill();
      } catch {
        /* ignored */
      }
      this.proc = null;
    } else if (this.attached) {
      // Not ours to stop — just disconnect.
      this.log.appendLine('[server] detaching from the adopted server');
    }
    this.baseUrl = null;
    this.auth = null;
    this.attached = false;
  }
}

/**
 * The banner echoes the address the server bound, which for a wildcard bind is
 * not dialable — swap it for loopback so requests work.
 */
function normalizeBaseUrl(url, host) {
  try {
    const u = new URL(url);
    if (u.hostname === '0.0.0.0' || u.hostname === '[::]' || u.hostname === '::') u.hostname = dialHost(host);
    return u.toString().replace(/\/+$/, '');
  } catch {
    return String(url).replace(/\/+$/, '');
  }
}

function basicAuth(password) {
  return 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
}

module.exports = { OpenCodeServer, findFreePort };
