import { PrivyClient } from '@privy-io/node';
import { CONFIG } from '../config';

export class PrivyService {
    private privy: PrivyClient;

    constructor() {
        console.log("Initializing PrivyService...");
        if (!CONFIG.PRIVY_APP_ID || !CONFIG.PRIVY_APP_SECRET) {
            console.error("❌ Privy App ID or Secret missing!");
        } else {
            console.log("✅ Privy Credentials loaded.");
        }

        try {
            this.privy = new PrivyClient({
                appId: CONFIG.PRIVY_APP_ID,
                appSecret: CONFIG.PRIVY_APP_SECRET
            });
            console.log("✅ PrivyClient instantiated.");
        } catch (e: any) {
            console.error("❌ Failed to instantiate PrivyClient:", e);
            throw e;
        }
    }

    /**
     * Gets an existing user or creates a new one for a Telegram ID.
     * Creates a SERVER-MANAGED wallet (not embedded) for signing support.
     */
    async getOrCreateUser(telegramId: string, username?: string, forceNewWallet: boolean = false) {
        console.log(`getOrCreateUser called: telegramId=${telegramId}, username=${username}, forceNew=${forceNewWallet}`);
        try {
            // 1. Try to find existing user by Telegram ID
            try {
                const user = await this.privy.users().getByTelegramUserID({ telegram_user_id: telegramId });
                console.log(`✅ Found existing Privy user for Telegram ID ${telegramId}: ${user.id}`);
                return await this.ensureServerWallet(user.id, telegramId, forceNewWallet);
            } catch (error: any) {
                console.log("User lookup error (expected if new):", error.message);
                // If 404 / not found, create user
                if (error.status === 404 || error.message?.includes('not found') || error.message?.includes('404')) {
                    console.log(`👤 Creating new Privy user for Telegram ID ${telegramId}...`);

                    const newUser = await this.privy.users().create({
                        linked_accounts: [{
                            type: 'telegram',
                            telegram_user_id: telegramId,
                            username: username
                        }]
                    });
                    console.log("✅ User created:", newUser.id);
                    return await this.ensureServerWallet(newUser.id, telegramId, true); // Always force new for new users
                }
                throw error;
            }
        } catch (error: any) {
            console.error("Error in getOrCreateUser:", error);
            throw error;
        }
    }

    /**
     * Resets the user's wallet - creates a new server wallet.
     * Use this if the old wallet was created without proper auth keys.
     */
    async resetWallet(telegramId: string, username?: string) {
        console.log(`🔄 Resetting wallet for Telegram ID ${telegramId}...`);
        return this.getOrCreateUser(telegramId, username, true);
    }

    /**
     * Ensures the user has a SERVER-MANAGED Movement wallet.
     * Server wallets support signing without user interaction.
     */
    private async ensureServerWallet(userId: string, telegramId: string, forceNew: boolean = false) {
        console.log(`Ensuring server wallet for user ${userId}${forceNew ? ' (FORCE NEW)' : ''}`);

        const user = await this.privy.users()._get(userId);

        // Skip cached lookup if forcing new wallet
        if (!forceNew) {
            // Look for existing SERVER wallet (must have ID and NOT be embedded)
            const existingWallet = user.linked_accounts.find(
                (a: any) => a.type === 'wallet' &&
                    (a.chain_type === 'movement' || a.chain_type === 'aptos') &&
                    a.id &&
                    a.connector_type !== 'embedded'
            );

            if (existingWallet) {
                console.log(`✅ Found existing server wallet: ${(existingWallet as any).address} (ID: ${(existingWallet as any).id})`);
                return { user, wallet: existingWallet };
            }

            // Check custom metadata for a previously created server wallet
            const customMeta = user.custom_metadata as any;
            if (customMeta?.server_wallet_id) {
                console.log(`Found server wallet ID in metadata: ${customMeta.server_wallet_id}`);
                try {
                    const wallet = await this.privy.wallets().get(customMeta.server_wallet_id);
                    console.log(`✅ Retrieved existing server wallet: ${wallet.address}`);
                    return { user, wallet };
                } catch (e) {
                    console.log("Stored wallet not found, creating new one...");
                }
            }
        }

        console.log(`💼 Creating SERVER wallet for user ${userId}...`);

        try {
            // Create an APP-MANAGED wallet (no owner = app wallet, can be signed with auth keys)
            // User-owned wallets require user signing keys, app wallets use authorization keys
            const wallet = await this.privy.wallets().create({
                chain_type: 'movement'
                // NOTE: We do NOT set owner here. Wallets without owner are app-managed
                // and can be signed using authorization keys (PRIVY_AUTHORIZATION_PRIVATE_KEY)
            });

            console.log(`✅ Server Wallet Created: ${wallet.address} (ID: ${wallet.id})`);

            // Store the wallet ID in user's custom metadata for future reference
            try {
                await this.privy.users().setCustomMetadata(userId, {
                    custom_metadata: {
                        server_wallet_id: wallet.id,
                        server_wallet_address: wallet.address
                    }
                });
                console.log("✅ Wallet ID stored in user metadata");
            } catch (metaErr) {
                console.log("Could not store wallet in metadata (non-critical):", metaErr);
            }

            return { user, wallet };
        } catch (e: any) {
            console.error("Server Wallet Create Error:", e.message);

            // Fallback: try to create embedded wallet instead
            console.log("Falling back to embedded wallet...");
            const updatedUser = await this.privy.users().pregenerateWallets(userId, {
                wallets: [{ chain_type: 'movement' }]
            });

            const newWallet = updatedUser.linked_accounts.find(
                (a: any) => a.type === 'wallet' && (a.chain_type === 'movement' || a.chain_type === 'aptos')
            );

            if (!newWallet) {
                throw new Error("Failed to create wallet");
            }

            console.log(`✅ Embedded Wallet Created: ${(newWallet as any).address}`);
            return { user: updatedUser, wallet: newWallet };
        }
    }

    async getUserWalletAddress(telegramId: string): Promise<string | null> {
        try {
            const result = await this.getOrCreateUser(telegramId);
            return (result.wallet as any).address || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Signs a message using the user's wallet (Server-Side Sign).
     */
    async signMessage(walletId: string, messageHash: string) {
        if (!CONFIG.PRIVY_AUTHORIZATION_PRIVATE_KEY) {
            console.log("⚠️ No PRIVY_AUTHORIZATION_PRIVATE_KEY set, trying without authorization context...");
        }

        const authKey = CONFIG.PRIVY_AUTHORIZATION_PRIVATE_KEY?.replace('wallet-auth:', '') || '';

        console.log(`✍️ Signing message with wallet ${walletId}, hash: ${messageHash.slice(0, 20)}...`);

        try {
            // Try with authorization context first
            if (authKey) {
                // @ts-ignore
                const response = await this.privy.wallets().rawSign(walletId, {
                    params: { hash: messageHash },
                    authorization_context: {
                        authorization_private_keys: [authKey]
                    }
                });
                console.log("✅ Signed message successfully with auth context");
                return (response as any).data?.signature || (response as any).signature;
            } else {
                // Try without authorization context
                // @ts-ignore
                const response = await this.privy.wallets().rawSign(walletId, {
                    params: { hash: messageHash }
                });
                console.log("✅ Signed message successfully without auth context");
                return (response as any).data?.signature || (response as any).signature;
            }
        } catch (e: any) {
            console.error("Signing message error:", e.message);
            throw e;
        }
    }

    /**
     * Signs a transaction for Auto-Deposit.
     * Takes a transaction bytes (hex string) or hash depending on flow, but rawSign expects a 32-byte hash.
     * For Aptos/Movement, we typically sign the hashing of the transaction (Signing Message).
     */
    async signTransaction(walletId: string, transactionHash: string) {
        if (!CONFIG.PRIVY_AUTHORIZATION_PRIVATE_KEY) {
            throw new Error("Missing PRIVY_AUTHORIZATION_PRIVATE_KEY for transaction signing");
        }

        const authKey = CONFIG.PRIVY_AUTHORIZATION_PRIVATE_KEY.replace('wallet-auth:', '') || '';
        console.log(`✍️ Signing TRANSACTION with wallet ${walletId}...`);

        try {
            // @ts-ignore
            const response = await this.privy.wallets().rawSign(walletId, {
                params: { hash: transactionHash },
                authorization_context: {
                    authorization_private_keys: [authKey]
                }
            });
            console.log("✅ Transaction signed successfully");
            return (response as any).data?.signature || (response as any).signature;
        } catch (e: any) {
            console.error("Transaction signing error:", e.message);
            throw e;
        }
    }

    /**
     * Get the wallet ID for signing (needed for rawSign)
     */
    async getWalletId(telegramId: string): Promise<string | null> {
        try {
            const result = await this.getOrCreateUser(telegramId);
            const wallet = result.wallet as any;
            return wallet.id || null;
        } catch (e) {
            return null;
        }
    }
}
