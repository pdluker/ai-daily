# ai.stluker.com: "AI Daily" + "AI Daily Recap"

A daily AI news page (web only), plus a short recap podcast and an email
roundup every Monday, Wednesday and Friday, the podcast read in Paul's own
cloned voice. Added 2026-10-04; Mon/Thu podcast and daily email until
2026-10-16.

```
stl-dispatcher
  45 11 * * *        aiIngest   (ai-ingest.js)
                       |- 10 AI feeds + Hacker News (fetchSource, parallel)
                       |- 1x Claude (claude-sonnet-5-5): lede + 4-10 stories
                       |- audit: stories must cite real candidate ids;
                       |         links come from the feeds, never from the model
                       '- KV  ai:day:YYYY-MM-DD, ai:index
  50 11 * * MON,WED,FRI  aiPodcast  (ai-podcast.js) -> then the email roundup
                       |- editions since the last episode
                       |    Mon -> Sat/Sun/Mon editions (news Fri..Sun)
                       |    Wed -> Tue/Wed editions     (news Mon..Tue)
                       |    Fri -> Thu/Fri editions     (news Wed..Thu)
                       |- 1x Claude: ~600-word first-person script + newsletterLede,
                       |    lint, one revise pass, fact audit
                       |- live ElevenLabs balance gate (protects Earth and Orbit)
                       |- ElevenLabs TTS, voice = ELEVENLABS_AI_VOICE_ID
                       |- R2 pod-audio/ai/episodes/*.mp3, KV ai:pod:*
                       '- POST ai.stluker.com/newsletter/send (runs even if the
                          episode is skipped or TTS fails)

ai-daily Worker (this folder, ai.stluker.com), read-only
  /  /day/:date  /archive  /podcast  /episode/:date
  /feed.xml (podcast)  /rss.xml (daily)  /audio/:date.mp3 (Range)  /transcript/:date.txt
```

There are no new KV namespaces or R2 buckets. The site reuses `PODCAST_KV` and
`pod-audio`, with everything stored under the `ai:` / `ai/` prefixes. That means
there is no placeholder ID to forget to replace.

## Costs

| Line item | Monthly |
|---|---|
| Claude, daily edition (~30 calls, ~6k in / ~3k out incl. thinking) | ~$3-5 |
| Claude, recap scripts (~13 episodes, 2-3 calls each incl. fact audit) | ~$2 |
| ElevenLabs, ~13 episodes x ~1,800 credits (Flash, ~600 words) | ~23k credits on the existing plan |
| Cloudflare | $0 extra |

### ElevenLabs: read this first

When this launched, Earth and Orbit used about 84k of the Creator plan's 100k
credits per month, so adding the recap went over 100k. Earth and Orbit was cut
to about 400 words on 2026-10-09 (stl-dispatcher `8c6bb00`), which should leave
room for the M/W/F recap, but that hasn't been measured over a full billing
cycle yet. Either way, `aiPodcast` checks the **real** account balance (`GET /v1/user/subscription`)
before every episode. It only goes ahead if the remaining credits can still
cover Earth and Orbit until the next reset (2,800/day + 3,000 safety). When
credits are short, the last recaps of a billing cycle are skipped (the email
roundup still goes out). They show up as `skipped: "ElevenLabs budget..."` in the diagnostics; this is
not an error. To get every episode, either:

- move to ElevenLabs Pro, or
- lower Earth and Orbit's length or `MONTHLY_CREDIT_BUDGET` in `podcast-ingest.js`.

If the API key can't read the subscription endpoint (it needs the `user_read`
permission), the gate falls back to its own 19k/month ledger in `ai:pod:credits`
(`FALLBACK_MONTHLY_BUDGET` in `ai-podcast.js`; not yet resized for M/W/F).

## Setup: your voice (do this first, in ElevenLabs)

1. ElevenLabs → Voices → **Add a new voice** → **Professional Voice Clone**
   (included on Creator). Upload 30+ minutes of clean solo speech. Reading old
   Earth and Orbit transcripts aloud works well. Verification and training take
   a few hours. An **Instant Voice Clone** (1-2 minutes of audio, ready right
   away) also works if you want to launch today, but it sounds noticeably less
   like you.
2. Copy the new voice's **Voice ID**.

## Deploy runbook

```powershell
# 1. Dispatcher: new secret + the two new crons
cd C:\Users\pdluk\stl-dispatcher
wrangler secret put ELEVENLABS_AI_VOICE_ID     # paste your clone's voice ID
wrangler deploy

# 2. Seed the first edition now instead of waiting for 11:45 UTC
curl.exe -X POST "https://dispatch.stluker.com/trigger?includeAi=true" -H "Authorization: Bearer <DISPATCH_SECRET>"

# 3. Read-check a script WITHOUT spending ElevenLabs credits
curl.exe -X POST "https://dispatch.stluker.com/trigger?includeAiPod=true&forceAiPod=true&aiPodDryRun=true" -H "Authorization: Bearer <DISPATCH_SECRET>"

# 4. Site Worker -- FROM THIS FOLDER, never from public\
cd C:\Users\pdluk\ai-daily
npm install
wrangler deploy        # creates the ai.stluker.com custom domain from wrangler.jsonc
```

> Run `wrangler deploy` from `ai-daily\`, never from `ai-daily\public\` (the
> `.wrangler` cache leak from Jul 14 / Jul 23). `public\.assetsignore` already
> contains `.wrangler/`; confirm with `Get-ChildItem -Force public`.

Then:

- Put a 3000x3000 JPEG at `public\cover.jpg` and redeploy. Apple needs
  1400-3000px square artwork before the show can be listed; the feed works
  without it.
- Your first real episode: `?includeAiPod=true&forceAiPod=true` (spends about
  2k credits). Then:

```powershell
curl.exe -H "Cache-Control: no-cache" https://ai.stluker.com/feed.xml
curl.exe -I https://ai.stluker.com/audio/<date>.mp3                              # 200 + accept-ranges
curl.exe -H "Range: bytes=0-1023" -I https://ai.stluker.com/audio/<date>.mp3     # 206
```

- Validate the feed at podba.se/validate, then subscribe by URL in your
  podcast app.

## Email newsletter (added 2026-10-10; M/W/F roundup since 2026-10-16)

Every Monday, Wednesday and Friday a roundup goes out as an email, laid out
like a wire report: masthead and dateline, the lead, a "Listen to today's
episode" link when there is one, an index of headlines, then numbered stories
with "Why it matters" and their sources. Preview it at `/newsletter/preview`.

- **What's in it:** the editions the day's episode covered; if there's no
  episode, every edition since the last send (max 5). Stories are merged,
  deduped by first source URL, sorted by importance then newest day, max 12.
  The lead is the episode's `newsletterLede`, else the newest edition's lede.

- **Signup:** there's a card under every edition, plus the `/newsletter` page.
  Signups are double opt-in: `POST /subscribe` sends a confirmation email,
  and the confirm link opens a page with a button. Only that button's POST
  activates the subscription, so link-scanning mail filters can't confirm one.
- **Storage:** subscribers live in `PODCAST_KV` under `ai:news:sub:*`, with
  the address in key metadata, so one `list` call returns the whole list.
- **Sending:** `POST /newsletter/send` with `Authorization: Bearer
  <NEWSLETTER_SEND_TOKEN>` mails the roundup for `?day=` (default: newest
  edition day) through Resend's batch API, 100 per call. Each day's roundup
  goes out once (`ai:news:sent:<day>`).
  Use `?dry=1` to count recipients, `?test=you@x.com` to send a single copy,
  and `?force=1` to send again.
- **Unsubscribe:** every email has a signed one-click link plus
  `List-Unsubscribe` / `List-Unsubscribe-Post` headers (Gmail and Yahoo
  require these for bulk mail).
- **Abuse guards:** a honeypot field, a 1-hour per-address cooldown, and a cap
  of 20 confirmation emails per day, all to protect the shared Resend quota.
- **Resend plan limits:** the free tier allows 100 emails/day and 3,000 per
  month, shared with alerting and Innovation Daily. Move to a paid tier
  before the list grows past about 80 people.

Setup, from `C:\Users\pdluk\ai-daily`:

```powershell
npx wrangler secret put RESEND_API_KEY          # same Resend account; stluker.com is verified
npx wrangler secret put NEWSLETTER_KEY          # any long random string (signs unsubscribe links)
npx wrangler secret put NEWSLETTER_SEND_TOKEN   # any long random string; also set it in stl-dispatcher
npx wrangler deploy
```

The send is triggered by stl-dispatcher's `runAiPodOnly()` (M/W/F 11:50 UTC),
after the episode attempt, because this Worker deliberately has no cron of
its own. The daily `aiIngest` run no longer emails. Failures land in
`STATUS_KV` `ainews:last-error`.

## Monitoring

Monitoring was added at the same time as the tasks:
- `/health` (authenticated): `aiIngest` (30h) and `aiPodcast` (4 days)
- `reconcile.js`: both crons are in `declaredCrons`, both heartbeats are in
  `heartbeatJobs`, and `ai-daily` is in `trackedWorkers`
- Errors: `STATUS_KV` `ai:last-error` / `aipod:last-error`
- Per-feed silent-source streaks: `PODCAST_KV` `sourcestreak:ai:*`

## Editorial guardrails

- The editor and script prompts forbid adding any fact that isn't in the
  fetched feed text. Story links are copied from the feeds; the model never
  writes a URL. A story without a valid source id is dropped, and the drop
  is logged in diagnostics.
- Audio has no citations, so every episode page shows its transcript and links
  to the editions it covers. Spot-check those against the sources.
- The show description says the script is AI-written and read by an AI clone
  of your voice. Keep that disclosure: Apple and Spotify both expect
  synthetic voices to be disclosed.
