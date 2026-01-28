import axios from 'axios';
import { CONFIG, TOKENS } from '../config';
import { PrivyService } from './PrivyService';
import { PythService } from './PythService';
import { Aptos, AptosConfig, Network, Ed25519Signature, AccountAuthenticatorEd25519, Ed25519PublicKey } from "@aptos-labs/ts-sdk";
import { serializeIntent, hashIntent } from '../utils/bcs';

const INTENT_SWAP_ADDRESS = "0xbd128d4f1dbb87783658bed4a4046f3811015952110f321863c34f161eb07611";

export interface SwapQuote {
    sellToken: typeof TOKENS[0];
    buyToken: typeof TOKENS[0];
    sellAmount: number;
    buyAmount: number;
    rate: number;
    rateLabel: string;
}

export class SwapService {
    private privyService: PrivyService;
    private client: Aptos;

    constructor(privyService: PrivyService) {
        this.privyService = privyService;
        const config = new AptosConfig({ network: Network.CUSTOM, fullnode: 'https://testnet.movementnetwork.xyz/v1' });
        this.client = new Aptos(config);
    }

    getTokenBySymbol(symbol: string) {
        return TOKENS.find(t => t.symbol.toLowerCase() === symbol.toLowerCase());
    }

    async getQuote(sellSymbol: string, buySymbol: string, sellAmount: number): Promise<SwapQuote | null> {
        const sellToken = this.getTokenBySymbol(sellSymbol);
        const buyToken = this.getTokenBySymbol(buySymbol);

        if (!sellToken || !buyToken) {
            console.error(`Token not found: sell=${sellSymbol}, buy=${buySymbol}`);
            return null;
        }

        try {
            // Fetch prices from Pyth (same as frontend)
            const prices = await PythService.getPricesMap();
            console.log("Pyth Prices:", prices);

            const sellPrice = prices[sellToken.symbol] || prices['MOVE']; // Fallback to MOVE
            const buyPrice = prices[buyToken.symbol] || prices['USDC.e']; // Fallback to USDC

            if (!sellPrice || !buyPrice) {
                console.error(`Prices not found: sell=${sellToken.symbol}($${sellPrice}), buy=${buyToken.symbol}($${buyPrice})`);
                return null;
            }

            // Calculate expected buy amount based on USD prices
            const sellValueUsd = sellAmount * sellPrice;
            const buyAmount = sellValueUsd / buyPrice;
            const rate = sellPrice / buyPrice; // How many buyTokens per sellToken

            console.log(`Quote: ${sellAmount} ${sellToken.symbol} ($${sellValueUsd.toFixed(2)}) -> ${buyAmount.toFixed(4)} ${buyToken.symbol}`);

            return {
                sellToken,
                buyToken,
                sellAmount,
                buyAmount,
                rate,
                rateLabel: rate.toFixed(6)
            };
        } catch (e) {
            console.error("Error getting quote:", e);
            return null;
        }
    }

    /**
     * Deposits to escrow contract using Privy Server Wallet signing.
     */
    async depositToEscrow(walletId: string, address: string, tokenType: string, amount: number, decimals: number): Promise<boolean> {
        const rawAmount = Math.floor(amount * Math.pow(10, decimals));
        const isFA = !tokenType.includes("::");
        const funcName = isFA ? "deposit_fa" : "deposit";
        const typeArgs = isFA ? [] : [tokenType];
        const funcArgs = isFA ? [INTENT_SWAP_ADDRESS, rawAmount, tokenType] : [rawAmount];

        console.log(`📥 Depositing ${rawAmount} (${amount}) ${tokenType} to escrow...`);

        try {
            // 1. Build the transaction
            const transaction = await this.client.transaction.build.simple({
                sender: address,
                data: {
                    function: `${INTENT_SWAP_ADDRESS}::escrow::${funcName}`,
                    typeArguments: typeArgs,
                    functionArguments: funcArgs
                }
            });

            // 2. Get signing message (the hash to sign)
            const signingMessage = this.client.transaction.getSigningMessage({ transaction });
            const signingHash = '0x' + Buffer.from(signingMessage).toString('hex');

            console.log(`Signing hash: ${signingHash.slice(0, 30)}...`);

            // 3. Sign with Privy
            const signatureHex = await this.privyService.signTransaction(walletId, signingHash);
            console.log(`Signature: ${signatureHex?.slice(0, 30)}...`);

            if (!signatureHex) {
                throw new Error("Failed to get signature from Privy");
            }

            // 4. Get public key from wallet
            const userData = await this.privyService.getOrCreateUser(String(Date.now())); // dummy call to get structure
            // Actually we need to fetch the wallet's public key. Privy wallets have `public_key` property.
            // For now, we'll fetch it from the wallet API
            const walletInfo = await (this.privyService as any).privy.wallets().get(walletId);
            const publicKeyHex = walletInfo.public_key;

            if (!publicKeyHex) {
                throw new Error("Could not get public key from wallet");
            }

            console.log(`Public Key: ${publicKeyHex.slice(0, 20)}...`);

            // 5. Construct the authenticator and submit
            // Clean hex strings
            let cleanSig = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
            let cleanPubKey = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;

            console.log(`Debug - Public Key Length: ${cleanPubKey.length}`);
            let pubKeyBuf = Buffer.from(cleanPubKey, 'hex');
            console.log(`Debug - Public Key Buffer Length: ${pubKeyBuf.length}`);

            // Fix for 33-byte keys (common with some providers adding a prefix byte like 0x00 or 0x02/03)
            if (pubKeyBuf.length === 33) {
                console.log("Trimming 1 byte prefix from public key...");
                pubKeyBuf = pubKeyBuf.subarray(1);
            } else if (pubKeyBuf.length !== 32) {
                console.error(`Invalid public key length: ${pubKeyBuf.length}. Expected 32.`);
                // We might proceed or throw error, but for debugging let's throw to see explicit fail
                throw new Error(`Invalid public key length: ${pubKeyBuf.length}`);
            }

            const signature = new Ed25519Signature(Buffer.from(cleanSig, 'hex'));
            const publicKey = new Ed25519PublicKey(pubKeyBuf);
            const authenticator = new AccountAuthenticatorEd25519(publicKey, signature);

            // 6. Submit transaction
            const pendingTx = await this.client.transaction.submit.simple({
                transaction,
                senderAuthenticator: authenticator
            });

            console.log(`📤 Transaction submitted: ${pendingTx.hash}`);

            // 7. Wait for confirmation
            const result = await this.client.waitForTransaction({ transactionHash: pendingTx.hash });
            console.log(`✅ Deposit confirmed! Success: ${result.success}`);

            return result.success;
        } catch (e: any) {
            console.error("Deposit to escrow failed:", e.message);
            throw e;
        }
    }

    /**
     * Withdraws funds from escrow back to user's wallet.
     */
    async withdrawFromEscrow(telegramId: string, tokenSymbol: string, amount: number): Promise<{ success: boolean; message: string; txHash?: string }> {
        try {
            const token = this.getTokenBySymbol(tokenSymbol);
            if (!token) throw new Error("Invalid token symbol");

            // 1. Get user's wallet
            const userData = await this.privyService.getOrCreateUser(telegramId);
            const wallet = userData.wallet as any;
            if (!wallet.id) throw new Error("No server wallet found. Run /deposit first.");

            const walletId = wallet.id;
            const address = wallet.address;

            // 2. Prepare transaction
            const rawAmount = Math.floor(amount * Math.pow(10, token.decimals));
            const isFA = !token.type.includes("::");
            const funcName = isFA ? "withdraw_fa" : "withdraw";
            const typeArgs = isFA ? [] : [token.type];
            const funcArgs = isFA ? [INTENT_SWAP_ADDRESS, rawAmount, token.type] : [rawAmount];

            console.log(`📤 Withdrawing ${rawAmount} (${amount}) ${token.symbol} from escrow...`);

            // 3. Build & Sign (Reusing the robust logic from deposit, but manual implementation here to handle specific context)
            const transaction = await this.client.transaction.build.simple({
                sender: address,
                data: {
                    function: `${INTENT_SWAP_ADDRESS}::escrow::${funcName}`,
                    typeArguments: typeArgs,
                    functionArguments: funcArgs
                }
            });

            // Get signing message
            const signingMessage = this.client.transaction.getSigningMessage({ transaction });
            const signingHash = '0x' + Buffer.from(signingMessage).toString('hex');

            // Sign with Privy
            const signatureHex = await this.privyService.signTransaction(walletId, signingHash);
            if (!signatureHex) throw new Error("Failed to sign transaction");

            // Get Public Key (and trim if needed)
            const walletInfo = await (this.privyService as any).privy.wallets().get(walletId);
            let publicKeyHex = walletInfo.public_key;
            let cleanPubKey = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;
            let pubKeyBuf = Buffer.from(cleanPubKey, 'hex');
            if (pubKeyBuf.length === 33) pubKeyBuf = pubKeyBuf.subarray(1);

            // Construct Authenticator
            const cleanSig = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
            const signature = new Ed25519Signature(Buffer.from(cleanSig, 'hex'));
            const publicKey = new Ed25519PublicKey(pubKeyBuf);
            const authenticator = new AccountAuthenticatorEd25519(publicKey, signature);

            // Submit
            const pendingTx = await this.client.transaction.submit.simple({
                transaction,
                senderAuthenticator: authenticator
            });

            console.log(`📤 Withdrawal submitted: ${pendingTx.hash}`);
            await this.client.waitForTransaction({ transactionHash: pendingTx.hash });

            return {
                success: true,
                message: `✅ Withdrawal Confirmed!\n${amount} ${token.symbol} moved from Escrow to Wallet.`,
                txHash: pendingTx.hash
            };

        } catch (e: any) {
            console.error("Withdraw Error:", e);
            return {
                success: false,
                message: `Withdrawal failed: ${e.message}`
            };
        }
    }

    /**
     * Cancel all pending orders by incrementing on-chain nonce
     */
    async cancelOrders(telegramId: string): Promise<{ success: boolean; message: string; txHash?: string }> {
        try {
            const userData = await this.privyService.getOrCreateUser(telegramId);
            const wallet = userData.wallet as any;

            if (!wallet.id) {
                throw new Error("No server wallet found. Please run /deposit first.");
            }

            const walletId = wallet.id;
            const address = wallet.address;

            console.log(`🚫 Cancelling orders for ${address}...`);

            // Build cancel_orders transaction
            const transaction = await this.client.transaction.build.simple({
                sender: address,
                data: {
                    function: `${INTENT_SWAP_ADDRESS}::swap::cancel_orders`,
                    typeArguments: [],
                    functionArguments: [INTENT_SWAP_ADDRESS]
                }
            });

            // Sign with Privy
            const signingMessage = this.client.transaction.getSigningMessage({ transaction });
            const signingHash = '0x' + Buffer.from(signingMessage).toString('hex');
            const signatureHex = await this.privyService.signTransaction(walletId, signingHash);
            if (!signatureHex) throw new Error("Failed to sign transaction");

            // Get and normalize public key
            const walletInfo = await (this.privyService as any).privy.wallets().get(walletId);
            let publicKeyHex = walletInfo.public_key;
            let cleanPubKey = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;
            let pubKeyBuf = Buffer.from(cleanPubKey, 'hex');
            if (pubKeyBuf.length === 33) pubKeyBuf = pubKeyBuf.subarray(1);

            // Construct Authenticator
            const cleanSig = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
            const signature = new Ed25519Signature(Buffer.from(cleanSig, 'hex'));
            const publicKey = new Ed25519PublicKey(pubKeyBuf);
            const authenticator = new AccountAuthenticatorEd25519(publicKey, signature);

            // Submit
            const pendingTx = await this.client.transaction.submit.simple({
                transaction,
                senderAuthenticator: authenticator
            });

            console.log(`🚫 Cancel submitted: ${pendingTx.hash}`);
            await this.client.waitForTransaction({ transactionHash: pendingTx.hash });

            return {
                success: true,
                message: `Orders cancelled! Your nonce has been incremented.`,
                txHash: pendingTx.hash
            };

        } catch (e: any) {
            console.error("Cancel Orders Error:", e);
            return {
                success: false,
                message: `Cancel failed: ${e.message}`
            };
        }
    }

    async executeSwap(telegramId: string, quote: SwapQuote): Promise<{ success: boolean; message: string; txHash?: string }> {
        try {
            // 1. Get user's SERVER wallet ID for signing
            const userData = await this.privyService.getOrCreateUser(telegramId);
            const wallet = userData.wallet as any;

            if (!wallet.id) {
                throw new Error("No server wallet found for signing. Please run /deposit again.");
            }

            const walletId = wallet.id;
            const address = wallet.address;

            // 2. Prepare Parameters
            const sellAmountAtomic = Math.floor(quote.sellAmount * Math.pow(10, quote.sellToken.decimals));
            const buyAmountAtomic = Math.floor(quote.buyAmount * Math.pow(10, quote.buyToken.decimals));

            // 3. Check Escrow Balance
            let currentEscrowBal = 0;
            try {
                const isFA = !quote.sellToken.type.includes("::");
                const func = isFA ? "get_fa_balance" : "get_balance";
                const typeArgs = isFA ? [] : [quote.sellToken.type];
                const funcArgs = isFA ? [address, quote.sellToken.type] : [address];

                const balanceVal = await this.client.view({
                    payload: {
                        function: `${INTENT_SWAP_ADDRESS}::escrow::${func}`,
                        typeArguments: typeArgs,
                        functionArguments: funcArgs
                    }
                });

                currentEscrowBal = Number(balanceVal[0]);
                console.log(`Escrow Balance: ${currentEscrowBal}, Needed: ${sellAmountAtomic}`);
            } catch (e) {
                console.log("Failed to fetch escrow balance (assuming 0)");
            }

            // 4. Auto-Deposit if needed
            if (currentEscrowBal < sellAmountAtomic) {
                const depositNeeded = (sellAmountAtomic - currentEscrowBal) / Math.pow(10, quote.sellToken.decimals);
                console.log(`⚠️ Auto-Deposit required: ${depositNeeded} ${quote.sellToken.symbol}`);

                try {
                    const depositSuccess = await this.depositToEscrow(
                        walletId,
                        address,
                        quote.sellToken.type,
                        depositNeeded,
                        quote.sellToken.decimals
                    );

                    if (!depositSuccess) {
                        return { success: false, message: "Auto-deposit to escrow failed. Please try again." };
                    }

                    console.log("✅ Auto-deposit successful, proceeding with swap...");
                } catch (depositError: any) {
                    return {
                        success: false,
                        message: `Deposit failed: ${depositError.message}. Please ensure you have enough ${quote.sellToken.symbol} in your wallet.`
                    };
                }
            }

            // 5. Fetch On-Chain Nonce
            let nonce = "0";
            try {
                const nonceVal = await this.client.view({
                    payload: {
                        function: `${INTENT_SWAP_ADDRESS}::swap::get_nonce`,
                        typeArguments: [],
                        functionArguments: [INTENT_SWAP_ADDRESS, address]
                    }
                });
                nonce = nonceVal[0]?.toString() || "0";
                console.log(`✅ On-Chain Nonce: ${nonce}`);
            } catch (e) {
                console.error("Failed to fetch nonce, using timestamp fallback");
                nonce = Date.now().toString();
            }

            // 6. Create Intent
            const now = Math.floor(Date.now() / 1000);
            const cleanSellType = quote.sellToken.type.includes("::") ? quote.sellToken.type : "@" + quote.sellToken.type;
            const cleanBuyType = quote.buyToken.type.includes("::") ? quote.buyToken.type : "@" + quote.buyToken.type;

            const intent = {
                maker: address,
                nonce: nonce,
                sell_token_type: quote.sellToken.type,
                buy_token_type: quote.buyToken.type,
                sell_token: Buffer.from(cleanSellType).toString('hex'),
                buy_token: Buffer.from(cleanBuyType).toString('hex'),
                sell_amount: sellAmountAtomic.toString(),
                start_time: now.toString(),
                end_time: (now + 300).toString(),
                start_buy_amount: buyAmountAtomic.toString(),
                end_buy_amount: Math.floor(buyAmountAtomic * 0.95).toString()
            };

            // 7. Hash and Sign Intent (Corrected to use BCS + SHA3-256 for intent hash)
            const serializedIntent = serializeIntent(
                address,
                nonce,
                cleanSellType,
                cleanBuyType,
                sellAmountAtomic,
                buyAmountAtomic,
                Math.floor(buyAmountAtomic * 0.95), // endBuyAmount
                now,
                now + 300 // endTime
            );

            const intentHash = hashIntent(serializedIntent); // hex string without 0x
            const intentHashHex = '0x' + intentHash;

            console.log(`Signing intent with Nonce ${nonce}...`);
            console.log(`Intent Hash: ${intentHashHex}`);

            // Construct AIP-62 Full Message for signing
            // Format: "APTOS\nmessage: <intent_hash_hex>\nnonce: <nonce>"
            const fullMessage = `APTOS\nmessage: ${intentHash}\nnonce: ${nonce}`;
            console.log(`Full Message to Sign:\n${fullMessage}`);

            // Convert to bytes and SHA-256 hash for rawSign
            const { createHash } = await import('crypto');
            const fullMessageBytes = Buffer.from(fullMessage, 'utf-8');
            const fullMessageHash = createHash('sha256').update(fullMessageBytes).digest('hex');
            const messageHashForSigning = '0x' + fullMessageHash;

            console.log(`Full Message Hash (for rawSign): ${messageHashForSigning}`);

            const signature = await this.privyService.signMessage(walletId, messageHashForSigning);

            // 8. Get public key for relayer
            const walletInfo = await (this.privyService as any).privy.wallets().get(walletId);
            const publicKey = walletInfo.public_key;

            // 9. Submit to Relayer
            // Pass signingNonce as hex-encoded bytes matching on-chain format
            const signingNonceHex = '0x' + Buffer.from(nonce, 'utf-8').toString('hex');
            console.log(`Signing Nonce (hex): ${signingNonceHex}`);
            console.log("Submitting to relayer...");
            try {
                const response = await axios.post(`${CONFIG.RELAYER_API_URL}/intents`, {
                    intent,
                    signature,
                    publicKey,
                    signingNonce: signingNonceHex,
                    intentHash: intentHashHex
                });

                return {
                    success: true,
                    message: `Order submitted!`,
                    txHash: intentHashHex  // Use intent hash as the unique order ID
                };
            } catch (e: any) {
                if (e.response?.data?.error) {
                    return { success: false, message: `Relayer rejected: ${e.response.data.error}` };
                }
                throw e;
            }

        } catch (error: any) {
            console.error("Swap execution error:", error);
            return {
                success: false,
                message: error.message || 'Swap failed'
            };
        }
    }

    formatQuoteMessage(quote: SwapQuote): string {
        return `📊 *Swap Quote*\n\n` +
            `📉 *Sell*: ${quote.sellAmount.toFixed(4)} ${quote.sellToken.symbol}\n` +
            `📈 *Buy*: ~${quote.buyAmount.toFixed(4)} ${quote.buyToken.symbol}\n` +
            `💱 *Rate*: 1 ${quote.sellToken.symbol} = ${quote.rate.toFixed(6)} ${quote.buyToken.symbol}\n\n` +
            `⚠️ Final amount may vary based on market conditions.\n` +
            `Reply with /confirm to execute this swap.`;
    }
}
