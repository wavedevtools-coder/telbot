# 🎬 Telegram Image-to-Video Bot

A Node.js Telegram bot that accepts image uploads and generates **15-second AI videos** using Stability AI or RunwayML.

---

## ✨ Features

- 📸 Upload any image → receive a 15-second AI video
- 🎭 Optional caption/prompt to guide video style
- 🔄 Real-time progress updates (3-step status)
- ⚡ Supports **Stability AI** (SVD) and **RunwayML Gen-3**
- 🛡️ Per-user session management (no queue conflicts)

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone <your-repo>
cd telegram-img2video-bot
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env` with your keys:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
VIDEO_PROVIDER=stability         # or "runway"
STABILITY_API_KEY=your_key       # if using stability
RUNWAY_API_KEY=your_key          # if using runway
```

### 3. Run the bot

```bash
npm start
# or for dev with auto-reload:
npm run dev
```

---

## 🔑 Getting API Keys

### Telegram Bot Token
1. Open Telegram, search for **@BotFather**
2. Send `/newbot` and follow the steps
3. Copy the token into `TELEGRAM_BOT_TOKEN`

### Stability AI (Recommended - Free tier available)
1. Go to [platform.stability.ai](https://platform.stability.ai/account/keys)
2. Create an account and generate an API key
3. Copy it into `STABILITY_API_KEY`
- Model used: **Stable Video Diffusion** (image-to-video)
- Cost: ~$0.05–0.10 per video

### RunwayML (Gen-3 Alpha Turbo)
1. Go to [app.runwayml.com](https://app.runwayml.com/account/api-keys)
2. Create an account and generate an API key
3. Copy it into `RUNWAY_API_KEY`
- Model used: **Gen-3 Alpha Turbo**
- Cost: ~$0.05 per second (so ~$0.75 for 15s)

---

## 📖 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Usage instructions |
| `/status` | Check your current generation job |

## 💬 Usage

1. Start a chat with your bot
2. Send `/start`
3. Upload or send any photo
4. Optionally add a caption like `"cinematic sunset"`, `"zoom in slowly"`, `"dramatic lighting"`
5. Wait ~60–90 seconds
6. Receive your 15-second MP4 video!

---

## 🏗️ Project Structure

```
telegram-img2video-bot/
├── bot.js           # Main bot logic
├── .env.example     # Environment variables template
├── .env             # Your actual config (gitignored)
├── package.json
└── README.md
```

---

## ⚙️ How It Works

```
User sends image
     ↓
Telegram API → bot downloads image
     ↓
Image sent to Stability AI / RunwayML
     ↓
Bot polls every 5s for completion
     ↓
Video downloaded and sent back to user
```

---

## 🐳 Docker (Optional)

```dockerfile
FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "bot.js"]
```

```bash
docker build -t img2video-bot .
docker run --env-file .env img2video-bot
```

---

## ⚠️ Notes

- Images are temporarily stored in `/tmp` and deleted after processing
- Only one video can be generated per user at a time
- Generation typically takes 60–120 seconds
- Max image size recommended: under 10MB
