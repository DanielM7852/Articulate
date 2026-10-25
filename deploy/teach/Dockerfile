FROM node:24-bookworm-slim AS web
WORKDIR /src
COPY web/package.json web/package-lock.json /src/web/
WORKDIR /src/web
RUN npm ci --no-audit --no-fund
COPY web /src/web
COPY vowel-mapper /src/vowel-mapper
COPY mouth-demo /src/mouth-demo
COPY spacetimedb/src /src/spacetimedb/src
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv nginx ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default
RUN curl -fsSL -o /tmp/spacetime.tar.gz https://github.com/clockworklabs/SpacetimeDB/releases/download/v2.13.0/spacetime-x86_64-unknown-linux-gnu.tar.gz \
    && tar -xzf /tmp/spacetime.tar.gz -C /usr/local/bin \
    && ln -s /usr/local/bin/spacetimedb-cli /usr/local/bin/spacetime \
    && chmod +x /usr/local/bin/spacetimedb-cli /usr/local/bin/spacetimedb-standalone \
    && rm /tmp/spacetime.tar.gz
RUN python3 -m venv /opt/classroom \
    && /opt/classroom/bin/pip install --no-cache-dir fastapi uvicorn pydantic pydantic-settings httpx
WORKDIR /app
COPY backend/app /app/backend/app
COPY spacetimedb/package.json spacetimedb/package-lock.json spacetimedb/tsconfig.json /app/spacetimedb/
RUN npm install --no-audit --no-fund --prefix /app/spacetimedb
COPY spacetimedb/src /app/spacetimedb/src
COPY --from=web /src/web/dist /usr/share/nginx/html
COPY deploy/teach/nginx.conf /etc/nginx/conf.d/classroom.conf
COPY deploy/teach/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh
ENV CLASSROOM_PUBLIC_FROM_HOST=1 \
    STORE_DIR=/app/backend/.local_store
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
