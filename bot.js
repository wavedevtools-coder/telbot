require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const bundledFfmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const ffmpegPath = process.env.FFMPEG_PATH || bundledFfmpegPath || 'ffmpeg';
const execAsync = promisify(exec);
const allowedChatId = process.env.TELEGRAM_CHAT_ID ? String(process.env.TELEGRAM_CHAT_ID).trim() : null;
let pollingRestartTimer = null;

const userSessions = new Map();

console.log('🤖 Image-to-Video Bot is starting...');

async function startBotPolling() {
  try {
    // Ensure we are in polling mode and not conflicting with an old webhook config.
    await bot.deleteWebHook();
    await bot.startPolling({ restart: true });
    console.log('✅ Telegram polling started.');
  } catch (err) {
    console.error('Failed to start Telegram polling:', err.message);
    schedulePollingRestart();
  }
}

function schedulePollingRestart(delayMs = 5000) {
  if (pollingRestartTimer) {
    return;
  }

  pollingRestartTimer = setTimeout(async () => {
    pollingRestartTimer = null;
    await startBotPolling();
  }, delayMs);
}

bot.on('polling_error', async (err) => {
  console.error('Polling error:', err.message);

  if (String(err.message).includes('409 Conflict')) {
    console.log('Another poller is active. Retrying shortly...');
    try {
      await bot.stopPolling();
    } catch (_stopErr) {
      // Ignore stop failures and retry.
    }
    schedulePollingRestart();
  }
});

startBotPolling();

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `🎬 *Welcome to Image-to-Video Bot!*\n\n` +
    `Send me any image and I'll transform it into a *15-second AI-generated video*!\n\n` +
    `📸 Just upload a photo to get started.\n\n` +
    `Commands:\n` +
    `/start - Show this message\n` +
    `/help - How to use this bot\n` +
    `/status - Check your current job`,
    { parse_mode: 'Markdown' }
  );
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `📖 *How to use this bot:*\n\n` +
    `1️⃣ Send or upload any image (JPG, PNG, WEBP)\n` +
    `2️⃣ Optionally add a caption to guide the video style\n` +
    `3️⃣ Wait ~60-90 seconds while AI generates your video\n` +
    `4️⃣ Receive your 15-second MP4 video!\n\n` +
    `💡 *Tips for best results:*\n` +
    `• Use clear, high-quality images\n` +
    `• Landscape/portrait photos work great\n` +
    `• Add a caption like "cinematic", "zoom in", "sunset vibes"\n\n` +
    `⚡ Powered by Stability AI / RunwayML`,
    { parse_mode: 'Markdown' }
  );
});

// /status command
bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  if (!session) {
    bot.sendMessage(chatId, '✅ No active job. Send an image to start!');
  } else {
    bot.sendMessage(chatId, `⏳ Your job is currently: *${session.status}*\nJob ID: \`${session.jobId || 'pending'}\``, { parse_mode: 'Markdown' });
  }
});

// Handle photo messages
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  if (allowedChatId && String(chatId) !== allowedChatId) {
    return bot.sendMessage(chatId, 'This bot is not enabled for this chat.');
  }

  if (userSessions.get(chatId)?.processing) {
    return bot.sendMessage(chatId, '⏳ You already have a video being generated. Please wait...');
  }

  const caption = msg.caption || '';
  const photo = msg.photo[msg.photo.length - 1]; // highest resolution
  const fileId = photo.file_id;

  userSessions.set(chatId, { processing: true, status: 'downloading', jobId: null });

  const statusMsg = await bot.sendMessage(chatId,
    `📥 *Image received!*\nStarting video generation...\n\n⏳ Step 1/3: Downloading your image...`,
    { parse_mode: 'Markdown' }
  );

  try {
    // Step 1: Download the image from Telegram
    const fileLink = await bot.getFileLink(fileId);
    const imageResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);
    const imagePath = path.join(os.tmpdir(), `${chatId}_input.jpg`);
    fs.writeFileSync(imagePath, imageBuffer);

    await bot.editMessageText(
      `📥 *Image received!*\n\n✅ Step 1/3: Image downloaded\n⏳ Step 2/3: Building video assets...`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    );

    const prepared = await buildRenderInputs(imagePath, caption);
    userSessions.set(chatId, { processing: true, status: 'rendering', jobId: `local-${Date.now()}` });

    await bot.editMessageText(
      `📥 *Image received!*\n\n✅ Step 1/3: Image downloaded\n✅ Step 2/3: Assets ready\n⏳ Step 3/3: Rendering video with FFmpeg...`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    );

    const videoPath = await createVideo(prepared.assets, prepared.script, chatId);

    await bot.editMessageText(
      `📥 *Image received!*\n\n✅ Step 1/3: Image downloaded\n✅ Step 2/3: Job submitted\n✅ Step 3/3: Video ready! Sending...`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    );

    await bot.sendVideo(chatId, videoPath, {
      caption: `🎬 *Your AI-generated 15s video is ready!*\n\n${caption ? `Prompt: _${caption}_\n\n` : ''}Send another image to create a new video! 🚀`,
      parse_mode: 'Markdown',
      supports_streaming: true
    });

    // Cleanup
    safeUnlink(imagePath);
    safeUnlink(videoPath);
    prepared.cleanupPaths.forEach(safeUnlink);
    userSessions.delete(chatId);

  } catch (err) {
    console.error('Error:', err.message);
    userSessions.delete(chatId);
    bot.editMessageText(
      `❌ *Something went wrong!*\n\n${err.message}\n\nPlease try again with a different image.`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    );
  }
});

// Handle document uploads (images sent as files)
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;
  if (doc.mime_type && doc.mime_type.startsWith('image/')) {
    // Treat as photo
    msg.photo = [{ file_id: doc.file_id, file_size: doc.file_size }];
    bot.emit('photo', msg);
  } else {
    bot.sendMessage(chatId, '❌ Please send an image file (JPG, PNG, WEBP).');
  }
});

function shellEscape(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

async function generateSilentAudio(duration, outputPath) {
  const cmd = [
    shellEscape(ffmpegPath),
    '-y',
    `-f lavfi -i "anullsrc=r=44100:cl=stereo"`,
    `-t ${duration}`,
    '-q:a 4',
    shellEscape(outputPath),
  ].join(' ');

  await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });
}

async function buildRenderInputs(imagePath, caption) {
  const cleanupPaths = [];
  const mainAudioPath = path.join(os.tmpdir(), `seg_${Date.now()}_main.mp3`);
  const ctaAudioPath = path.join(os.tmpdir(), `seg_${Date.now()}_cta.mp3`);

  await generateSilentAudio(12, mainAudioPath);
  await generateSilentAudio(3, ctaAudioPath);
  cleanupPaths.push(mainAudioPath, ctaAudioPath);

  return {
    assets: [{
      image: imagePath,
      audio: mainAudioPath,
      duration: 12,
      text: caption || 'Watch till the end',
    }],
    script: {
      cta: 'Follow for more',
      ctaAudio: ctaAudioPath,
    },
    cleanupPaths,
  };
}

async function createVideo(assets, script, chatId) {
  console.log('\nRendering video with motion, effects and subtitles...');

  let inputs = [];
  let filterGraphs = [];
  let concatVideo = [];
  let concatAudio = [];

  const effects = ['zoom', 'pan', 'shake'];

  for (let i = 0; i < assets.length; i++) {
    inputs.push(`-loop 1 -t ${assets[i].duration} -i ${shellEscape(assets[i].image)}`);
    inputs.push(`-i ${shellEscape(assets[i].audio)}`);

    const effect = effects[i % effects.length];
    let motionFilter = '';
    let colorFlash = '';

    if (effect === 'zoom') {
      motionFilter = `zoompan=z='min(zoom+0.0015,1.5)':d=25*${assets[i].duration}:s=1080x1920`;
      colorFlash = 'eq=contrast=1.1:brightness=0.05';
    } else if (effect === 'shake') {
      motionFilter = 'crop=in_w-20:in_h-20:10+10*sin(t*10):10+10*cos(t*10),scale=1080:1920';
      colorFlash = 'eq=saturation=1.2';
    } else {
      motionFilter = `zoompan=x='if(lte(on,1),(iw/2)-(iw/zoom/2),x-1)':y='if(lte(on,1),(ih/2)-(ih/zoom/2),y)':d=25*${assets[i].duration}:s=1080x1920`;
      colorFlash = 'eq=gamma=1.1';
    }

    const safeText = assets[i].text.replace(/'/g, '\u2019').replace(/:/g, '\\:');
    let subtitleFilter = `drawtext=text='${safeText}':x=(w-text_w)/2:y=h-300:fontsize=72:fontcolor=white:bordercolor=black:borderw=5:shadowcolor=black:shadowx=3:shadowy=3:box=1:boxcolor=black@0.6:boxborderw=15`;

    if (i === assets.length - 1) {
      subtitleFilter += `,drawtext=text='CORRECT!':x=(w-text_w)/2:y=h/2-200:fontsize=120:fontcolor=#FFD700:bordercolor=black:borderw=8:shadowcolor=black:shadowx=5:shadowy=5:enable='between(t,1,${assets[i].duration})'`;
    }

    filterGraphs.push(`[${i * 2}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${motionFilter},${colorFlash},${subtitleFilter},setsar=1[v${i}]`);
    concatVideo.push(`[v${i}]`);

    filterGraphs.push(`[${i * 2 + 1}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,adelay=500|500[a${i}]`);
    concatAudio.push(`[a${i}]`);
  }

  const ctaImgIdx = assets.length * 2;
  const ctaAudIdx = assets.length * 2 + 1;
  inputs.push(`-loop 1 -t 3 -i ${shellEscape(assets[assets.length - 1].image)}`);
  inputs.push(`-i ${shellEscape(script.ctaAudio)}`);

  const safeCta = script.cta.replace(/'/g, '\u2019').replace(/:/g, '\\:');
  filterGraphs.push(`[${ctaImgIdx}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,drawtext=text='${safeCta}':x=(w-text_w)/2:y=h/2:fontsize=90:fontcolor=#FF0000:bordercolor=white:borderw=6,setsar=1[v_cta]`);
  concatVideo.push('[v_cta]');

  filterGraphs.push(`[${ctaAudIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,adelay=100|100[a_cta]`);
  concatAudio.push('[a_cta]');

  const totalSegments = assets.length + 1;
  const videoConcatStr = concatVideo.join('') + `concat=n=${totalSegments}:v=1:a=0[vout]`;
  const audioConcatStr = concatAudio.join('') + `concat=n=${totalSegments}:v=0:a=1[aout_raw]`;
  const bgmGraph = 'sine=f=150:d=15:r=44100,volume=0.1[bgm];[aout_raw][bgm]amix=inputs=2:duration=first[aout]';
  const filterComplex = [...filterGraphs, videoConcatStr, audioConcatStr, bgmGraph].join('; ');
  const outputPath = path.join(os.tmpdir(), `${chatId}_output.mp4`);

  const cmd = [
    shellEscape(ffmpegPath),
    '-y',
    ...inputs,
    `-filter_complex "${filterComplex}"`,
    '-map "[vout]" -map "[aout]"',
    '-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart',
    shellEscape(outputPath),
  ].join(' ');

  try {
    await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
    console.log('Video rendered successfully.');
    return outputPath;
  } catch (err) {
    const output = `${err.stdout || ''}\n${err.stderr || ''}`.slice(-1000);
    console.error('FFmpeg error:', output);
    throw err;
  }
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_err) {
    // Best effort cleanup only.
  }
}
