import { PrivyClient } from '@privy-io/node';
import dotenv from 'dotenv';
dotenv.config();

// Mock env if needed for instantiation, or use real if user provided (they haven't yet for Privy)
const privy = new PrivyClient({ appId: 'test', appSecret: 'test' });

console.log("Methods on privy:", Object.getOwnPropertyNames(Object.getPrototypeOf(privy)));
console.log("Methods on privy.walletApi:", privy.walletApi ? Object.getOwnPropertyNames(Object.getPrototypeOf(privy.walletApi)) : "N/A");
// Check for newer API structure
console.log("Methods on privy.wallets:", privy.wallets ? "Has .wallets()" : "No .wallets()");
if (privy.wallets) {
    try {
        const wHandler = privy.wallets();
        console.log("Methods on privy.wallets() handler:", Object.getOwnPropertyNames(Object.getPrototypeOf(wHandler)));
    } catch (e) {
        console.log("Error invoking wallets():", e.message);
    }
}
