FROM node:24-slim

# transcribe_video.py needs python3, ffmpeg and ffprobe, plus CA certs for HTTPS to OpenRouter
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js transcribe_video.py ./
COPY dev ./dev

CMD ["node", "server.js"]
