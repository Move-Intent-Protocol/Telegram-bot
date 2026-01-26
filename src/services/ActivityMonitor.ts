import axios from 'axios';
import { Context, Telegraf } from 'telegraf';
import { CONFIG, TOKENS } from '../config';

interface SwapActivity {
    hash: string;
    success: boolean;
    timestamp: number;
    intent: {
        maker: string;
        sell_token_type: string;
        buy_token_type: string;
        sell_amount: string;
        buy_amount?: string;        // Limit orders
        start_buy_amount?: string;  // Market orders
        end_buy_amount?: string;    // Market orders
        nonce: string;
    };
    executionPrice?: number;
    executionRateLabel?: string;
}

export class ActivityMonitor {
    private bot: Telegraf;
    private processedHashes = new Set<string>();
    private interval: NodeJS.Timeout | null = null;
    private subscribedChatIds: Set<string> = new Set();

    constructor(bot: Telegraf) {
        this.bot = bot;
    }

    subscribe(chatId: string) {
        this.subscribedChatIds.add(chatId);
        if (!this.interval) {
            this.start();
        }
    }

    unsubscribe(chatId: string) {
        this.subscribedChatIds.delete(chatId);
    }

    start() {
        if (this.interval) return;
        console.log("🔄 Starting Activity Monitor...");
        this.interval = setInterval(() => this.checkActivity(), CONFIG.POLL_INTERVAL_MS);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    async checkActivity() {
        if (this.subscribedChatIds.size === 0) return;

        try {
            const response = await axios.get(`${CONFIG.RELAYER_API_URL}/activity`);
            const orders: SwapActivity[] = response.data.orders || [];

            // Process new swaps
            const newSwaps = orders.filter(o => o.hash && !this.processedHashes.has(o.hash));

            // Process oldest first
            newSwaps.reverse();

            for (const swap of newSwaps) {
                this.processedHashes.add(swap.hash);

                // Only broadcast recent swaps (last 60 minutes for testing)
                // Note: swap.timestamp is already in milliseconds from relayer
                const age = Date.now() - swap.timestamp;
                if (age < 60000 * 60) {
                    const message = this.formatSwap(swap);
                    for (const chatId of this.subscribedChatIds) {
                        try {
                            await this.bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                        } catch (e) {
                            console.error(`Failed to send to chat ${chatId}:`, e);
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Error polling activity:", error);
        }
    }

    private getToken(type: string) {
        return TOKENS.find(t => t.type === type) || {
            symbol: type.includes("::") ? type.split("::").pop() || "UNK" : "FA",
            type: type,
            decimals: 8
        };
    }

    private formatAmount(amount: string | number, decimals: number): string {
        const val = typeof amount === 'string' ? parseFloat(amount) : amount;
        const formatted = val / Math.pow(10, decimals);
        return formatted.toLocaleString(undefined, { maximumFractionDigits: 4 });
    }

    formatSwap(swap: SwapActivity): string {
        const intent = swap.intent;
        const sellToken = this.getToken(intent.sell_token_type);
        const buyToken = this.getToken(intent.buy_token_type);

        const sellAmount = this.formatAmount(intent.sell_amount, sellToken.decimals);

        // Calculate buy amount (use executed or expected)
        let buyAmount = "0";
        if (intent.buy_amount) {
            // Limit order
            buyAmount = this.formatAmount(intent.buy_amount, buyToken.decimals);
        } else if (intent.end_buy_amount) {
            // Market order - use end amount as minimum expected
            buyAmount = this.formatAmount(intent.end_buy_amount, buyToken.decimals);
        }

        // Determine order type
        const isLimit = intent.buy_amount !== undefined && intent.start_buy_amount === undefined;
        const orderType = isLimit ? "📋 LIMIT" : "⚡ MARKET";

        // Transaction status
        const statusEmoji = swap.success ? "✅" : "❌";
        const status = swap.success ? "FILLED" : "FAILED";

        // Build message
        let message = `${statusEmoji} *Swap ${status}*\n\n`;
        message += `🏷 *Type*: ${orderType}\n`;
        message += `👤 *Maker*: \`${intent.maker.slice(0, 6)}...${intent.maker.slice(-4)}\`\n\n`;

        // Swap details with arrow format like your UI
        message += `🔄 *Swap Details*\n`;
        message += `📉 *Sold*: ${sellAmount} ${sellToken.symbol}\n`;
        message += `📈 *Received*: ${buyAmount} ${buyToken.symbol}\n`;

        // Price if available
        if (swap.executionRateLabel) {
            message += `\n💵 *Rate*: ${swap.executionRateLabel}\n`;
        }

        // Explorer link
        message += `\n🔗 [View on Explorer](https://explorer.movementlabs.xyz/txn/${swap.hash}?network=testnet)`;

        // Frontend Link
        message += `\n🚀 [Swap on Intent Protocol](https://intent-protocol.vercel.app/swap)`;

        return message;
    }

    // Fetch and format all recent swaps for on-demand display
    async getRecentSwaps(limit: number = 5): Promise<string> {
        try {
            const response = await axios.get(`${CONFIG.RELAYER_API_URL}/activity`);
            const orders: SwapActivity[] = response.data.orders || [];

            if (orders.length === 0) {
                return "📭 No recent swaps found.";
            }

            const recentOrders = orders.slice(0, limit);
            let message = "📊 *Recent Swaps*\n\n";

            for (const swap of recentOrders) {
                const intent = swap.intent;
                const sellToken = this.getToken(intent.sell_token_type);
                const buyToken = this.getToken(intent.buy_token_type);

                const sellAmount = this.formatAmount(intent.sell_amount, sellToken.decimals);

                let buyAmount = "0";
                if (intent.buy_amount) {
                    buyAmount = this.formatAmount(intent.buy_amount, buyToken.decimals);
                } else if (intent.end_buy_amount) {
                    buyAmount = this.formatAmount(intent.end_buy_amount, buyToken.decimals);
                }

                const statusEmoji = swap.success ? "✅" : "❌";
                const timeAgo = this.timeAgo(swap.timestamp);

                message += `${statusEmoji} ${sellAmount} ${sellToken.symbol} → ${buyAmount} ${buyToken.symbol}\n`;
                message += `   _${timeAgo}_\n\n`;
            }

            return message;
        } catch (error) {
            console.error("Error fetching recent swaps:", error);
            return "❌ Failed to fetch recent swaps.";
        }
    }

    private timeAgo(timestamp: number): string {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }
}
