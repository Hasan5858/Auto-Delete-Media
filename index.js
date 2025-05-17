// Load environment variables from .env file for local development
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.RAILWAY_STATIC_URL;

if (!BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set!');
  process.exit(1);
}

// --- Initialize In-Memory Stores ---
const chatTimers = new Map(); // chatId -> durationString | "off"
const chatSchedules = new Map(); // chatId -> { startTime: "HH:MM", endTime: "HH:MM" | null, deleteDuration: "5m" | null, timezone: "GMT+6" }
// const chatWhitelists = new Map(); // Removed

const bot = new TelegramBot(BOT_TOKEN);
const app = express();
app.use(express.json());

const DEFAULT_TIMER_DURATION = '15m';
const MADE_BY_FOOTER = "\n\nMade by [Trendy Tribe](https://t.me/+Mlo9njp07m01ZTY1)";
const BOT_REPLY_DELETE_DELAY = 60000; // 1 minute in milliseconds for bot's replies
const USER_COMMAND_DELETE_DELAY = 10000; // 10 seconds for user's commands

// --- Helper Functions ---
function parseDurationToMs(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return null;
  const match = durationStr.toLowerCase().match(/^(\d+)([smh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  return null;
}

function getCurrentTimeInGMT6() {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const gmt6Hours = (utcHours + 6) % 24;
    return {
        hours: gmt6Hours,
        minutes: now.getUTCMinutes()
    };
}

async function isAdmin(msg) { // Takes the full message object
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (msg.chat.type === 'private') {
        return true;
    }
    if (msg.sender_chat && msg.sender_chat.id === chatId) {
        return true; 
    }
    if (userId) {
        try {
            const member = await bot.getChatMember(chatId, userId);
            return ['administrator', 'creator'].includes(member.status);
        } catch (error) {
            console.error(`RAILWAY LOG: Error checking admin status for user ${userId} in chat ${chatId}: ${error.message}`);
            return false;
        }
    }
    return false;
}

function escapeMarkdownV2(text) {
  if (typeof text !== 'string') return '';
  const escapeChars = '_*[]()~`>#+-=|{}.!';
  return text.replace(new RegExp(`([${escapeChars.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}])`, 'g'), '\\$1');
}

function autoDeleteMessage(chatId, messageId, delay = USER_COMMAND_DELETE_DELAY) {
    setTimeout(() => {
        bot.deleteMessage(chatId, messageId).catch(err => {
            // It's okay if the message is already deleted or not found
            if (!err.message.includes("message to delete not found") && !err.message.includes("message can't be deleted")) {
                console.log(`RAILWAY LOG: Could not auto-delete message ${messageId} in chat ${chatId}: ${err.message}`);
            }
        });
    }, delay);
}

// --- Webhook ---
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// --- Bot Commands ---

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `👋 Welcome to Auto-Delete Media Bot!

📌 To use this bot:
1. Add it to your group.
2. Make it admin with delete permissions.
3. Use /settimer 15m or /settimer off (admins only)
4. Use /status to view settings (all users)

⚙️ Commands:
  /settimer <duration|off> – Set auto-delete timer (e.g., 10s, 5m, 1h) (Admins only)
  /schedule <HH:MM_start> <delete_duration> – Schedule active timer (GMT+6) (Admins only)
  /scheduleoff <HH:MM_end> – Schedule timer off (GMT+6) (Admins only)
  /status – Show current configuration (All users)

📸 Media with a time in caption (e.g., 'my pic 30s') will use that specific time for deletion (works for all users).`;
  bot.sendMessage(chatId, escapeMarkdownV2(welcomeMessage) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
    .then(sentMessage => {
        if (sentMessage) {
            autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
        }
    }).catch(err => console.error(`RAILWAY LOG: Error sending /start reply: ${err.message}`));
});

bot.onText(/\/settimer (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userCommandMessageId = msg.message_id;
  let replyText = '';

  if (!(await isAdmin(msg))) {
    if (msg.chat.type !== 'private') {
        replyText = "🚫 Only admins can use this command.";
        bot.sendMessage(chatId, escapeMarkdownV2(replyText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
            .then(sentMessage => {
                if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
            }).catch(err => console.error(`RAILWAY LOG: Error sending admin restriction reply for /settimer: ${err.message}`));
        autoDeleteMessage(chatId, userCommandMessageId); 
        return; 
    }
  }
  
  autoDeleteMessage(chatId, userCommandMessageId); 

  const inputDuration = match[1].trim().toLowerCase();
  if (inputDuration === 'off') {
    chatTimers.set(chatId, 'off');
    replyText = '⏰ Auto-delete timer is now OFF.';
  } else {
    if (parseDurationToMs(inputDuration)) {
      chatTimers.set(chatId, inputDuration);
      replyText = `⏰ Auto-delete timer set to ${inputDuration}.`;
    } else {
      replyText = '⚠️ Invalid duration format. Use "10s", "5m", "1h", or "off".';
    }
  }
  bot.sendMessage(chatId, escapeMarkdownV2(replyText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
    .then(sentMessage => {
        if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
    }).catch(err => console.error(`RAILWAY LOG: Error sending /settimer reply: ${err.message}`));
});

bot.onText(/\/schedule (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userCommandMessageId = msg.message_id;
    let replyText = '';

    if (!(await isAdmin(msg))) {
        if (msg.chat.type !== 'private') {
            replyText = "🚫 Only admins can use this command.";
            bot.sendMessage(chatId, escapeMarkdownV2(replyText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
                .then(sentMessage => {
                    if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
                }).catch(err => console.error(`RAILWAY LOG: Error sending admin restriction reply for /schedule: ${err.message}`));
            autoDeleteMessage(chatId, userCommandMessageId);
            return;
        }
    }
    autoDeleteMessage(chatId, userCommandMessageId);

    const args = match[1].trim().split(' ');
    if (args.length !== 2) {
        replyText = '⚠️ Invalid format. Use: /schedule <HH:MM_start> <delete_duration>\nExample: /schedule 22:00 5m';
        bot.sendMessage(chatId, escapeMarkdownV2(replyText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
            .then(sentMessage => {
                if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
            }).catch(err => console.error(`RAILWAY LOG: Error sending /schedule format error reply: ${err.message}`));
        return;
    }
    const startTime = args[0]; 
    const deleteDuration = args[1].toLowerCase(); 

    if (!/^\d{2}:\d{2}$/.test(startTime) || !parseDurationToMs(deleteDuration)) {
        replyText = '⚠️ Invalid time or duration format.\nStart time: HH:MM. Delete duration: 5m, 10s, 1h.';
        bot.sendMessage(chatId, escapeMarkdownV2(replyText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
            .then(sentMessage => {
                if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
            }).catch(err => console.error(`RAILWAY LOG: Error sending /schedule time/duration error reply: ${err.message}`));
        return;
    }
    
    const scheduleData = chatSchedules.get(chatId) || {};
    scheduleData.startTime = startTime;
    scheduleData.deleteDuration = deleteDuration;
    scheduleData.timezone = "GMT+6";
    chatSchedules.set(chatId, scheduleData);
    
    let messageText = `🗓️ Timer scheduled to be active from ${startTime} (GMT+6).`;
    if(scheduleData.endTime) messageText += ` It will turn off at ${scheduleData.endTime} (GMT+6).`;
    else messageText += ` No specific off time set yet (use /scheduleoff HH:MM).`;
    messageText += `\nDuring this active period, media will be deleted after ${deleteDuration}.`;
    bot.sendMessage(chatId, escapeMarkdownV2(messageText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
        .then(sentMessage => {
            if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
        }).catch(err => console.error(`RAILWAY LOG: Error sending /schedule success reply: ${err.message}`));
});

bot.onText(/\/scheduleoff (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userCommandMessageId = msg.message_id;
    let replyText = '';

    if (!(await isAdmin(msg))) {
        if (msg.chat.type !== 'private') {
            replyText = "🚫 Only admins can use this command.";
            bot.sendMessage(chatId, escapeMarkdownV2(replyText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
                .then(sentMessage => {
                    if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
                }).catch(err => console.error(`RAILWAY LOG: Error sending admin restriction reply for /scheduleoff: ${err.message}`));
            autoDeleteMessage(chatId, userCommandMessageId);
            return;
        }
    }
    autoDeleteMessage(chatId, userCommandMessageId);

    const endTime = match[1].trim(); 
    if (!/^\d{2}:\d{2}$/.test(endTime)) {
        replyText = '⚠️ Invalid time format. End time should be HH:MM (e.g., 08:00).';
        bot.sendMessage(chatId, escapeMarkdownV2(replyText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
            .then(sentMessage => {
                if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
            }).catch(err => console.error(`RAILWAY LOG: Error sending /scheduleoff format error reply: ${err.message}`));
        return;
    }

    const scheduleData = chatSchedules.get(chatId) || {};
    scheduleData.endTime = endTime;
    scheduleData.timezone = scheduleData.timezone || "GMT+6"; 
    chatSchedules.set(chatId, scheduleData);
    
    let messageText = `🗓️ Scheduled timer will now turn off at ${endTime} (GMT+6).`;
    if(scheduleData.startTime && scheduleData.deleteDuration) messageText += `\nIt is active from ${scheduleData.startTime} (GMT+6) deleting media after ${scheduleData.deleteDuration}.`;
    else messageText += `\nℹ️ Note: Schedule start time and delete duration are not set. Use /schedule HH:MM <duration>.`;
    bot.sendMessage(chatId, escapeMarkdownV2(messageText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
        .then(sentMessage => {
            if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
        }).catch(err => console.error(`RAILWAY LOG: Error sending /scheduleoff success reply: ${err.message}`));
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const userCommandMessageId = msg.message_id;
  autoDeleteMessage(chatId, userCommandMessageId, USER_COMMAND_DELETE_DELAY); 

  let statusMessage = "📊 Current Bot Configuration:\n\n";
  const groupTimer = chatTimers.get(chatId) || DEFAULT_TIMER_DURATION;
  statusMessage += `⏰ General Timer: ${groupTimer === 'off' ? 'OFF' : `Deletes after ${groupTimer}`}\n`;

  const schedule = chatSchedules.get(chatId);
  if (schedule && schedule.startTime && schedule.deleteDuration) {
      statusMessage += `🗓️ Scheduled Active Period (GMT+6):\n`;
      statusMessage += `   - Starts: ${schedule.startTime}\n`;
      statusMessage += `   - Deletion during schedule: After ${schedule.deleteDuration}\n`;
      statusMessage += `   - Ends: ${schedule.endTime || 'Not set (runs indefinitely or until /scheduleoff)'}\n`;
  } else {
      statusMessage += `🗓️ Scheduled Active Period: Not configured or OFF.\n`;
  }
  
  statusMessage += `\n📸 Media with a time in caption (e.g., 'pic 30s') will use that specific time.`;
  bot.sendMessage(chatId, escapeMarkdownV2(statusMessage) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' })
    .then(sentMessage => {
        if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
    }).catch(err => console.error(`RAILWAY LOG: Error sending /status reply: ${err.message}`));
});

// --- Media Processing Logic ---
bot.on('photo', (msg) => processMedia(msg));
bot.on('video', (msg) => processMedia(msg));

function processMedia(msg) {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const caption = msg.caption ? msg.caption.trim() : '';

  let timerToUse = null; 
  const captionDurationMatch = caption.toLowerCase().match(/(\b\d+[smh]\b)/);
  if (captionDurationMatch && captionDurationMatch[1]) {
    const captionSpecificDuration = captionDurationMatch[1];
    if (parseDurationToMs(captionSpecificDuration)) {
      timerToUse = captionSpecificDuration;
      console.log(`RAILWAY LOG: Chat ${chatId}: Using caption timer "${timerToUse}" for message ${messageId}`);
    }
  }

  if (!timerToUse) {
    const schedule = chatSchedules.get(chatId); 
    if (schedule && schedule.startTime && schedule.deleteDuration) {
        const { hours: currentHourGMT6, minutes: currentMinuteGMT6 } = getCurrentTimeInGMT6();
        const currentTimeInMinutesGMT6 = currentHourGMT6 * 60 + currentMinuteGMT6;
        const [startH, startM] = schedule.startTime.split(':').map(Number);
        const startTimeInMinutesGMT6 = startH * 60 + startM;
        let endTimeInMinutesGMT6 = Infinity; 
        if(schedule.endTime) {
            const [endH, endM] = schedule.endTime.split(':').map(Number);
            endTimeInMinutesGMT6 = endH * 60 + endM;
        }
        let isActiveSchedule = false;
        if (startTimeInMinutesGMT6 <= endTimeInMinutesGMT6) { 
            if (currentTimeInMinutesGMT6 >= startTimeInMinutesGMT6 && currentTimeInMinutesGMT6 < endTimeInMinutesGMT6) isActiveSchedule = true;
        } else { 
            if (currentTimeInMinutesGMT6 >= startTimeInMinutesGMT6 || currentTimeInMinutesGMT6 < endTimeInMinutesGMT6) isActiveSchedule = true;
        }
        if (isActiveSchedule) {
            timerToUse = schedule.deleteDuration;
            console.log(`RAILWAY LOG: Chat ${chatId}: Using active schedule timer "${timerToUse}" for message ${messageId}`);
        }
    }
  }

  if (!timerToUse) {
    timerToUse = chatTimers.get(chatId); 
  }
  
  if (!timerToUse && timerToUse !== 'off') { 
    timerToUse = DEFAULT_TIMER_DURATION;
  }

  if (timerToUse === 'off') {
    console.log(`RAILWAY LOG: Chat ${chatId}: Auto-delete is effectively off. Not deleting message ${messageId}.`);
    return;
  }

  const deleteDelayMs = parseDurationToMs(timerToUse);

  if (deleteDelayMs && deleteDelayMs > 0) {
    console.log(`RAILWAY LOG: Chat ${chatId}: Scheduling message ${messageId} for deletion in ${timerToUse} (${deleteDelayMs}ms).`);
    setTimeout(() => {
      bot.deleteMessage(chatId, messageId)
        .then(() => console.log(`RAILWAY LOG: Chat ${chatId}: Successfully deleted message ${messageId} after ${timerToUse}.`))
        .catch((error) => {
          if (error.response && error.response.body) {
            const errorBody = typeof error.response.body === 'string' ? JSON.parse(error.response.body) : error.response.body;
            // Avoid logging "message to delete not found" as a critical error, it's common
            if (!errorBody.description || !errorBody.description.includes("message to delete not found")) {
                 console.error(`RAILWAY LOG: Chat ${chatId}: Failed to delete message ${messageId} (API Error): ${errorBody.description || error.message}`);
            }
          } else {
            console.error(`RAILWAY LOG: Chat ${chatId}: Failed to delete message ${messageId} (Network/Other Error): ${error.message}`);
          }
        });
    }, deleteDelayMs);
  } else {
    console.warn(`RAILWAY LOG: Chat ${chatId}: Invalid or zero timer duration "${timerToUse}" for message ${messageId}. Not scheduling deletion.`);
  }
}

// --- Start App ---
async function startApp() {
  if (process.env.NODE_ENV === 'development' || !APP_URL ) { 
    console.log('🤖 Starting bot with polling for local development...');
    bot.startPolling()
      .then(() => console.log('✅ Bot polling started successfully.'))
      .catch(err => console.error('❌ Polling error:', err));
    app.listen(PORT, () => {
        console.log(`🚀 Express server listening on port ${PORT} for potential local webhook testing.`);
    });
  } else { // Production on Railway with APP_URL
    app.listen(PORT, '0.0.0.0', async () => { 
      console.log(`🚀 Bot server started on port ${PORT}. Setting up webhook...`);
      if (APP_URL && BOT_TOKEN) {
        const webhookUrl = `https://${APP_URL}${WEBHOOK_PATH}`;
        try {
          await bot.setWebHook(webhookUrl);
          console.log(`✅ Webhook set to ${webhookUrl}`);
        } catch (error) {
          console.error('❌ Error setting webhook:', error.message);
          console.log(`ℹ️ Manual webhook setup might be needed: https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
        }
      } else {
        console.error('❌ APP_URL or BOT_TOKEN is missing. Cannot set webhook.');
      }
    });
  }
}

startApp();
