# Demo video

Recorded from the real site — no mock-ups, nothing paid. The footage is the landing page, a PR pasted into the
input (the live "what you'll get" line), the replay of a real finished analysis, and a step of its walkthrough read
aloud with the same narration mp3s the viewer plays. Captions sit in a bar under the page.

```bash
# from the repo root; music files are local (see music/README.md), output goes to docs/video/out (git-ignored)
M=docs/video/music
pnpm --filter @pr-walkthrough/server exec tsx scripts/record-demo-video.ts --cut 25 \
  --out ../../docs/video/out --music $M/track1-the_mountain-ambient-technology-133250.mp3,$M/track2-paulyudin-ambient-technology-153473.mp3
pnpm --filter @pr-walkthrough/server exec tsx scripts/record-demo-video.ts --cut 45 --out ../../docs/video/out --music ...
```

Each run writes `video-<cut>.mp4` (silent), `timeline-<cut>.json`, and `demo-<cut>s-track<N>.mp4` per music file
(narration over the music, the music ducked under the voice, loudness −16 LUFS).

Options: `--site` (default the Oracle VM), `--paste` (the PR typed into the input), `--cut 25|45`.
Needs Google Chrome and ffmpeg. The replay plays the recorded run of excalidraw#10295 compressed to 7 / 16 s.

## The video on the landing page

The landing plays `packages/web/public/demo/pr-walkthrough-demo.mp4` (poster next to it). It is the long cut with the
PaulYudin track, recorded against a local stack that serves the repo's committed #10295 data (clean desktop
before/after pair) and the real recorded run (`--site http://localhost:5180`, server with `ANALYZER=cached`,
`ELEVENLABS_VOICE_ID` from `deploy/.env.production` and a dummy key so the cached narration mp3s are served;
copy the live run's events over `data/events/excalidraw/excalidraw/10295.ndjson` for the recording and
`git checkout` it afterwards). Presenter: ElevenLabs "Sarah" at speed 0.84 (`--speed`), cached in
`docs/video/out/voice-cache`. The music is a fixed envelope: full level, a dip under the presenter, almost silent
for the whole stretch where the site's own narration plays. To replace the video: record, then copy the mp4 and a
frame (`ffmpeg -ss 29 -i demo.mp4 -frames:v 1 poster.jpg`) into `packages/web/public/demo/`.

### Splicing a re-filmed scene (no full re-record)
`record-demo-video.ts --only viewer --cut 45 --out <dir>` films just the finished walkthrough (Start → Next → Listen, the site's own
narration, Pause at the Nth sentence) and writes `voices-viewer.json`. `assemble-demo-video.ts` then cuts the first N seconds of an
earlier video, appends that scene and mixes the sound again (same music envelope). The current demo is the first 29.4 s of the
previous cut (landing → paste → Analyse → the analysis, ending as the before/after appears) + the stacking-diagram step.
