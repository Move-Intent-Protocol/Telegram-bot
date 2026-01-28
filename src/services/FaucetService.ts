import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import { CONFIG } from '../config';

// Rate limiting storage (in-memory) - tracks claim count and first claim time
interface ClaimInfo {
    count: number;
    firstClaimTime: number;
}
const claimHistory: Map<string, ClaimInfo> = new Map();

export class FaucetService {
    private client: Aptos;
    private faucetAccount: Account | null = null;
    private readonly FAUCET_AMOUNT = 1000000000; // 10 MOVE (8 decimals)
    private readonly COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
    private readonly MAX_CLAIMS_PER_PERIOD = 3; // 3 claims per 24h

    constructor() {
        const config = new AptosConfig({
            network: Network.CUSTOM,
            fullnode: 'https://testnet.movementnetwork.xyz/v1'
        });
        this.client = new Aptos(config);
        this.initFaucetAccount();
    }

    private initFaucetAccount() {
        const privateKeyHex = CONFIG.FAUCET_PRIVATE_KEY;
        if (!privateKeyHex) {
            console.warn("⚠️ FAUCET_PRIVATE_KEY not set - faucet disabled");
            return;
        }

        try {
            const cleanKey = privateKeyHex.replace('ed25519-priv-', '').replace('0x', '');
            const privateKey = new Ed25519PrivateKey(Buffer.from(cleanKey, 'hex'));
            this.faucetAccount = Account.fromPrivateKey({ privateKey });
            console.log(`💧 Faucet initialized: ${this.faucetAccount.accountAddress.toString()}`);
        } catch (e) {
            console.error("Failed to initialize faucet account:", e);
        }
    }

    /**
     * Check if user can claim (rate limiting: 3 claims per 24 hours)
     */
    canClaim(telegramId: string): { allowed: boolean; waitTime?: string; claimsRemaining?: number } {
        const info = claimHistory.get(telegramId);

        if (!info) {
            return { allowed: true, claimsRemaining: this.MAX_CLAIMS_PER_PERIOD };
        }

        const elapsed = Date.now() - info.firstClaimTime;

        // If 24h has passed, reset the counter
        if (elapsed >= this.COOLDOWN_MS) {
            claimHistory.delete(telegramId);
            return { allowed: true, claimsRemaining: this.MAX_CLAIMS_PER_PERIOD };
        }

        // Check if user has claims remaining in this period
        if (info.count < this.MAX_CLAIMS_PER_PERIOD) {
            return { allowed: true, claimsRemaining: this.MAX_CLAIMS_PER_PERIOD - info.count };
        }

        // User has exhausted claims, show wait time
        const remaining = this.COOLDOWN_MS - elapsed;
        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const minutes = Math.ceil((remaining % (60 * 60 * 1000)) / (60 * 1000));
        return {
            allowed: false,
            waitTime: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
            claimsRemaining: 0
        };
    }

    /**
     * Claim tokens from faucet
     */
    async claimTokens(userAddress: string, telegramId: string): Promise<{
        success: boolean;
        message: string;
        txHash?: string;
    }> {
        if (!this.faucetAccount) {
            return { success: false, message: "Faucet is not configured" };
        }

        // Check rate limit
        const { allowed, waitTime, claimsRemaining } = this.canClaim(telegramId);
        if (!allowed) {
            return {
                success: false,
                message: `You've used all 3 claims. Please wait ${waitTime} before claiming again.`
            };
        }

        try {
            // Check faucet balance
            const faucetBalance = await this.getFaucetBalance();
            if (faucetBalance < this.FAUCET_AMOUNT) {
                return { success: false, message: "Faucet is empty. Please try again later." };
            }

            // Build and submit transfer transaction
            const transaction = await this.client.transaction.build.simple({
                sender: this.faucetAccount.accountAddress,
                data: {
                    function: "0x1::aptos_account::transfer",
                    typeArguments: [],
                    functionArguments: [userAddress, this.FAUCET_AMOUNT]
                }
            });

            const pendingTx = await this.client.signAndSubmitTransaction({
                signer: this.faucetAccount,
                transaction
            });

            await this.client.waitForTransaction({ transactionHash: pendingTx.hash });

            // Record claim
            const existingInfo = claimHistory.get(telegramId);
            if (existingInfo) {
                claimHistory.set(telegramId, {
                    count: existingInfo.count + 1,
                    firstClaimTime: existingInfo.firstClaimTime
                });
            } else {
                claimHistory.set(telegramId, { count: 1, firstClaimTime: Date.now() });
            }

            const newClaimsRemaining = (claimsRemaining || this.MAX_CLAIMS_PER_PERIOD) - 1;
            const amountFormatted = (this.FAUCET_AMOUNT / 100000000).toFixed(0);
            return {
                success: true,
                message: `You received ${amountFormatted} MOVE! (${newClaimsRemaining} claims left today)`,
                txHash: pendingTx.hash
            };

        } catch (e: any) {
            console.error("Faucet claim error:", e);
            return { success: false, message: `Claim failed: ${e.message}` };
        }
    }

    /**
     * Get faucet wallet balance
     */
    async getFaucetBalance(): Promise<number> {
        if (!this.faucetAccount) return 0;

        try {
            const resources = await this.client.getAccountResources({
                accountAddress: this.faucetAccount.accountAddress
            });
            const coinResource = resources.find(
                (r: any) => r.type === '0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>'
            );
            if (coinResource) {
                return Number((coinResource.data as any).coin.value);
            }
        } catch (e) {
            console.error("Failed to get faucet balance:", e);
        }
        return 0;
    }

    /**
     * Get faucet address
     */
    getFaucetAddress(): string | null {
        return this.faucetAccount?.accountAddress.toString() || null;
    }
}
