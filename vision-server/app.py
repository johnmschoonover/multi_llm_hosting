import base64
import io
import os
import time
from typing import Optional

import torch
from diffusers import AutoPipelineForText2Image, DiffusionPipeline
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

MODEL_ID = os.environ.get("MODEL_ID", "stabilityai/stable-diffusion-3.5-medium")
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

PIPELINE: Optional[DiffusionPipeline] = None


def load_pipeline() -> DiffusionPipeline:
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

    PIPELINE = AutoPipelineForText2Image.from_pretrained(
        MODEL_ID,
        **load_kwargs
    )
    if not ENABLE_SAFETY_CHECKER:
        if hasattr(PIPELINE, "safety_checker"):
            PIPELINE.safety_checker = None
        if hasattr(PIPELINE, "requires_safety_checker"):
            PIPELINE.requires_safety_checker = False
    PIPELINE = PIPELINE.to("cuda")
    PIPELINE.set_progress_bar_config(disable=True)
    if ENABLE_TILING and hasattr(PIPELINE, "enable_vae_tiling"):
        PIPELINE.enable_vae_tiling()
    if ENABLE_ATTENTION_SLICING and hasattr(PIPELINE, "enable_attention_slicing"):
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


def _run_generation(req: GenerateRequest) -> GenerateResponse:
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


@app.on_event("startup")
async def _warm_pipeline() -> None:
    load_pipeline()


@app.get("/healthz")
async def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL_ID}


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest) -> GenerateResponse:
    return _run_generation(req)


def _parse_size(size: str) -> tuple[int, int]:
    try:
        width_str, height_str = size.lower().split("x")
        width = int(width_str)
        height = int(height_str)
    except ValueError as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="size must look like 512x512") from exc

    if width < 256 or height < 256 or width > MAX_EDGE or height > MAX_EDGE:
        raise HTTPException(
            status_code=400,
            detail=f"size must stay within 256-{MAX_EDGE}px per dimension",
        )
    return width, height


class OpenAIImageRequest(BaseModel):
    prompt: str
    size: str = Field(default="512x512", description="WxH format, e.g. 768x512")
    n: int = Field(default=1, ge=1, le=1, description="Only one image per request supported")
    response_format: str = Field(default="b64_json", description="Only b64_json is supported")
    model: Optional[str] = Field(
        default=None,
        description="Optional identifier; currently ignored but kept for compatibility",
    )
    negative_prompt: Optional[str] = None
    guidance_scale: Optional[float] = Field(default=None, ge=0.0, le=20.0)
    num_inference_steps: Optional[int] = Field(default=None, ge=1, le=100)
    seed: Optional[int] = Field(default=None, ge=0)


class OpenAIImageData(BaseModel):
    b64_json: str


class OpenAIImageResponse(BaseModel):
    created: int
    data: list[OpenAIImageData]


@app.post("/v1/images/generations", response_model=OpenAIImageResponse)
async def openai_image_endpoint(req: OpenAIImageRequest) -> OpenAIImageResponse:
    if req.response_format.lower() != "b64_json":
        raise HTTPException(status_code=400, detail="Only response_format=b64_json is supported")

    width, height = _parse_size(req.size)
    defaults = GenerateRequest.model_fields
    gen_payload = GenerateRequest(
        prompt=req.prompt,
        negative_prompt=req.negative_prompt,
        guidance_scale=req.guidance_scale
        if req.guidance_scale is not None
        else defaults["guidance_scale"].default,
        num_inference_steps=req.num_inference_steps
        if req.num_inference_steps is not None
        else defaults["num_inference_steps"].default,
        seed=req.seed,
        width=width,
        height=height,
    )
    result = _run_generation(gen_payload)
    return OpenAIImageResponse(
        created=int(time.time()),
        data=[OpenAIImageData(b64_json=result.image_base64)],
    )
