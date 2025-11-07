# Vision Server Guidelines

## Scope & Purpose
- This directory houses a lightweight FastAPI service that wraps a Diffusers image generation pipeline for the `/vision` route.
- Keep the code GPU-aware (PyTorch with CUDA) and avoid CPU fallbacks unless explicitly toggled via environment variables.

## Coding Style
- Use Python 3.10+ features with `black`-compatible 88 character lines and 4-space indentation.
- Prefer `pydantic` models for request/response validation and document every request field with sensible bounds to protect VRAM.
- Avoid global mutable state beyond the lazy-loaded pipeline/scheduler cache; encapsulate helpers in functions when feasible.

## Dependencies & Packaging
- Pin Python dependencies in `requirements.txt`; upgrade deliberately and keep CUDA compatibility (Torch + Diffusers + Accelerate versions should remain in lockstep).
- The Dockerfile should stay minimal, based on the official PyTorch CUDA runtime images. Avoid adding system packages unless absolutely needed for inference.
- If new environment variables are introduced, document them in the README and `.env.example`.

## Testing & Validation
- Provide a simple `/healthz` endpoint returning JSON, and keep it aligned with the launcher health checks.
- If you add complex logic, consider adding lightweight unit tests (e.g., `pytest`) and wire them into the Dockerfile as build-time checks or document how to run them locally.
