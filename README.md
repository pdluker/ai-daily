# ai.stluker.com: "AI Daily" + "AI Daily Recap"

A daily AI news page, plus a ~5-minute recap podcast every Monday and Thursday
read in Paul's own cloned voice. Added 2026-10-04.

```
stl-dispatcher
  45 11 * * *        aiIngest   (ai-ingest.js)
                       |- 10 AI feeds + Hacker News (fetchSource, parallel)
                       |- 1x Claude (claude-sonnet-5): lede + 4-10 stories
                       |- audit: stories must cite real candidate ids;
                       |         links come from the feeds, never from the model
                       '- KV  ai:day:YYYY-MM-DD, ai:index
  50 11 * * MON,THU  aiPodcast  (ai-podcast.js)
                       |- editions since the last episode
                       |    Mon -> Fri/Sat/Sun/Mon editions (news Thu..Sun)
                       |    Thu -> Tue/Wed/Thu editions     (news Mon..Wed)
                       |- 1x Claude: ~720-word first-person script (+1 length fix)
                       |- live ElevenLabs balance gate (protects Earth and Orbit)
                       |- ElevenLabs TTS, voice = ELEVENLABS_AI_VOICE_ID
                       '- R2 pod-audio/ai/episodes/*.mp3, KV ai:pod:*

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
| Claude, recap scripts (~9 episodes, 1-2 calls each) | ~$1 |
| ElevenLabs, ~9 episodes x ~2,150 credits (Flash) | ~19k credits on the existing plan |
| Cloudflare | $0 extra |

### ElevenLabs: read this first

Earth and Orbit already uses about 84k of the Creator plan's 100k credits per
month. Adding about 19k for the recap puts the total over 100k. Because of that,
`aiPodcast` checks the **real** account balance (`GET /v1/user/subscription`)
before every episode. It only goes ahead if the remaining credits can still
cover Earth and Orbit until the next reset (2,800/day + 3,000 safety). In
practice the last one or two recaps of each billing cycle will be skipped.
They show up as `skipped: "ElevenLabs budget..."` in the diagnostics; this is
not an error. To get every episode, either:

- move to ElevenLabs Pro, or
- lower Earth and Orbit's length or `MONTHLY_CREDIT_BUDGET` in `podcast-ingest.js`.

If the API key can't read the subscription endpoint (it needs the `user_read`
permission), the gate falls back to its own 19k/month ledger in `ai:pod:credits`.

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

## Monitoring

Monitoring was added at the same time as the tasks:
- `/health` (authenticated): `aiIngest` (30h) and `aiPodcast` (5 days)
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
