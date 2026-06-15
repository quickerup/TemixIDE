const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../services/logger');
const state = require('../services/state');
const { userState } = require('./utils');
const { handleAction } = require('./actions');
const { setupHandlers } = require('./handlers');

let pollingBotInstance = null;
let broadcastBotInstance = null;

const broadcastToChannel = async (message) => {
  if (!config.BOT_TOKEN || !config.CHANNEL_ID) return;
  try {
    const bot = pollingBotInstance || (broadcastBotInstance ||= new TelegramBot(config.BOT_TOKEN, { polling: false }));
    await bot.sendMessage(config.CHANNEL_ID, message, { parse_mode: 'MarkdownV2' });
    logger.trace(`Channel broadcast sent to ${config.CHANNEL_ID}`);
  } catch (e) {
    logger.error(`[Broadcast Error] ${e.message}`);
  }
};

function initBot() {
  if (!config.BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled.');
    return null;
  }

  const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
  pollingBotInstance = bot;
  logger.info('Telegram Bot (TemixIDE) active.');

  // Initialize Handlers
  setupHandlers(bot);

  // Initialize Inline Query Support
  bot.on('inline_query', async (query) => {
    const authorized = config.AUTHORIZED_USERS.length === 0 || config.AUTHORIZED_USERS.includes(String(query.from.id));
    if (!authorized) return bot.answerInlineQuery(query.id, []);

    const text = query.query.trim();
    if (!text) return bot.answerInlineQuery(query.id, []);

    // Smart split regex
    const parts = [];
    const regex = /[^\s"]+|"([^"]*)"/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
        parts.push(match[1] ? match[1] : match[0]);
    }

    const cmd = parts[0].toLowerCase(); // get or call
    const cName = parts[1];
    const methodOrMsg = parts[2];
    const args = parts.slice(3);

    const results = [];
    
    // Resolve session for this specific user
    // Note: Inline queries don't have a chatId, but they have a user.id
    // Our state service is currently global, but it uses chatId. 
    // In this bot, chatId and userId are often the same for private chats.
    const target = state.state.deployed ? state.state.deployed[cName] : null;

    if (cmd === 'get' && cName && methodOrMsg && target) {
        results.push({
            type: 'article',
            id: 'get_' + Date.now(),
            title: `🔍 Get ${cName}.${methodOrMsg}()`,
            description: `Run getter on ${target.slice(0, 10)}...`,
            input_message_content: {
                message_text: `🔍 <b>Executing Getter</b>\nContract: <code>${cName}</code>\nMethod: <code>${methodOrMsg}</code>\nArgs: <code>${args.join(' ') || 'none'}</code>`,
                parse_mode: 'HTML'
            },
            reply_markup: {
                inline_keyboard: [[{ text: '▶️ Run Now', callback_data: `inline_get:${state.getShort(cName)}:${state.getShort(methodOrMsg)}:${state.getShort(args.join(','))}` }]]
            }
        });
    } else if (cmd === 'call' && cName && methodOrMsg && target) {
        results.push({
            type: 'article',
            id: 'call_' + Date.now(),
            title: `🚀 Call ${cName}.${methodOrMsg}`,
            description: `Send message to ${target.slice(0, 10)}...`,
            input_message_content: {
                message_text: `🚀 <b>Preparing Transaction</b>\nContract: <code>${cName}</code>\nMessage: <code>${methodOrMsg}</code>\nArgs: <code>${args.join(' ') || 'none'}</code>`,
                parse_mode: 'HTML'
            },
            reply_markup: {
                inline_keyboard: [[{ text: '✍️ Sign & Send', callback_data: `inline_call:${state.getShort(cName)}:${state.getShort(methodOrMsg)}:${state.getShort(args.join(','))}` }]]
            }
        });
    }
 else {
        // Show help/status
        results.push({
            type: 'article',
            id: 'help',
            title: '⚡ TemixIDE Power Commands',
            description: 'Usage: get [Contract] [Method] | call [Contract] [Msg]',
            input_message_content: {
                message_text: `<b>TemixIDE Inline Help</b>\n\nUsage:\n<code>@bot get [Contract] [Method] [Args]</code>\n<code>@bot call [Contract] [Message] [Args]</code>`,
                parse_mode: 'HTML'
            }
        });
    }

    bot.answerInlineQuery(query.id, results, { cache_time: 0, is_personal: true }).catch(e => logger.error('Inline Query Answer Error', '', e));
  });

  // Initialize Callback Actions
  bot.on('callback_query', async (query) => {
      const authorized = config.AUTHORIZED_USERS.length === 0 || config.AUTHORIZED_USERS.includes(String(query.from.id));
      if (!authorized) return bot.answerCallbackQuery(query.id, { text: "Unauthorized", show_alert: true });
      
      bot.answerCallbackQuery(query.id).catch(() => {});
      try {
          await handleAction(bot, query);
      } catch (e) {
          logger.error('[Bot Action Error]', '', e);
          bot.sendMessage(query.message.chat.id, "❌ Error: " + e.message);
      }
  });

  // State sweeper
  const userStateSweeper = setInterval(() => {
    const now = Date.now();
    for (const [chatId, entry] of Object.entries(userState)) {
      if ((now - entry.updatedAt) > 5 * 60 * 1000) {
        delete userState[chatId];
      }
    }
  }, 60_000);
  userStateSweeper.unref();

  return bot;
}

module.exports = {
  initBot,
  broadcastToChannel,
  getBot: () => pollingBotInstance
};
