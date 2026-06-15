require('dotenv').config();
const path = require('path');

module.exports = {
  PORT: parseInt(process.env.TACT_PORT || '3000', 10),
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID ? String(process.env.TELEGRAM_CHANNEL_ID).trim() : '',
  FEE_COLLECTOR_ADDRESS: process.env.FEE_COLLECTOR_ADDRESS || 'UQD_K5_CunSUpL4p_N_v5U-Xn9Z_Mv_2_j_B_D_C_F_E_F_G', // Placeholder
  DEPLOY_FEE_MAINNET: 0.5,
  TONCENTER_API_KEY: process.env.TONCENTER_API_KEY || "1dce291cfe6b56e6d28f52cec84c72b942da3723cc9a4bfe6b224b1c8f7efb62",
  ENV: process.env.TACT_ENV || 'development',
  DEBUG: process.env.DEBUG === 'true' || (process.env.TACT_ENV || 'development') === 'development',
  NETWORK: process.env.TACT_NETWORK || 'testnet',
  IS_TESTNET: (process.env.TACT_NETWORK || 'testnet') === 'testnet',
  WALLET_MNEMONIC: process.env.WALLET_MNEMONIC,
  AUTHORIZED_USERS: process.env.TELEGRAM_AUTHORIZED_ID ? process.env.TELEGRAM_AUTHORIZED_ID.split(',').map(id => id.trim()) : [],
  PATHS: {
    LOG_DIR: path.resolve(process.cwd(), 'logs'),
    WALLET_FILE: path.join(process.cwd(), 'dev-wallet.json'),
    SESSIONS_DIR: path.resolve(process.cwd(), 'sessions'),
    STATE_FILE: path.join(process.cwd(), 'state.json'),
    PUBLIC_DIR: path.join(process.cwd(), 'public')
  }
};
