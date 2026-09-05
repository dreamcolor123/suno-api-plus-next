# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    BROWSER_DISABLE_GPU=true \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       python3 python3-pip ffmpeg \
       libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
       libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
       libxkbcommon0 libasound2 libcups2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/python ./python
COPY --from=builder /app/requirements-fast-upload.txt ./requirements-fast-upload.txt

# Install only public Python dependencies. Credentials are runtime inputs.
RUN python3 -m pip install --no-cache-dir --break-system-packages \
      -r ./python/requirements-fast-upload.txt

VOLUME ["/app/data"]
EXPOSE 3000
CMD ["npm", "run", "start"]
