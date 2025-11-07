# multi_llm_hosting

Self-hosted playground for multiple vLLM backends plus a GPU diffusion server behind a single lazy-launching proxy.
`docker-compose.yml` defines five intent-based language models (`coder-fast`, `chat-general`, `general-reasoner`, `coder-slow`, `agent-tools`), a Stable Diffusion profile (`vision-diffusion`), and a `launcher`
container that routes `/coder`, `/chat`, `/general`, `/coderslow`, `/agent`, and `/vision` traffic to the right backend, starting/stopping
containers on demand to conserve GPU memory.

## Overview

This README describes how to run the vLLM multi-service stack inside WSL2 on a Windows 11 host, expose the lazy-launcher proxy on TCP 8000, and let LAN clients (e.g., macOS) call it. OS-level provisioning (WSL import, Docker Desktop installation, model selection) is already done and out of scope.

## Repository layout

| Path | Description |
| ---- | ----------- |
| `docker-compose.yml` | All service definitions, profiles, and shared env blocks. |
| `launcher/` | Tiny Node.js proxy that autostarts containers and trims idle ones. |
| `vision-server/` | FastAPI wrapper around a Stable Diffusion pipeline for the `/vision` route. |
| `.env` | Local-only secrets (`VLLM_API_KEY`, `COMPOSE_PROJECT_NAME`, etc.); ignored by Git. |
| `TODOs.txt` | Living checklist for features, hardening, and DX niceties. |

## Prerequisites

- Docker + Docker Compose plugin (v2).
- NVIDIA GPU + `nvidia-container-toolkit`.
- Host paths `/srv/llm/.cache` (for vLLM cache) and optional `/srv/llm/weights`.
- Host path `/srv/llm/vision-cache` for the diffusion model weights and scheduler files.

## Environment setup

1. Copy `.env.example` (or create `.env`) and define:
   ```env
   VLLM_API_KEY=<your hex token>
   HF_TOKEN=<huggingface token if you use gated models>
   ```
     `.env` is already ignored; keep your API key here and rotate it periodically.
   `HF_TOKEN` is optional but required for gated checkpoints such as Meta Llama 3.1; reuse it for both
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
2. Ensure the cache directories exist and are writable:
   ```bash
   sudo mkdir -p /srv/llm/.cache
   sudo mkdir -p /srv/llm/vision-cache
   ```

## Running services

Bring up the launcher alone (no models warmed):

```bash
docker compose --profile launcher up -d launcher
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

# Vision diffusion service (Stable Diffusion v1.5 FastAPI wrapper)
docker compose --profile launcher --profile vision up -d
```

The launcher listens on `:8000` and expects requests like:

```bash
curl -s http://localhost:8000/coder/v1/models \
  -H "Authorization: Bearer $VLLM_API_KEY" | jq .
```

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
- For profile automation, see the scripts in `TODOs.txt` (switch script / Makefile ideas).

## Cold-start timings (RTX 4080, WSL2, Nov 2025)

| Route / profile | Model (quantization) | Cold start (s) | Notes |
| --------------- | -------------------- | -------------- | ----- |
| `/coder` (`coder-fast`) | Qwen/Qwen2.5-Coder-7B-Instruct (bitsandbytes) | ~38s | Includes cache download check; expect faster when already staged |
| `/chat` (`chat-general`) | meta-llama/Meta-Llama-3.1-8B-Instruct (bitsandbytes) | ~38s | Requires valid `HF_TOKEN` + accepted license |
| `/general` (`general-reasoner`) | deepseek-ai/DeepSeek-R1-Distill-Qwen-7B (bitsandbytes) | ~33s | Lightest footprint of the set |
| `/coderslow` (`coder-slow`) | TechxGenus/DeepSeek-Coder-V2-Lite-Instruct-AWQ (awq) | ~37s | 16B AWQ export; still fits in 16 GB with low concurrency |
| `/agent` (`agent-tools`) | Qwen/Qwen2.5-7B-Instruct (bitsandbytes) | ~33s | Use this route when Continue Agent mode needs function/tool calling |
| `/vision` (`vision-diffusion`) | runwayml/stable-diffusion-v1-5 (fp16) | ~28s | Includes one-time weights download into `/srv/llm/vision-cache` |

Times were recorded with `docker compose up -d <service>` followed by a curl loop against `/v1/models`. Subsequent launches on a warm filesystem are usually 5‑10s faster as long as caches stay in `/srv/llm/.cache`.

## Basic security checklist

- Only expose the launcher (`:8000`) publicly; keep model ports (`8001-8005`) on the LAN.
- Keep `.env` out of Git (already enforced) and rotate `VLLM_API_KEY` quarterly.
- Optional: front with Cloudflare Tunnel or Nginx/Caddy for TLS + auth.

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
| Launcher logs `Error: spawn docker ENOENT` | Docker CLI not available inside container | Confirm Docker Desktop WSL integration is enabled and restart Docker Desktop before `docker compose up`. |
| `launch error: Backend not healthy in time` | Model still loading or GPU exhausted | Increase `START_TIMEOUT_SECONDS`, ensure VRAM is free, and pre-seed caches on SSD. |
| `502` responses intermittently | Containers stopping mid-request or idle timeout too low | Raise `IDLE_SECONDS` and monitor launcher logs for stop/start churn. |
| `CUDA out of memory` in vLLM | Multiple models active or quantization missing | Use compose profiles to run one heavy model at a time and double-check quantized configs (`bitsandbytes`/`awq` for the configured models). |
