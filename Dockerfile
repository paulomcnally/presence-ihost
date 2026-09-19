# Build frontend (glibc base: Tailwind v4 native deps ship linux-arm-gnueabihf
# but not linux-arm-musl, so Alpine would break the arm/v7 build; dist is
# architecture-independent and copied into the Alpine runtime stage below)
FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Build settings server
FROM golang:1.25-alpine AS settings
WORKDIR /build
COPY settings/go.mod settings/go.sum ./
RUN go mod download
COPY settings/ .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /settings-server .

# Runtime
FROM alpine:3.22
RUN apk add --no-cache arp-scan iproute2 iputils python3 tzdata \
    && mkdir -p /data /app/settings
WORKDIR /app
COPY presence.py /app/presence.py
COPY entrypoint.sh /app/entrypoint.sh
COPY --from=settings /settings-server /app/settings-server
COPY --from=frontend /build/dist /app/settings/dist

RUN chmod +x /app/entrypoint.sh

ENV WEB_ROOT=/app/settings/dist
EXPOSE 8082

ENTRYPOINT ["/app/entrypoint.sh"]