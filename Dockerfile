FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml README.md ./
COPY shelfwise ./shelfwise
RUN pip install ".[postgres]" && useradd --create-home --uid 10001 shelfwise
USER shelfwise
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz').status==200 else 1)"
CMD ["uvicorn", "shelfwise.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--workers", "2"]
