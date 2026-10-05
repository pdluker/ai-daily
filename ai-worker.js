/**
 * ai-worker.js  --  the `ai-daily` Worker behind ai.stluker.com
 *
 * Read-only front end. stl-dispatcher writes everything (aiIngest daily at
 * 11:45 UTC, aiPodcast Mon/Thu at 11:50 UTC); this Worker renders it from
 * PODCAST_KV / POD_BUCKET at request time, same pattern as pod/space/earth.
 *
 *   GET /                    latest daily edition + latest recap episode
 *   GET /day/YYYY-MM-DD      one edition
 *   GET /archive             every edition
 *   GET /podcast             AI Daily Recap: subscribe + all episodes
 *   GET /episode/YYYY-MM-DD  one episode: player + transcript + editions covered
 *   GET /feed.xml            podcast RSS (Apple/Overcast/Pocket Casts)
 *   GET /rss.xml             daily edition RSS (for feed readers)
 *   GET /audio/:id.mp3       episode MP3 from R2, Range-aware (podcast apps need 206)
 *   GET /transcript/:id.txt  plain-text script
 *
 * KV keys (all written by stl-dispatcher):
 *   ai:index                [{day, headline, count}] newest first
 *   ai:day:YYYY-MM-DD       {day, lede, stories:[{headline, summary, why, category, importance, links[]}]}
 *   ai:pod:manifest         [episode without script] newest first
 *   ai:pod:episode:YYYY-MM-DD  full episode incl. script
 */

const SITE = {
  name: 'AI Daily',
  tagline: 'What happened in AI, every morning. No hype.',
  url: 'https://ai.stluker.com',
};

const SHOW = {
  title: 'AI Daily Recap',
  subtitle: 'Five minutes, twice a week: everything that mattered in AI since last time.',
  description:
    'Every Monday and Thursday, Paul Luker walks through the AI news that actually mattered ' +
    'since the last episode: new models, launches, research, money, and policy. About five ' +
    'minutes. Built from the daily editions at ai.stluker.com; scripted with AI and read in ' +
    "Paul's own cloned voice. Part of the stluker.com network.",
  author: 'Paul Luker',
  email: 'pdluker@gmail.com',
  language: 'en-us',
  category: 'Technology',
  explicit: 'false',
  imageUrl: `${SITE.url}/cover.jpg`,
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── utils ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const xmlEscape = (s) => esc(s).replace(/&#39;/g, '&apos;');

async function readJson(kv, key, fallback) {
  try { const raw = await kv.get(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function longDate(day, weekday = true) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    ...(weekday ? { weekday: 'long' } : {}), month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}
function shortDate(day) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function hhmmss(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
function hostOf(url) { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } }

function html(body, status = 200, maxAge = 300) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` },
  });
}

// ── layout ─────────────────────────────────────────────────────────────────
const CSS = `
:root{--bg:#f7f6f2;--surface:#fff;--ink:#16171a;--muted:#5f6570;--line:#e3e1da;--accent:#4b3fe0;--accent-soft:#ecebfd;--chip:#f0eee8}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a20;--ink:#e9eaee;--muted:#9aa1ad;--line:#262a33;--accent:#9d95ff;--accent-soft:#232147;--chip:#20242c}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}
.wrap{max-width:46rem;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--line);background:var(--surface)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-top:.9rem;padding-bottom:.9rem;flex-wrap:wrap}
.brand{font-weight:800;letter-spacing:-.02em;font-size:1.25rem;text-decoration:none;display:flex;align-items:center;gap:.5rem}
.brand .dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--accent);display:inline-block}
nav a{text-decoration:none;color:var(--muted);margin-left:1.1rem;font-size:.95rem}
nav a:hover,nav a[aria-current]{color:var(--ink)}
main{padding:2rem 0 3rem}
.kicker{color:var(--muted);font-size:.85rem;text-transform:uppercase;letter-spacing:.08em;margin:0 0 .4rem}
h1{font-size:clamp(1.8rem,5vw,2.5rem);line-height:1.15;letter-spacing:-.025em;margin:0 0 1rem}
.lede{font-size:1.15rem;color:var(--ink);margin:0 0 2rem;max-width:40rem}
.story{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:1.2rem 1.25rem;margin:0 0 1rem}
.story.top{border-color:var(--accent)}
.story h2{font-size:1.2rem;line-height:1.3;margin:.35rem 0 .5rem;letter-spacing:-.01em}
.story p{margin:0 0 .6rem}
.why{color:var(--muted);font-size:.95rem}
.why b{color:var(--ink);font-weight:600}
.chip{display:inline-block;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;background:var(--chip);color:var(--muted);border-radius:999px;padding:.15rem .6rem}
.story.top .chip{background:var(--accent-soft);color:var(--accent)}
.links{display:flex;flex-wrap:wrap;gap:.4rem .9rem;font-size:.88rem;margin-top:.4rem}
.links a{color:var(--accent);text-decoration:none}
.links a:hover{text-decoration:underline}
.pod{display:flex;gap:1rem;align-items:center;background:var(--accent-soft);border-radius:14px;padding:1rem 1.1rem;margin:0 0 2rem}
.pod .t{font-weight:700;margin:0}
.pod .s{color:var(--muted);font-size:.9rem;margin:0 0 .4rem}
.pod > div{flex:1;min-width:0}
audio{width:100%;display:block}
.daynav{display:flex;justify-content:space-between;gap:1rem;margin-top:2rem;font-size:.95rem}
.daynav a{color:var(--accent);text-decoration:none}
.list{list-style:none;padding:0;margin:0}
.list li{border-bottom:1px solid var(--line);padding:.75rem 0;display:flex;gap:1rem;align-items:baseline}
.list .d{color:var(--muted);font-size:.85rem;min-width:7.5rem;font-variant-numeric:tabular-nums}
.list a{text-decoration:none}
.list a:hover{text-decoration:underline}
.ep{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:1.1rem 1.2rem;margin:0 0 1rem}
.ep h2{font-size:1.1rem;margin:.2rem 0 .4rem}
.ep .meta{color:var(--muted);font-size:.85rem}
details{margin-top:.6rem}
summary{cursor:pointer;color:var(--accent);font-size:.9rem}
.transcript{white-space:pre-wrap;font-size:.95rem;color:var(--ink);margin-top:.6rem}
code.feed{display:block;background:var(--chip);padding:.6rem .75rem;border-radius:8px;font-size:.85rem;word-break:break-all;margin:.5rem 0 1rem}
.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;border-radius:999px;padding:.45rem 1rem;font-size:.9rem;font-weight:600;border:0;cursor:pointer}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:.85rem;padding:1.5rem 0 2.5rem}
footer a{color:var(--muted)}
.empty{color:var(--muted);padding:2rem 0}
@media (max-width:520px){nav a{margin-left:0;margin-right:1rem}.list li{flex-direction:column;gap:.1rem}.pod{flex-direction:column;align-items:stretch}}
`;

function page({ title, description = SITE.tagline, active = '', body }) {
  const navLink = (href, label, key) => `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${esc(SITE.name)}" href="/rss.xml">
<link rel="alternate" type="application/rss+xml" title="${esc(SHOW.title)}" href="/feed.xml">
<style>${CSS}</style>
</head><body>
<header class="top"><div class="wrap">
  <a class="brand" href="/"><span class="dot"></span>${esc(SITE.name)}</a>
  <nav>${navLink('/', 'Today', 'today')}${navLink('/podcast', 'Podcast', 'podcast')}${navLink('/archive', 'Archive', 'archive')}</nav>
</div></header>
<main><div class="wrap">${body}</div></main>
<footer><div class="wrap">
  ${esc(SITE.name)} is assembled automatically each morning from public AI news sources and Hacker News, then edited by Claude. Every story links to its sources; read them before quoting anything.
  <br><a href="/rss.xml">Daily RSS</a> &middot; <a href="/feed.xml">Podcast feed</a> &middot; <a href="https://stluker.com">stluker.com</a>
</div></footer>
</body></html>`;
}

// ── fragments ──────────────────────────────────────────────────────────────
function storyHtml(s, i) {
  const links = (s.links || []).map((l) =>
    `<a href="${esc(l.url)}" rel="noopener">${esc(l.source || hostOf(l.url))} &rarr;</a>` +
    (l.discussion ? `<a href="${esc(l.discussion)}" rel="noopener">HN discussion</a>` : '')).join('');
  return `<article class="story${i === 0 ? ' top' : ''}">
  <span class="chip">${esc(s.category)}</span>
  <h2>${esc(s.headline)}</h2>
  <p>${esc(s.summary)}</p>
  ${s.why ? `<p class="why"><b>Why it matters:</b> ${esc(s.why)}</p>` : ''}
  <div class="links">${links}</div>
</article>`;
}

function podBanner(ep) {
  if (!ep) return '';
  return `<section class="pod" aria-label="Latest podcast episode">
  <div>
    <p class="t">${esc(SHOW.title)}: ${esc(ep.title)}</p>
    <p class="s">${esc(shortDate(ep.id))} &middot; ${hhmmss(ep.durationSeconds)} &middot; <a href="/episode/${esc(ep.id)}">Transcript</a> &middot; <a href="/podcast">Subscribe</a></p>
    <audio controls preload="none" src="/audio/${esc(ep.id)}.mp3"></audio>
  </div>
</section>`;
}

function editionHtml(ed, { prev, next, latestEp, isToday }) {
  return `
<p class="kicker">${isToday ? 'Today&rsquo;s edition' : 'Edition'} &middot; ${ed.stories.length} stories</p>
<h1>${esc(longDate(ed.day))}</h1>
<p class="lede">${esc(ed.lede)}</p>
${podBanner(latestEp)}
${ed.stories.map(storyHtml).join('\n')}
<nav class="daynav">
  <span>${prev ? `<a href="/day/${prev}">&larr; ${esc(shortDate(prev))}</a>` : ''}</span>
  <span>${next ? `<a href="/day/${next}">${esc(shortDate(next))} &rarr;</a>` : ''}</span>
</nav>`;
}

// ── feeds ──────────────────────────────────────────────────────────────────
function buildPodcastFeed(episodes) {
  const items = episodes.map((ep) => {
    const audioUrl = `${SITE.url}/audio/${ep.id}.mp3`;
    // The spoken closeout promises "links are in the show notes" -- this is
    // where that promise is kept: the episode page lists every story + source.
    const pageUrl = `${SITE.url}/episode/${ep.id}`;
    const notes = `${ep.blurb || SHOW.subtitle} Every story and source link: ${pageUrl}`;
    return `    <item>
      <title>${xmlEscape(ep.title)}</title>
      <description>${xmlEscape(notes)}</description>
      <content:encoded><![CDATA[<p>${esc(ep.blurb || SHOW.subtitle)}</p><p><a href="${pageUrl}">Every story and source link for this episode</a></p>]]></content:encoded>
      <itunes:summary>${xmlEscape(notes)}</itunes:summary>
      <pubDate>${xmlEscape(ep.pubDate)}</pubDate>
      <guid isPermaLink="false">stluker-ai-recap-${xmlEscape(ep.id)}</guid>
      <link>${SITE.url}/episode/${xmlEscape(ep.id)}</link>
      <enclosure url="${audioUrl}" length="${ep.bytes || 0}" type="audio/mpeg"/>
      <itunes:duration>${hhmmss(ep.durationSeconds)}</itunes:duration>
      ${ep.episodeNumber ? `<itunes:episode>${ep.episodeNumber}</itunes:episode>` : ''}
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(SHOW.title)}</title>
    <link>${SITE.url}/podcast</link>
    <atom:link href="${SITE.url}/feed.xml" rel="self" type="application/rss+xml"/>
    <language>${SHOW.language}</language>
    <description>${xmlEscape(SHOW.description)}</description>
    <itunes:author>${xmlEscape(SHOW.author)}</itunes:author>
    <itunes:summary>${xmlEscape(SHOW.description)}</itunes:summary>
    <itunes:subtitle>${xmlEscape(SHOW.subtitle)}</itunes:subtitle>
    <itunes:type>episodic</itunes:type>
    <itunes:explicit>${SHOW.explicit}</itunes:explicit>
    <itunes:image href="${xmlEscape(SHOW.imageUrl)}"/>
    <itunes:owner><itunes:name>${xmlEscape(SHOW.author)}</itunes:name><itunes:email>${xmlEscape(SHOW.email)}</itunes:email></itunes:owner>
    <itunes:category text="${SHOW.category}"/>
${items}
  </channel>
</rss>`;
}

async function buildEditionFeed(env, index) {
  const days = index.slice(0, 20);
  const eds = (await Promise.all(days.map((d) => readJson(env.PODCAST_KV, `ai:day:${d.day}`, null)))).filter(Boolean);
  const items = eds.map((ed) => {
    const body = `<p>${esc(ed.lede)}</p>` + ed.stories.map((s) =>
      `<h3>${esc(s.headline)}</h3><p>${esc(s.summary)}</p>${s.why ? `<p><em>Why it matters:</em> ${esc(s.why)}</p>` : ''}` +
      `<p>${(s.links || []).map((l) => `<a href="${esc(l.url)}">${esc(l.source)}</a>`).join(' &middot; ')}</p>`).join('');
    return `    <item>
      <title>${xmlEscape(`${shortDate(ed.day)}: ${ed.stories[0]?.headline || 'AI Daily'}`)}</title>
      <link>${SITE.url}/day/${ed.day}</link>
      <guid isPermaLink="true">${SITE.url}/day/${ed.day}</guid>
      <pubDate>${new Date(ed.generatedAt || `${ed.day}T12:00:00Z`).toUTCString()}</pubDate>
      <description>${xmlEscape(ed.lede)}</description>
      <content:encoded><![CDATA[${body.replace(/]]>/g, ']]&gt;')}]]></content:encoded>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(SITE.name)}</title>
    <link>${SITE.url}</link>
    <atom:link href="${SITE.url}/rss.xml" rel="self" type="application/rss+xml"/>
    <description>${xmlEscape(SITE.tagline)}</description>
    <language>en-us</language>
${items}
  </channel>
</rss>`;
}

// ── audio (Range-aware) ────────────────────────────────────────────────────
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rs, re] = m;
  if (rs === '' && re === '') return null;
  if (rs === '') { const len = Math.min(Number(re), size); return { offset: size - len, length: len }; }
  const start = Number(rs);
  const end = re === '' ? size - 1 : Math.min(Number(re), size - 1);
  if (start > end || start >= size) return null;
  return { offset: start, length: end - start + 1 };
}

async function serveAudio(request, env, id) {
  const key = `ai/episodes/${id}.mp3`;
  const head = await env.POD_BUCKET.head(key);
  if (!head) return new Response('Not found', { status: 404 });
  const range = parseRange(request.headers.get('range'), head.size);
  const obj = await env.POD_BUCKET.get(key, range ? { range } : undefined);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers({
    'content-type': 'audio/mpeg', 'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400, must-revalidate', etag: obj.httpEtag,
  });
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set('content-length', String(range.length));
    return new Response(request.method === 'HEAD' ? null : obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(head.size));
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
}

// ── routes ─────────────────────────────────────────────────────────────────
async function renderEdition(env, day, { isToday = false } = {}) {
  const [index, manifest] = await Promise.all([
    readJson(env.PODCAST_KV, 'ai:index', []),
    readJson(env.PODCAST_KV, 'ai:pod:manifest', []),
  ]);
  const target = day || index[0]?.day;
  if (!target) {
    return html(page({ title: SITE.name, active: 'today', body: `<h1>${esc(SITE.name)}</h1><p class="empty">The first edition lands tomorrow morning at about 6:45 a.m. Central.</p>` }), 200, 60);
  }
  const ed = await readJson(env.PODCAST_KV, `ai:day:${target}`, null);
  if (!ed) return notFound();
  const pos = index.findIndex((e) => e.day === target);
  const prev = pos >= 0 ? index[pos + 1]?.day : null;
  const next = pos > 0 ? index[pos - 1]?.day : null;
  // Show the newest episode published on or before this edition's day.
  const latestEp = manifest.find((e) => e.id <= target) || null;
  return html(page({
    title: isToday ? `${SITE.name}: ${ed.stories[0]?.headline || ''}` : `${SITE.name}, ${longDate(target, false)}`,
    description: ed.lede,
    active: isToday ? 'today' : '',
    body: editionHtml(ed, { prev, next, latestEp, isToday }),
  }));
}

async function renderArchive(env) {
  const index = await readJson(env.PODCAST_KV, 'ai:index', []);
  const rows = index.map((e) => `<li><span class="d">${esc(shortDate(e.day))}</span><a href="/day/${esc(e.day)}">${esc(e.headline)}</a></li>`).join('');
  return html(page({
    title: `Archive · ${SITE.name}`, active: 'archive',
    body: `<p class="kicker">Archive</p><h1>Every edition</h1>${rows ? `<ul class="list">${rows}</ul>` : '<p class="empty">Nothing here yet.</p>'}`,
  }));
}

function episodeCard(ep, { open = false, script = null } = {}) {
  const covers = (ep.covers || []).map((d) => `<a href="/day/${esc(d)}">${esc(shortDate(d))}</a>`).join(', ');
  return `<article class="ep">
  <div class="meta">${ep.episodeNumber ? `Episode ${ep.episodeNumber} &middot; ` : ''}${esc(longDate(ep.id))} &middot; ${hhmmss(ep.durationSeconds)}</div>
  <h2><a href="/episode/${esc(ep.id)}" style="text-decoration:none">${esc(ep.title)}</a></h2>
  ${ep.blurb ? `<p>${esc(ep.blurb)}</p>` : ''}
  <audio controls preload="none" src="/audio/${esc(ep.id)}.mp3"></audio>
  ${covers ? `<div class="meta" style="margin-top:.5rem">Covers editions: ${covers}</div>` : ''}
  ${script ? `<details${open ? ' open' : ''}><summary>Transcript</summary><div class="transcript">${esc(script)}</div></details>` : `<details><summary><a href="/episode/${esc(ep.id)}">Transcript</a></summary></details>`}
</article>`;
}

async function renderPodcast(env) {
  const manifest = await readJson(env.PODCAST_KV, 'ai:pod:manifest', []);
  const body = `
<p class="kicker">Podcast &middot; Mondays and Thursdays</p>
<h1>${esc(SHOW.title)}</h1>
<p class="lede">${esc(SHOW.subtitle)}</p>
<p>Subscribe in any podcast app with this feed URL. Apple Podcasts: Library &rarr; &hellip; &rarr; Follow a Show by URL. Overcast and Pocket Casts take it directly.</p>
<code class="feed">${SITE.url}/feed.xml</code>
${manifest.length ? manifest.map((ep) => episodeCard(ep)).join('\n') : '<p class="empty">The first episode drops on the next Monday or Thursday morning.</p>'}
<p class="why" style="margin-top:2rem">Scripts are written by Claude from the daily editions on this site, then read by an AI clone of Paul&rsquo;s voice. Every fact traces to a linked source on the matching edition page.</p>`;
  return html(page({ title: `${SHOW.title} · ${SITE.name}`, description: SHOW.subtitle, active: 'podcast', body }));
}

async function renderEpisode(env, id) {
  const ep = await readJson(env.PODCAST_KV, `ai:pod:episode:${id}`, null);
  if (!ep) return notFound();
  // Show notes: every story from the editions this episode covered, with sources.
  const eds = (await Promise.all((ep.covers || []).map((d) => readJson(env.PODCAST_KV, `ai:day:${d}`, null)))).filter(Boolean);
  const notes = eds.map((ed) => `
<h2 style="font-size:1rem;margin:1.5rem 0 .5rem;color:var(--muted)"><a href="/day/${esc(ed.day)}" style="text-decoration:none">${esc(longDate(ed.day))}</a></h2>
<ul class="list">${ed.stories.map((s) => `<li style="display:block"><b>${esc(s.headline)}</b><div class="links">${(s.links || []).map((l) =>
    `<a href="${esc(l.url)}" rel="noopener">${esc(l.source || hostOf(l.url))} &rarr;</a>`).join('')}</div></li>`).join('')}</ul>`).join('');
  return html(page({
    title: `${ep.title} · ${SHOW.title}`, description: ep.blurb || SHOW.subtitle, active: 'podcast',
    body: `<p class="kicker"><a href="/podcast" style="text-decoration:none">${esc(SHOW.title)}</a></p>${episodeCard(ep, { open: false, script: ep.script })}
${notes ? `<p class="kicker" style="margin-top:2rem">Show notes &middot; every story and source</p>${notes}` : ''}`,
  }));
}

function notFound() {
  return html(page({ title: `Not found · ${SITE.name}`, body: '<h1>Not found</h1><p><a href="/">Back to today&rsquo;s edition</a></p>' }), 404, 60);
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/index.html') return renderEdition(env, null, { isToday: true });
    if (path === '/archive') return renderArchive(env);
    if (path === '/podcast') return renderPodcast(env);

    let m;
    if ((m = path.match(/^\/day\/(\d{4}-\d{2}-\d{2})$/))) return renderEdition(env, m[1]);
    if ((m = path.match(/^\/episode\/(\d{4}-\d{2}-\d{2})$/))) return renderEpisode(env, m[1]);

    if (path === '/feed.xml' || path === '/podcast.xml') {
      const manifest = await readJson(env.PODCAST_KV, 'ai:pod:manifest', []);
      return new Response(buildPodcastFeed(manifest), {
        headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
      });
    }
    if (path === '/rss.xml') {
      const index = await readJson(env.PODCAST_KV, 'ai:index', []);
      return new Response(await buildEditionFeed(env, index), {
        headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600', 'access-control-allow-origin': '*' },
      });
    }
    if (path.startsWith('/audio/')) {
      const id = path.slice(7).replace(/\.mp3$/i, '');
      return DAY_RE.test(id) ? serveAudio(request, env, id) : new Response('Not found', { status: 404 });
    }
    if (path.startsWith('/transcript/')) {
      const id = path.slice(12).replace(/\.txt$/i, '');
      if (!DAY_RE.test(id)) return new Response('Not found', { status: 404 });
      const ep = await readJson(env.PODCAST_KV, `ai:pod:episode:${id}`, null);
      if (!ep) return new Response('Not found', { status: 404 });
      return new Response(ep.script || '', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }

    // Anything else: static assets (cover.jpg, favicon.svg), else 404 page.
    const asset = await env.ASSETS.fetch(request);
    return asset.status === 404 ? notFound() : asset;
  },
};
