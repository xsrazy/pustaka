'use strict';

// Shared helpers for the API Hub functions. Zero dependencies.

function sendJson(res, status, obj) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (res.req && res.req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}

function createCache() {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}

class TimeoutError extends Error {
  constructor(message) {
    super(message || 'request timed out');
    this.name = 'TimeoutError';
  }
}

async function fetchTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } catch (err) {
    if (err && err.name === 'AbortError') throw new TimeoutError('request timed out after ' + ms + 'ms');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const net = require('net');

function isPrivateOrReservedIp(ip) {
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    const n = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
    const inRange = (base, bits) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === (base & mask);
    };
    const ipToNum = (s) => {
      const p = s.split('.').map(Number);
      return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
    };
    if (inRange(ipToNum('10.0.0.0'), 8)) return true;
    if (inRange(ipToNum('172.16.0.0'), 12)) return true;
    if (inRange(ipToNum('192.168.0.0'), 16)) return true;
    if (inRange(ipToNum('127.0.0.0'), 8)) return true;
    if (inRange(ipToNum('0.0.0.0'), 8)) return true;
    if (inRange(ipToNum('100.64.0.0'), 10)) return true;
    if (inRange(ipToNum('169.254.0.0'), 16)) return true;
    if (inRange(ipToNum('192.0.0.0'), 24)) return true;
    if (inRange(ipToNum('192.0.2.0'), 24)) return true;
    if (inRange(ipToNum('198.51.100.0'), 24)) return true;
    if (inRange(ipToNum('203.0.113.0'), 24)) return true;
    if (inRange(ipToNum('198.18.0.0'), 15)) return true;
    if (inRange(ipToNum('240.0.0.0'), 4)) return true;
    return false;
  }
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    // fe80::/10 link-local, fc00::/7 unique-local
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xffc0) === 0xfe80) return true;
    if ((first & 0xfe00) === 0xfc00) return true;
    return false;
  }
  return false;
}

async function assertPublicHostname(hostname) {
  const host = String(hostname || '').toLowerCase().trim();
  if (!host || host === 'localhost') throw new Error('blocked host');
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('blocked host');
  }
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) throw new Error('blocked host');
    return;
  }
  const dns = require('dns').promises;
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (err) {
    throw new Error('blocked host');
  }
  if (!records || records.length === 0) throw new Error('blocked host');
  for (const record of records) {
    if (isPrivateOrReservedIp(record.address)) throw new Error('blocked host');
  }
}

function checkRateLimit(ip, limit, windowMs) {
  const now = Date.now();
  let bucket = checkRateLimit.buckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    checkRateLimit.buckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}
checkRateLimit.buckets = new Map();

function getClientIp(req) {
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseQuery(req) {
  const host = (req.headers && req.headers.host) || 'localhost';
  const url = new URL(req.url || '/', 'http://' + host);
  return url.searchParams;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// --- Vercel Blob storage for the URL shortener (shorten.js / redirect.js) ---
// REST contract, confirmed from the official Vercel Blob docs and the
// @vercel/blob SDK source (api version 11):
//   Write: PUT https://vercel.com/api/blob/?pathname=<pathname>
//     Headers: Authorization: Bearer <BLOB_READ_WRITE_TOKEN>,
//     x-api-version: 11, x-add-random-suffix: 0, x-allow-overwrite: 1,
//     x-content-type: application/json
//     Response JSON: { url, downloadUrl, pathname, ... }
//   Read (private store): GET <blob url> with
//     Authorization: Bearer <BLOB_READ_WRITE_TOKEN>
//     The blob url host is <storeId>.private.blob.vercel-storage.com.
//     The store id is the 4th underscore segment of the token, the same
//     split the SDK performs. When a PUT has already returned a url in
//     this instance, that url is reused instead of reconstructing it.
// This was verified against docs and SDK source only, not against a live
// store, because no token is available in this environment.
const BLOB_PATHNAME = 'shortener/links.json';
let cachedBlobUrl = null;

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || null;
}

function blobUrlFromToken(token) {
  const parts = String(token).split('_');
  const storeId = parts[3] || '';
  if (!storeId) return null;
  return 'https://' + storeId + '.private.blob.vercel-storage.com/' + BLOB_PATHNAME;
}

async function blobReadDoc() {
  const token = blobToken();
  if (!token) return { unavailable: true };
  const urls = [];
  if (cachedBlobUrl) urls.push(cachedBlobUrl);
  const constructed = blobUrlFromToken(token);
  if (constructed && constructed !== cachedBlobUrl) urls.push(constructed);
  const publicVariant = constructed
    ? constructed.replace('.private.blob.vercel-storage.com', '.public.blob.vercel-storage.com')
    : null;
  if (publicVariant) urls.push(publicVariant);
  let lastStatus = 0;
  let sawError = false;
  for (const url of urls) {
    try {
      const res = await fetchTimeout(url, {
        headers: { Authorization: 'Bearer ' + token },
      }, 8000);
      lastStatus = res.status;
      if (res.status === 404) continue;
      if (!res.ok) { sawError = true; console.error('[api-hub blob] read non-ok status', res.status); continue; }
      const text = await res.text();
      cachedBlobUrl = url;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && parsed.links && typeof parsed.links === 'object') {
          return { doc: parsed };
        }
        return { doc: { links: {} } };
      } catch (err) {
        return { doc: { links: {} } };
      }
    } catch (err) {
      sawError = true;
      console.error('[api-hub blob] read threw', err && err.name ? err.name : 'error');
      continue;
    }
  }
  if (lastStatus === 404 && !sawError) return { doc: { links: {} } };
  if (sawError) return { doc: { links: {} }, readFailed: true };
  return { doc: { links: {} } };
}

async function blobWriteDoc(doc) {
  const token = blobToken();
  if (!token) throw new Error('shortener unavailable');
  const params = new URLSearchParams({ pathname: BLOB_PATHNAME });
  const res = await fetchTimeout('https://vercel.com/api/blob/?' + params.toString(), {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + token,
      'x-api-version': '11',
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1',
      'x-vercel-blob-access': 'private',
      'x-content-type': 'application/json',
    },
    body: JSON.stringify(doc),
  }, 8000);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    console.error('[api-hub blob] write failed status', res.status, 'detail', detail);
    throw new Error('blob write failed: ' + res.status);
  }
  try {
    const body = await res.json();
    if (body && body.url) cachedBlobUrl = body.url;
  } catch (err) {
    // Keep going: the write succeeded even if the response body is unreadable.
  }
}

module.exports = {
  sendJson,
  createCache,
  fetchTimeout,
  TimeoutError,
  assertPublicHostname,
  checkRateLimit,
  getClientIp,
  escapeXml,
  parseQuery,
  readJsonBody,
  blobReadDoc,
  blobWriteDoc,
  blobToken,
  BLOB_PATHNAME,
};
