const fs = require('fs');
const path = require('path');
const { beginCell, internal, Address, Cell, contractAddress } = require('@ton/ton');
const config = require('../config');
const logger = require('../services/logger');
const state = require('../services/state');
const ton = require('../services/ton');
const tonUtils = require('../services/ton-utils');
const compiler = require('../services/compiler');
const { setUserState, clearUserState, getUserState } = require('./utils');

function getAllSourceFiles(dir, base = '', exts = ['.tact', '.fc', '.func', '.tolk']) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const fullPath = path.join(dir, file);
        const relPath = path.join(base, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            if (file !== 'build' && file !== 'node_modules' && !file.startsWith('.')) {
                results = results.concat(getAllSourceFiles(fullPath, relPath, exts));
            }
        } else if (exts.some(ext => file.endsWith(ext))) {
            results.push(relPath);
        }
    });
    return results;
}

function getArtifactPaths(buildDir, name) {
    let baseName = name;
    let codePath = path.join(buildDir, `${baseName}.code.boc`);
    let abiPath = path.join(buildDir, `${baseName}.abi`);
    let pkgPath = path.join(buildDir, `${baseName}.pkg`);
    let dataPath = path.join(buildDir, `${baseName}.data.boc`);
    
    if (!fs.existsSync(codePath) || !fs.existsSync(abiPath)) {
        const files = fs.readdirSync(buildDir);
        const match = files.find(f => f.endsWith(`_${name}.code.boc`) || f === `${name}.code.boc`);
        if (match) {
            baseName = match.replace('.code.boc', '');
            codePath = path.join(buildDir, `${baseName}.code.boc`);
            abiPath = path.join(buildDir, `${baseName}.abi`);
            pkgPath = path.join(buildDir, `${baseName}.pkg`);
            dataPath = path.join(buildDir, `${baseName}.data.boc`);
        }
    }
    return { baseName, codePath, abiPath, pkgPath, dataPath };
}

async function handleAction(bot, query) {
  const chatId = query.message.chat.id;
  const data = query.data;
  const messageId = query.message.message_id;

  const sendOrEdit = async (text, options) => {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    } catch (e) {
      return await bot.sendMessage(chatId, text, options);
    }
  };

  // Helper for menu navigation
  if (data === 'menu') {
    return sendOrEdit(`🚀 <b>TemixIDE v2.0</b>\nMain Menu - Select a category:`, {
      reply_markup: { 
        inline_keyboard: [
          [{ text: '📂 Forge', callback_data: 'forge_menu' }, { text: '📂 Contract', callback_data: 'contract_menu' }],
          [{ text: '📂 Workspace', callback_data: 'workspace_menu' }, { text: '📂 Account', callback_data: 'account_menu' }],
          [{ text: '🏥 System Health', callback_data: 'health_check' }]
        ] 
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'forge_menu') {
    return sendOrEdit(`📂 <b>Forge</b>\nFocuses on the creation and "building" phase of your project.\n\n🔨 <b>Compile:</b> The primary engine for building your code.\n✨ <b>AI Forge:</b> Generate smart contracts using DeepSeek AI.\n📦 <b>Artifacts:</b> Where your compiled BOC (Bag of Cells) and ABI files live.\n📜 <b>Logs:</b> Essential for debugging compilation errors or build outputs.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔨 Compile', callback_data: 'compile_menu' }, { text: '✨ AI Forge', callback_data: 'ai_forge_menu' }],
          [{ text: '📦 Artifacts', callback_data: 'artifacts_menu' }],
          [{ text: '📜 Logs', callback_data: 'logs_menu' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'ai_forge_menu') {
    setUserState(chatId, { action: 'awaiting_ai_prompt' });
    return sendOrEdit(`✨ <b>AI Forge — Smart Contract Generation</b>\n\nDescribe the contract you want to create. Be as specific as possible about state variables, messages, and logic.\n\n<b>Example:</b>\n<i>"Create a lottery contract where users can buy tickets for 1 TON. After 10 users join, a random winner is selected and gets the entire balance."</i>`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'forge_menu' }]]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'contract_menu') {
    return sendOrEdit(`📂 <b>Contract</b>\nFocuses on the live lifecycle and communication with the blockchain.\n\n🚀 <b>Deploy:</b> Moving the code from your pocket to the network.\n🎮 <b>Interact:</b> Sending external messages or transactions to a live contract.\n🔍 <b>Getters:</b> Running "read-only" methods to check the contract state.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Deploy', callback_data: 'deploy_menu' }],
          [{ text: '🎮 Interact', callback_data: 'interact_menu' }],
          [{ text: '🔍 Getters', callback_data: 'getters_menu' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'workspace_menu') {
    return sendOrEdit(`📂 <b>Workspace</b>\nFocuses on your local environment and project history.\n\n📁 <b>Files:</b> Your central hub for managing TON source files.\n📂 <b>Sessions:</b> Manage multiple project workspaces.\n📝 <b>Paste Code:</b> Quick-add contract code by pasting it here.\n🔗 <b>GitHub Import:</b> Extract TON contracts from any GitHub repo.\n📋 <b>History:</b> Tracking your previous deployments and interactions.\n⚙️ <b>Help:</b> Documentation and guides to help you navigate the IDE.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📁 Files', callback_data: 'files_list' }, { text: '📂 Sessions', callback_data: 'sessions_menu' }],
          [{ text: '📝 Paste Code', callback_data: 'paste_code' }, { text: '🔗 GitHub Import', callback_data: 'github_import' }],
          [{ text: '📋 History', callback_data: 'history' }],
          [{ text: '⚙️ Help', callback_data: 'help' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'github_import') {
    setUserState(chatId, { action: 'awaiting_github_link' });
    return sendOrEdit(`🔗 <b>GitHub Import</b>\n\nPlease send me a link to a GitHub repository.\n\nTemix will automatically:\n1. Clone the repository.\n2. Extract all <code>.tact</code>, <code>.fc</code>, and <code>.func</code> files.\n3. Create a fresh session for you.\n\n<b>Example:</b> <code>https://github.com/evaafi/contracts</code>`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'workspace_menu' }]]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'paste_code') {
    setUserState(chatId, { action: 'awaiting_paste_code' });
    return sendOrEdit(`📝 <b>Paste Code</b>\n\nPlease paste your Tact smart contract code below as a single message. The filename will be automatically determined.`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'workspace_menu' }]]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'account_menu') {
    return sendOrEdit(`📂 <b>Account</b>\nFocuses on the developer's credentials and resources.\n\n💳 <b>Wallet:</b> Managing your balance, address, and faucet access.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Wallet', callback_data: 'wallet' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'sessions_menu') {
    const sessions = Object.keys(state.state.sessions || {});
    return sendOrEdit(`📂 <b>Sessions</b>\nManage your project sessions. Current: <code>${state.state.currentSession}</code>\n\n<i>Note: Deleting a session permanently removes all its files and history.</i>`, {
      reply_markup: {
        inline_keyboard: [
          ...sessions.map(s => [
            { text: `${s === state.state.currentSession ? '✅ ' : ''}${s}`, callback_data: `switch_session:${state.getShort(s)}` },
            ...(s !== 'default' ? [{ text: '🗑', callback_data: `confirm_del_session:${state.getShort(s)}` }] : [])
          ]),
          [{ text: '➕ New Session', callback_data: 'create_session' }],
          [{ text: '⬅️ Back', callback_data: 'workspace_menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data.startsWith('switch_session:')) {
    const name = state.getLong(data.split(':')[1]);
    if (state.switchSession(name)) {
      bot.answerCallbackQuery(query.id, { text: `Switched to session: ${name}` });
      return handleAction(bot, { ...query, data: 'sessions_menu' });
    }
  }

  if (data === 'create_session') {
    setUserState(chatId, { action: 'awaiting_session_name' });
    return sendOrEdit(`➕ <b>Create New Session</b>\n\nPlease enter a name for your new session (alphanumeric only):`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'sessions_menu' }]]
      },
      parse_mode: 'HTML'
    });
  }

  if (data.startsWith('confirm_del_session:')) {
    const name = state.getLong(data.split(':')[1]);
    return sendOrEdit(`⚠️ <b>Delete Session: ${name}?</b>\n\nThis will permanently delete all files and history in this session. This action cannot be undone!`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔥 YES, DELETE', callback_data: `delete_session:${state.getShort(name)}` }],
          [{ text: '⬅️ No, Cancel', callback_data: 'sessions_menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data.startsWith('delete_session:')) {
    const name = state.getLong(data.split(':')[1]);
    if (state.deleteSession(name)) {
      bot.answerCallbackQuery(query.id, { text: `Deleted session: ${name}` });
      return handleAction(bot, { ...query, data: 'sessions_menu' });
    }
  }

  if (data === 'wallet') {
    const balance = await tonUtils.withRetry(async () => {
        const endpoint = await tonUtils.getEndpoint();
        const client = tonUtils.createTonClient(endpoint);
        return await client.getBalance(ton.getDevWallet().address);
    });
    const addr = ton.getDevWallet().address.toString({ testOnly: config.IS_TESTNET });
    return sendOrEdit(`💳 *Wallet Status*\n\n*Address:* \`${addr}\`\n*Balance:* \`${(Number(balance) / 1e9).toFixed(4)} TON\`\n*Network:* ${config.NETWORK.toUpperCase()}\n\n*Note:* Balance may take a few seconds to update after transactions.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗝 View Seed Phrase', callback_data: 'view_seed' }],
          [{ text: '🗑 Reset Wallet', callback_data: 'confirm_reset' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'Markdown'
    });
  }

  if (data === 'compile_menu') {
    const sessionPath = state.getSessionPath();
    const files = getAllSourceFiles(sessionPath);
    if (files.length === 0) return bot.sendMessage(chatId, "❌ No source files (.tact, .fc, .tolk, etc.) found in this session.");
    
    return sendOrEdit(`🔨 <b>Select file to compile:</b>\nSession: <code>${state.state.currentSession}</code>`, {
      reply_markup: {
        inline_keyboard: [
          ...files.map(f => [{ text: `📄 ${f}`, callback_data: `do_compile:${state.getShort(f)}` }]),
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'deploy_menu') {
    const buildDir = state.getSessionBuildDir();
    if (!fs.existsSync(buildDir)) return bot.sendMessage(chatId, "❌ No builds found. Compile first.");
    const files = fs.readdirSync(buildDir).filter(f => f.endsWith('.code.boc'));
    if (files.length === 0) return bot.sendMessage(chatId, "❌ No compiled artifacts found.");

    return sendOrEdit("🚀 <b>Select contract to deploy:</b>", {
      reply_markup: {
        inline_keyboard: [
          ...files.map(f => {
            const name = f.replace('.code.boc', '');
            return [{ text: `🚀 Deploy ${name}`, callback_data: `prep_manual_deploy:${state.getShort(name)}` }];
          }),
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'interact_menu') {
    const contracts = Object.keys(state.getSession().deployed);

    return sendOrEdit("🎮 <b>Select contract to interact with:</b>", {
      reply_markup: {
        inline_keyboard: [
          ...contracts.map(c => [{ text: `🕹 ${c}`, callback_data: `int_methods:${state.getShort(c)}` }]),
          [{ text: '🎯 Manual Address', callback_data: 'prep_manual_addr:int' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'getters_menu') {
    const contracts = Object.keys(state.getSession().deployed);

    return sendOrEdit("🔍 <b>Select contract to query:</b>", {
      reply_markup: {
        inline_keyboard: [
          ...contracts.map(c => [{ text: `📜 ${c}`, callback_data: `get_methods:${state.getShort(c)}` }]),
          [{ text: '🎯 Manual Address', callback_data: 'prep_manual_addr:get' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data.startsWith('prep_manual_addr:')) {
    const type = data.split(':')[1];
    const { setUserState } = require('./utils');
    setUserState(chatId, { action: 'awaiting_manual_addr', mode: type });
    return bot.sendMessage(chatId, "🎯 <b>Enter the contract address you want to interact with:</b>", { parse_mode: 'HTML' });
  }

  if (data.startsWith('use_manual_abi:')) {
    const abiName = state.getLong(data.split(':')[1]);
    const { getUserState, clearUserState } = require('./utils');
    const stateData = getUserState(chatId);
    if (!stateData || !stateData.target) return bot.sendMessage(chatId, "❌ Session expired. Please try again.");
    
    const { target, mode } = stateData;
    state.getSession().deployed[abiName] = target;
    state.saveState();
    clearUserState(chatId);
    
    const nextAction = mode === 'get' ? 'get_methods' : 'int_methods';
    return handleAction(bot, { message: query.message, data: `${nextAction}:${state.getShort(abiName)}`, from: query.from });
  }

  if (data === 'files_list') {
    const files = getAllSourceFiles(state.getSessionPath());
    // Limit to 50 files for UI stability
    const displayedFiles = files.slice(0, 50);
    return sendOrEdit(`📁 *Project Files:* (Total: ${files.length}${files.length > 50 ? ', showing first 50' : ''})`, {
      reply_markup: { 
        inline_keyboard: [
          ...displayedFiles.map(f => [{ text: `📄 ${f}`, callback_data: `view_file:${state.getShort(f)}` }]),
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ] 
      },
      parse_mode: 'Markdown'
    });
  }

  if (data.startsWith('view_file:')) {
    const fileName = state.getLong(data.split(':')[1]);
    const sessionPath = state.getSessionPath();
    const filePath = path.join(sessionPath, fileName);
    
    if (!fs.existsSync(filePath)) return bot.sendMessage(chatId, `❌ File ${tonUtils.escapeHTML(fileName)} not found.`);
    
    const content = fs.readFileSync(filePath, 'utf8');
    const escapedContent = tonUtils.escapeHTML(content.slice(0, 3000));
    const msgText = `📄 <b>File:</b> <code>${tonUtils.escapeHTML(fileName)}</code>\n\n<pre>${escapedContent}</pre>${content.length > 3000 ? '\n\n<i>(Truncated...)</i>' : ''}`;
    
    return sendOrEdit(msgText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔨 Compile This', callback_data: `do_compile:${state.getShort(fileName)}` }],
          [{ text: '⬅️ Back to Files', callback_data: 'files_list' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data.startsWith('do_compile:')) {
    const fileName = state.getLong(data.split(':')[1]);
    bot.sendMessage(chatId, `🔨 <b>Compiling ${tonUtils.escapeHTML(fileName)}...</b>`, { parse_mode: 'HTML' });
    compiler.queueCompileTask(async () => {
        const sessionPath = state.getSessionPath();
        const buildDir = state.getSessionBuildDir();
        const t0 = Date.now();
        
        state.getSession().lastFile = fileName; state.saveState();

        const result = await compiler.compile(fileName, sessionPath);
        const dur = Date.now() - t0;

        if (result.success) {
            logger.info(`Bot compile (${result.language}) OK: ${fileName} (${dur}ms)`);
            const reply_markup = { inline_keyboard: [] };
            
            if (result.baseName) {
                reply_markup.inline_keyboard.push([{ text: `🚀 Deploy ${result.baseName} Now`, callback_data: `prep_manual_deploy:${state.getShort(result.baseName)}` }]);
            } else if (result.artifacts && result.artifacts.length > 0) {
                const firstContract = result.artifacts.find(a => a.endsWith('.code.boc'));
                if (firstContract) {
                    const cName = firstContract.replace('.code.boc', '');
                    reply_markup.inline_keyboard.push([{ text: `🚀 Deploy ${cName} Now`, callback_data: `prep_manual_deploy:${state.getShort(cName)}` }]);
                }
            }
            
            reply_markup.inline_keyboard.push([{ text: '⬅️ Back to Menu', callback_data: 'menu' }]);

            let artifactsText = '';
            if (result.artifacts) {
                artifactsText = `\n\n<b>Artifacts:</b> ${result.artifacts.map(a => `<code>${tonUtils.escapeHTML(a.replace('.code.boc',''))}</code>`).join(', ')}`;
            } else if (result.baseName) {
                artifactsText = `\n\n<b>Artifacts:</b> <code>${tonUtils.escapeHTML(result.baseName)}</code>`;
            }

            bot.sendMessage(chatId, `✅ <b>Compiled ${result.language} ${tonUtils.escapeHTML(fileName)} in ${dur}ms</b>${artifactsText}`, { 
                parse_mode: 'HTML',
                reply_markup
            });
        } else {
            throw new Error(result.error || 'Compilation failed');
        }
    }).catch((e) => {
        const err = e.stdout ? e.stdout.toString('utf8') : e.message;
        const ext = path.extname(fileName).toLowerCase();
        let parsedErr = err;
        
        if (ext === '.fc' || ext === '.func') parsedErr = compiler.parseFuncError(err);
        else if (ext === '.tolk') parsedErr = compiler.parseTolkError(err);
        else if (ext === '.tact') parsedErr = compiler.parseTactError(err);

        logger.error(`Bot compile FAIL: ${fileName}`, '', e);
        bot.sendMessage(chatId, parsedErr, { parse_mode: 'HTML' });
    });
  }

  if (data.startsWith('int_methods:')) {
      const name = state.getLong(data.split(':')[1]);
      const buildDir = state.getSessionBuildDir();
      let abiPath = path.join(buildDir, `${name}.abi`);
      
      if (!fs.existsSync(abiPath)) {
          const files = fs.readdirSync(buildDir);
          const match = files.find(f => f.endsWith(`_${name}.abi`) || f === `${name}.abi`);
          if (match) abiPath = path.join(buildDir, match);
      }
      
      if (!fs.existsSync(abiPath)) return bot.sendMessage(chatId, `❌ ABI not found for ${tonUtils.escapeHTML(name)}. Try compiling first.`);
      
      const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
      const buttons = [];
      (abi.receivers || []).forEach(r => {
          if (r.receiver === 'internal') {
              const m = r.message;
              const type = m.kind === 'typed' ? m.type : (m.kind === 'text' ? 'text' : m.kind);
              const label = m.kind === 'text' ? `✉️ "${m.text}"` : `✉️ ${m.type || m.kind}`;
              buttons.push([{ text: label, callback_data: `prep_int:${state.getShort(name)}:${state.getShort(type)}:${state.getShort(m.text || '')}` }]);
          }
      });
      
      return sendOrEdit(`🎮 <b>Interact with ${tonUtils.escapeHTML(name)}</b>\nSelect a message type to send:`, {
          reply_markup: { inline_keyboard: [...buttons, [{ text: '⬅️ Back', callback_data: 'interact_menu' }]] },
          parse_mode: 'HTML'
      });
  }

  if (data.startsWith('get_methods:')) {
      const name = state.getLong(data.split(':')[1]);
      const buildDir = state.getSessionBuildDir();
      let abiPath = path.join(buildDir, `${name}.abi`);
      
      if (!fs.existsSync(abiPath)) {
          const files = fs.readdirSync(buildDir);
          const match = files.find(f => f.endsWith(`_${name}.abi`) || f === `${name}.abi`);
          if (match) abiPath = path.join(buildDir, match);
      }
      
      if (!fs.existsSync(abiPath)) return bot.sendMessage(chatId, `❌ ABI not found for ${tonUtils.escapeHTML(name)}.`);
      
      const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
      const buttons = [];
      (abi.getters || []).forEach(g => {
          buttons.push([{ text: `🔍 ${g.name}()`, callback_data: `call_get:${state.getShort(name)}:${state.getShort(g.name)}` }]);
      });
      
      return sendOrEdit(`🔍 <b>Getters for ${tonUtils.escapeHTML(name)}</b>\nSelect a method to call:`, {
          reply_markup: { inline_keyboard: [...buttons, [{ text: '⬅️ Back', callback_data: 'getters_menu' }]] },
          parse_mode: 'HTML'
      });
  }

  if (data.startsWith('prep_int:')) {
      const [_, cShort, typeShort, textShort] = data.split(':');
      const cName = state.getLong(cShort);
      const type = state.getLong(typeShort);
      const text = state.getLong(textShort);
      const target = state.getSession().deployed[cName];
      const buildDir = state.getSessionBuildDir();
      let abiPath = path.join(buildDir, `${cName}.abi`);
      
      if (!fs.existsSync(abiPath)) {
          const files = fs.readdirSync(buildDir);
          const match = files.find(f => f.endsWith(`_${cName}.abi`) || f === `${cName}.abi`);
          if (match) abiPath = path.join(buildDir, match);
      }
      
      if (type === 'text') {
          return bot.sendMessage(chatId, `✉️ <b>Send Text Message?</b>\n\nContract: <code>${cName}</code>\nTarget: <code>${target}</code>\nMessage: <code>"${text}"</code>`, {
              parse_mode: 'HTML',
              reply_markup: {
                  inline_keyboard: [[{ text: '🚀 Send Now', callback_data: `do_int:${cShort}:${typeShort}:${textShort}` }], [{ text: '⬅️ Cancel', callback_data: 'menu' }]]
              }
          });
      } else {
          // Typed message - needs arguments
          if (!fs.existsSync(abiPath)) return bot.sendMessage(chatId, `❌ ABI not found for ${cName}.`);
          const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
          const typeDef = abi.types.find(t => t.name === type);
          if (!typeDef || !typeDef.fields || typeDef.fields.length === 0) {
              return bot.sendMessage(chatId, `✉️ <b>Send Message ${type}?</b>\n\nTarget: <code>${target}</code>`, {
                  parse_mode: 'HTML',
                  reply_markup: {
                      inline_keyboard: [[{ text: '🚀 Send Now', callback_data: `do_int:${cShort}:${typeShort}:${textShort}` }], [{ text: '⬅️ Cancel', callback_data: 'menu' }]]
                  }
              });
          }
          
          setUserState(chatId, { action: 'awaiting_args', cName, type, target, fields: typeDef.fields, currentField: 0, args: {} });
          return bot.sendMessage(chatId, `⌨️ <b>Enter arguments for ${tonUtils.escapeHTML(type)}:</b>\n\nField: <code>${tonUtils.escapeHTML(typeDef.fields[0].name)}</code> (${tonUtils.escapeHTML(typeDef.fields[0].type.type)})`, { parse_mode: 'HTML' });
      }
      
      const { handleSendMessage } = require('./ton-actions');
      bot.sendMessage(chatId, `🚀 <b>Sending ${tonUtils.escapeHTML(type)} to ${tonUtils.escapeHTML(cName)}...</b>`, { parse_mode: 'HTML' });
      await handleSendMessage(bot, chatId, target, type, cName, {});
  }

  if (data.startsWith('call_get:')) {
      const [_, cShort, gShort] = data.split(':');
      const cName = state.getLong(cShort);
      const method = state.getLong(gShort);
      const target = state.getSession().deployed[cName];
      const buildDir = state.getSessionBuildDir();
      let abiPath = path.join(buildDir, `${cName}.abi`);
      
      if (!fs.existsSync(abiPath)) {
          const files = fs.readdirSync(buildDir);
          const match = files.find(f => f.endsWith(`_${cName}.abi`) || f === `${cName}.abi`);
          if (match) abiPath = path.join(buildDir, match);
      }
      
      if (!fs.existsSync(abiPath)) return bot.sendMessage(chatId, `❌ ABI not found for ${tonUtils.escapeHTML(cName)}.`);
      const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
      const getter = abi.getters.find(g => g.name === method);

      if (getter.arguments && getter.arguments.length > 0) {
          setUserState(chatId, { action: 'awaiting_get_args', cName, method, target, fields: getter.arguments, currentField: 0, args: [] });
          return bot.sendMessage(chatId, `⌨️ <b>Enter arguments for ${tonUtils.escapeHTML(method)}():</b>\n\nField: <code>${tonUtils.escapeHTML(getter.arguments[0].name)}</code>`, { parse_mode: 'HTML' });
      }
      
      const { handleCallGetter } = require('./ton-actions');
      await handleCallGetter(bot, chatId, target, method, cName, []);
  }

  if (data.startsWith('do_int:')) {
      const [_, cShort, typeShort, textShort] = data.split(':');
      const cName = state.getLong(cShort);
      const type = state.getLong(typeShort);
      const text = state.getLong(textShort);
      const target = state.getSession().deployed[cName];
      
      const { handleSendMessage } = require('./ton-actions');
      await handleSendMessage(bot, chatId, target, type, cName, { text });
  }

  if (data.startsWith('prep_manual_deploy:')) {
    const name = state.getLong(data.split(':')[1]);
    const buildDir = state.getSessionBuildDir();
    const { abiPath, pkgPath, dataPath } = getArtifactPaths(buildDir, name);
    
    // Check if we need arguments from ABI or PKG
    let initDef = null;
    let abi = null;

    if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        abi = typeof pkg.abi === 'string' ? JSON.parse(pkg.abi) : pkg.abi;
        initDef = pkg.init;
    } else if (fs.existsSync(abiPath)) {
        abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
        initDef = abi.init;
    }

    if (initDef && !fs.existsSync(dataPath)) {
        const fields = initDef.args || initDef.arguments;
        if (fields && fields.length > 0) {
            const { setUserState } = require('./utils');
            setUserState(chatId, {
                action: 'awaiting_deploy_args',
                name,
                fields: fields,
                currentField: 0,
                args: {},
                abi
            });
            return bot.sendMessage(chatId, `🚀 <b>Deploying ${tonUtils.escapeHTML(name)}</b>\n\nThis contract requires initialization arguments.\n\n⌨️ <b>Enter value for ${tonUtils.escapeHTML(fields[0].name)}:</b> (${tonUtils.escapeHTML(fields[0].type.type)})`, { parse_mode: 'HTML' });
        }
    }

    return bot.sendMessage(chatId, `🚀 <b>Ready to deploy ${tonUtils.escapeHTML(name)}?</b>\n\nThis will use 0.05 TON to deploy the contract on ${config.NETWORK.toUpperCase()}.`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm & Deploy', callback_data: `do_deploy:${state.getShort(name)}` }],
          [{ text: '⬅️ Back', callback_data: 'deploy_menu' }]
        ]
      }
    });
  }

  if (data.startsWith('do_deploy:')) {
    const name = state.getLong(data.split(':')[1]);
    await handleDoDeploy(bot, chatId, name);
  }
}

async function handleDoDeploy(bot, chatId, name, args = {}) {
    logger.info(`Bot requested deploy: ${name}`);
    bot.sendMessage(chatId, `🚀 <b>Deploying ${tonUtils.escapeHTML(name)}...</b>`, { parse_mode: 'HTML' });
    try {
        const buildDir = state.getSessionBuildDir();
        const { baseName, codePath, abiPath, pkgPath, dataPath } = getArtifactPaths(buildDir, name);

        if (!fs.existsSync(codePath)) throw new Error(`Artifacts for "${baseName}" not found. Compile first.`);
        
        const codeCell = Cell.fromBoc(fs.readFileSync(codePath))[0];
        
        let dataCell;
        let initDef = null;
        let abi = null;

        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            abi = typeof pkg.abi === 'string' ? JSON.parse(pkg.abi) : pkg.abi;
            initDef = pkg.init;
        } else if (fs.existsSync(abiPath)) {
            abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
            initDef = abi.init;
        }

        if (initDef) {
            const fields = initDef.args || initDef.arguments;
            if (fields && fields.length > 0) {
                // If we have arguments in ABI but args object is empty/incomplete, check if we can skip
                const missing = fields.filter(f => args[f.name] === undefined);
                if (missing.length > 0 && !fs.existsSync(dataPath)) {
                    throw new Error(`Missing required initialization arguments: ${missing.map(m => m.name).join(', ')}. Quick deploy only supports contracts with zero-argument init() or those with a pre-compiled data.boc.`);
                }
                
                if (Object.keys(args).length > 0) {
                    const builder = beginCell();
                    if (initDef.prefix) {
                        builder.storeUint(initDef.prefix.value, initDef.prefix.bits);
                    }
                    fields.forEach(f => tonUtils.packField(builder, f, args[f.name], abi));
                    dataCell = builder.endCell();
                }
            } else if (initDef.prefix && !fs.existsSync(dataPath)) {
                // Handle zero-arg init with prefix
                dataCell = beginCell().storeUint(initDef.prefix.value, initDef.prefix.bits).endCell();
            }
        }
        
        if (!dataCell) {
            dataCell = fs.existsSync(dataPath) ? Cell.fromBoc(fs.readFileSync(dataPath))[0] : beginCell().storeBit(0).endCell();
        }

        const stateInit = { code: codeCell, data: dataCell };
        const address = contractAddress(0, stateInit);
        
        const seqno = await tonUtils.withRetry(async () => {
          const endpoint = await tonUtils.getEndpoint();
          const activeClient = tonUtils.createTonClient(endpoint);
          const balance = await activeClient.getBalance(ton.getDevWallet().address);
          if (balance < 50000000n) throw new Error(`Insufficient funds.`);

          const contract = activeClient.open(ton.getDevWallet());
          let s = 0; try { s = await contract.getSeqno(); } catch (e) { s = 0; }
          await contract.sendTransfer({
            seqno: s, secretKey: ton.getWalletKey().secretKey,
            messages: [internal({ to: address, value: '0.05', bounce: false, init: stateInit, body: beginCell().storeUint(0, 32).storeStringTail('Deploy').endCell() })]
          });
          return s;
        });

        const addrStr = address.toString({ testOnly: config.IS_TESTNET });
        state.getSession().deployed[name] = addrStr; state.saveState();
        bot.sendMessage(chatId, `🎉 <b>Contract Deployed!</b>\n\n<b>Address:</b> <code>${tonUtils.escapeHTML(addrStr)}</code>`, { parse_mode: 'HTML' });
    } catch (e) {
        bot.sendMessage(chatId, `❌ <b>Deployment Failed</b>\n\n${tonUtils.escapeHTML(e.message)}`, { parse_mode: 'HTML' });
    }
}

module.exports = {
  handleAction,
  handleDoDeploy
};
