FROM node:24-slim

# transcribe.js needs ffmpeg and ffprobe
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.js ./
COPY dev ./dev
COPY frontend/index.html frontend/sample-take.m4a ./frontend/

CMD ["node", "server.js"]
