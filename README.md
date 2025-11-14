# multi_llm_hosting

Self-hosted playground for multiple vLLM backends plus a GPU diffusion server behind a single lazy-launching proxy, now with an optional Open WebUI front-end.
`docker-compose.yml` defines five intent-based language models (`coder-fast`, `chat-general`, `general-reasoner`, `coder-slow`, `agent-tools`), a Stable Diffusion 3.5 Medium profile (`vision-diffusion`), and a `launcher`
container that routes `/coder`, `/chat`, `/general`, `/coderslow`, `/agent`, and `/vision` traffic to the right backend, starting/stopping
containers on demand to conserve GPU memory.

## Overview

This README describes how to run the vLLM multi-service stack inside WSL2 on a Windows 11 host, expose the lazy-launcher proxy on TCP 8000, and let LAN clients (e.g., macOS) call it. OS-level provisioning (WSL import, Docker Desktop installation, model selection) is already done and out of scope.

## Repository layout

| Path | Description |
| ---- | ----------- |
| `docker-compose.yml` | All service definitions, profiles, and shared env blocks. |
| `launcher/` | Tiny Node.js proxy that autostarts containers and trims idle ones. |
| `vision-server/` | FastAPI wrapper around a Stable Diffusion 3.5 Medium pipeline for the `/vision` route. |
| *(Compose service)* `open-webui` | Optional Open WebUI container that points at the `/chat` route on the launcher. |
| Docker volume `open-webui-data` | Persists Open WebUI accounts, chat history, and workspace settings. |
| `.env` | Local-only secrets (`VLLM_API_KEY`, `COMPOSE_PROJECT_NAME`, etc.); ignored by Git. |
| `TODOs.txt` | Living checklist for features, hardening, and DX niceties. |

## Prerequisites

- Docker + Docker Compose plugin (v2).
- NVIDIA GPU + `nvidia-container-toolkit`.
- Host path `/srv/llm/.cache` (shared across vLLM download cache and the diffusion weights).
- Optional host path `/srv/llm/weights` if you want to serve local checkpoints instead of Hugging Face Hub IDs.

## Environment setup

1. Copy `.env.example` (or create `.env`) and define:
   ```env
   VLLM_API_KEY=<your hex token>
   HF_TOKEN=<huggingface token if you use gated models>
   # Optional: comma-separated launcher routes to prewarm at boot (e.g., chat,general)
   PREWARM_ROUTES=
   ```
     `.env` is already ignored; keep your API key here and rotate it periodically.
  `HF_TOKEN` is optional but required for gated checkpoints such as Meta Llama 3.1 and `stabilityai/stable-diffusion-3.5-medium`; reuse it for both
  `HF_TOKEN` and `HUGGING_FACE_HUB_TOKEN` via the shared env block in `docker-compose.yml`.
   Create the token from https://huggingface.co/settings/tokens (scope: **Read**) and accept the
   specific model licenses (e.g., Meta Llama 3.1) under each repo’s “Access” tab. Paste the token into
   `.env` or run `huggingface-cli login --token $HF_TOKEN` before `docker compose up`.
   Quick way to mint a 32-byte hex token (uses OpenSSL, available on most systems):
   ```bash
   openssl rand -hex 32
   ```
   If OpenSSL isn’t available, fall back to `/dev/urandom`:
   ```bash
   head -c32 /dev/urandom | xxd -p
   ```
2. Ensure the cache directories exist and are writable (the vision service reuses the same root cache directory):
   ```bash
   sudo mkdir -p /srv/llm/.cache
   sudo mkdir -p /srv/llm/.cache/vision
   ```

## Running services

Bring up the launcher core (launcher proxy + Open WebUI + SearXNG, still with no LLMs warmed):

```bash
docker compose --profile launcher up -d
```

Start a specific model profile (launcher + backend):

```bash
# Fast coding model (Qwen2.5 Coder 7B, 8-bit)
docker compose --profile launcher --profile coder up -d

# General chat assistant (Llama 3.1 8B, 8-bit)
docker compose --profile launcher --profile chat up -d

# Reasoning-forward 7B (DeepSeek R1 Distill)
docker compose --profile launcher --profile general up -d

# High-accuracy coding (DeepSeek Coder V2 Lite, 16B AWQ)
docker compose --profile launcher --profile coderslow up -d

# Tool-capable agent (Qwen2.5 7B Instruct w/ tool calling, 8-bit)
docker compose --profile launcher --profile agent up -d

# Vision diffusion service (Stable Diffusion 3.5 Medium FastAPI wrapper)
docker compose --profile launcher --profile vision up -d
```

Open WebUI and SearXNG are bundled into the `launcher` profile, so anytime you run a command with `--profile launcher` (including the ones above) those services will come up automatically—no extra `docker compose` invocation needed.

> **Note:** `stabilityai/stable-diffusion-3.5-medium` is a gated Hugging Face repo. Request/accept access and export `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` before starting the vision profile; otherwise the container will crash at startup with a 403.

> **Heads-up:** All vLLM model containers now set `restart: "no"` so they stay stopped after you `docker compose stop` them or restart the Docker engine; the launcher will spin them up on demand the next time traffic hits their route. The `launcher` and `open-webui` services themselves use `restart: unless-stopped`, so they automatically return after a daemon restart unless you explicitly stop them.

### Open WebUI quickstart

- Browse to [http://localhost:3000](http://localhost:3000) (or the host mapped to port `3000`) once the container is up.
- The first visitor is prompted to create an admin account; subsequent logins reuse those credentials.
- Requests go through the `/chat` launcher route by default via `OPENAI_API_BASE_URL=http://launcher:8000/chat/v1`.
  Add more providers inside **Settings → Connections** if you want to expose the other launcher routes (e.g., `/coder`).
- Open WebUI reuses the shared `VLLM_API_KEY`. Rotate it in `.env` and restart the containers if you update the key.
- Authentication stays enabled by default; set `OPEN_WEBUI_AUTH=false` in `.env` if you trust every client on the LAN and want one-click access.
- **Unified OpenAI connector:** Instead of juggling multiple connectors, point a single OpenAI-compatible connection at `http://launcher:8000/openai` (no trailing `/v1`). The launcher now returns every model (LLMs + diffusion) from `GET /openai/v1/models`, so Open WebUI sees them in one dropdown without cold-starting each backend just for health checks.
- **Default system prompt:** Open WebUI lets you bake persona instructions into every `/chat` call without touching the launcher. After logging in:
  1. Go to **Settings → Interface** and edit **Default system prompt**. The text you enter here is prepended to every new chat (existing threads keep their original prompt).
  2. If you prefer per-connector prompts, open **Settings → Connections**, select the `OpenAI Compatible` entry that points at `http://launcher:8000/chat/v1`, and fill in **Default system prompt** under that connection instead.
  3. Save changes and start a fresh conversation to confirm the model reflects the new instruction. Both forms store the value inside the `open-webui-data` volume so it persists across container restarts.
- **Optional direct vision connector:** If you want the legacy arrangement (separate connector aimed straight at the diffusion route), you can still do it:
  1. Make sure the `vision-diffusion` service is running (e.g., `docker compose --profile launcher --profile vision up -d` or let the launcher cold-start it).
  2. In Open WebUI, open **Settings → Connections → Images**, click **Add Connection**, and choose **OpenAI Compatible**.
  3. Set **Base URL** to `http://launcher:8000/vision`, keep the endpoint at `/v1/images/generations`, and enter any placeholder API key if the UI insists (the launcher sets `MAP__vision__auth=passthrough`, so the key is ignored).
  4. Save, head to the **Images** tab, select the connector you just created, and generate an image to confirm the round-trip works.

### Local SearXNG search

The Compose stack also ships a `searxng` service on port `8080`, mounting `./searxng/settings.yml` so you can tune engine priorities. The bundled config keeps only privacy-friendly engines we care about and sets sane defaults:

| Mode      | Engines                                                         |
|-----------|-----------------------------------------------------------------|
| General   | `duckduckgo`, `brave`, `wikipedia`, `wikidata`                  |
| Code      | `github`, `stackoverflow`, plus `duckduckgo` for broader web    |
| Research  | `arxiv`, `semantic scholar`, plus `duckduckgo`                  |

To expose this inside Open WebUI, create a tool named `searxng_search` (via the UI or by dropping a plugin under `open-webui-data`). Suggested schema:

- `query: str` — search string.
- `mode: Optional[str]` — `"general"`, `"code"`, `"research"`, or `"auto"` (when `"auto"`, inspect the Open WebUI model name: treat names containing `code`, `coder`, `deepseek-coder`, `qwen-coder` as code; treat `research`, `r1`, `deepseek-r1` as research; otherwise default to general).
- `model: Optional[str]` — model identifier if Open WebUI forwards it.

Implementation sketch:

```pseudo
if mode == "code": engines = "github,stackoverflow,duckduckgo"
elif mode == "research": engines = "arxiv,semantic scholar,duckduckgo"
else: engines = "duckduckgo,brave,wikipedia"
resp = GET http://searxng:8080/search?q=...&format=json&engines=...&language=en
return {
  "mode": resolved_mode,
  "engines_used": engines.split(","),
  "results": top 5 items with title/url/snippet
}
```

If you’d rather centralize access through the launcher, add a `POST /tools/searxng_search` endpoint in `launcher/server.js` that wraps the same logic and point the Open WebUI tool at `http://launcher:8000/tools/searxng_search`.

User accounts, workspace preferences, and chat history are stored inside the `open-webui-data`
named volume. Keep it mounted to preserve UI state across rebuilds, or remove it to factory reset:

```bash
# Substitute your COMPOSE_PROJECT_NAME if it differs
docker volume rm ${COMPOSE_PROJECT_NAME:-multi_llm_hosting}_open-webui-data
```

Customize the diffusion checkpoint or runtime limits by exporting
`VISION_MODEL_ID` (defaults to `stabilityai/stable-diffusion-3.5-medium`),
`VISION_MODEL_REVISION`, `VISION_ENABLE_SAFETY_CHECKER`, `VISION_ENABLE_TILING`,
`VISION_ENABLE_ATTENTION_SLICING`, or `VISION_MAX_EDGE`
(default `1024`) before running `docker compose` (all default to sensible values in the container if unset).

The launcher listens on `:8000` and expects requests like:

```bash
curl -s http://localhost:8000/coder/v1/models \
  -H "Authorization: Bearer $VLLM_API_KEY" | jq .
```

### Launcher admin endpoints

The proxy now exposes lightweight operational endpoints on the launcher port:

| Path | Description |
| ---- | ----------- |
| `GET /healthz` | Returns `{ "status": "ok" }` when the launcher is up (no Docker calls).
| `GET /routes` | Lists all configured `/route → container:port` mappings plus health/auth metadata.
| `GET /stats` | Reports currently running containers, last-hit timestamps, and cold-start timing metrics gathered from Docker.

These endpoints respond without proxying to model backends and are safe to call from readiness probes or dashboards.

To generate an image through the diffusion profile, send a JSON payload to `/vision/generate` (no bearer token required):

```bash
curl -s http://localhost:8000/vision/generate \
  -H "Content-Type: application/json" \
  -d '{
        "prompt": "sunset over a future city, cinematic lighting",
        "num_inference_steps": 20,
        "guidance_scale": 6.5,
        "seed": 1337
      }' | jq -r '.image_base64' | base64 -d > output.png
```

The response includes the base64-encoded PNG, elapsed time, and seed; adjust width/height with the optional fields documented in `vision-server/app.py`.

You can also hit the OpenAI-compatible endpoint that Open WebUI uses:

```bash
curl -s http://localhost:8000/vision/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
        "prompt": "sunset over a future city, cinematic lighting",
        "size": "768x512"
      }' | jq -r '.data[0].b64_json' | base64 -d > output.png
```

### Unified OpenAI endpoint

The launcher now mirrors a small slice of the OpenAI REST API at `/openai/v1/*` so tools only have to talk to one base URL:

- `GET /openai/v1/models` – returns every model id the launcher can spin up. Customize the ids by setting `MAP__<route>__models` (comma-separated) in `.env`; otherwise the container name is used.
- `POST /openai/v1/chat/completions` – route is selected via the `model` field and lazily started on demand.
- `POST /openai/v1/images/generations` – proxies to the diffusion backend using the same `model` mapping as above.

Examples:

```bash
curl -s http://localhost:8000/openai/v1/models | jq .

curl -s http://localhost:8000/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
        "model": "chat-general",
        "messages": [
          { "role": "system", "content": "You are a concise assistant." },
          { "role": "user", "content": "Summarize the repo layout." }
        ],
        "temperature": 0.2
      }' | jq .
```

Both responses above complete even if the backing containers are stopped—the launcher handles the cold start and health checks transparently.

Idle services shut down after `IDLE_SECONDS` (default 600). Tune `IDLE_SECONDS` and
`START_TIMEOUT_SECONDS` in the compose file via environment overrides. Each route name matches its
purpose (`/coder`, `/chat`, `/general`, `/coderslow`, `/agent`) rather than specific model families so you can
swap checkpoints without reworking client integrations.

## Operational tips

- Pin container names and ports via `MAP__<route>__container|port` env vars (already prefilled).
- Launcher logs every container stop/start and request proxy; tail via `docker compose logs -f launcher` when debugging swaps.
- Launcher enforces a one-model-at-a-time policy: every cold request stops other backends, starts the requested one, and only then proxies traffic.
- Tail launcher logs during cold starts: `docker logs -f launcher`.
- Use `docker compose stop <service>` to free GPU memory quickly when switching workloads.
- Set `PREWARM_ROUTES` (comma-separated, e.g., `chat`) to warm priority routes when the launcher boots and surface cold-start durations via `GET /stats` for SLO tracking.
- Override `DOCKER_HOST_SOCKET` if your Docker Engine socket lives somewhere other than `/var/run/docker.sock`.
- For profile automation, see the scripts in `TODOs.txt` (switch script / Makefile ideas).

## Cold-start timings (RTX 4080, WSL2, Nov 2025)

| Route / profile | Model (quantization) | Cold start (s) | Notes |
| --------------- | -------------------- | -------------- | ----- |
| `/coder` (`coder-fast`) | Qwen/Qwen2.5-Coder-7B-Instruct (bitsandbytes) | ~38s | Includes cache download check; expect faster when already staged |
| `/chat` (`chat-general`) | meta-llama/Meta-Llama-3.1-8B-Instruct (bitsandbytes) | ~38s | Requires valid `HF_TOKEN` + accepted license |
| `/general` (`general-reasoner`) | deepseek-ai/DeepSeek-R1-Distill-Qwen-7B (bitsandbytes) | ~33s | Lightest footprint of the set |
| `/coderslow` (`coder-slow`) | TechxGenus/DeepSeek-Coder-V2-Lite-Instruct-AWQ (awq) | ~37s | 16B AWQ export; still fits in 16 GB with low concurrency |
| `/agent` (`agent-tools`) | Qwen/Qwen2.5-7B-Instruct (bitsandbytes) | ~33s | Use this route when Continue Agent mode needs function/tool calling |
| `/vision` (`vision-diffusion`) | runwayml/stable-diffusion-v1-5 (fp16) | ~28s | Includes one-time weights download into `/srv/llm/.cache/vision` |

Times were recorded with `docker compose up -d <service>` followed by a curl loop against `/v1/models`. Subsequent launches on a warm filesystem are usually 5‑10s faster as long as caches stay in `/srv/llm/.cache`.

## Basic security checklist

- Only expose the launcher (`:8000`) publicly; keep model ports (`8001-8005`) on the LAN.
- Keep `.env` out of Git (already enforced) and rotate `VLLM_API_KEY` quarterly.
- Optional: front with Cloudflare Tunnel or Nginx/Caddy for TLS + auth.

## VS Code Continue client

Use `continue.config.json` as a ready-to-copy model list for the Continue extension:

1. Install Continue in VS Code and open Command Palette → **Continue: Open Config File**. Replace the default contents with this repo’s `continue.config.json` or merge the `"models"` array.
2. Keep `VLLM_API_KEY` defined in your shell (Continue will inject it into the `Authorization: Bearer` header).
3. If VS Code runs on a different machine, swap `127.0.0.1` in each `baseUrl` for the LAN IP/hostname of the launcher but keep the `/coder`, `/chat`, `/general`, `/coderslow`, and `/agent` prefixes so Continue still hits the lazy-launch routes.
4. The config already wires the fast coder route for tab completions; switch the `tabAutocompleteModel` block if you want a different backend for inline suggestions.

## Windows host configuration

- **Firewall**: allow inbound TCP 8000 on the Private profile only, then confirm your network is set to Private in Windows Settings → Network & Internet.

  ```powershell
  # PowerShell (Admin)
  New-NetFirewallRule -DisplayName "vLLM Launcher 8000 (Private)" `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 -Profile Private
  ```

- **Docker Desktop ↔ WSL integration**: open Docker Desktop → Settings → Resources → WSL Integration → enable the Ubuntu distro backing `/srv/llm`. Start Docker Desktop before running any `docker compose` commands in WSL.
- **GPU drivers**: ensure the latest NVIDIA Windows driver is installed. CUDA userspace libraries are baked into the vLLM containers; no Windows CUDA toolkit install is needed.
- **Performance (optional)**: if models/cache sit on NTFS-mounted paths or the WSL VHD, add Windows Defender exclusions to those folders to reduce cold-start latency. Only do this on trusted machines.
- **Stable addressing (optional)**: reserve a DHCP lease for the Windows host so the LAN IP stays fixed and, if desired, add a local DNS record like `llm.local`. No hosts-file edits are required.
- **Public exposure (optional)**: setup kept the launcher LAN-only. If you later need remote access, either:
  1. Port-forward 443 → 8000 on your router and add a matching Windows Firewall **Public** rule.
  2. Run a Cloudflare Tunnel (`cloudflared tunnel --url http://127.0.0.1:8000`) with Cloudflare Access; no inbound firewall change needed.
  
  In both cases, harden with API keys and rate limits before exposing.
- **.wslconfig note**: `networkingMode=mirrored` is already configured. The `wsl2.localhostForwarding` option has no effect under mirrored networking; an “ignored” warning from WSL is expected.

## Secret scanning

Local heuristic scan (regex + entropy) can be rerun anytime:

```bash
python scripts/secret_scan.py  # or reuse the one-off snippet from the agent logs
```

Recommended to add a real tool (e.g., `gitleaks` or `detect-secrets`) before pushing to shared repos.

## Post-rebuild verification

Run these after bringing the stack up:

```bash
# From Windows-side WSL shell
curl http://127.0.0.1:8000/chat/v1/models -H "Authorization: Bearer $VLLM_API_KEY"
curl http://127.0.0.1:8000/agent/v1/models -H "Authorization: Bearer $VLLM_API_KEY"
curl http://127.0.0.1:8000/vision/healthz

# From macOS client on same LAN
curl http://<windows-ip>:8000/chat/v1/models -H "Authorization: Bearer $VLLM_API_KEY"
```

If the first succeeds but the second fails, revisit the Windows Firewall rule (Private profile + correct network type).

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `curl` from Mac gets `connection refused` | Firewall rule missing or network marked Public | Re-run the firewall command above and ensure the Windows NIC is Private. |
| Launcher logs `Docker API ... ECONNREFUSED` | Docker socket not mounted or Docker Desktop stopped | Ensure `/var/run/docker.sock` is shared into the launcher container (default compose file already does) and restart Docker Desktop. |
| `launch error: Backend not healthy in time` | Model still loading or GPU exhausted | Increase `START_TIMEOUT_SECONDS`, ensure VRAM is free, and pre-seed caches on SSD. |
| `502` responses intermittently | Containers stopping mid-request or idle timeout too low | Raise `IDLE_SECONDS` and monitor launcher logs for stop/start churn. |
| `CUDA out of memory` in vLLM | Multiple models active or quantization missing | Use compose profiles to run one heavy model at a time and double-check quantized configs (`bitsandbytes`/`awq` for the configured models). |
