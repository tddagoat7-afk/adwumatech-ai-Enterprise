import express from 'express';
import cors from 'cors';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const cache = new Map();
const TTL = 1000 * 60 * 10;
const USER_AGENT = 'AdwumaTech-Intelligence-OS/10.0 (+https://github.com/tddagoat7-afk/adwumatech-ai-Enterprise)';

function normalizeText(value = '') {
  return String(value).replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanUrl(value = '') {
  try {
    const u = new URL(value);
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return value;
  }
}

function sourceFromUrl(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
}

function sentimentFor(text = '') {
  const t = text.toLowerCase();
  const positive = ['growth','wins','launch','record','award','strong','profit','success','expands','innovation','partnership','approved','surges'];
  const negative = ['lawsuit','fraud','decline','loss','crisis','recall','investigation','cut','breach','controversy','risk','warning','drops'];
  let score = 0;
  for (const word of positive) if (t.includes(word)) score += 1;
  for (const word of negative) if (t.includes(word)) score -= 1;
  return score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
}

function authorityScore(source = '') {
  const host = source.toLowerCase();
  const high = ['reuters.com','apnews.com','bbc.com','wsj.com','nytimes.com','ft.com','bloomberg.com','sec.gov'];
  const medium = ['cnbc.com','cnn.com','forbes.com','businesswire.com','prnewswire.com','techcrunch.com'];
  if (high.some(x => host.includes(x))) return 96;
  if (medium.some(x => host.includes(x))) return 84;
  if (host.includes('youtube.com') || host.includes('reddit.com')) return 62;
  return 72;
}

function recencyScore(date) {
  if (!date) return 40;
  const days = Math.max(0, (Date.now() - date.getTime()) / 86400000);
  return Math.max(25, Math.round(100 - days * 1.2));
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${normalizeText(item.title).toLowerCase()}|${cleanUrl(item.url)}`;
    if (!item.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildQueryVariants(company) {
  const q = company.trim();
  const simple = q.replace(/\b(incorporated|inc\.?|corp\.?|corporation|ltd\.?|limited|llc|plc|company|group|holdings?)\b/gi, '').replace(/\s+/g, ' ').trim();
  return [...new Set([
    `"${q}"`,
    `"${q}" company`,
    `"${q}" news`,
    `"${q}" business`,
    simple && `"${simple}"`,
    simple && `"${simple}" brand`,
    simple && `"${simple}" review`,
    simple && `"${simple}" partnership`
  ].filter(Boolean))];
}

async function fetchText(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...(options.headers || {}) }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseRss(xml, provider) {
  const data = parser.parse(xml);
  const channel = data?.rss?.channel || data?.feed;
  let entries = channel?.item || channel?.entry || [];
  if (!Array.isArray(entries)) entries = [entries];
  return entries.map(entry => {
    const link = typeof entry.link === 'string' ? entry.link : entry.link?.href || entry.guid || '';
    const title = normalizeText(entry.title?.['#text'] || entry.title || '');
    const description = normalizeText(entry.description || entry.summary || entry.content || '');
    const published = entry.pubDate || entry.published || entry.updated || entry.date || null;
    const date = safeDate(published);
    const source = normalizeText(entry.source?.['#text'] || entry.source || '') || sourceFromUrl(link) || provider;
    return { title, description, url: cleanUrl(link), published: date?.toISOString() || null, date, source, provider };
  }).filter(x => x.title && x.url);
}

async function googleNews(company, days) {
  const q = encodeURIComponent(`"${company}" when:${days}d`);
  const xml = await fetchText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
  return parseRss(xml, 'Google News');
}

async function bingNews(company, days) {
  const q = encodeURIComponent(`"${company}" freshness:${days}`);
  const xml = await fetchText(`https://www.bing.com/news/search?q=${q}&format=rss`);
  return parseRss(xml, 'Bing News');
}

async function yahooNews(company) {
  const q = encodeURIComponent(`"${company}"`);
  const xml = await fetchText(`https://news.search.yahoo.com/rss?p=${q}`);
  return parseRss(xml, 'Yahoo News');
}

async function gdelt(company, days) {
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  const fmt = d => d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${company}"`)}&mode=ArtList&maxrecords=250&format=json&startdatetime=${fmt(start)}&enddatetime=${fmt(end)}&sort=HybridRel`;
  const raw = await fetchText(url, {}, 12000);
  const data = JSON.parse(raw);
  return (data.articles || []).map(a => {
    const date = safeDate(a.seendate || a.date);
    return {
      title: normalizeText(a.title),
      description: normalizeText(a.socialimage ? `Coverage detected by GDELT. ${a.domain || ''}` : 'Coverage detected by GDELT.'),
      url: cleanUrl(a.url),
      published: date?.toISOString() || null,
      date,
      source: a.domain || sourceFromUrl(a.url),
      provider: 'GDELT'
    };
  });
}

async function hackerNews(company, days) {
  const after = Math.floor((Date.now() - days * 86400000) / 1000);
  const raw = await fetchText(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(company)}&tags=story&numericFilters=created_at_i>${after}&hitsPerPage=100`);
  const data = JSON.parse(raw);
  return (data.hits || []).map(h => {
    const date = safeDate(h.created_at);
    const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
    return { title: normalizeText(h.title), description: `${h.points || 0} points · ${h.num_comments || 0} comments`, url, published: date?.toISOString() || null, date, source: sourceFromUrl(url), provider: 'Hacker News' };
  });
}

async function reddit(company, days) {
  const raw = await fetchText(`https://www.reddit.com/search.json?q=${encodeURIComponent(company)}&sort=new&t=${days <= 7 ? 'week' : days <= 30 ? 'month' : 'year'}&limit=100`, { headers: { accept: 'application/json' } });
  const data = JSON.parse(raw);
  return (data?.data?.children || []).map(({ data: p }) => {
    const date = safeDate((p.created_utc || 0) * 1000);
    return { title: normalizeText(p.title), description: normalizeText(p.selftext || `${p.score || 0} score · ${p.num_comments || 0} comments`), url: `https://www.reddit.com${p.permalink}`, published: date?.toISOString() || null, date, source: `reddit.com/r/${p.subreddit}`, provider: 'Reddit' };
  });
}

async function newsApi(company, days) {
  if (!process.env.NEWS_API_KEY) return [];
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const raw = await fetchText(`https://newsapi.org/v2/everything?q=${encodeURIComponent(`"${company}"`)}&from=${from}&language=en&sortBy=publishedAt&pageSize=100&apiKey=${process.env.NEWS_API_KEY}`);
  const data = JSON.parse(raw);
  return (data.articles || []).map(a => {
    const date = safeDate(a.publishedAt);
    return { title: normalizeText(a.title), description: normalizeText(a.description || a.content), url: cleanUrl(a.url), published: date?.toISOString() || null, date, source: a.source?.name || sourceFromUrl(a.url), provider: 'NewsAPI' };
  });
}

async function youtube(company, days) {
  if (!process.env.YOUTUBE_API_KEY) return [];
  const publishedAfter = new Date(Date.now() - days * 86400000).toISOString();
  const raw = await fetchText(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=50&order=date&q=${encodeURIComponent(company)}&publishedAfter=${publishedAfter}&key=${process.env.YOUTUBE_API_KEY}`);
  const data = JSON.parse(raw);
  return (data.items || []).map(v => {
    const date = safeDate(v.snippet?.publishedAt);
    return { title: normalizeText(v.snippet?.title), description: normalizeText(v.snippet?.description), url: `https://www.youtube.com/watch?v=${v.id?.videoId}`, published: date?.toISOString() || null, date, source: v.snippet?.channelTitle || 'YouTube', provider: 'YouTube' };
  });
}

function enrich(items, company, days) {
  const cutoff = Date.now() - days * 86400000;
  return dedupe(items)
    .filter(x => !x.date || x.date.getTime() >= cutoff)
    .map(item => {
      const text = `${item.title} ${item.description}`;
      const sentiment = sentimentFor(text);
      const authority = authorityScore(item.source);
      const recency = recencyScore(item.date);
      const relevance = Math.min(100, 55 + (text.toLowerCase().includes(company.toLowerCase()) ? 35 : 10));
      const confidence = Math.round(authority * 0.4 + recency * 0.25 + relevance * 0.35);
      return { ...item, sentiment, authority, recency, relevance, confidence };
    })
    .sort((a, b) => (b.confidence - a.confidence) || ((b.date?.getTime() || 0) - (a.date?.getTime() || 0)));
}

function summarize(items, providers, company, days) {
  const total = items.length;
  const counts = { positive: 0, neutral: 0, negative: 0 };
  const sourceMap = new Map();
  const providerMap = new Map();
  const topicMap = new Map();
  const dayMap = new Map();
  const stop = new Set(['the','and','for','that','with','from','this','will','have','has','into','about','after','before','their','your','company','brand','says','said','new']);

  for (const item of items) {
    counts[item.sentiment] += 1;
    sourceMap.set(item.source, (sourceMap.get(item.source) || 0) + 1);
    providerMap.set(item.provider, (providerMap.get(item.provider) || 0) + 1);
    const day = item.published?.slice(0, 10) || 'Unknown';
    dayMap.set(day, (dayMap.get(day) || 0) + 1);
    normalizeText(`${item.title} ${item.description}`).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 4 && !stop.has(w) && !company.toLowerCase().includes(w)).forEach(w => topicMap.set(w, (topicMap.get(w) || 0) + 1));
  }

  const pct = key => total ? Math.round(counts[key] / total * 100) : 0;
  const avgConfidence = total ? Math.round(items.reduce((s, x) => s + x.confidence, 0) / total) : 0;
  const trust = Math.max(0, Math.min(100, Math.round(avgConfidence * 0.7 + pct('positive') * 0.3 - pct('negative') * 0.15)));
  const crisisRisk = Math.max(0, Math.min(100, Math.round(pct('negative') * 1.2 + Math.min(25, counts.negative * 2))));
  const reputation = Math.max(0, Math.min(100, Math.round(50 + pct('positive') * 0.55 - pct('negative') * 0.65 + avgConfidence * 0.15)));
  const opportunity = Math.max(0, Math.min(100, Math.round(pct('positive') * 0.5 + Math.min(total, 50) + (100 - crisisRisk) * 0.2)));

  const top = map => [...map.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10).map(([name,count]) => ({ name, count }));
  const timeline = [...dayMap.entries()].sort((a,b) => a[0].localeCompare(b[0])).map(([date,count]) => ({ date, count }));
  const topTopics = top(topicMap);
  const topSources = top(sourceMap);

  const summary = total
    ? `${company} generated ${total} verified public mentions over the last ${days} days. Coverage is ${pct('positive')}% positive, ${pct('neutral')}% neutral, and ${pct('negative')}% negative. Reputation currently scores ${reputation}/100, with crisis risk at ${crisisRisk}/100. The strongest recurring topics are ${topTopics.slice(0,3).map(x => x.name).join(', ') || 'not yet established'}.`
    : `No verified public mentions were found for ${company} in the selected ${days}-day window. This can indicate low media visibility, a highly local brand, or provider access limits—not necessarily an absence of activity.`;

  const recommendations = [];
  if (!total) recommendations.push('Increase searchable public visibility through press releases, indexed announcements, and consistent company naming.');
  if (crisisRisk >= 50) recommendations.push('Review negative evidence immediately and prepare a response plan around the highest-authority sources.');
  if (pct('positive') < 25 && total) recommendations.push('Create more proof-based positive stories around wins, customer outcomes, partnerships, and measurable impact.');
  if (topSources.length < 5 && total) recommendations.push('Diversify media coverage so reputation is not dependent on only a few publishers.');
  if (!recommendations.length) recommendations.push('Maintain current momentum and monitor for sudden changes in sentiment, source authority, or mention velocity.');

  return {
    company,
    days,
    generatedAt: new Date().toISOString(),
    totals: { mentions: total, sources: sourceMap.size, providers: providerMap.size, positive: counts.positive, neutral: counts.neutral, negative: counts.negative },
    percentages: { positive: pct('positive'), neutral: pct('neutral'), negative: pct('negative') },
    scores: { reputation, trust, crisisRisk, opportunity, confidence: avgConfidence },
    topSources,
    topProviders: top(providerMap),
    topTopics,
    timeline,
    summary,
    recommendations,
    providerStatus: providers
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '10.0.0', name: 'AdwumaTech Intelligence OS', optionalKeys: { NEWS_API_KEY: Boolean(process.env.NEWS_API_KEY), YOUTUBE_API_KEY: Boolean(process.env.YOUTUBE_API_KEY) } });
});

app.get('/api/search', async (req, res) => {
  const company = normalizeText(req.query.company || req.query.q || '');
  const days = [7,30,90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  if (!company || company.length < 2) return res.status(400).json({ error: 'Enter a company or organization name.' });

  const cacheKey = `${company.toLowerCase()}|${days}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.created < TTL) return res.json({ ...cached.data, cached: true });

  const variants = buildQueryVariants(company).slice(0, 3);
  const providers = [];
  const jobs = [];
  const add = (name, fn) => jobs.push((async () => {
    try {
      const data = await fn();
      providers.push({ name, status: 'online', mentions: data.length });
      return data;
    } catch (error) {
      providers.push({ name, status: 'limited', mentions: 0, message: error.message });
      return [];
    }
  })());

  add('Google News', async () => (await Promise.all(variants.map(v => googleNews(v.replaceAll('"',''), days)))).flat());
  add('Bing News', () => bingNews(company, days));
  add('Yahoo News', () => yahooNews(company));
  add('GDELT', () => gdelt(company, days));
  add('Hacker News', () => hackerNews(company, days));
  add('Reddit', () => reddit(company, days));
  add('NewsAPI', () => newsApi(company, days));
  add('YouTube', () => youtube(company, days));

  const settled = await Promise.all(jobs);
  const items = enrich(settled.flat(), company, days).slice(0, 1000);
  const analytics = summarize(items, providers, company, days);
  const payload = { version: '10.0.0', query: company, days, items, analytics, cached: false };
  cache.set(cacheKey, { created: Date.now(), data: payload });
  res.json(payload);
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`AdwumaTech Intelligence OS v10 running on port ${PORT}`));
