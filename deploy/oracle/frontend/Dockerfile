FROM docker.io/library/node:24.10-alpine AS builder

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend ./
ARG VITE_API_URL=""
ARG VITE_TURNSTILE_SITE_KEY=""
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_TURNSTILE_SITE_KEY=${VITE_TURNSTILE_SITE_KEY}
RUN npm run build

FROM docker.io/library/caddy:2.10.2-alpine

RUN setcap -r /usr/bin/caddy
COPY deploy/oracle/frontend/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/dist /srv

USER 10001:10001
EXPOSE 8080
