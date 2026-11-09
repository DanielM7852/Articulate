# Public demo app on AWS Lightsail (Caddy + web/API)

One box (2 GB RAM, x86_64, Ubuntu 24.04). Caddy serves HTTPS on 80/443 and proxies (WebSockets included)
to the `app` container (built React app + FastAPI on port 8000, never published). Phone model and SPARC
are off until the GPU box exists (`PHONES_URL` / `ARTICULATION_URL` blank = "Phone model offline" view).

## First-time setup
1. Lightsail firewall: open TCP 80, TCP 443, UDP 443 (and 22). Attach a static IP.
2. DNS: A record `demo.example.com` -> the static IP (wait until it resolves; Caddy needs it for the cert).
3. On the box:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER   # then log out and in
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile  # safety net for the build
   git clone <repo-url> articulate && cd articulate && git switch main
   cp deploy/aws/app.env.example deploy/aws/app.env && nano deploy/aws/app.env   # fill secrets, CORS_ORIGINS
   echo "SITE_DOMAIN=demo.example.com" > deploy/aws/.env
   docker compose -f deploy/aws/compose.app.yaml up -d --build
   ```
   The Vite build is memory hungry; with 2 GB keep the swap above, or build elsewhere:
   `docker buildx build --platform linux/amd64 -f deploy/Dockerfile.app -t <registry>/articulate-app:<tag> --push .`
   then set `image:` in the compose file and run `up -d --pull always` without `--build`.

## Build args (baked into the web bundle)
- `VITE_DEMO_MVP` (default `true`): `true` = MVP demo flow (no survey, fixed lessons track -> sheep -> rent);
  `false` = the full app. Set with `--build-arg VITE_DEMO_MVP=false` or `build.args` in the compose file.
- `VITE_SPACETIME_URI`, `VITE_SPACETIME_DATABASE` (defaults match the app), `VITE_PHONES_WS` /
  `VITE_PHONES_HTTP` (default `same-origin`: the browser uses the backend's `/phones` relay).

## Update
```bash
cd articulate && git pull && docker compose -f deploy/aws/compose.app.yaml up -d --build
```
Changed only `app.env`: `docker compose -f deploy/aws/compose.app.yaml up -d --force-recreate app`.

## Logs and status
```bash
docker compose -f deploy/aws/compose.app.yaml ps
docker compose -f deploy/aws/compose.app.yaml logs -f app      # backend
docker compose -f deploy/aws/compose.app.yaml logs -f caddy    # TLS and proxy
curl -s https://demo.example.com/health
```

## Notes
- Coach memory/store lives in the `app_store` volume; certificates in `caddy_data`. Do not `down -v` casually.
- While `PHONES_URL` is blank, `/phones/<path>` returns 404 `{"detail":"phones_disabled"}` and `/phones/ws`
  accepts, sends `phone model unavailable`, then closes with 1011.
- `/phones/ws` origin check: allowed when Origin host equals `Host` / `X-Forwarded-Host`. Caddy forwards
  `Host` unchanged, so `PHONES_PROXY_ORIGIN_REGEX` is not needed.
