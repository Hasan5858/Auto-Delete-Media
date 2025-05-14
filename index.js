// Load environment variables from .env file for local development
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000; // Port for Railway or local
const APP_URL = process.env.RAILWAY_STATIC_URL; // Railway provides this automatically after first deploy

if (!BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN);
const app = express();

app.use(express.json());

// --- In-memory stores ---
const chatTimers = new Map(); // chatId -> durationString | "off"
const chatSchedules = new Map(); // chatId -> { startTime: "HH:MM", endTime: "HH:MM" | null, deleteDuration: "5m" | null, timezone: "GMT+6" }
const chatWhitelists = new Map(); // chatId -> Array<userId>

const DEFAULT_TIMER_DURATION = '15m'; // Default 15 minutes
const MADE_BY_FOOTER = "\n\nMade by [Trendy Tribe](https://t.me/+Mlo9njp07m01ZTY1)"; // Footer text

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
    const gmt6Hours = (utcHours + 6) % 24; // Add 6 hours for GMT+6
    return {
        hours: gmt6Hours,
        minutes: now.getUTCMinutes()
    };
}

async function isAdmin(chatId, userId) {
    // In private chats, everyone is an "admin" of their own chat in a sense, or commands should work.
    // For group/supergroup, we check actual admin status.
    const chat = await bot.getChat(chatId);
    if (chat.type === 'private') {
        return true; // Allow commands in private chat with the bot
    }
    if (!chatId || !userId) return false;
    try {
        const member = await bot.getChatMember(chatId, userId);
        return ['administrator', 'creator'].includes(member.status);
    } catch (error) {
        console.error(`Error checking admin status for chat ${chatId}, user ${userId}:`, error.message);
        return false; // Assume not admin if check fails
    }
}

/**
 * Escapes text for Telegram MarkdownV2.
 * @param {string} text - The text to escape.
 * @returns {string} - The escaped text.
 */
function escapeMarkdownV2(text) {
  if (typeof text !== 'string') return '';
  const escapeChars = '_*[]()~`>#+-=|{}.!'; // Characters to escape for MarkdownV2
  return text.replace(new RegExp(`([${escapeChars.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}])`, 'g'), '\\$1');
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
4. Use /status to view settings (admins only)

⚙️ Commands (Admin Only in Groups):
  /settimer <duration|off> – Set auto-delete timer (e.g., 10s, 5m, 1h)
  /schedule <HH:MM_start> <delete_duration> – Schedule active timer (GMT+6, e.g., /schedule 22:00 5m)
  /scheduleoff <HH:MM_end> – Schedule timer off (GMT+6, e.g., /scheduleoff 08:00)
  /whitelist_him – Reply to a user's message to whitelist them
  /remove_him – Reply to a user's message to remove from whitelist
  /status – Show current configuration

📸 Media with a time in caption (e.g., 'my pic 30s') will use that specific time for deletion (works for all users).`;
  bot.sendMessage(chatId, escapeMarkdownV2(welcomeMessage) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/settimer (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId, msg.from.id))) {
    // Silently ignore for non-admins in groups, or send a message if it's a private chat and they aren't supposed to use it.
    // For this case, we assume commands are admin-only in groups.
    const chat = await bot.getChat(chatId);
    if (chat.type !== 'private') {
        console.log(`Non-admin user ${msg.from.id} tried /settimer in group ${chatId}`);
        return; // Do not respond to non-admins in groups
    }
    // If it's a private chat, the isAdmin check might allow it if you want direct control.
    // However, the prompt implies these are group admin commands.
  }
  const inputDuration = match[1].trim().toLowerCase();
  if (inputDuration === 'off') {
    chatTimers.set(chatId, 'off');
    bot.sendMessage(chatId, escapeMarkdownV2('⏰ Auto-delete timer is now OFF.') + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
  } else {
    if (parseDurationToMs(inputDuration)) {
      chatTimers.set(chatId, inputDuration);
      bot.sendMessage(chatId, escapeMarkdownV2(`⏰ Auto-delete timer set to ${inputDuration}.`) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
    } else {
      bot.sendMessage(chatId, escapeMarkdownV2('⚠️ Invalid duration format. Use "10s", "5m", "1h", or "off".') + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
    }
  }
});

bot.onText(/\/schedule (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!(await isAdmin(chatId, msg.from.id))) {
        const chat = await bot.getChat(chatId);
        if (chat.type !== 'private') return;
    }
    const args = match[1].trim().split(' ');
    if (args.length !== 2) {
        bot.sendMessage(chatId, escapeMarkdownV2('⚠️ Invalid format. Use: /schedule <HH:MM_start> <delete_duration_during_schedule>\nExample: /schedule 22:00 5m') + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
        return;
    }
    const startTime = args[0]; 
    const deleteDuration = args[1].toLowerCase(); 

    if (!/^\d{2}:\d{2}$/.test(startTime) || !parseDurationToMs(deleteDuration)) {
        bot.sendMessage(chatId, escapeMarkdownV2('⚠️ Invalid time or duration format.\nStart time should be HH:MM (e.g., 22:00).\nDelete duration should be like 5m, 10s, 1h.') + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
        return;
    }
    
    const scheduleData = chatSchedules.get(chatId) || {};
    scheduleData.startTime = startTime;
    scheduleData.deleteDuration = deleteDuration;
    scheduleData.timezone = "GMT+6";

    chatSchedules.set(chatId, scheduleData);
    let messageText = `🗓️ Timer scheduled to be active from ${startTime} (GMT+6).`;
    if(scheduleData.endTime) {
        messageText += ` It will turn off at ${scheduleData.endTime} (GMT+6).`;
    } else {
        messageText += ` No specific off time set yet (use /scheduleoff HH:MM).`;
    }
    messageText += `\nDuring this active period, media will be deleted after ${deleteDuration}.`;
    bot.sendMessage(chatId, escapeMarkdownV2(messageText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/scheduleoff (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!(await isAdmin(chatId, msg.from.id))) {
        const chat = await bot.getChat(chatId);
        if (chat.type !== 'private') return;
    }
    const endTime = match[1].trim(); 

    if (!/^\d{2}:\d{2}$/.test(endTime)) {
        bot.sendMessage(chatId, escapeMarkdownV2('⚠️ Invalid time format. End time should be HH:MM (e.g., 08:00).') + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
        return;
    }

    const scheduleData = chatSchedules.get(chatId) || {};
    scheduleData.endTime = endTime;
    scheduleData.timezone = scheduleData.timezone || "GMT+6"; 

    chatSchedules.set(chatId, scheduleData);
    
    let messageText = `🗓️ Scheduled timer will now turn off at ${endTime} (GMT+6).`;
    if(scheduleData.startTime && scheduleData.deleteDuration){
        messageText += `\nIt is active from ${scheduleData.startTime} (GMT+6) deleting media after ${scheduleData.deleteDuration}.`;
    } else {
        messageText += `\nℹ️ Note: Schedule start time and delete duration are not set. Use /schedule HH:MM <duration> to fully define the active period.`;
    }
    bot.sendMessage(chatId, escapeMarkdownV2(messageText) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/whitelist_him/, async (msg) => {
    const chatId = msg.chat.id;
    if (!(await isAdmin(chatId, msg.from.id))) {
        const chat = await bot.getChat(chatId);
        if (chat.type !== 'private') return;
    }
    if (!msg.reply_to_message) {
        bot.sendMessage(chatId, escapeMarkdownV2("⚠️ Please reply to a user's message to whitelist them.") + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
        return;
    }
    const userToWhitelist = msg.reply_to_message.from;
    let whitelist = chatWhitelists.get(chatId) || [];
    if (!whitelist.includes(userToWhitelist.id)) {
        whitelist.push(userToWhitelist.id);
        chatWhitelists.set(chatId, whitelist);
        bot.sendMessage(chatId, escapeMarkdownV2(`✅ ${userToWhitelist.first_name} (@${userToWhitelist.username || 'User'}) has been added to the whitelist.`) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
    } else {
        bot.sendMessage(chatId, escapeMarkdownV2(`👍 ${userToWhitelist.first_name} is already on the whitelist.`) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
    }
});

bot.onText(/\/remove_him/, async (msg) => {
    const chatId = msg.chat.id;
    if (!(await isAdmin(chatId, msg.from.id))) {
        const chat = await bot.getChat(chatId);
        if (chat.type !== 'private') return;
    }
    if (!msg.reply_to_message) {
        bot.sendMessage(chatId, escapeMarkdownV2("⚠️ Please reply to a user's message to remove them from the whitelist.") + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
        return;
    }
    const userToRemove = msg.reply_to_message.from;
    let whitelist = chatWhitelists.get(chatId) || [];
    const index = whitelist.indexOf(userToRemove.id);
    if (index > -1) {
        whitelist.splice(index, 1);
        chatWhitelists.set(chatId, whitelist);
        bot.sendMessage(chatId, escapeMarkdownV2(`🗑️ ${userToRemove.first_name} (@${userToRemove.username || 'User'}) has been removed from the whitelist.`) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
    } else {
        bot.sendMessage(chatId, escapeMarkdownV2(`🤷 ${userToRemove.first_name} is not on the whitelist.`) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
    }
});

bot.onText(/\/status/, async (msg) => { // Added async here
  const chatId = msg.chat.id;
  // Check if user is admin FOR GROUPS. In private chat, /status can be used.
  if (!(await isAdmin(chatId, msg.from.id))) {
    const chat = await bot.getChat(chatId);
    if (chat.type !== 'private') { // Only restrict if it's a group and user is not admin
        console.log(`Non-admin user ${msg.from.id} tried /status in group ${chatId}`);
        // Optionally, send a message saying only admins can use it, or just ignore.
        // For now, let's just ignore to prevent spamming non-admins.
        return; 
    }
  }

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

  const whitelist = chatWhitelists.get(chatId) || [];
  statusMessage += `🛡️ Whitelisted Users: ${whitelist.length} user(s).\n`;
  
  statusMessage += `\n📸 Media with a time in caption (e.g., 'pic 30s') will use that specific time.`;

  bot.sendMessage(chatId, escapeMarkdownV2(statusMessage) + MADE_BY_FOOTER, { parse_mode: 'MarkdownV2' });
});

// --- Media Processing Logic ---
bot.on('photo', (msg) => processMedia(msg));
bot.on('video', (msg) => processMedia(msg));

function processMedia(msg) {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const userId = msg.from.id;
  const caption = msg.caption ? msg.caption.trim() : '';

  const whitelist = chatWhitelists.get(chatId) || [];
  if (whitelist.includes(userId)) {
    console.log(`Chat ${chatId}: User ${userId} is whitelisted. Not deleting message ${messageId}.`);
    return;
  }

  let timerToUse = null; 

  const captionDurationMatch = caption.toLowerCase().match(/(\b\d+[smh]\b)/);
  if (captionDurationMatch && captionDurationMatch[1]) {
    const captionSpecificDuration = captionDurationMatch[1];
    if (parseDurationToMs(captionSpecificDuration)) {
      timerToUse = captionSpecificDuration;
      console.log(`Chat ${chatId}: Using caption timer "${timerToUse}" for message ${messageId}`);
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
        if(schedule.endTime){
            const [endH, endM] = schedule.endTime.split(':').map(Number);
            endTimeInMinutesGMT6 = endH * 60 + endM;
        }

        let isActiveSchedule = false;
        if (startTimeInMinutesGMT6 <= endTimeInMinutesGMT6) { 
            if (currentTimeInMinutesGMT6 >= startTimeInMinutesGMT6 && currentTimeInMinutesGMT6 < endTimeInMinutesGMT6) {
                isActiveSchedule = true;
            }
        } else { 
            if (currentTimeInMinutesGMT6 >= startTimeInMinutesGMT6 || currentTimeInMinutesGMT6 < endTimeInMinutesGMT6) {
                isActiveSchedule = true;
            }
        }

        if (isActiveSchedule) {
            timerToUse = schedule.deleteDuration;
            console.log(`Chat ${chatId}: Using active schedule timer "${timerToUse}" for message ${messageId}`);
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
    console.log(`Chat ${chatId}: Auto-delete is effectively off. Not deleting message ${messageId}.`);
    return;
  }

  const deleteDelayMs = parseDurationToMs(timerToUse);

  if (deleteDelayMs && deleteDelayMs > 0) {
    console.log(`Chat ${chatId}: Scheduling message ${messageId} for deletion in ${timerToUse} (${deleteDelayMs}ms).`);
    setTimeout(() => {
      bot.deleteMessage(chatId, messageId)
        .then(() => {
          console.log(`Chat ${chatId}: Successfully deleted message ${messageId} after ${timerToUse}.`);
        })
        .catch((error) => {
          if (error.response && error.response.body) {
            const errorBody = typeof error.response.body === 'string' ? JSON.parse(error.response.body) : error.response.body;
            console.error(`Chat ${chatId}: Failed to delete message ${messageId} (API Error): ${errorBody.description || error.message}`);
          } else {
            console.error(`Chat ${chatId}: Failed to delete message ${messageId} (Network/Other Error): ${error.message}`);
          }
        });
    }, deleteDelayMs);
  } else {
    console.warn(`Chat ${chatId}: Invalid or zero timer duration "${timerToUse}" for message ${messageId}. Not scheduling deletion.`);
  }
}

// --- Start App ---
async function startApp() {
  if (process.env.NODE_ENV === 'development' || !APP_URL) {
    console.log('🤖 Starting bot with polling for local development...');
    bot.startPolling()
      .then(() => console.log('✅ Bot polling started successfully.'))
      .catch(err => console.error('❌ Polling error:', err));
    app.listen(PORT, () => {
        console.log(`🚀 Express server listening on port ${PORT} for potential local webhook testing.`);
    });
  } else {
    app.listen(PORT, async () => {
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
