# Launcher Folder Guidelines

## Scope & Purpose
- Everything here builds the lazy-launcher proxy that listens on port 8000 and hot-swaps vLLM backends.
- `server.js` is the single runtime entrypoint (also executed by the Docker image); keep all proxy/mutex logic inside this file or nearby helpers.
- Node 20 (see `Dockerfile`) plus native `node:test` are the only runtime/test dependencies; avoid adding frameworks unless absolutely required.

## Layout
- `server.js` – HTTP proxy, Docker orchestration helpers (`buildRouteMap`, `Mutex`, `createEnsureExclusive`, idle reaper).
- `server.test.js` – unit tests for routing, mutex, and exclusivity logic; mirror new helpers here to keep coverage.
- `package.json` / `package-lock.json` – ESM is enforced via `"type": "module"`; only `http-proxy` is vendored.
- `Dockerfile` – copies `server.js` and installs deps with `npm install --omit=dev`; keep runtime lean and remember it needs `docker-cli`.

## Coding Style & Patterns
- Use 2-space indentation, ES modules, and small pure helpers (see `buildRouteMap`, `pickTarget`, `rewritePath`).
- Environment keys follow `MAP__<route>__(container|port)`; extend parsing in `buildRouteMap` if new metadata is required.
- Concurrency-sensitive code must go through the shared `Mutex`/`createEnsureExclusive` combo so only one container boots at a time.
- Prefer async/await with the built-in Docker API helper; keep log lines consistent with `logger.info/warn/error`.
- Interact with Docker through the Engine API (`/var/run/docker.sock`) using the existing helper instead of spawning the Docker CLI.

## Configuration & Env Vars
- `MAP__<route>__container` / `MAP__<route>__port` define routable backends and must match Docker service names.
- `IDLE_SECONDS` controls when `startIdleReaper()` stops inactive containers (default 600); `START_TIMEOUT_SECONDS` gates health polling.
- `VLLM_API_KEY` is injected into outbound requests if clients do not send `Authorization`; never hardcode secrets.
- `LAUNCHER_DISABLE_IDLE_REAPER=1` is the opt-out switch used by tests or debugging sessions.
- `PREWARM_ROUTES=chat,general` warms specific routes on boot; `DOCKER_HOST_SOCKET` overrides the Docker Engine socket path when `/var/run/docker.sock` is unavailable.

## Development Workflow
- `npm test` (or `node server.test.js`) is the fast feedback loop; add regression tests whenever proxy logic changes.
- Run the server locally with `node server.js` or through Docker via `docker compose --profile launcher up -d launcher` from the repo root.
- Tail behavior using `docker compose logs -f launcher`; look for `Ensuring exclusive access` and `Idle timeout` lines when debugging.
- After changing Docker interactions, verify manually with `curl http://127.0.0.1:8000/<route>/v1/models` (auth header optional if `VLLM_API_KEY` set).

## Security & Hygiene
- Do not commit `.env` or real API keys; test secrets should live in your shell environment.
- Keep the runtime surface minimal—avoid extra npm dependencies unless required for proxy correctness.
- Before shipping, run the existing tests and (if dependencies change) update the lockfile inside this directory only.
