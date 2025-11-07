import base64
import io
import os
import time
from typing import Optional

import torch
from diffusers import StableDiffusionPipeline
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

MODEL_ID = os.environ.get("MODEL_ID", "runwayml/stable-diffusion-v1-5")
MODEL_REVISION = os.environ.get("MODEL_REVISION")
ENABLE_SAFETY_CHECKER = os.environ.get("ENABLE_SAFETY_CHECKER", "0") == "1"
ENABLE_TILING = os.environ.get("ENABLE_TILING", "1") == "1"
ENABLE_ATTENTION_SLICING = os.environ.get("ENABLE_ATTENTION_SLICING", "1") == "1"
MAX_EDGE = int(os.environ.get("MAX_EDGE", "1024"))
HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

app = FastAPI(title="Vision Diffusion Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

PIPELINE: Optional[StableDiffusionPipeline] = None


def load_pipeline() -> StableDiffusionPipeline:
    global PIPELINE
    if PIPELINE is not None:
        return PIPELINE

    torch.backends.cuda.matmul.allow_tf32 = True
    torch.set_grad_enabled(False)

    load_kwargs = {
        "torch_dtype": torch.float16,
        "use_safetensors": True,
    }
    if MODEL_REVISION:
        load_kwargs["revision"] = MODEL_REVISION
    if HF_TOKEN:
        load_kwargs["token"] = HF_TOKEN

    PIPELINE = StableDiffusionPipeline.from_pretrained(
        MODEL_ID,
        **load_kwargs
    )
    if not ENABLE_SAFETY_CHECKER:
        PIPELINE.safety_checker = None
        PIPELINE.requires_safety_checker = False
    PIPELINE = PIPELINE.to("cuda")
    PIPELINE.set_progress_bar_config(disable=True)
    if ENABLE_TILING:
        PIPELINE.enable_vae_tiling()
    if ENABLE_ATTENTION_SLICING:
        PIPELINE.enable_attention_slicing()
    return PIPELINE


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="Positive prompt text")
    negative_prompt: Optional[str] = Field(
        default=None,
        description="Negative prompt to suppress concepts"
    )
    guidance_scale: float = Field(
        default=7.0,
        ge=0.0,
        le=20.0,
        description="Classifier-free guidance scale"
    )
    num_inference_steps: int = Field(
        default=25,
        ge=1,
        le=100,
        description="Number of denoising steps"
    )
    seed: Optional[int] = Field(
        default=None,
        ge=0,
        description="Seed for reproducible outputs"
    )
    width: int = Field(
        default=512,
        ge=256,
        le=MAX_EDGE,
        description="Output width in pixels"
    )
    height: int = Field(
        default=512,
        ge=256,
        le=MAX_EDGE,
        description="Output height in pixels"
    )


class GenerateResponse(BaseModel):
    image_base64: str
    seed: Optional[int]
    took_ms: int


@app.on_event("startup")
async def _warm_pipeline() -> None:
    load_pipeline()


@app.get("/healthz")
async def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL_ID}


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest) -> GenerateResponse:
    pipe = load_pipeline()
    generator = None
    if req.seed is not None:
        generator = torch.Generator(device="cuda").manual_seed(req.seed)

    started = time.perf_counter()
    try:
        result = pipe(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            guidance_scale=req.guidance_scale,
            num_inference_steps=req.num_inference_steps,
            generator=generator,
            width=req.width,
            height=req.height,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    image = result.images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("utf-8")
    took_ms = int((time.perf_counter() - started) * 1000)
    return GenerateResponse(image_base64=encoded, seed=req.seed, took_ms=took_ms)
