FROM pytorch/pytorch:2.2.2-cuda12.1-cudnn8-runtime

ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

EXPOSE 8188

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8188"]
