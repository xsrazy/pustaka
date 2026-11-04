'use strict';

// Live search over official free scholarly and book APIs.
// Pustaka: the same aggregator, served as its own site.
// Every source is optional: one failing source never fails the response.

const { sendJson, createCache, fetchTimeout, parseQuery } = require('./_lib');

const cache = createCache();
const CACHE_TTL = 60 * 60 * 1000;
const TIMEOUT = 8000;
const LIMIT = 10;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, function (match, hex) {
      var cp = parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    })
    .replace(/&#(\d+);/g, function (match, dec) {
      var cp = parseInt(dec, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Strip HTML tags and decode entities. Entities are decoded BEFORE
// stripping (looped, so double-encoded markup is caught too): an
// abstract like "&lt;p&gt;..." or "<p>..." must never reach the page
// as visible markup.
function stripHtml(s) {
  var text = String(s || '');
  for (var i = 0; i < 3; i++) {
    var next = decodeEntities(text).replace(/<[^>]*>/g, '');
    if (next === text) {
      text = next;
      break;
    }
    text = next;
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Truncate at a word boundary, never mid-word. Appends a clean
// ellipsis only when text was actually cut.
function truncateWords(text, max) {
  var clean = String(text || '').trim();
  if (clean.length <= max) return clean;
  var cut = clean.slice(0, max);
  var lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.5) return cut.slice(0, lastSpace).trimEnd() + '…';
  return cut.trimEnd() + '…';
}

function result(source, title, description, url, year) {
  return {
    source,
    title: truncateWords(stripHtml(title), 200),
    description: truncateWords(stripHtml(description), 500),
    url: url || '',
    year: year || null,
  };
}

async function fetchJson(url, headers) {
  const res = await fetchTimeout(url, { headers: headers || {} }, TIMEOUT);
  if (!res.ok) {
    const err = new Error('upstream status ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function searchOpenLibrary(q) {
  const data = await fetchJson(
    'https://openlibrary.org/search.json?q=' + encodeURIComponent(q) + '&limit=' + LIMIT
  );
  return (data.docs || []).map((doc) =>
    result(
      'Open Library',
      doc.title,
      (doc.author_name || []).join(', '),
      doc.key ? 'https://openlibrary.org' + doc.key : '',
      doc.first_publish_year || null
    )
  );
}

async function searchCrossref(q) {
  const data = await fetchJson(
    'https://api.crossref.org/works?query=' + encodeURIComponent(q) + '&rows=' + LIMIT,
    { 'User-Agent': 'API-Hub/1.0' }
  );
  const items = (data.message && data.message.items) || [];
  return items.map((item) => {
    const authors = (item.author || [])
      .map((a) => [a.given, a.family].filter(Boolean).join(' '))
      .join(', ');
    let year = null;
    const dp = item.published && item.published['date-parts'];
    if (dp && dp[0] && dp[0][0]) year = dp[0][0];
    return result(
      'Crossref',
      (item.title && item.title[0]) || '',
      authors,
      item.DOI ? 'https://doi.org/' + item.DOI : '',
      year
    );
  });
}

async function searchDoaj(q) {
  // DOAJ API v4, documented at https://doaj.org/api/docs and verified live
  // against https://doaj.org/api/swagger.json:
  // GET /api/search/articles/{search_query}?pageSize=10
  // Response: { results: [{ bibjson: { title, abstract, author, link,
  // identifier, year } }] }
  const data = await fetchJson(
    'https://doaj.org/api/search/articles/' + encodeURIComponent(q) + '?pageSize=' + LIMIT
  );
  return (data.results || []).map((item) => {
    const bib = item.bibjson || {};
    const authors = (bib.author || []).map((a) => a.name).filter(Boolean).join(', ');
    const doi = (bib.identifier || []).find((i) => i.type === 'doi');
    const fulltext = (bib.link || []).find((l) => l.type === 'fulltext');
    return result(
      'DOAJ',
      bib.title,
      bib.abstract || authors,
      (fulltext && fulltext.url) || (doi ? 'https://doi.org/' + doi.id : ''),
      bib.year ? parseInt(bib.year, 10) || null : null
    );
  });
}

function parseLibriVoxAuthors(raw) {
  if (!raw) return '';
  if (Array.isArray(raw)) {
    return raw.map((a) => [a.first_name, a.last_name].filter(Boolean).join(' ')).join(', ');
  }
  // The API returns authors as a stringified list, e.g.
  // "[{'id': '431', 'first_name': 'Alexandre', 'last_name': 'Dumas', ...}]"
  const names = [];
  const re = /'first_name':\s*'([^']*)',\s*'last_name':\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(String(raw))) !== null) {
    names.push([m[1], m[2]].filter(Boolean).join(' '));
  }
  if (names.length) return names.join(', ');
  return truncateWords(stripHtml(String(raw)), 200);
}

async function searchLibriVox(q) {
  // LibriVox feed API: books[] with url_librivox, description, authors.
  // Verified live: the feed ignores title/search query parameters and
  // always returns the same unfiltered list, so results are filtered
  // client-side by query text. An empty LibriVox result set means no
  // match among the fetched books, not an error.
  const data = await fetchJson(
    'https://librivox.org/api/feed/audiobooks/?format=json&limit=50'
  );
  const needle = q.toLowerCase();
  const books = (data.books || []).filter((book) => {
    const hay = ((book.title || '') + ' ' + parseLibriVoxAuthors(book.authors)).toLowerCase();
    return hay.includes(needle);
  }).slice(0, LIMIT);
  return books.map((book) =>
    result(
      'LibriVox',
      book.title,
      truncateWords(stripHtml(book.description), 300) || parseLibriVoxAuthors(book.authors),
      book.url_librivox || '',
      book.copyright_year ? parseInt(book.copyright_year, 10) || null : null
    )
  );
}

async function searchWikibooks(q) {
  const data = await fetchJson(
    'https://en.wikibooks.org/w/api.php?action=query&format=json&list=search&srsearch=' +
      encodeURIComponent(q) + '&srlimit=' + LIMIT
  );
  const hits = (data.query && data.query.search) || [];
  return hits.map((hit) =>
    result(
      'Wikibooks',
      hit.title,
      stripHtml(hit.snippet),
      'https://en.wikibooks.org/wiki/' + String(hit.title).split('/').map((seg) => encodeURIComponent(seg.replace(/ /g, '_'))).join('/'),
      null
    )
  );
}

async function searchSemanticScholar(q) {
  const data = await fetchJson(
    'https://api.semanticscholar.org/graph/v1/paper/search?query=' +
      encodeURIComponent(q) +
      '&fields=title,year,authors,externalIds,url&limit=' + LIMIT
  );
  return (data.data || []).map((paper) => {
    const authors = (paper.authors || []).map((a) => a.name).filter(Boolean).join(', ');
    const doi = paper.externalIds && paper.externalIds.DOI;
    return result(
      'Semantic Scholar',
      paper.title,
      authors,
      paper.url || (doi ? 'https://doi.org/' + doi : ''),
      paper.year || null
    );
  });
}

async function searchOpenAlex(q) {
  const data = await fetchJson(
    'https://api.openalex.org/works?search=' + encodeURIComponent(q) + '&per-page=' + LIMIT,
    { 'User-Agent': 'API-Hub/1.0' }
  );
  return (data.results || []).map((work) => {
    const authors = ((work.authorships || []).map((a) => a.author && a.author.display_name))
      .filter(Boolean)
      .join(', ');
    return result(
      'OpenAlex',
      work.title,
      authors,
      work.doi || work.id || '',
      work.publication_year || null
    );
  });
}

async function searchGutendex(q) {
  // Gutendex: GET https://gutendex.com/books/?search={q}
  // Response: { results: [{ id, title, authors: [{name}], summaries: [],
  // formats: { 'text/html': url } }] }
  const data = await fetchJson('https://gutendex.com/books/?search=' + encodeURIComponent(q));
  if (!Array.isArray(data.results)) throw new Error('unexpected Gutendex response');
  return data.results.slice(0, LIMIT).map((book) => {
    const authors = (book.authors || []).map((a) => a.name).filter(Boolean).join(', ');
    const formats = book.formats || {};
    const url = formats['text/html'] || 'https://www.gutenberg.org/ebooks/' + book.id;
    const summary = (book.summaries && book.summaries[0]) || authors;
    return result('Gutendex', book.title, summary, url, null);
  });
}

const SOURCES = [
  { name: 'Open Library', fn: searchOpenLibrary },
  { name: 'Crossref', fn: searchCrossref },
  { name: 'DOAJ', fn: searchDoaj },
  { name: 'LibriVox', fn: searchLibriVox },
  { name: 'Wikibooks', fn: searchWikibooks },
  // Disabled 2026-11-04: the source returns nothing (HTTP 429 from the
  // upstream). Function kept so re-adding is a one-flag change.
  { name: 'Semantic Scholar', fn: searchSemanticScholar, enabled: false },
  { name: 'OpenAlex', fn: searchOpenAlex },
  // Disabled 2026-11-04: the source is unreachable. Function kept so
  // re-adding is a one-flag change.
  { name: 'Gutendex', fn: searchGutendex, enabled: false },
];

// Only enabled sources are queried; disabled ones are never fetched and
// never shown as "unavailable" sections in the results.
const ACTIVE_SOURCES = SOURCES.filter(function (source) {
  return source.enabled !== false;
});

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

  const query = parseQuery(req);
  const q = (query.get('q') || '').trim();
  if (q.length < 2) {
    return sendJson(res, 400, { error: 'q is required, minimum 2 characters' });
  }

  const normalized = q.toLowerCase().replace(/\s+/g, ' ').trim();
  const cacheKey = 'search:' + normalized;
  if (query.get('fresh') !== '1') {
    const cached = cache.get(cacheKey);
    if (cached) return sendJson(res, 200, cached);
  }

  const settled = await Promise.allSettled(
    ACTIVE_SOURCES.map(async (source) => {
      const started = Date.now();
      try {
        const items = await source.fn(q);
        return { name: source.name, status: 'ok', ms: Date.now() - started, count: items.length, items };
      } catch (err) {
        return { name: source.name, status: 'unavailable', ms: Date.now() - started, count: 0, items: [] };
      }
    })
  );

  const results = [];
  const sources = [];
  for (const entry of settled) {
    const value = entry.value;
    sources.push({ name: value.name, status: value.status, ms: value.ms, count: value.count });
    for (const item of value.items) {
      if (item.title || item.url) results.push(item);
    }
  }

  const payload = {
    query: q,
    checkedAt: new Date().toISOString(),
    results,
    sources,
  };
  cache.set(cacheKey, payload, CACHE_TTL);
  return sendJson(res, 200, payload);
};
