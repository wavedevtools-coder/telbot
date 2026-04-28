FROM node:20-bookworm-slim

WORKDIR /app

# ffmpeg is required by bot.js for synthetic audio segment generation.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "bot.js"]
