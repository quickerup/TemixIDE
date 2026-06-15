const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../services/logger');
const state = require('../services/state');
const { setupHandlers } = require('./handlers');
const { handleAction } = require('./actions');

/**
 * Headless Bot Runner for Serverless Environments (GitHub Actions)
 */
async function runHeadless(update) {
    if (!config.BOT_TOKEN) {
        console.error('TELEGRAM_BOT_TOKEN missing');
        return;
    }

    // Initialize bot without polling
    const bot = new TelegramBot(config.BOT_TOKEN, { polling: false });

    // Mock the bot instance for handlers
    setupHandlers(bot);

    try {
        if (update.message) {
            console.log(`Processing message from ${update.message.chat.id}`);
            // Manually emit the message event
            bot.processUpdate(update);
        } else if (update.callback_query) {
            console.log(`Processing callback from ${update.callback_query.message.chat.id}`);
            await handleAction(bot, update.callback_query);
        } else if (update.inline_query) {
            // Logic for inline queries if needed
            bot.processUpdate(update);
        }
        
        // Wait a bit for async operations to complete
        // In a real serverless env, we'd want more robust async tracking
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Save state before exit
        state.saveState();
        console.log('Bot task completed.');
        
    } catch (e) {
        console.error('Headless execution failed:', e);
    }
}

// Check if run from CLI with payload
if (require.main === module) {
    const payloadStr = process.env.TELEGRAM_UPDATE;
    if (payloadStr) {
        try {
            const update = JSON.parse(payloadStr);
            runHeadless(update);
        } catch (e) {
            console.error('Failed to parse TELEGRAM_UPDATE');
        }
    } else {
        console.log('No TELEGRAM_UPDATE found in environment.');
    }
}

module.exports = { runHeadless };
