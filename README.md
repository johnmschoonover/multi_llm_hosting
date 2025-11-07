# multi_llm_hosting

Self-hosted playground for multiple vLLM backends behind a single lazy-launching proxy.  
`docker-compose.yml` defines three models (`coder3b`, `sitechat`, `qwen7b-bnb4`) and a `launcher`
container that routes `/coder`, `/chat`, and `/qwen7b` traffic to the right backend, starting/stopping
containers on demand to conserve GPU memory.

## Overview

This README describes how to run the vLLM multi-service stack inside WSL2 on a Windows 11 host, expose the lazy-launcher proxy on TCP 8000, and let LAN clients (e.g., macOS) call it. OS-level provisioning (WSL import, Docker Desktop installation, model selection) is already done and out of scope.

## Repository layout

| Path | Description |
| ---- | ----------- |
| `docker-compose.yml` | All service definitions, profiles, and shared env blocks. |
| `launcher/` | Tiny Node.js proxy that autostarts containers and trims idle ones. |
| `.env` | Local-only secrets (`VLLM_API_KEY`, `COMPOSE_PROJECT_NAME`, etc.); ignored by Git. |
| `TODOs.txt` | Living checklist for features, hardening, and DX niceties. |

## Prerequisites

- Docker + Docker Compose plugin (v2).
- NVIDIA GPU + `nvidia-container-toolkit`.
- Host paths `/srv/llm/.cache` (for model cache) and optional `/srv/llm/weights`.

## Environment setup

1. Copy `.env.example` (or create `.env`) and define:
   ```env
   VLLM_API_KEY=<your hex token>
   ```
   `.env` is already ignored; keep your API key here and rotate it periodically.
   Quick way to mint a 32-byte hex token (uses OpenSSL, available on most systems):
   ```bash
   openssl rand -hex 32
   ```
   If OpenSSL isn’t available, fall back to `/dev/urandom`:
   ```bash
   head -c32 /dev/urandom | xxd -p
   ```
2. Ensure the cache directory exists and is writable: `sudo mkdir -p /srv/llm/.cache`.

## Running services

Bring up the launcher alone (no models warmed):

```bash
docker compose --profile launcher up -d launcher
```

Start a specific model profile (launcher + backend):

```bash
# Fast coding model
docker compose --profile launcher --profile coder3b up -d

# Website-friendly Phi-3.5 chat model
docker compose --profile launcher --profile chat up -d

# Quantized Qwen 7B
docker compose --profile launcher --profile qwen7b up -d
```

The launcher listens on `:8000` and expects requests like:

```bash
curl -s http://localhost:8000/coder/v1/models \
  -H "Authorization: Bearer $VLLM_API_KEY" | jq .
```

Idle services shut down after `IDLE_SECONDS` (default 600). Tune `IDLE_SECONDS` and
`START_TIMEOUT_SECONDS` in the compose file via environment overrides.

## Operational tips

- Pin container names and ports via `MAP__<route>__container|port` env vars (already prefilled).
- Tail launcher logs during cold starts: `docker logs -f launcher`.
- Use `docker compose stop <service>` to free GPU memory quickly when switching workloads.
- For profile automation, see the scripts in `TODOs.txt` (switch script / Makefile ideas).

## Basic security checklist

- Only expose the launcher (`:8000`) publicly; keep model ports (`8001-8003`) on the LAN.
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
| `CUDA out of memory` in vLLM | Multiple models active or quantization missing | Use compose profiles to run one heavy model at a time and double-check quantized configs (`bitsandbytes` for qwen7b). |
