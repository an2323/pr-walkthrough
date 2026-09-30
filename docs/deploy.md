# Deploy: live analysis on a VM (GCP or Oracle) + Supabase

## Front end on Vercel, everything else on the VM (cut over Sep 30)

| What | Where |
|------|-------|
| `pr-walkthrough-bob.vercel.app` (the URL the judges have) | Vercel project `pr-walkthrough`: the **live** web build (`vercel.json` → `VITE_API_BASE=https://130-61-220-249.sslip.io`), no static export |
| API, analysis, screenshots, audio | the VM (`https://130-61-220-249.sslip.io`), called cross-origin — `CORS_ORIGINS` in `deploy/.env.production` lists the judges' domain and this project's preview URLs |
| Live work | branch `live-backend` |

`deploy/deploy.sh` ships the VM only. The Vercel front end is deployed with the Vercel CLI from the same
checkout: `vercel deploy` (preview, check it) → `vercel deploy --prod` (the judges' URL). The previous
production deployment stays available: `vercel rollback` restores it in seconds.


```
browser ──https──▶ Caddy (VM) ──▶ viewer (live build, same container stack)
                        └──────▶ API :3000 ──▶ Bob Shell, git, yarn, Chromium
                                     ├──▶ Supabase Postgres  (walkthroughs, jobs, spend)
                                     └──▶ Supabase Storage   (shots, audio, replays)
```

The **app does not care** which cloud hosts it. Same Docker image, same
`deploy/.env.production`, same Supabase. Only the thin `deploy/{gcp,oracle}/*.sh`
wrappers differ. `deploy/create-vm.sh` and `deploy/deploy.sh` pick a provider:

1. `DEPLOY_PROVIDER=gcp|oracle` if set
2. else Oracle when `OCI_COMPARTMENT_ID` / `oci` CLI is ready
3. else GCP when `GCP_PROJECT` / `gcloud` is ready

## 1. Supabase (free)

1. Create a project at supabase.com.
2. **Database URL** — Project → Connect → *Transaction pooler* (port 6543). Replace
   `[YOUR-PASSWORD]` with the database password.
3. **API** — Project Settings → API: copy the *Project URL* and the `service_role`
   key (secret — server only).
4. Tables and the public Storage bucket are created automatically on first start.

## 2. Local secrets file

Create `deploy/.env.production` (gitignored):

```bash
SITE_ADDRESS=34-1-2-3.sslip.io          # printed by create-vm.sh

DATABASE_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

BOB_API_KEY=...
GITHUB_TOKEN=...                         # read-only PAT: PR metadata + rate limits

ACCESS_CODE=...                          # ADMIN key: needed only for `force` re-runs and rehearsals (analyses need no code)
ANALYZE_DAILY_LIMIT=5                    # paid runs per rolling 24 h
BOB_BUDGET_USD=40                        # total cap across all runs (ledger in Postgres)
MAX_PR_FILES=80
MAX_PR_DIFF=2000

# optional narration
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
TTS_GENERATE=0
```

Worst case per run with the defaults: analysis `MAX_COST` 8 + quality repair 1 +
screenshot verifier 2 + revise 1–2 ≈ **$13**; typical runs are $2–5. Screenshots,
ablation and revise run only for repos with an app recipe (`src/verify/recipes.ts` —
Excalidraw).

## 3. Migrate local history

Put `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` into the local `.env`, then:

```bash
pnpm --filter @pr-walkthrough/server migrate:supabase --dry-run
pnpm --filter @pr-walkthrough/server migrate:supabase
```

Copies the Excalidraw walkthroughs, replays, screenshots and narration. Outline is
skipped (licence unverified). Safe to re-run.

## 4. Create a VM (GCP **or** Oracle)

Pack Bob Shell once (needed by both):

```bash
npm pack "$(npm root -g)/bobshell" --pack-destination deploy/vendor
```

### Google Cloud ($300 / 90 days trial)

```bash
gcloud auth login
GCP_PROJECT=<project-id> deploy/create-vm.sh   # or: deploy/gcp/create-vm.sh
# put SITE_ADDRESS into deploy/.env.production, wait ~2 min
deploy/deploy.sh
```

e2-standard-2 (2 vCPU, 8 GB) ≈ $55/month from the trial credit.

### Oracle Always Free (Ampere A1, ARM)

Needs a public subnet in your tenancy (Free Tier VCN from the sign-up wizard is fine):

```bash
oci setup config
OCI_COMPARTMENT_ID=ocid1.tenancy… deploy/create-vm.sh
# optional: OCI_SUBNET_ID=ocid1.subnet… if auto-detect finds none
# put SITE_ADDRESS into deploy/.env.production, wait ~2 min
deploy/deploy.sh
```

Default shape: `VM.Standard.A1.Flex` 2 OCPU / 12 GB (Always Free). If Bob or
Chromium fail on ARM, recreate as x86 (uses paid capacity unless you have other
Free shapes):

```bash
OCI_SHAPE=VM.Standard.E4.Flex OCI_OCPUS=2 OCI_MEMORY_GB=16 deploy/oracle/create-vm.sh
```

## 5. Smoke test

```bash
curl -s https://$SITE_ADDRESS/health
# {"ok":true,"analyzer":"bob","database":true,"storage":true}
```

Open `https://$SITE_ADDRESS/`: the example cards load from Supabase; paste a small
Excalidraw PR, press Analyse, watch the progress screen (no code needed; `force` and rehearsals use ACCESS_CODE).

## Operations

```bash
# GCP
gcloud compute ssh pr-walkthrough --zone europe-west1-b

# Oracle
ssh -i ~/.ssh/id_rsa ubuntu@<ip>

cd ~/app && sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f api
```

- Idle GCP: `gcloud compute instances stop pr-walkthrough --zone europe-west1-b`
  (disk + static IP still cost a little).
- Switching cloud: create the other VM, same `deploy/.env.production` (new
  `SITE_ADDRESS`), `deploy/deploy.sh`. **No data migration** — everything is in Supabase.
- Force a provider: `DEPLOY_PROVIDER=gcp|oracle deploy/deploy.sh`.

## Run protocol — nothing is paid for until it has passed for $0

Every problem found on a paid run so far (a draft thrown away over one quote, `cp -cR` on Linux, a
revise that skipped the quality repair, a repair that dropped the auto-skipped hunks) was
catchable for $0. The order below is enforced where it can be:

1. **`pnpm preflight`** — builds, typecheck, every test, including `analyze-pipeline.test.ts`
   (every pipeline branch held to the same invariants) and `fake-bob.test.ts`. It stamps the
   tree's content hash; **`deploy/deploy.sh` refuses a tree that hasn't passed** (`SKIP_PREFLIGHT=1`
   overrides) and waits for `/health` after starting the containers.
2. **Rehearsal on the deployed site** ($0, ~10 min with ablation):
   ```bash
   pnpm --filter @pr-walkthrough/server rehearse --pr excalidraw/excalidraw#10295
   pnpm --filter @pr-walkthrough/server rehearse --pr excalidraw/excalidraw#10295 --plan analysis=critical,verifier=broken
   ```
   The real pipeline on the real VM — worktrees, installs, dev servers, backend confirmation,
   frames, ablation, storage, the progress screen (the command prints its URL) — with
   `scripts/fake-bob.mjs` answering from the PR's last real result. It is stored apart
   (`data/rehearsals/`, `?rehearsal=1`), is not in the spend ledger, and never overwrites the real
   walkthrough. `--plan` injects the failures seen on paid runs (see the header of fake-bob.mjs);
   `tts=on` also records the narration. The command ends with the rubric check below.
3. **The paid run**, from the site. One at a time; the job's `done`
   reports the full cost.
4. **Acceptance** — the rubric as code (`src/validation/run-report.ts`), against the site:
   ```bash
   pnpm --filter @pr-walkthrough/server check-run --site https://$SITE_ADDRESS --pr owner/repo#123 --audio
   ```
   Schema, coverage, no critical quality warning, an honest screenshot outcome, ablation verdicts
   kept, every frame loads, every narration sentence has audio. A run is done when this prints
   `RESULT: PASS`, not when it "looks fine".
5. **A failure on a paid run becomes a $0 case first**: a fixture or a `--plan` fault and a test
   that reproduces it, then the fix — never a second paid run to debug.

**Voice.** The pipeline's last stage records the narration with ElevenLabs when
`ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` are set (`TTS_PREGEN=0` turns it off) and uploads it to
Supabase Storage. A voice failure never fails the run — the viewer reads with the browser voice.
`TTS_GENERATE` stays `0`: visitors never trigger paid generation.

## Known limits

- The screenshot verifier runs the analysed repository's own code (`yarn install`,
  dev server) in the API container. Env vars are scrubbed for those processes, but
  they run as the same user as the API. Keep the recipe allowlist to trusted repos.
- One paid analysis at a time; a second request gets 409.
- Progress of an analysis that is running during a restart is lost (the job fails;
  finished walkthroughs are safe).
- Oracle Always Free Ampere is ARM — first smoke should confirm `bob --version` and
  Playwright Chromium inside the container.

## Operations

**Deploying while an analysis runs.** `deploy.sh` (both providers) asks `/health` first and refuses to
recreate the containers while `activeJob` is `true` — a run killed mid-way has already spent its
Bobcoins and its result is lost. `FORCE=1 deploy/deploy.sh` overrides.

**Disk.** Every analysed PR leaves two installed worktrees (BASE and HEAD, ~1.5 GB of
`node_modules` each) under `/cache/repos/<owner>__<repo>/wt/`. The pipeline prunes all but the
current pair and the two most recent others before the screenshot step (`pruneWorktrees`), and
`deploy.sh` prunes old images and build cache. New VMs get a 100 GB boot volume (`OCI_BOOT_GB`);
an existing one can be grown with `oci bv boot-volume update --size-in-gbs 100`, then on the VM
`echo 1 | sudo tee /sys/class/block/sda/device/rescan; sudo growpart /dev/sda 1; sudo resize2fs /dev/sda1`.

**Spend cap.** `BOB_BUDGET_USD` is checked against the `spend` ledger in Postgres, which only knows
runs made through this deployment. Set it to *(ledger total so far) + (what is really left on the
Bob key)*, not to the key's original size, or the guard will happily allow more than exists.

**$0 smoke test of the screenshot chain** (run this before paying for a verifier run, and after
touching `verify/`). It installs the app at BASE and HEAD, starts both dev servers, warms them up,
runs a saved `repro.cjs` and the symptom scripts, and does an ablation — everything except Bob:

```bash
# copy a saved repro (+ optional symptom-N.cjs) into the api container, then:
docker compose -f deploy/docker-compose.yml --env-file deploy/.env cp ./smoke api:/tmp/smoke
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec api \
  sh -c 'cd /app/packages/server && pnpm exec tsx scripts/verify-smoke.ts --dir /tmp/smoke'
```

It prints one PASS/FAIL line per step with timings. `ALL GREEN` means the paid step has a fair chance.

**Bob's task history** lives on the `bob` volume (`/root/.bob`), so `--resume` repairs and manual
recovery of an unparsed answer survive redeploys. Raw output of every analysis run is saved under
`data/runs/<stamp>-<repo>-<n>-analysis/`.
