// Load environment variables from .env file for local development
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000; // Railway will inject its own PORT

// Attempt to get the public URL from Railway environment variables
// Railway might provide RAILWAY_PUBLIC_DOMAIN or other variables for the public URL.
// RAILWAY_STATIC_URL was an older variable, might still be used by some templates.
const RAILWAY_APP_HOSTNAME = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || null;

console.log("RAILWAY LOG: --- Environment Variable Check ---");
console.log("RAILWAY LOG: NODE_ENV:", process.env.NODE_ENV);
console.log("RAILWAY LOG: BOT_TOKEN is set:", BOT_TOKEN ? "Yes" : "No");
console.log("RAILWAY LOG: PORT:", PORT);
console.log("RAILWAY LOG: Detected RAILWAY_APP_HOSTNAME:", RAILWAY_APP_HOSTNAME);
console.log("RAILWAY LOG: ---------------------------------");


if (!BOT_TOKEN) {
  console.error('RAILWAY LOG: Error: TELEGRAM_BOT_TOKEN is not set! Bot will not start correctly.');
  process.exit(1); // Exit if token is missing, as bot is unusable
}

// --- Initialize In-Memory Stores ---
const chatTimers = new Map(); 
const chatSchedules = new Map(); 

const bot = new TelegramBot(BOT_TOKEN);
const app = express();
app.use(express.json());

const DEFAULT_TIMER_DURATION = '15m';
const MADE_BY_FOOTER = "\n\nMade by [Trendy Tribe](https://t.me/+Mlo9njp07m01ZTY1)";
const BOT_REPLY_DELETE_DELAY = 60000; 
const USER_COMMAND_DELETE_DELAY = 10000;

// --- Helper Functions (Keep them as they are) ---
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

async function isAdmin(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (msg.chat.type === 'private') return true;
    if (msg.sender_chat && msg.sender_chat.id === chatId) return true; 
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
            if (!err.message.includes("message to delete not found") && !err.message.includes("message can't be deleted")) {
                console.log(`RAILWAY LOG: Could not auto-delete message ${messageId} in chat ${chatId}: ${err.message}`);
            }
        });
    }, delay);
}

// --- Webhook ---
// Using a more generic path, not dependent on BOT_TOKEN in the path itself for simplicity with reverse proxies
// The BOT_TOKEN in the path was for some secrecy, but can be problematic if token has special chars.
// A fixed secret path is often better.
const WEBHOOK_SECRET_PATH = process.env.WEBHOOK_SECRET_PATH || `/telegram_webhook_handler_${BOT_TOKEN.substring(0,10)}`; // Use a portion of token or a fixed secret
console.log("RAILWAY LOG: Webhook path for Express app:", WEBHOOK_SECRET_PATH);

app.post(WEBHOOK_SECRET_PATH, (req, res) => {
  console.log(`RAILWAY LOG: POST request received at ${WEBHOOK_SECRET_PATH}`);
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// --- Bot Commands (Ensure all your command handlers are here) ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`RAILWAY LOG: /start command from chat ${chatId}`);
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
        if (sentMessage) autoDeleteMessage(sentMessage.chat.id, sentMessage.message_id, BOT_REPLY_DELETE_DELAY);
    }).catch(err => console.error(`RAILWAY LOG: Error sending /start reply: ${err.message}`));
});

// (Paste ALL your other command handlers: /settimer, /schedule, /scheduleoff, /status here.
//  Ensure they use `console.log(\`RAILWAY LOG: ...\`)` for logging.)
// Example for /settimer:
bot.onText(/\/settimer (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userCommandMessageId = msg.message_id;
  let replyText = '';
  console.log(`RAILWAY LOG: /settimer command from chat ${chatId}, args: ${match[1]}`);

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

// (Ensure /schedule, /scheduleoff, /status handlers are here with similar logging)
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const userCommandMessageId = msg.message_id;
  console.log(`RAILWAY LOG: /status command from chat ${chatId}`);
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


// --- Media Processing Logic (Keep it as it is) ---
bot.on('photo', (msg) => processMedia(msg));
bot.on('video', (msg) => processMedia(msg));

function processMedia(msg) {
  // (Ensure the full processMedia function from the previous artifact is here, with RAILWAY LOG prefixes)
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const caption = msg.caption ? msg.caption.trim() : '';
  console.log(`RAILWAY LOG: Processing media message ${messageId} in chat ${chatId}`);

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
  // Check if NODE_ENV is production AND a public URL is available
  if (process.env.NODE_ENV === 'production' && RAILWAY_APP_HOSTNAME) {
    console.log(`RAILWAY LOG: Production environment detected. RAILWAY_APP_HOSTNAME: ${RAILWAY_APP_HOSTNAME}. Starting in webhook mode.`);
    app.listen(PORT, '0.0.0.0', async () => { 
      console.log(`RAILWAY LOG: 🚀 Bot server started on port ${PORT}. Setting up webhook...`);
      // Construct webhook URL using the detected hostname and the secret path
      const webhookUrl = `https://${RAILWAY_APP_HOSTNAME}${WEBHOOK_SECRET_PATH}`;
      try {
        await bot.setWebHook(webhookUrl);
        console.log(`RAILWAY LOG: ✅ Webhook set to ${webhookUrl}`);
        const info = await bot.getWebHookInfo();
        console.log("RAILWAY LOG: Current Webhook Info:", info);
      } catch (error) {
        console.error('RAILWAY LOG: ❌ Error setting webhook:', error.message, error.stack);
        console.log(`RAILWAY LOG: ℹ️ Manual webhook setup might be needed: https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      }
    });
  } else { 
    console.log('RAILWAY LOG: 🤖 Not in production or RAILWAY_APP_HOSTNAME not found. Starting bot with polling for local/dev environment...');
    if (!RAILWAY_APP_HOSTNAME) {
        console.warn("RAILWAY LOG: RAILWAY_PUBLIC_DOMAIN or RAILWAY_STATIC_URL was not found in environment variables. Webhook setup will be skipped if not in development mode.");
    }
    bot.startPolling()
      .then(() => console.log('RAILWAY LOG: ✅ Bot polling started successfully.'))
      .catch(err => console.error('RAILWAY LOG: ❌ Polling error:', err.message));
    // Express server can still listen for local testing if needed, but polling is primary for dev here
    app.listen(PORT, () => {
        console.log(`RAILWAY LOG: 🚀 Express server (for potential local webhook testing) listening on port ${PORT}.`);
    });
  }
}

startApp();
