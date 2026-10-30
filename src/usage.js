'use strict';

/**
 * Usage reporting for the Console account this workspace is billed to.
 *
 * The numbers here are the gateway's own: the Console keeps one record per
 * request, and `GET /console/api/v2/usage/export` folds them into one CSV row
 * per (day, member, provider, model) with the token split and the cost it
 * charged. That is the only source that knows the price, so the report reads
 * this rather than re-pricing local transcripts.
 *
 * The export also says which credential paid, which is the one filter: the
 * per-request log (`/console/api/request-logs`) has richer columns, but it is
 * authenticated with the Console's browser session rather than an API key, so
 * it is not reachable from here and no client dimension is offered.
 *
 * Authentication is the part worth knowing: the API key is already on this
 * machine, held by the opencode server this extension talks to. We ask that
 * server for it (`GET /api/credential`) rather than making the user paste the
 * same key into a second place, so the report is billed against exactly the
 * account the prompts are.
 */

const ORIGIN = 'https://opencode.ai';
const EXPORT_PATH = '/console/api/v2/usage/export';

/** The largest window the export offers; a shorter report is sliced from it. */
const RANGES = [7, 30, 90];

/** A report is a network round trip, so a second click reuses it briefly. */
const CACHE_MS = 60 * 1000;

/** The request in flight, so a double click does not spend two of them. */
let inflight = null;
/** The last export table, reused for `CACHE_MS`; filters re-aggregate it. */
let cache = null;

/**
 * An error the webview can react to: `code` says what the user could change.
 * @param {string} message
 * @param {string} code
 */
function usageError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** The range token that covers `days`, coarsest match first. */
function rangeFor(days) {
  const wanted = Number(days) || 30;
  return RANGES.find((r) => wanted <= r) || RANGES[RANGES.length - 1];
}

/**
 * Ask the connected opencode server for the Console API key it authenticates
 * with. The server exposes its stored credentials, so the key the sidebar's own
 * requests use is the key the report uses — no second copy, no second prompt.
 *
 * @param {{request:Function}} server the connected OpenCodeServer
 * @returns {Promise<{key:string, integrationID:string}|null>}
 */
async function keyFromServer(server) {
  if (!server || !server.baseUrl) return null;
  const body = await server.request('GET', '/api/credential');
  const list = Array.isArray(body && body.data) ? body.data : [];
  const keys = list.filter(
    (c) => c && c.value && c.value.type === 'key' && typeof c.value.key === 'string' && c.value.key.trim()
  );
  if (!keys.length) return null;

  const id = (c) => String(c.integrationID || '').toLowerCase();
  // The Go credential is the one the plan is billed to; prefer it when a
  // workspace holds several (an `opencode` pay-as-you-go key may sit beside it).
  const pick =
    keys.find((c) => id(c).includes('go') && c.active !== false) ||
    keys.find((c) => id(c).startsWith('opencode') && c.active !== false) ||
    keys.find((c) => c.active !== false) ||
    keys[0];
  return { key: pick.value.key.trim(), integrationID: pick.integrationID || '' };
}

/**
 * The key the report authenticates with, taken from the connected server.
 *
 * A Console key is not something to hold twice: the server already has the one
 * every prompt is billed against, so asking it keeps the report and the
 * transcript on the same account and needs no setup from the user. A server
 * with no Console credential is the one case worth an explanation — connecting
 * a provider is what fixes it, and that is said in those terms.
 *
 * @param {{request:Function, baseUrl?:string}} server
 * @returns {Promise<{key:string, source:string, integrationID:string}>}
 */
async function resolveKey(server) {
  if (!server || !server.baseUrl) {
    throw usageError('The opencode server is not connected, so there is no API key to read.', 'NO_SERVER');
  }

  let key = null;
  try {
    key = await keyFromServer(server);
  } catch (err) {
    throw usageError(`Could not read the server's API key: ${err.message}`, 'NO_KEY');
  }
  if (!key) {
    throw usageError(
      'The opencode server has no Console API key. Connect a provider with `/connect` and reopen the report.',
      'NO_KEY'
    );
  }
  return { ...key, source: 'server' };
}

/**
 * Split CSV into rows, honouring quoted fields so a name containing a comma
 * survives. The export is a fixed shape, but user names are not under our
 * control and a truncated name mid-report would be worse than a few lines here.
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Costs are serialised in micro-cents: 1e8 of them make a dollar. */
const MICRO_CENTS_PER_USD = 1e8;

/** Column indexes the report reads, resolved once per export. */
function columnIndex(header) {
  const col = (name) => header.indexOf(name);
  const needs = ['day', 'requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cost_micro_cents'];
  for (const name of needs) {
    if (col(name) < 0) throw usageError(`Usage export is missing the "${name}" column.`, 'BAD_EXPORT');
  }
  return {
    day: col('day'),
    requests: col('requests'),
    input: col('input_tokens'),
    output: col('output_tokens'),
    read: col('cache_read_tokens'),
    // Cache writes have their own columns and only some models price them, so
    // a missing pair counts as zero rather than failing the whole report.
    write5m: col('cache_write_5m_tokens'),
    write1h: col('cache_write_1h_tokens'),
    cost: col('cost_micro_cents'),
    model: col('model'),
    userType: col('user_type'),
    userId: col('user_id'),
    userName: col('user_name')
  };
}

/**
 * The credential a row was billed to. The gateway charges a request to the
 * key's owner — a member account or a service account — so that identity is the
 * finest grain at which two API keys can be told apart here.
 *
 * @param {string[]} row
 * @param {ReturnType<typeof columnIndex>} idx
 */
function rowIdentity(row, idx) {
  if (idx.userId < 0) return null;
  const id = String(row[idx.userId] || '').trim();
  if (!id) return null;
  return {
    id,
    type: idx.userType >= 0 ? String(row[idx.userType] || '').trim() : '',
    name: idx.userName >= 0 ? String(row[idx.userName] || '').trim() : ''
  };
}

/**
 * Every credential the export mentions, for the API-key filter's menu. A
 * service account is named as such because it is not a person, even though its
 * label usually quotes one ("Legacy: you@example.com").
 *
 * @param {string[]} header
 * @param {string[][]} rows
 */
function identities(header, rows) {
  const idx = columnIndex(header);
  const seen = new Map();
  for (const row of rows) {
    const who = rowIdentity(row, idx);
    if (!who || seen.has(who.id)) continue;
    const kind = who.type === 'service_account' ? 'service account' : who.type || 'member';
    seen.set(who.id, {
      id: who.id,
      type: who.type,
      name: who.name || who.id,
      // Second line in the menu: the kind plus the id's tail, which is what
      // separates two keys that share an owner.
      detail: `${kind} · ${who.id.slice(-6)}`
    });
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fold the per-(day, member, model) rows into one row per day, newest first,
 * which is the shape the report shows.
 *
 * @param {string[]} header
 * @param {string[][]} rows body rows, header excluded
 * @param {{limit?:number, identity?:string}} [opts] keep at most `limit` days,
 *   and only rows billed to `identity`
 */
function aggregateDays(header, rows, opts = {}) {
  const idx = columnIndex(header);
  const limit = opts.limit || 0;
  const only = opts.identity ? String(opts.identity) : '';
  const byDay = new Map();

  for (const row of rows) {
    if (!row.length || !row[idx.day]) continue;
    const day = row[idx.day].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (only) {
      const who = rowIdentity(row, idx);
      if (!who || who.id !== only) continue;
    }
    const num = (i) => (i >= 0 ? Number(row[i]) || 0 : 0);
    const at = byDay.get(day) || {
      date: day,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0
    };
    at.requests += num(idx.requests);
    at.inputTokens += num(idx.input);
    at.outputTokens += num(idx.output);
    // "Cached" is every token served from cache, reads and writes alike.
    at.cachedTokens += num(idx.read) + num(idx.write5m) + num(idx.write1h);
    at.costUsd += num(idx.cost) / MICRO_CENTS_PER_USD;
    byDay.set(day, at);
  }

  // The export already returns newest first, but sort rather than trust it:
  // the report's "descending" is a promise, not an observation.
  const days = Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    days: limit ? days.slice(0, limit) : days,
    days_available: days.length
  };
}

/**
 * Download the export for one range. The result is the parsed table plus the
 * key that answered, and it is what the cache holds: re-filtering the report
 * must not spend another request.
 *
 * @param {{request:Function, baseUrl?:string}} server
 * @param {number} range 7, 30 or 90
 */
async function fetchExport(server, range) {
  const auth = await resolveKey(server);
  const url = `${ORIGIN}${EXPORT_PATH}?range=${range}d`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${auth.key}`,
        // Console rejects an unnamed HTTP client with a 403 and no explanation.
        'User-Agent': 'opencode-sidebar/usage-report',
        Accept: 'text/csv, application/json'
      },
      signal: controller.signal
    });
  } catch (err) {
    throw usageError(
      err.name === 'AbortError'
        ? 'The usage request timed out.'
        : `Could not reach ${ORIGIN}: ${err.message}`,
      'NETWORK'
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw usageError(
      'The Console API key was rejected for usage. It needs the Usage (Read) permission.',
      'FORBIDDEN'
    );
  }
  if (!res.ok) {
    throw usageError(`Usage request failed (${res.status}): ${text.slice(0, 200)}`, 'HTTP');
  }
  // A body that is JSON is an error, not a CSV — reporting that as a parse
  // failure would hide the actual message.
  if (/^\s*[[{]/.test(text)) {
    throw usageError(`Usage request was refused: ${text.slice(0, 200)}`, 'BAD_EXPORT');
  }

  const table = parseCsv(text).filter((row) => row.some((field) => field.trim() !== ''));
  if (!table.length) throw usageError('The usage export came back empty.', 'BAD_EXPORT');
  return {
    header: table[0].map((h) => h.trim()),
    rows: table.slice(1),
    auth
  };
}

/**
 * Fetch and shape the daily report.
 *
 * `identity` narrows it to one API key's owner. Filtering happens here rather
 * than in the view so the ranking, the totals and the rounding all come from
 * one place, and so switching filters costs no network call.
 *
 * @param {{request:Function, baseUrl?:string}} server the connected server
 * @param {{days?:number, refresh?:boolean, identity?:string}} [opts]
 */
async function dailyReport(server, opts = {}) {
  const days = Number(opts.days) || 30;
  const range = rangeFor(days);
  const token = `${range}d`;

  let bundle;
  let cached = false;
  if (!opts.refresh && cache && cache.range === token && Date.now() - cache.at < CACHE_MS) {
    bundle = cache.value;
    cached = true;
  } else if (inflight && inflight.range === token) {
    bundle = await inflight.promise;
    cached = true;
  } else {
    const promise = fetchExport(server, range);
    inflight = { range: token, promise };
    try {
      bundle = await promise;
      cache = { at: Date.now(), range: token, value: bundle };
    } finally {
      inflight = null;
    }
  }

  const identity = opts.identity ? String(opts.identity) : '';

  const aggregated = aggregateDays(bundle.header, bundle.rows, { limit: days, identity });
  const rows = aggregated.days;
  const daysAvailable = aggregated.days_available;

  const totals = rows.reduce(
    (acc, d) => ({
      requests: acc.requests + d.requests,
      inputTokens: acc.inputTokens + d.inputTokens,
      outputTokens: acc.outputTokens + d.outputTokens,
      cachedTokens: acc.cachedTokens + d.cachedTokens,
      costUsd: acc.costUsd + d.costUsd
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }
  );

  return {
    days: rows,
    totals,
    days_available: daysAvailable,
    range: token,
    requested: days,
    // The full list, not the filtered one: the menu must stay complete so the
    // user can switch away from the account they picked.
    identities: identities(bundle.header, bundle.rows),
    identity,
    source: bundle.auth.source,
    integrationID: bundle.auth.integrationID,
    // Which key answered, not the key: enough to spot the wrong one.
    keyHint: `${bundle.auth.key.slice(0, 12)}…`,
    fetchedAt: Date.now(),
    cached
  };
}

/** Drop the cached report so the next click always re-queries. */
function invalidate() {
  cache = null;
}

module.exports = {
  dailyReport,
  invalidate,
  parseCsv,
  aggregateDays,
  identities,
  rangeFor,
  EXPORT_PATH,
  ORIGIN
};
