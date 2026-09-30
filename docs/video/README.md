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
