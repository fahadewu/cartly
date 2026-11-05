# The `tools` service in the workspace's docker-compose.yml: backups and restores with the same PostgreSQL
# version as the database (pg_dump/psql 16) and redis-cli. Build from the backend/ folder.
FROM pgvector/pgvector:pg16
RUN apt-get update && apt-get install -y --no-install-recommends redis-tools && rm -rf /var/lib/apt/lists/*
COPY scripts/store-data.sh /usr/local/bin/store-data
RUN chmod +x /usr/local/bin/store-data
ENV CARTLY_TOOLS=1
ENTRYPOINT ["store-data"]
