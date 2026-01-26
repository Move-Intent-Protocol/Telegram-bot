import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

export interface TokenConfig {
    symbol: string;
    type: string;
    decimals: number;
    price?: number;
}

const tokensPath = path.join(__dirname, 'tokens.json');
const rawTokens = fs.readFileSync(tokensPath, 'utf-8');
export const TOKENS: TokenConfig[] = JSON.parse(rawTokens);

export const CONFIG = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    RELAYER_API_URL: process.env.RELAYER_API_URL || 'http://localhost:3001',
    POLL_INTERVAL_MS: 5000,
    PRIVY_APP_ID: process.env.PRIVY_APP_ID || '',
    PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET || '',
    PRIVY_AUTHORIZATION_PRIVATE_KEY: process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY || ''
};
