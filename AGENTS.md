# Repository Guidelines

## Project Structure & Module Organization
- `docker-compose.yml` orchestrates all vLLM backends plus the `launcher` proxy; treat it as the single source of truth for service config.
- `launcher/` contains the Node.js lazy-launcher (Dockerfile, `package.json`, `server.js`); any proxy logic lives here.
- `vision-server/` packages the diffusion FastAPI container that powers the `/vision` route. Keep it lightweight and GPU-first.
- `open-webui` lives exclusively in `docker-compose.yml`; keep its base URL targeting the launcher and persist state through the `open-webui-data` volume.
- `README.md` documents host-level setup, while `TODOs.txt` tracks pending infra improvements; update both when behavior changes.
- Secrets belong in `.env` (ignored). Do not add sensitive data to tracked files.
- Whenever env vars are added/removed/repurposed in compose or code, update `.env.example` in the same change so newcomers know which keys to set (e.g., `HF_TOKEN`).

## Build, Test, and Development Commands
- `docker compose --profile launcher up -d launcher` boots only the proxy for quick iterations.
- `docker compose --profile launcher --profile coder up -d` (or `chat`, `general`, `coderslow`, `agent`) launches the proxy plus a specific model intent.
- `docker compose logs -f launcher` tails proxy logs; essential for diagnosing lazy-start events.
- `docker compose stop <service>` frees GPU VRAM when switching workloads.
- `cd launcher && npm test` runs the lightweight unit tests for route parsing/mutex logic.

## Coding Style & Naming Conventions
- Node code in `launcher/` uses ES modules, 2-space indentation, and concise helper functions. Follow existing patterns for env parsing (e.g., `MAP__route__field`).
- Shell/compose examples assume lowercase service names that match container names (`coder-fast`, `chat-general`, `general-reasoner`, `coder-slow`, `agent-tools`, `launcher`).
- When adding scripts, prefer `.sh` with `set -euo pipefail` and minimal dependencies.

## Testing Guidelines
- `cd launcher && npm test` exercises the launcher helper functions (route map parsing, mutex, exclusive-start logic). Keep new logic covered here when possible.
- Still run manual verification after changes:
  - `curl http://127.0.0.1:8000/<route>/v1/models -H "Authorization: Bearer $VLLM_API_KEY"` after swapping models to ensure Docker orchestration works.
  - Tail `docker compose logs -f launcher` during cold starts to confirm start/stop events fire as expected.

## Commit & Pull Request Guidelines
- Use imperative, one-line commit subjects (e.g., “Add idle shutdown knob”). Group related doc/code changes together.
- Describe testing steps in the commit or PR body (e.g., “Verified via curl from WSL and macOS client”).
- PRs should summarize what changed, why, and any validation commands/output. Link TODO items when relevant and include screenshots only if UI artifacts are touched.

## Security & Configuration Tips
- Never commit real API keys. Run a heuristic scan before pushing (`python scripts/secret_scan.py` or `gitleaks`).
- Keep the Windows firewall rule scoped to the Private profile and rotate `VLLM_API_KEY` quarterly.
