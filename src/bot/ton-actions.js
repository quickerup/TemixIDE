const fs = require('fs');
const path = require('path');
const { beginCell, internal, Address } = require('@ton/ton');
const config = require('../config');
const logger = require('../services/logger');
const state = require('../services/state');
const ton = require('../services/ton');
const tonUtils = require('../services/ton-utils');
const { escapeMarkdownV2 } = require('./utils');

async function handleSendMessage(bot, chatId, target, type, contractName, args) {
    logger.info(`Bot interaction (handleSendMessage): ${type} for ${contractName} to ${target}`);
    
    let body;
    if (type === 'text') {
        const text = args.text || '';
        bot.sendMessage(chatId, `🚀 Sending text message "${text}" to \`${contractName}\`...`, { parse_mode: 'Markdown' });
        body = beginCell().storeUint(0, 32).storeStringTail(text).endCell();
    } else {
        const buildDir = state.getSessionBuildDir();
        const abiPath = path.join(buildDir, `${contractName}.abi`);
        if (!fs.existsSync(abiPath)) throw new Error(`ABI not found for ${contractName}`);
        
        const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
        const typeDef = abi.types.find(t => t.name === type);
        if (!typeDef) throw new Error(`Message type "${type}" not found in ABI`);

        bot.sendMessage(chatId, `🚀 Sending \`${type}\` to \`${contractName}\`...`, { parse_mode: 'Markdown' });
        
        const builder = beginCell();
        if (typeDef.header !== null) builder.storeUint(typeDef.header, 32);
        typeDef.fields.forEach((f, idx) => {
            const val = args[f.name] !== undefined ? args[f.name] : args[idx];
            tonUtils.packField(builder, f, val, abi);
        });
        body = builder.endCell();
    }

    const seqno = await tonUtils.withRetry(async () => {
        const endpoint = await tonUtils.getEndpoint();
        const client = tonUtils.createTonClient(endpoint);
        const balance = await client.getBalance(ton.getDevWallet().address);
        if (balance < 50000000n) throw new Error(`Insufficient funds.`);

        const contract = client.open(ton.getDevWallet());
        let s = 0; try { s = await contract.getSeqno(); } catch (e) { s = 0; }
        await contract.sendTransfer({
            seqno: s, secretKey: ton.getWalletKey().secretKey,
            messages: [internal({ to: Address.parseFriendly(target).address, value: '0.2', bounce: true, body })]
        });
        return s;
    });
    
    const explorerUrl = `https://${config.IS_TESTNET?'testnet.':''}tonscan.org/search?q=${seqno}`;
    bot.sendMessage(chatId, `✅ <b>Transaction Sent!</b>\nSeqno: <code>${seqno}</code>\n<a href="${explorerUrl}">View on Explorer</a>`, { parse_mode: 'HTML', disable_web_page_preview: true });
}

async function handleCallGetter(bot, chatId, target, method, contractName, args) {
    logger.info(`Bot call (handleCallGetter): ${contractName}.${method}() on ${target}`);
    const buildDir = state.getSessionBuildDir();
    const abiPath = path.join(buildDir, `${contractName}.abi`);
    if (!fs.existsSync(abiPath)) throw new Error(`ABI not found for ${contractName}`);
    
    const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    const getterDef = abi.getters.find(g => g.name === method);
    if (!getterDef) throw new Error(`Getter "${method}" not found in ABI`);

    bot.sendMessage(chatId, `🔍 Calling \`${contractName}.${method}()\`...`, { parse_mode: 'Markdown' });
    
    const stack = args.map(arg => {
        if (typeof arg === 'number' || !isNaN(arg)) return { type: 'int', value: BigInt(arg) };
        if (typeof arg === 'string') {
            const normalized = arg.trim().replace(/\+/g, '-').replace(/\//g, '_');
            try { 
                const parsed = Address.parseFriendly(normalized);
                return { type: 'slice', cell: beginCell().storeAddress(parsed.address).endCell() }; 
            }
            catch (e) { return { type: 'slice', cell: beginCell().storeStringTail(arg).endCell() }; }
        }
        return arg;
    });

    try {
        const result = await tonUtils.withRetry(async () => {
            const endpoint = await tonUtils.getEndpoint();
            const client = tonUtils.createTonClient(endpoint);
            return await client.runMethod(Address.parseFriendly(target).address, method, stack);
        });

        if (result.exit_code !== 0 && result.exit_code !== undefined) {
            let msg = `❌ *Call Failed:* Exit code \`${result.exit_code}\``;
            return bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        }

        const returnType = getterDef ? (getterDef.returnType ? getterDef.returnType.type : null) : null;
        
        // Smart stack filtering:
        // Some RPCs return a "dirty" stack with many leading Cells representing internal VM state.
        // If we have many items and they are mostly Cells followed by something else, we take only the relevant part.
        // Standard Tact/modern getters usually return exactly 1 item (which can be a Tuple).
        let itemsToDecode = result.stack.items;
        if (itemsToDecode.length > 1) {
            const lastItem = itemsToDecode[itemsToDecode.length - 1];
            const allOthersAreCells = itemsToDecode.slice(0, -1).every(i => i.type === 'cell');
            
            if (allOthersAreCells) {
                // Highly likely a dirty stack, take only the last item
                itemsToDecode = [lastItem];
            } else {
                // If it doesn't look like a simple dirty stack, we might have a multi-value return.
                // We keep the whole stack but maybe we should still be careful.
                // For now, let's trust the stack if it's not obviously junk.
            }
        }
        
        const resultStack = itemsToDecode.map(i => tonUtils.decodeStackItem(i, returnType, abi));

        const finalOutput = resultStack.length === 1 ? resultStack[0] : resultStack;
        bot.sendMessage(chatId, `📊 *Result:* \`${contractName}.${method}()\`\n\n\`\`\`json\n${JSON.stringify(finalOutput, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(chatId, `❌ *Call Failed:* ${e.message}`);
    }
}

module.exports = {
    handleSendMessage,
    handleCallGetter
};
