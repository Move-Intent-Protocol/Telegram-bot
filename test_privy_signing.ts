/**
 * Privy Signing Test Script
 * Run with: npx ts-node test_privy_signing.ts
 */

import { PrivyClient } from '@privy-io/node';
import dotenv from 'dotenv';

dotenv.config();

async function testPrivySigning() {
    console.log("=== Privy Signing Test ===\n");

    // 1. Check environment variables
    console.log("1. Checking Environment Variables:");
    console.log(`   PRIVY_APP_ID: ${process.env.PRIVY_APP_ID ? '✓ Set' : '✗ Missing'}`);
    console.log(`   PRIVY_APP_SECRET: ${process.env.PRIVY_APP_SECRET ? '✓ Set (' + process.env.PRIVY_APP_SECRET.slice(0, 20) + '...)' : '✗ Missing'}`);
    console.log(`   PRIVY_AUTHORIZATION_PRIVATE_KEY: ${process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY ? '✓ Set' : '✗ Missing'}`);

    const authKeyRaw = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY || '';
    const hasWalletAuthPrefix = authKeyRaw.startsWith('wallet-auth:');
    console.log(`   Key has 'wallet-auth:' prefix: ${hasWalletAuthPrefix ? '✓ Yes' : '✗ No'}`);

    if (!process.env.PRIVY_APP_ID || !process.env.PRIVY_APP_SECRET) {
        console.error("\n❌ Missing required environment variables!");
        return;
    }

    // 2. Initialize Privy Client
    console.log("\n2. Initializing Privy Client...");
    const privy = new PrivyClient({
        appId: process.env.PRIVY_APP_ID,
        appSecret: process.env.PRIVY_APP_SECRET
    });
    console.log("   ✓ Client initialized");

    // 3. Create a test wallet
    console.log("\n3. Creating Test Wallet...");
    try {
        const wallet = await privy.wallets().create({
            chain_type: 'movement'
        });
        console.log(`   ✓ Wallet created: ${wallet.address}`);
        console.log(`   Wallet ID: ${wallet.id}`);
        console.log(`   Chain Type: ${wallet.chain_type}`);
        console.log(`   Public Key: ${wallet.public_key?.slice(0, 30)}...`);

        // 4. Attempt to sign a test message
        console.log("\n4. Attempting to sign a test hash...");
        const testHash = "0x" + "a".repeat(64); // 32-byte hash
        console.log(`   Test hash: ${testHash.slice(0, 20)}...`);

        const authKey = authKeyRaw.replace('wallet-auth:', '');
        console.log(`   Auth key (stripped): ${authKey.slice(0, 30)}...`);

        try {
            // @ts-ignore
            const signResult = await privy.wallets().rawSign(wallet.id, {
                params: { hash: testHash },
                authorization_context: {
                    authorization_private_keys: [authKey]
                }
            });
            console.log("\n   ✅ SIGNING SUCCESSFUL!");
            console.log(`   Signature: ${JSON.stringify(signResult, null, 2)}`);
        } catch (signError: any) {
            console.log("\n   ❌ SIGNING FAILED!");
            console.log(`   Error: ${signError.message}`);
            console.log(`   Status: ${signError.status || 'N/A'}`);

            if (signError.message?.includes('authorization')) {
                console.log("\n   📋 Troubleshooting Steps:");
                console.log("   1. Go to Privy Dashboard > Your App > Wallets > Authorization Keys");
                console.log("   2. Verify an authorization key exists and is ACTIVE");
                console.log("   3. If using an existing key, ensure the PUBLIC key is registered");
                console.log("   4. If you generated a new key, copy the PRIVATE key to .env");
                console.log("   5. The .env format should be: wallet-auth:MIGHAgEA...");
            }
        }

        // 5. Try without authorization context (for comparison)
        console.log("\n5. Attempting to sign WITHOUT authorization context...");
        try {
            // @ts-ignore
            const signResult2 = await privy.wallets().rawSign(wallet.id, {
                params: { hash: testHash }
            });
            console.log("   ✅ Signing without auth context worked!");
            console.log(`   Signature: ${JSON.stringify(signResult2, null, 2)}`);
        } catch (err2: any) {
            console.log(`   ❌ Also failed: ${err2.message}`);
        }

    } catch (walletError: any) {
        console.error(`   ❌ Failed to create wallet: ${walletError.message}`);
    }

    console.log("\n=== Test Complete ===");
}

testPrivySigning().catch(console.error);
