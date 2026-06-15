const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../services/logger');
const state = require('../services/state');
const compiler = require('../services/compiler');
const tonUtils = require('../services/ton-utils');
const githubImporter = require('../services/github-importer');
const { getShort, getLong } = require('../services/state');
const { getMainMenu } = require('./menus');
const { setUserState, clearUserState, getUserState } = require('./utils');
const { handleSendMessage, handleCallGetter } = require('./ton-actions');

function setupHandlers(bot) {
    const isAuthorized = (msg) => {
      const authorized = config.AUTHORIZED_USERS.length === 0 || config.AUTHORIZED_USERS.includes(String(msg.from.id));
      if (!authorized) logger.warn(`Unauthorized access attempt from ${msg.from.id} (@${msg.from.username})`);
      return authorized;
    };

    bot.onText(/\/start|\/menu/, (msg) => {
      if (!isAuthorized(msg)) return bot.sendMessage(msg.chat.id, "🚫 Unauthorized.");
      
      const welcome = `
🚀 <b>Welcome to TemixIDE v2.0</b>
The professional IDE for TON, now in your pocket.

<b>Quick Start Guide:</b>
1. ✨ <b>AI Forge:</b> Generate smart contracts using DeepSeek AI.
2. 📝 <b>Paste Code:</b> Add your own code by pasting it directly.
3. 📂 <b>Forge:</b> Compile your .tact or .fc files and manage artifacts.
4. 📂 <b>Contract:</b> Deploy and interact with live contracts.
5. 📂 <b>Workspace:</b> Manage your files and project history.
6. 📂 <b>Account:</b> Check your wallet balance and credentials.

<b>Power User Commands:</b>
• <code>/compile [FileName]</code> - Build a contract
• <code>/deploy [Contract] [Args...]</code> - Deploy to network
• <code>/get [Contract] [Method] [Args...]</code> - Call a getter
• <code>/call [Contract] [Message] [Args...]</code> - Send a transaction

<i>Tip: You can send any .tact or .fc file to this bot to add it to your project instantly.</i>
      `;
      bot.sendMessage(msg.chat.id, welcome, { ...getMainMenu(), parse_mode: 'HTML' });
    });

    bot.on('message', async (msg) => {
        if (!isAuthorized(msg)) return;
        const chatId = msg.chat.id;
        const stateData = getUserState(chatId);
        let text = msg.text ? msg.text.trim().replace(/^[\u200B\u200C\u200D\uFEFF]/, '') : '';
        if (text) logger.debug(`Bot message: "${text}" from ${msg.from.id}`);

        // Map reply keyboard buttons to actions
        const menuActions = {
          '📂 Forge': 'forge_menu', '📂 Contract': 'contract_menu', '📂 Workspace': 'workspace_menu',
          '📂 Account': 'account_menu', '📂 Sessions': 'sessions_menu', '✨ AI Forge': 'ai_forge_menu',
          // Legacy mappings for backward compatibility
          '📂 Project': 'workspace_menu', '🚀 Live': 'contract_menu', '💳 Wallet': 'account_menu'
        };

        if (menuActions[text]) {
            const { handleAction } = require('./actions');
            return handleAction(bot, { message: msg, data: menuActions[text], from: msg.from });
        }

        if (text === '/cancel') {
            clearUserState(chatId);
            return bot.sendMessage(chatId, "🚫 <b>Operation cancelled.</b>", { ...getMainMenu(), parse_mode: 'HTML' });
        }
        const lines = text.split('\n').filter(l => {
            const trimmed = l.trim();
            return trimmed.startsWith('/get ') || trimmed.startsWith('/call ') || trimmed.startsWith('/deploy ') || trimmed.startsWith('/compile ');
        });
        if (lines.length > 0) {
            for (const line of lines) {
                const trimmedLine = line.trim();
                // Regex to split by space but keep quoted strings together
                const parts = [];
                const regex = /[^\s"]+|"([^"]*)"/gi;
                let match;
                while ((match = regex.exec(trimmedLine)) !== null) {
                    parts.push(match[1] ? match[1] : match[0]);
                }

                const cmd = parts[0]; // /get, /call, /deploy, or /compile
                const cName = parts[1];
                const methodOrMsg = parts[2];
                const argsArr = parts.slice(cmd === '/deploy' || cmd === '/compile' ? 2 : 3);

                const session = state.getSession();
                
                if (cmd === '/compile') {
                    const fileName = cName;
                    if (!fileName) {
                        await bot.sendMessage(chatId, "❓ <b>Usage:</b> <code>/compile [FileName.tact]</code>", { parse_mode: 'HTML' });
                        continue;
                    }
                    bot.sendMessage(chatId, `🔨 <b>Compiling ${tonUtils.escapeHTML(fileName)}...</b>`, { parse_mode: 'HTML' });
                    compiler.queueCompileTask(async () => {
                        const sessionPath = state.getSessionPath();
                        const result = await compiler.compile(fileName, sessionPath);
                        if (result.success) {
                            await bot.sendMessage(chatId, `✅ <b>Compilation Successful: ${tonUtils.escapeHTML(fileName)}</b>\n\nArtifacts generated.`, {
                                parse_mode: 'HTML',
                                reply_markup: {
                                    inline_keyboard: [[{ text: '🚀 Deploy Menu', callback_data: 'deploy_menu' }]]
                                }
                            });
                        } else {
                            await bot.sendMessage(chatId, `❌ <b>Compilation Failed: ${tonUtils.escapeHTML(fileName)}</b>\n\n<pre>${tonUtils.escapeHTML(result.error || 'Unknown error')}</pre>`, { parse_mode: 'HTML' });
                        }
                    });
                    continue;
                }

                if (cmd === '/deploy') {
                    try {
                        const { handleDoDeploy } = require('./actions');
                        const deployArgs = {};
                        argsArr.forEach(arg => {
                            if (arg.includes('=')) {
                                const [k, v] = arg.split('=');
                                deployArgs[k.trim()] = v.trim();
                            }
                        });
                        await handleDoDeploy(bot, chatId, cName, deployArgs);
                    } catch (e) {
                        await bot.sendMessage(chatId, `❌ <b>Deployment failed:</b> <code>${tonUtils.escapeHTML(trimmedLine)}</code>\n${tonUtils.escapeHTML(e.message)}`, { parse_mode: 'HTML' });
                    }
                    continue;
                }

                const target = session.deployed[cName];
                const args = argsArr;

                if (!target) {
                    await bot.sendMessage(chatId, `❌ <b>Contract "${tonUtils.escapeHTML(cName)}" not found.</b>\n(Skipping command: <code>${tonUtils.escapeHTML(trimmedLine)}</code>)`, { parse_mode: 'HTML' });
                    continue;
                }

                if (!methodOrMsg) {
                    await bot.sendMessage(chatId, `❓ <b>Usage:</b>\n<code>${tonUtils.escapeHTML(cmd)} [ContractName] [Method] [Args...]</code>`, { parse_mode: 'HTML' });
                    continue;
                }

                try {
                    if (cmd === '/get') {
                        await handleCallGetter(bot, chatId, target, methodOrMsg, cName, args);
                    } else if (cmd === '/call') {
                        // Check if the original message had quotes around methodOrMsg to determine if it's a text comment
                        const isQuoted = trimmedLine.includes(`"${methodOrMsg}"`) || trimmedLine.includes(`'${methodOrMsg}'`);
                        
                        if (isQuoted && args.length === 0) {
                            await handleSendMessage(bot, chatId, target, 'text', cName, { text: methodOrMsg });
                        } else {
                            await handleSendMessage(bot, chatId, target, methodOrMsg, cName, args.reduce((acc, curr, idx) => {
                                if (curr.includes('=')) {
                                    const [k, v] = curr.split('=');
                                    acc[k] = v;
                                } else {
                                    acc[idx] = curr; 
                                }
                                return acc;
                            }, {}));
                        }
                    }
                } catch (e) {
                    await bot.sendMessage(chatId, `❌ <b>Error in command:</b> <code>${tonUtils.escapeHTML(trimmedLine)}</code>\n${tonUtils.escapeHTML(e.message)}`, { parse_mode: 'HTML' });
                }
            }
            return;
        }

        if (!stateData) {
            if (msg.text && !msg.text.startsWith('/')) {
                // If not in a state and message is not a command, show main menu as fallback
                const { getMainMenu } = require('./menus');
                return bot.sendMessage(chatId, "❓ <b>Command not recognized.</b>\nPlease use the menu below or send /start to refresh.", { ...getMainMenu(), parse_mode: 'HTML' });
            }
            return;
        }

        try {
            if (stateData.action === 'awaiting_manual_addr') {
                const addr = text;
                // Basic TON address validation (starts with E or U or 0:, etc.)
                if (!/^[a-zA-Z0-9_-]{48}$/.test(addr) && !/^-?[0-9]:[a-fA-F0-9]{64}$/.test(addr)) {
                    return bot.sendMessage(chatId, "❌ Invalid TON address format. Please try again.");
                }

                const buildDir = state.getSessionBuildDir();
                if (!fs.existsSync(buildDir)) {
                    return bot.sendMessage(chatId, "❌ No compiled artifacts found. Please compile a contract first to use its ABI.");
                }

                const files = fs.readdirSync(buildDir).filter(f => f.endsWith('.abi'));
                if (files.length === 0) {
                    return bot.sendMessage(chatId, "❌ No ABI files found. Please compile a contract first.");
                }

                setUserState(chatId, { action: 'awaiting_manual_abi', target: addr, mode: stateData.mode });
                
                return bot.sendMessage(chatId, "📜 <b>Select contract type (ABI) for this address:</b>", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: files.map(f => {
                            const name = f.replace('.abi', '');
                            const displayName = name.includes('_') ? name.split('_').pop() : name;
                            return [{ text: `📜 ${displayName}`, callback_data: `use_manual_abi:${getShort(name)}` }];
                        })
                    }
                });
            } else if (stateData.action === 'awaiting_deploy_args') {
                const { name, fields, currentField, args } = stateData;
                args[fields[currentField].name] = text;
                
                if (currentField + 1 < fields.length) {
                    const nextField = fields[currentField + 1];
                    setUserState(chatId, { ...stateData, currentField: currentField + 1, args });
                    return bot.sendMessage(chatId, `⌨️ <b>Enter value for ${tonUtils.escapeHTML(nextField.name)}:</b> (${tonUtils.escapeHTML(nextField.type.type)})`, { parse_mode: 'HTML' });
                } else {
                    const { handleDoDeploy } = require('./actions');
                    clearUserState(chatId);
                    await handleDoDeploy(bot, chatId, name, args);
                }
            } else if (stateData.action === 'awaiting_session_name') {
                const name = text.replace(/[^a-zA-Z0-9_-]/g, '');
                if (!name) return bot.sendMessage(chatId, "❌ Invalid session name. Use alphanumeric characters only.");
                
                clearUserState(chatId);
                if (state.createSession(name)) {
                    bot.sendMessage(chatId, `✅ <b>Session "${tonUtils.escapeHTML(name)}" created and selected!</b>`, { 
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: '📂 Go to Sessions', callback_data: 'sessions_menu' }]] }
                    });
                } else {
                    bot.sendMessage(chatId, `❌ Session "${tonUtils.escapeHTML(name)}" already exists.`);
                }
            } else if (stateData.action === 'awaiting_args') {
                const { cName, type, target, fields, currentField, args } = stateData;
                args[fields[currentField].name] = text;
                
                if (currentField + 1 < fields.length) {
                    const nextField = fields[currentField + 1];
                    setUserState(chatId, { ...stateData, currentField: currentField + 1, args });
                    return bot.sendMessage(chatId, `⌨️ <b>Enter value for ${tonUtils.escapeHTML(nextField.name)}:</b> (${tonUtils.escapeHTML(nextField.type.type)})`, { parse_mode: 'HTML' });
                } else {
                    clearUserState(chatId);
                    bot.sendMessage(chatId, `🚀 <b>Sending ${tonUtils.escapeHTML(type)} to ${tonUtils.escapeHTML(cName)}...</b>`, { parse_mode: 'HTML' });
                    await handleSendMessage(bot, chatId, target, type, cName, args);
                }
            } else if (stateData.action === 'awaiting_get_args') {
                const { cName, method, target, fields, currentField, args } = stateData;
                args.push(text);
                
                if (currentField + 1 < fields.length) {
                    const nextField = fields[currentField + 1];
                    setUserState(chatId, { ...stateData, currentField: currentField + 1, args });
                    return bot.sendMessage(chatId, `⌨️ <b>Enter value for ${tonUtils.escapeHTML(nextField.name)}:</b>`, { parse_mode: 'HTML' });
                } else {
                    clearUserState(chatId);
                    bot.sendMessage(chatId, `🔍 <b>Calling ${tonUtils.escapeHTML(cName)}.${tonUtils.escapeHTML(method)}()...</b>`, { parse_mode: 'HTML' });
                    await handleCallGetter(bot, chatId, target, method, cName, args);
                }
            } else if (stateData.action === 'awaiting_paste_code') {
                const code = text;
                clearUserState(chatId);

                // Auto-detect filename from contract/trait/message name (Tact) or #include/() (FunC/Tolk)
                let filename = 'contract.tact';
                const tactMatch = code.match(/(?:contract|trait|message|struct)\s+([a-zA-Z0-9_]+)/);
                const funcMatch = code.match(/(?:#include|void|int|cell|slice)\s+([a-zA-Z0-9_]+)\s*\(/) || code.includes('()');
                const tolkMatch = code.match(/(?:import|tolk|@)/);

                if (tactMatch && tactMatch[1]) {
                    filename = `${tactMatch[1]}.tact`;
                } else if (tolkMatch) {
                    filename = 'contract.tolk';
                } else if (funcMatch) {
                    filename = 'contract.fc';
                }

                const sessionPath = state.getSessionPath();
                fs.writeFileSync(path.join(sessionPath, filename), code);

                bot.sendMessage(chatId, `✅ <b>File "${tonUtils.escapeHTML(filename)}" saved successfully!</b>`, { 
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔨 Compile Now', callback_data: `do_compile:${getShort(filename)}` }],
                            [{ text: '📂 Back to Workspace', callback_data: 'workspace_menu' }]
                        ]
                    }
                });
            } else if (stateData.action === 'awaiting_github_link') {
                const url = text;
                clearUserState(chatId);
                const statusMsg = await bot.sendMessage(chatId, "🔗 <b>Temix: Cloning and extracting contracts...</b>", { parse_mode: 'HTML' });
                
                try {
                    const result = await githubImporter.importFromGitHub(url);
                    if (result.success) {
                        bot.editMessageText(`✅ <b>Import Successful!</b>\n\n<b>Session:</b> <code>${tonUtils.escapeHTML(result.sessionName)}</code>\n<b>Files Extracted:</b> ${result.fileCount}\n\nYour workspace has been switched to the new session.`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id,
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔨 Go to Compile', callback_data: 'compile_menu' }],
                                    [{ text: '📂 Workspace', callback_data: 'workspace_menu' }]
                                ]
                            }
                        });
                    } else {
                        bot.editMessageText(`❌ <b>Import Failed</b>\n\n${tonUtils.escapeHTML(result.error)}`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id,
                            parse_mode: 'HTML'
                        });
                    }
                } catch (e) {
                    bot.editMessageText(`❌ <b>System Error</b>\n\n${tonUtils.escapeHTML(e.message)}`, {
                        chat_id: chatId,
                        message_id: statusMsg.message_id,
                        parse_mode: 'HTML'
                    });
                }
            }
        } catch (e) {
            logger.error('Bot input error', '', e);
            bot.sendMessage(chatId, `❌ *Input Error:* ${e.message}`);
        }
    });

    bot.on('document', async (msg) => {
      const exts = ['.tact', '.fc', '.func', '.tolk'];
      const isCodeFile = exts.some(ext => msg.document.file_name.endsWith(ext));
      if (!isAuthorized(msg) || !isCodeFile) return;
      logger.info(`Bot file upload: ${msg.document.file_name}`);
      try {
        const fileUrl = await bot.getFileLink(msg.document.file_id);
        const response = await fetch(fileUrl);
        const buffer = await response.arrayBuffer();
        const sessionPath = state.getSessionPath();
        fs.writeFileSync(path.join(sessionPath, msg.document.file_name), Buffer.from(buffer));
        bot.sendMessage(msg.chat.id, `✅ *File saved!*`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔨 Compile Now', callback_data: `do_compile:${getShort(msg.document.file_name)}` }]] }
        });
      } catch (e) { bot.sendMessage(msg.chat.id, "❌ Upload failed: " + e.message); }
    });
}

module.exports = {
  setupHandlers
};
