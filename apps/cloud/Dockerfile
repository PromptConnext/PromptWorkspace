# PromptZone Cloud — container image for Cloud Run / any container host.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install deps first for layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# App code + migrations (schema_version on /health reads the migrations dir).
COPY app ./app
COPY migrations ./migrations

# Cloud Run injects $PORT; default to 8080 locally.
ENV PORT=8080
EXPOSE 8080

# Single worker: presence + rate-limit + metrics state is in-process (v1).
# Horizontal scale needs a shared backplane first — see README.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
