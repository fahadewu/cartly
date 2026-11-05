# The AI & voice service. Build from the backend/ folder:  docker build -f ai/Dockerfile .
# (docker compose in the workspace does this for you.)
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    CUTOUT_MODEL_PATH=/data/models/birefnet-lite.onnx
COPY ai/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ai/app ./app
COPY docker/ /app/docker/
EXPOSE 8001
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=6 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.getenv('AI_PORT', '8001'), timeout=4)"
# Config comes from the environment (docker compose passes it); the secrets from the shared volume.
ENTRYPOINT ["sh", "/app/docker/ai-entrypoint.sh"]
