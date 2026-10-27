/**
 * ai-worker.js  --  the `ai-daily` Worker behind ai.stluker.com
 *
 * Front end. stl-dispatcher writes the content (aiIngest daily at 11:45 UTC,
 * aiPodcast Mon/Wed/Fri at 11:50 UTC) and triggers the newsletter every day
 * (after aiPodcast on M/W/F, after aiIngest otherwise); this Worker renders it from PODCAST_KV /
 * POD_BUCKET at request time, same pattern as pod/space/earth. The one thing
 * it writes is the newsletter subscriber list (ai:news:*), and it mails each
 * edition when stl-dispatcher calls POST /newsletter/send.
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
 *   GET /newsletter          newsletter pitch + signup + sample issue
 *   GET /newsletter/preview  the next email, rendered as it will be sent
 *   POST /subscribe          email -> pending + confirmation mail (double opt-in)
 *   GET|POST /confirm        confirm page (GET) / activate subscription (POST)
 *   GET|POST /unsubscribe    confirm page (GET) / remove (POST, also RFC 8058 one-click)
 *   POST /newsletter/send    Bearer NEWSLETTER_SEND_TOKEN; mails the daily briefing once per day
 *
 * KV keys (all written by stl-dispatcher):
 *   ai:index                [{day, headline, count}] newest first
 *   ai:day:YYYY-MM-DD       {day, lede, stories:[{headline, summary, why, category, importance, links[]}]}
 *   ai:pod:manifest         [episode without script] newest first
 *   ai:pod:episode:YYYY-MM-DD  full episode incl. script
 *
 * KV keys written by this Worker (newsletter):
 *   ai:news:sub:<sha256(email)>      {email, since}, metadata {e: email}
 *   ai:news:pending:<token>          {email, at}, 3-day TTL
 *   ai:news:cool:<sha256(email)>     1h resend cooldown for confirmation mail
 *   ai:news:confirms:YYYY-MM-DD      daily confirmation-mail counter (quota guard)
 *   ai:news:sent:YYYY-MM-DD          {at, sent} once an edition has been mailed
 *
 * Secrets: RESEND_API_KEY, NEWSLETTER_KEY (HMAC for unsubscribe links),
 * NEWSLETTER_SEND_TOKEN (bearer for /newsletter/send).
 */

const SITE = {
  name: 'AI Daily',
  tagline: 'What happened in AI, every morning. No hype.',
  url: 'https://ai.stluker.com',
};

const SHOW = {
  title: 'AI Daily Recap',
  subtitle: 'Five minutes, every Monday, Wednesday and Friday: everything that mattered in AI since last time.',
  description:
    'Every Monday, Wednesday and Friday, Paul Luker walks through the AI news that actually mattered ' +
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
.serif{font-family:Charter,"Iowan Old Style","Palatino Linotype",Georgia,serif}
.signup{display:grid;grid-template-columns:1.15fr 1fr;gap:1.25rem 1.75rem;align-items:center;background:var(--surface);border:1px solid var(--line);border-top:3px solid var(--ink);border-radius:4px 4px 14px 14px;padding:1.4rem 1.5rem;margin:2.5rem 0 0}
.signup h2{font-size:1.45rem;line-height:1.2;letter-spacing:-.01em;margin:.1rem 0 .45rem}
.signup p{margin:0;color:var(--muted);font-size:.95rem}
.signup .kicker{margin:0;color:var(--accent);font-weight:700}
.signup form{display:flex;flex-direction:column;gap:.55rem}
.signup .row{display:flex;gap:.5rem}
.signup input[type=email]{flex:1;min-width:0;font:inherit;font-size:1rem;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:.6rem 1rem}
.signup input[type=email]:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
.signup .btn,.notice .btn{font-family:inherit;padding:.6rem 1.15rem;font-size:.95rem;white-space:nowrap}
.signup .btn[disabled]{opacity:.6;cursor:default}
.signup .fine{font-size:.8rem}
.signup .msg{font-size:.95rem;color:var(--ink);margin:0}
.signup .msg.err{color:#c0392b}
.signup.wide{grid-template-columns:1fr;margin:0 0 2.5rem}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.perks{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin:0 0 2.5rem}
.perks div{border-top:1px solid var(--line);padding-top:.8rem}
.perks h3{font-size:1rem;margin:0 0 .3rem}
.perks p{margin:0;color:var(--muted);font-size:.92rem}
.sample{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#f7f6f2}
.sample iframe{display:block;width:100%;height:760px;border:0}
.notice{max-width:32rem}
.notice form{margin-top:1.2rem}
@media (max-width:640px){.signup{grid-template-columns:1fr}.perks{grid-template-columns:1fr}}
@media (max-width:520px){nav a{margin-left:0;margin-right:1rem}.list li{flex-direction:column;gap:.1rem}.pod{flex-direction:column;align-items:stretch}.signup .row{flex-direction:column}.sample iframe{height:620px}}
`;

// Progressive enhancement for .signup forms: without JS they POST and get a
// full result page; with JS the card answers in place.
const SIGNUP_JS = `document.querySelectorAll('form[data-signup]').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var b=f.querySelector('button'),m=f.querySelector('.msg');b.disabled=true;m.className='msg';m.textContent='Sending\\u2026';fetch(f.action,{method:'POST',body:new FormData(f),headers:{accept:'application/json'}}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){m.textContent=x.j.message;if(x.ok){f.querySelector('.row').remove();}else{m.className='msg err';b.disabled=false;}}).catch(function(){m.className='msg err';m.textContent='Something went wrong. Please try again.';b.disabled=false;});});});`;

function signupForm() {
  return `<form method="post" action="/subscribe" data-signup>
    <div class="row">
      <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" aria-label="Email address">
      <button class="btn" type="submit">Subscribe</button>
    </div>
    <label class="hp" aria-hidden="true">Leave blank <input type="text" name="website" tabindex="-1" autocomplete="off"></label>
    <p class="msg" role="status" aria-live="polite"></p>
    <p class="fine">Free. One email every morning. We send one message to confirm; unsubscribe in one click.</p>
  </form>`;
}

function signupCard({ wide = false } = {}) {
  return `<section class="signup${wide ? ' wide' : ''}" aria-label="Subscribe to the newsletter">
  ${wide ? '' : `<div>
    <p class="kicker">The morning briefing</p>
    <h2 class="serif">Get this edition in your inbox, every morning</h2>
    <p>Every story, why it matters, and the source links. In your inbox by about 7&nbsp;a.m. Central. <a href="/newsletter">See a sample</a>.</p>
  </div>`}
  ${signupForm()}
</section>`;
}

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
  <nav>${navLink('/', 'Today', 'today')}${navLink('/newsletter', 'Newsletter', 'newsletter')}${navLink('/podcast', 'Podcast', 'podcast')}${navLink('/archive', 'Archive', 'archive')}</nav>
</div></header>
<main><div class="wrap">${body}</div></main>
<footer><div class="wrap">
  ${esc(SITE.name)} is assembled automatically each morning from public AI news sources and Hacker News, then edited by Claude. Every story links to its sources; read them before quoting anything.
  <br><a href="/newsletter">Email newsletter</a> &middot; <a href="/rss.xml">Daily RSS</a> &middot; <a href="/feed.xml">Podcast feed</a> &middot; <a href="https://stluker.com">stluker.com</a>
</div></footer>
<script>${SIGNUP_JS}</script>
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
${signupCard()}
<nav class="daynav">
  <span>${prev ? `<a href="/day/${prev}">&larr; ${esc(shortDate(prev))}</a>` : ''}</span>
  <span>${next ? `<a href="/day/${next}">${esc(shortDate(next))} &rarr;</a>` : ''}</span>
</nav>`;
}

// ── newsletter: email template ─────────────────────────────────────────────
// Wire-report layout: masthead + dateline, the lead, an index of headlines,
// then numbered briefs with a "why it matters" line and sources. Tables and
// inline styles only (Gmail/Outlook strip <style>); system fonts only.
const NEWS = {
  from: `${SITE.name} <news@stluker.com>`,
  replyTo: SHOW.email,
  confirmTtl: 3 * 86400,
  cooldown: 3600,
  dailyConfirmCap: 20,  // protects the shared Resend quota from signup spam (was 300 until 2026-10-16)
  batchSize: 100,       // Resend /emails/batch maximum
};
const E = {
  serif: "Georgia,'Times New Roman',Times,serif",
  sans: "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
  ink: '#16171a', muted: '#5f6570', line: '#e3e1da', bg: '#f7f6f2', accent: '#4b3fe0', soft: '#f3f2fd',
};
const UNSUB = '%%UNSUBSCRIBE_URL%%';

function readingMinutes(ed) {
  const words = [ed.lede, ...ed.stories.flatMap((s) => [s.headline, s.summary, s.why])].join(' ').split(/\s+/).length;
  return Math.max(1, Math.round(words / 230));
}

function emailShell({ preheader, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(SITE.name)}</title></head>
<body style="margin:0;padding:0;background:${E.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${E.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;background:#ffffff;border:1px solid ${E.line}">
${body}
</table>
</td></tr></table>
</body></html>`;
}

// `ed` comes from buildRoundup(): normally one day's edition (daily since
// 2026-10-27); after a missed send, several editions merged, each story
// tagged with its `day`. `episode`, when given (M/W/F), adds a "Listen to
// today's episode" block.
function renderIssue(ed, { issueNo = null, episode = null } = {}) {
  const webUrl = episode ? `${SITE.url}/episode/${ed.day}` : `${SITE.url}/day/${ed.day}`;
  const episodeUrl = `${SITE.url}/episode/${ed.day}`;
  const n = ed.stories.length;
  const multiDay = (ed.days || []).length > 1;
  const top = ed.stories[0];
  const subject = `${top?.headline || 'Today in AI'}${n > 1 ? ` (+${n - 1} more)` : ''}`;
  const label = (t) => `<div style="font-family:${E.sans};font-size:11px;line-height:16px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${E.accent}">${t}</div>`;
  const rule = `<tr><td style="padding:0 32px"><div style="border-top:1px solid ${E.line};height:1px;line-height:1px">&nbsp;</div></td></tr>`;

  const index = ed.stories.map((s, i) => `<tr>
    <td valign="top" style="width:28px;padding:5px 0;font-family:${E.sans};font-size:12px;line-height:20px;font-weight:700;color:${E.muted}">${String(i + 1).padStart(2, '0')}</td>
    <td valign="top" style="padding:5px 0;font-family:${E.sans};font-size:15px;line-height:20px;color:${E.ink}">${esc(s.headline)} <span style="color:${E.muted};font-size:12px">&middot; ${esc(s.category)}</span></td>
  </tr>`).join('');

  const stories = ed.stories.map((s, i) => {
    const sources = (s.links || []).map((l) =>
      `<a href="${esc(l.url)}" style="color:${E.accent};text-decoration:none">${esc(l.source || hostOf(l.url))}</a>` +
      (l.discussion ? ` &middot; <a href="${esc(l.discussion)}" style="color:${E.accent};text-decoration:none">HN discussion</a>` : '')).join(' &middot; ');
    return `<tr><td style="padding:${i === 0 ? '8px' : '26px'} 32px 0">
    <div style="font-family:${E.sans};font-size:11px;line-height:16px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${E.muted}">${i === 0 ? `<span style="color:${E.accent}">Top story</span> &middot; ` : `${String(i + 1).padStart(2, '0')} &middot; `}${esc(s.category)}${s.day ? ` &middot; ${esc(shortDate(s.day))}` : ''}</div>
    <h2 style="margin:6px 0 10px;font-family:${E.serif};font-size:${i === 0 ? 26 : 21}px;line-height:1.25;font-weight:700;color:${E.ink}">${esc(s.headline)}</h2>
    <p style="margin:0 0 12px;font-family:${E.sans};font-size:16px;line-height:26px;color:${E.ink}">${esc(s.summary)}</p>
    ${s.why ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-left:3px solid ${E.accent};background:${E.soft};padding:10px 14px;font-family:${E.sans};font-size:15px;line-height:23px;color:${E.ink}"><b>Why it matters:</b> ${esc(s.why)}</td></tr></table>` : ''}
    ${sources ? `<p style="margin:10px 0 0;font-family:${E.sans};font-size:13px;line-height:20px;color:${E.muted}">Sources: ${sources}</p>` : ''}
    ${i < n - 1 ? `<div style="border-top:1px solid ${E.line};height:1px;line-height:1px;margin-top:26px">&nbsp;</div>` : ''}
  </td></tr>`;
  }).join('');

  const body = `
<tr><td style="padding:14px 32px 0;font-family:${E.sans};font-size:12px;line-height:18px;color:${E.muted}" align="right"><a href="${webUrl}" style="color:${E.muted}">Read on the web</a></td></tr>
<tr><td style="padding:10px 32px 0" align="center">
  <div style="font-family:${E.serif};font-size:38px;line-height:44px;font-weight:700;letter-spacing:-.01em;color:${E.ink}">${esc(SITE.name)}</div>
  <div style="font-family:${E.sans};font-size:12px;line-height:18px;color:${E.muted};margin-top:2px">${esc(SITE.tagline)}</div>
</td></tr>
<tr><td style="padding:16px 32px 0"><div style="border-top:3px double ${E.ink};height:0;line-height:0">&nbsp;</div></td></tr>
<tr><td style="padding:8px 32px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="font-family:${E.sans};font-size:11px;line-height:16px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${E.ink}">${esc(longDate(ed.day))}</td>
    <td align="right" style="font-family:${E.sans};font-size:11px;line-height:16px;letter-spacing:.1em;text-transform:uppercase;color:${E.muted}">${issueNo ? `No. ${issueNo} &middot; ` : ''}${n} stories &middot; ${readingMinutes(ed)} min read</td>
  </tr></table>
</td></tr>
<tr><td style="padding:8px 32px 0"><div style="border-top:1px solid ${E.ink};height:0;line-height:0">&nbsp;</div></td></tr>
<tr><td style="padding:26px 32px 0">
  ${label('The lead')}
  <p style="margin:8px 0 0;font-family:${E.serif};font-size:20px;line-height:31px;color:${E.ink}">${esc(ed.lede)}</p>
</td></tr>
${episode ? `<tr><td style="padding:22px 32px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${E.soft};border-left:3px solid ${E.accent};padding:14px 18px;font-family:${E.sans};font-size:15px;line-height:23px;color:${E.ink}">
    ${label('Listen to today&rsquo;s episode')}
    <div style="margin-top:6px"><b>${esc(episode.title || SHOW.title)}</b>${episode.durationSeconds ? ` <span style="color:${E.muted}">&middot; ${hhmmss(episode.durationSeconds)}</span>` : ''}</div>
    <div style="margin-top:6px"><a href="${episodeUrl}" style="color:${E.accent};text-decoration:none;font-weight:700">Listen to today&rsquo;s episode &rarr;</a></div>
  </td></tr></table>
</td></tr>` : ''}
<tr><td style="padding:24px 32px 20px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${E.bg}"><tr><td style="padding:14px 18px">
    ${label(multiDay ? 'In this roundup' : 'In this edition')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px">${index}</table>
  </td></tr></table>
</td></tr>
${rule}
${stories}
<tr><td style="padding:30px 32px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border:1px solid ${E.line};padding:14px 18px;font-family:${E.sans};font-size:14px;line-height:22px;color:${E.ink}">
    <b>Prefer to listen?</b> ${esc(SHOW.title)} covers all of this in about five minutes every Monday, Wednesday and Friday. <a href="${SITE.url}/podcast" style="color:${E.accent};text-decoration:none">Listen or subscribe &rarr;</a>
  </td></tr></table>
</td></tr>
<tr><td style="padding:28px 32px 30px;font-family:${E.sans};font-size:12px;line-height:19px;color:${E.muted}">
  <div style="border-top:1px solid ${E.line};padding-top:18px">
  ${esc(SITE.name)} is assembled each morning from public AI news sources and Hacker News, then written up by Claude, an AI model. Every story links to its sources; check them before quoting anything.<br><br>
  You are receiving this because you subscribed at <a href="${SITE.url}" style="color:${E.muted}">ai.stluker.com</a>.
  <a href="${UNSUB}" style="color:${E.muted}">Unsubscribe</a> &middot; <a href="${SITE.url}/archive" style="color:${E.muted}">Archive</a> &middot; <a href="https://stluker.com" style="color:${E.muted}">stluker.com</a>
  </div>
</td></tr>`;

  const text = [
    `${SITE.name.toUpperCase()} | ${longDate(ed.day)}${issueNo ? ` | No. ${issueNo}` : ''}`,
    `Read on the web: ${webUrl}`,
    '',
    'THE LEAD',
    ed.lede,
    '',
    ...(episode ? ["LISTEN TO TODAY'S EPISODE", `${episode.title || SHOW.title}: ${episodeUrl}`, ''] : []),
    multiDay ? 'IN THIS ROUNDUP' : 'IN THIS EDITION',
    ...ed.stories.map((s, i) => `${String(i + 1).padStart(2, '0')}  ${s.headline}`),
    '',
    ...ed.stories.flatMap((s, i) => [
      '------------------------------------------------------------',
      `${i === 0 ? 'TOP STORY' : String(i + 1).padStart(2, '0')} | ${String(s.category || '').toUpperCase()}${s.day ? ` | ${shortDate(s.day)}` : ''}`,
      s.headline,
      '',
      s.summary,
      ...(s.why ? ['', `Why it matters: ${s.why}`] : []),
      ...((s.links || []).length ? ['', 'Sources:', ...s.links.map((l) => `  ${l.source || hostOf(l.url)}: ${l.url}`)] : []),
      '',
    ]),
    '------------------------------------------------------------',
    `Prefer to listen? ${SHOW.title}, Mondays, Wednesdays and Fridays: ${SITE.url}/podcast`,
    '',
    `${SITE.name} is assembled from public AI news sources and written up by Claude, an AI model. Check the sources before quoting.`,
    `Unsubscribe: ${UNSUB}`,
  ].join('\n');

  return { subject, html: emailShell({ preheader: ed.lede, body }), text };
}

function renderConfirmEmail(confirmUrl) {
  const body = `
<tr><td style="padding:28px 32px 0" align="center"><div style="font-family:${E.serif};font-size:30px;line-height:36px;font-weight:700;color:${E.ink}">${esc(SITE.name)}</div></td></tr>
<tr><td style="padding:14px 32px 0"><div style="border-top:3px double ${E.ink};height:0;line-height:0">&nbsp;</div></td></tr>
<tr><td style="padding:24px 32px 8px;font-family:${E.sans};font-size:16px;line-height:26px;color:${E.ink}">
  <p style="margin:0 0 14px">One click and you're on the list for the ${esc(SITE.name)} morning briefing: every story, why it matters, and the source links, every morning by about 7 a.m. Central.</p>
  <p style="margin:22px 0" align="center"><a href="${confirmUrl}" style="display:inline-block;background:${E.accent};color:#ffffff;text-decoration:none;font-weight:700;border-radius:999px;padding:12px 26px">Confirm my subscription</a></p>
  <p style="margin:0;font-size:13px;line-height:20px;color:${E.muted}">The link works for three days. If you didn't ask for this, ignore this email and nothing will happen.</p>
</td></tr>
<tr><td style="padding:16px 32px 28px"></td></tr>`;
  return {
    subject: `Confirm your ${SITE.name} subscription`,
    html: emailShell({ preheader: 'One click to start the morning briefing.', body }),
    text: `Confirm your ${SITE.name} subscription:\n${confirmUrl}\n\nThe link works for three days. If you didn't ask for this, ignore this email.`,
  };
}

// ── newsletter: subscribers + sending ──────────────────────────────────────
const enc = new TextEncoder();
function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  try {
    const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return ''; }
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function randomToken() { const a = new Uint8Array(24); crypto.getRandomValues(a); return b64url(a); }
function normalizeEmail(s) {
  const e = String(s || '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : '';
}
const subKey = async (email) => `ai:news:sub:${await sha256hex(email)}`;
async function unsubscribeUrl(env, email) {
  return `${SITE.url}/unsubscribe?e=${b64url(enc.encode(email))}&t=${await hmac(env.NEWSLETTER_KEY, `unsub:${email}`)}`;
}

async function resend(env, path, payload, idempotencyKey) {
  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.resend.com${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[newsletter] Resend ${path} ${res.status}: ${detail.slice(0, 300)}`);
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

// One response helper for both the JS card (JSON) and no-JS form posts (page).
function signupReply(request, status, title, message) {
  if ((request.headers.get('accept') || '').includes('application/json')) {
    return new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  return noticePage(title, `<p>${esc(message)}</p><p><a href="/">&larr; Back to today&rsquo;s edition</a></p>`, status);
}
function noticePage(title, inner, status = 200) {
  const r = html(page({ title: `${title} · ${SITE.name}`, active: 'newsletter', body: `<div class="notice"><p class="kicker">Newsletter</p><h1 class="serif">${esc(title)}</h1>${inner}</div>` }), status);
  r.headers.set('cache-control', 'no-store');
  return r;
}

async function handleSubscribe(request, env) {
  let form;
  try { form = await request.formData(); } catch { return signupReply(request, 400, 'Something went wrong', 'That request could not be read. Please try again.'); }
  const checkInbox = 'Check your inbox: we just sent a link to confirm your subscription. It works for three days.';
  if (form.get('website')) return signupReply(request, 200, 'Check your inbox', checkInbox); // honeypot
  const email = normalizeEmail(form.get('email'));
  if (!email) return signupReply(request, 400, 'Check that address', 'That doesn’t look like an email address. Please check it and try again.');
  if (!env.RESEND_API_KEY || !env.NEWSLETTER_KEY) {
    return signupReply(request, 503, 'Not open yet', 'Signups aren’t open just yet. Please check back soon.');
  }

  const kv = env.PODCAST_KV;
  const hash = await sha256hex(email);
  // Already subscribed, or a confirmation went out within the hour: answer
  // the same way and send nothing, so the form can't be used to probe or spam.
  const [existing, cooling] = await Promise.all([kv.get(`ai:news:sub:${hash}`), kv.get(`ai:news:cool:${hash}`)]);
  if (existing || cooling) return signupReply(request, 200, 'Check your inbox', checkInbox);

  const today = new Date().toISOString().slice(0, 10);
  const capKey = `ai:news:confirms:${today}`;
  const sentToday = Number(await kv.get(capKey)) || 0;
  if (sentToday >= NEWS.dailyConfirmCap) {
    return signupReply(request, 429, 'Try again tomorrow', 'We’ve hit today’s signup limit. Please try again tomorrow.');
  }

  const token = randomToken();
  const mail = renderConfirmEmail(`${SITE.url}/confirm?t=${token}`);
  const sent = await resend(env, '/emails', { from: NEWS.from, to: [email], reply_to: NEWS.replyTo, ...mail });
  if (!sent.ok) return signupReply(request, 502, 'Something went wrong', 'We couldn’t send the confirmation email. Please try again in a few minutes.');

  await Promise.all([
    kv.put(`ai:news:pending:${token}`, JSON.stringify({ email, at: new Date().toISOString() }), { expirationTtl: NEWS.confirmTtl }),
    kv.put(`ai:news:cool:${hash}`, '1', { expirationTtl: NEWS.cooldown }),
    kv.put(capKey, String(sentToday + 1), { expirationTtl: 2 * 86400 }),
  ]);
  return signupReply(request, 200, 'Check your inbox', checkInbox);
}

// GET shows a button and only POST activates, so mail scanners that follow
// every link can't confirm a signup someone else typed in.
async function handleConfirm(request, env, url) {
  const kv = env.PODCAST_KV;
  let token = url.searchParams.get('t') || '';
  if (request.method === 'POST') { try { token = (await request.formData()).get('t') || token; } catch {} }
  const expired = () => noticePage('That link has expired', '<p>Confirmation links work for three days and only once. You can sign up again on the <a href="/newsletter">newsletter page</a>.</p>', 404);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return expired();
  const pending = await readJson(kv, `ai:news:pending:${token}`, null);
  if (!pending?.email) return expired();

  if (request.method !== 'POST') {
    return noticePage('One more click', `<p>Confirm that <b>${esc(pending.email)}</b> should get the ${esc(SITE.name)} morning briefing.</p>
<form method="post" action="/confirm"><input type="hidden" name="t" value="${esc(token)}"><button class="btn" type="submit">Confirm my subscription</button></form>`);
  }
  const email = pending.email;
  await kv.put(await subKey(email), JSON.stringify({ email, since: new Date().toISOString() }), { metadata: { e: email } });
  await kv.delete(`ai:news:pending:${token}`);
  return noticePage('You’re on the list', `<p>Your first briefing arrives tomorrow morning, by about 7&nbsp;a.m. Central. Every email has a one-click unsubscribe link at the bottom.</p>
<p><a class="btn" href="/">Read today&rsquo;s edition now</a></p>`);
}

async function handleUnsubscribe(request, env, url) {
  const email = normalizeEmail(fromB64url(url.searchParams.get('e') || ''));
  const sig = url.searchParams.get('t') || '';
  const valid = email && env.NEWSLETTER_KEY && safeEqual(sig, await hmac(env.NEWSLETTER_KEY, `unsub:${email}`));
  if (!valid) return noticePage('That link doesn’t work', `<p>The unsubscribe link looks incomplete. Use the link at the bottom of any ${esc(SITE.name)} email, or reply to one and ask.</p>`, 400);
  if (request.method === 'POST') {
    // Also serves RFC 8058 one-click (List-Unsubscribe-Post) from mail clients.
    await env.PODCAST_KV.delete(await subKey(email));
    return noticePage('You’re unsubscribed', `<p><b>${esc(email)}</b> won&rsquo;t get any more emails from ${esc(SITE.name)}. The site is still here whenever you want it.</p><p><a href="/">&larr; Today&rsquo;s edition</a></p>`);
  }
  return noticePage('Unsubscribe?', `<p>Stop sending the ${esc(SITE.name)} morning briefing to <b>${esc(email)}</b>?</p>
<form method="post" action="/unsubscribe?${esc(url.searchParams.toString())}"><button class="btn" type="submit">Unsubscribe</button></form>`);
}

async function listSubscribers(kv) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'ai:news:sub:', cursor });
    for (const k of page.keys) if (k.metadata?.e) out.push(k.metadata.e);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort();
}

// ── What the next email covers (roundup ADDED 2026-10-16, daily 2026-10-27) ─
// Days: every ai:index day after the most recent ai:news:sent:<d> (d < day),
// up to and including <day>, capped at ROUNDUP_MAX_DAYS. Sent daily, that is
// just <day>; after a missed send it catches up. The podcast episode's
// `covers` is deliberately NOT used: those days were already mailed. The
// episode (M/W/F) only adds the "listen" block. Stories are merged, deduped
// by first link URL (fallback: normalized headline), sorted by importance
// desc then newest day, capped at ROUNDUP_MAX_STORIES.
const ROUNDUP_MAX_DAYS = 5;
const ROUNDUP_MAX_STORIES = 12;

async function buildRoundup(kv, day, index) {
  const episode = await readJson(kv, `ai:pod:episode:${day}`, null);
  let lastSent = null;
  let cursor;
  do {
    const page = await kv.list({ prefix: 'ai:news:sent:', cursor });
    for (const k of page.keys) {
      const d = k.name.slice('ai:news:sent:'.length);
      if (DAY_RE.test(d) && d < day && (!lastSent || d > lastSent)) lastSent = d;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  let days = index.map((e) => e.day).filter((d) => d <= day && (!lastSent || d > lastSent));
  days = [...new Set(days)].sort().slice(-ROUNDUP_MAX_DAYS);
  if (!days.includes(day) && index.some((e) => e.day === day)) days = [...days.slice(-(ROUNDUP_MAX_DAYS - 1)), day];

  const eds = (await Promise.all(days.map((d) => readJson(kv, `ai:day:${d}`, null)))).filter((e) => e?.stories?.length);
  if (!eds.length) return null;

  const normHeadline = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  // Per-story date tags only make sense when the email spans several days.
  const all = eds.flatMap((ed) => ed.stories.map((s) => (eds.length > 1 ? { ...s, day: ed.day } : { ...s })))
    .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0) || (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const seen = new Set();
  const stories = [];
  for (const s of all) {
    const key = s.links?.[0]?.url ? `u:${s.links[0].url}` : `h:${normHeadline(s.headline)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stories.push(s);
    if (stories.length >= ROUNDUP_MAX_STORIES) break;
  }
  const newest = eds.reduce((a, b) => (a.day > b.day ? a : b));
  return {
    // newsletterLede summarizes the episode's multi-day span; a one-day email
    // uses that day's own lede.
    ed: { day, lede: (eds.length > 1 && episode?.newsletterLede) || newest.lede, stories, days: eds.map((e) => e.day) },
    episode,
  };
}

// Issue number = how many roundups went out before <day>, plus one.
async function roundupIssueNo(kv, day) {
  let n = 0;
  let cursor;
  do {
    const page = await kv.list({ prefix: 'ai:news:sent:', cursor });
    n += page.keys.filter((k) => k.name.slice('ai:news:sent:'.length) < day).length;
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return n + 1;
}

// POST /newsletter/send  (Bearer NEWSLETTER_SEND_TOKEN)
//   ?day=YYYY-MM-DD   roundup to send (default: newest edition day)
//   ?test=addr        send only to addr; doesn't mark the edition sent
//   ?dry=1            count recipients, send nothing
//   ?force=1          send even if this edition was already mailed
// Idempotent: each edition is mailed once (ai:news:sent:<day>), and each
// batch carries a Resend Idempotency-Key so a retried call can't double-send.
async function handleSend(request, env, url) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const auth = request.headers.get('authorization') || '';
  if (!env.NEWSLETTER_SEND_TOKEN || !safeEqual(auth, `Bearer ${env.NEWSLETTER_SEND_TOKEN}`)) return json({ error: 'unauthorized' }, 401);
  if (!env.RESEND_API_KEY || !env.NEWSLETTER_KEY) return json({ error: 'RESEND_API_KEY or NEWSLETTER_KEY not set' }, 503);

  const kv = env.PODCAST_KV;
  const index = await readJson(kv, 'ai:index', []);
  const day = url.searchParams.get('day') || index[0]?.day;
  if (!day || !DAY_RE.test(day)) return json({ error: 'no edition' }, 404);
  const roundup = await buildRoundup(kv, day, index);
  if (!roundup?.ed?.stories?.length) return json({ error: `no editions to send for ${day}` }, 404);
  const { ed, episode } = roundup;

  const test = normalizeEmail(url.searchParams.get('test'));
  const dry = url.searchParams.get('dry') === '1';
  const force = url.searchParams.get('force') === '1';
  const sentKey = `ai:news:sent:${day}`;
  if (!test && !force) {
    const prior = await readJson(kv, sentKey, null);
    if (prior) return json({ skipped: 'already sent', day, ...prior });
  }

  const recipients = test ? [test] : await listSubscribers(kv);
  if (dry) return json({ dry: true, day, recipients: recipients.length, days: ed.days, stories: ed.stories.length, episode: !!episode });
  if (!recipients.length) return json({ day, sent: 0, note: 'no subscribers' });

  const issue = renderIssue(ed, { issueNo: await roundupIssueNo(kv, day), episode });
  let sent = 0, failed = 0;
  for (let i = 0; i < recipients.length; i += NEWS.batchSize) {
    const chunk = recipients.slice(i, i + NEWS.batchSize);
    const emails = await Promise.all(chunk.map(async (to) => {
      const unsub = await unsubscribeUrl(env, to);
      return {
        from: NEWS.from, to: [to], reply_to: NEWS.replyTo,
        subject: issue.subject,
        html: issue.html.replaceAll(UNSUB, esc(unsub)),
        text: issue.text.replaceAll(UNSUB, unsub),
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      };
    }));
    const r = await resend(env, '/emails/batch', emails, test ? null : `ai-news-${day}-${i / NEWS.batchSize}`);
    if (r.ok) sent += chunk.length; else failed += chunk.length;
    if (i + NEWS.batchSize < recipients.length) await new Promise((res) => setTimeout(res, 600)); // Resend rate limit
  }
  const result = { day, sent, failed, at: new Date().toISOString() };
  if (!test && !failed) await kv.put(sentKey, JSON.stringify(result), { expirationTtl: 60 * 86400 });
  return json(result, failed && !sent ? 502 : 200);
}

async function renderNewsletter(env) {
  const index = await readJson(env.PODCAST_KV, 'ai:index', []);
  const body = `
<p class="kicker">Newsletter &middot; Every morning</p>
<h1 class="serif">The ${esc(SITE.name)} morning briefing</h1>
<p class="lede">One email every morning, by about 7&nbsp;a.m. Central: what happened in AI, why it matters, and a link to every source. Written like a wire report, not a hype thread.</p>
${signupCard({ wide: true })}
<div class="perks">
  <div><h3>Reported, not hyped</h3><p>A short lead, then each story in plain language: what happened, and why it matters.</p></div>
  <div><h3>Every claim sourced</h3><p>Each story links to the original reporting so you can check it yourself.</p></div>
  <div><h3>Two-minute scan</h3><p>An index up top shows the whole edition at a glance. Read what you need, skip the rest.</p></div>
</div>
${index.length ? `<p class="kicker">Sample &middot; the latest edition, as it arrives</p>
<div class="sample"><iframe src="/newsletter/preview" title="Sample ${esc(SITE.name)} email" loading="lazy"></iframe></div>
<p class="why" style="margin-top:.8rem"><a href="/newsletter/preview">Open the sample in its own tab &rarr;</a></p>` : ''}
<p class="why" style="margin-top:2rem">Editions are assembled automatically from public AI news sources and written up by Claude, an AI model. Your address is used only to send this newsletter, and every email has a one-click unsubscribe.</p>`;
  return html(page({ title: `Newsletter · ${SITE.name}`, description: 'The AI Daily morning briefing: every story, why it matters, and the sources, in your inbox every morning.', active: 'newsletter', body }));
}

async function renderPreview(env, url) {
  const index = await readJson(env.PODCAST_KV, 'ai:index', []);
  const q = url.searchParams.get('day');
  const day = q && DAY_RE.test(q) ? q : index[0]?.day;
  // Same roundup handleSend() would mail for this day.
  const roundup = day ? await buildRoundup(env.PODCAST_KV, day, index) : null;
  if (!roundup?.ed?.stories?.length) return notFound();
  const { html: body } = renderIssue(roundup.ed, { issueNo: await roundupIssueNo(env.PODCAST_KV, day), episode: roundup.episode });
  return html(body.replaceAll(UNSUB, '/newsletter'));
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
      <itunes:image href="${xmlEscape(SHOW.imageUrl)}"/>
      <podcast:transcript url="${SITE.url}/transcript/${xmlEscape(ep.id)}.txt" type="text/plain"/>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:podcast="https://podcastindex.org/namespace/1.0">
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
    <podcast:guid>e9335dfe-01c4-5a9d-9714-0933ae5952de</podcast:guid>
    <podcast:locked owner="${xmlEscape(SHOW.email)}">yes</podcast:locked>
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
<p class="kicker">Podcast &middot; Mondays, Wednesdays and Fridays</p>
<h1>${esc(SHOW.title)}</h1>
<p class="lede">${esc(SHOW.subtitle)}</p>
<p>Subscribe in any podcast app with this feed URL. Apple Podcasts: Library &rarr; &hellip; &rarr; Follow a Show by URL. Overcast and Pocket Casts take it directly.</p>
<code class="feed">${SITE.url}/feed.xml</code>
${manifest.length ? manifest.map((ep) => episodeCard(ep)).join('\n') : '<p class="empty">The first episode drops on the next Monday, Wednesday or Friday morning.</p>'}
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
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // The only routes that take POST.
    if (path === '/subscribe' && request.method === 'POST') return handleSubscribe(request, env);
    if (path === '/confirm' && (request.method === 'GET' || request.method === 'POST')) return handleConfirm(request, env, url);
    if (path === '/unsubscribe' && (request.method === 'GET' || request.method === 'POST')) return handleUnsubscribe(request, env, url);
    if (path === '/newsletter/send' && request.method === 'POST') return handleSend(request, env, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (path === '/subscribe') return Response.redirect(`${SITE.url}/newsletter`, 302);

    if (path === '/' || path === '/index.html') return renderEdition(env, null, { isToday: true });
    if (path === '/archive') return renderArchive(env);
    if (path === '/podcast') return renderPodcast(env);
    if (path === '/newsletter') return renderNewsletter(env);
    if (path === '/newsletter/preview') return renderPreview(env, url);

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
