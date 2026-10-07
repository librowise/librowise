# syntax=docker/dockerfile:1
# Shelfwise ILS — one image for the web app and the background worker.

FROM python:3.12-slim-trixie AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /src
COPY pyproject.toml README.md ./
COPY shelfwise ./shelfwise
RUN pip wheel --wheel-dir /wheels ".[postgres]"

FROM python:3.12-slim-trixie
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SHELFWISE_ENVIRONMENT=production \
    SHELFWISE_LOG_FORMAT=json \
    SHELFWISE_BACKUP_DIR=/backups \
    SHELFWISE_CACHE_DIR=/var/lib/shelfwise
# postgresql-client (17 on trixie) provides pg_dump/pg_restore for the backup job; tini reaps
# children and forwards SIGTERM so workers shut down gracefully.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin shelfwise \
 && mkdir -p /backups /var/lib/shelfwise \
 && chown shelfwise:shelfwise /backups /var/lib/shelfwise
COPY --from=build /wheels /wheels
RUN pip install --no-index --find-links=/wheels "shelfwise[postgres]" && rm -rf /wheels
WORKDIR /home/shelfwise
USER shelfwise:shelfwise
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"
ENTRYPOINT ["tini", "--"]
# Trust X-Forwarded-* only from the reverse proxy: set FORWARDED_ALLOW_IPS to its address/network.
CMD ["uvicorn", "shelfwise.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--workers", "2", "--no-access-log"]
