import axios from 'axios';
import { CONFIG } from '../config';

export interface Order {
    id: string;
    maker: string;
    sellToken: string;
    buyToken: string;
    sellAmount: number;
    buyAmount: number;
    status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
    timestamp: number;
    txHash?: string;
    nonce: string;
}

interface RelayerOrder {
    id: string;
    intent: {
        maker: string;
        nonce: string;
        sell_token_type: string;
        buy_token_type: string;
        sell_amount: string;
        start_buy_amount?: string;
        end_buy_amount?: string;
        buy_amount?: string;
        start_time?: string;
        end_time?: string;
    };
    signature: string;
    publicKey: string;
    signingNonce: string;
    timestamp: number;
}

interface RelayerActivity {
    hash: string;
    success: boolean;
    timestamp: number;
    intent: {
        maker: string;
        nonce: string;
        sell_token_type: string;
        buy_token_type: string;
        sell_amount: string;
    };
    executionRateLabel?: string;
}

// Token type to symbol mapping
const TYPE_TO_SYMBOL: Record<string, string> = {
    "0x1::aptos_coin::AptosCoin": "MOVE",
    "0x7eb1210794c2fdf636c5c9a5796b5122bf932458e3dd1737cf830d79954f5fdb": "WETH.e",
    "0x45142fb00dde90b950183d8ac2815597892f665c254c3f42b5768bc6ae4c8489": "USDC.e",
    "0x927595491037804b410c090a4c152c27af24d647863fc00b4a42904073d2d9de": "USDT.e"
};

// Token decimals
const DECIMALS: Record<string, number> = {
    "MOVE": 8,
    "WETH.e": 8,
    "USDC.e": 6,
    "USDT.e": 6
};

export class OrderService {
    private relayerUrl: string;

    constructor() {
        this.relayerUrl = CONFIG.RELAYER_API_URL;
    }

    /**
     * Get orders for a specific maker address
     */
    async getOrders(makerAddress: string): Promise<Order[]> {
        const orders: Order[] = [];

        try {
            // Fetch pending orders
            const pendingRes = await axios.get(`${this.relayerUrl}/orders`);
            const pendingOrders: RelayerOrder[] = pendingRes.data?.orders || [];

            // Fetch filled/activity
            const activityRes = await axios.get(`${this.relayerUrl}/activity`);
            const activityOrders: RelayerActivity[] = activityRes.data?.orders || [];

            // Map pending orders
            for (const order of pendingOrders) {
                if (order.intent.maker.toLowerCase() === makerAddress.toLowerCase()) {
                    orders.push(this.mapPendingOrder(order));
                }
            }

            // Map filled/cancelled orders from activity
            for (const activity of activityOrders) {
                if (activity.intent.maker.toLowerCase() === makerAddress.toLowerCase()) {
                    orders.push(this.mapActivityOrder(activity));
                }
            }

            // Sort by timestamp (newest first)
            orders.sort((a, b) => b.timestamp - a.timestamp);

            // Limit to last 10 orders
            return orders.slice(0, 10);

        } catch (error) {
            console.error("Failed to fetch orders:", error);
            return [];
        }
    }

    /**
     * Poll for order completion
     */
    async waitForOrderCompletion(
        intentHash: string,
        makerAddress: string,
        timeoutMs: number = 60000,
        pollIntervalMs: number = 5000
    ): Promise<{ filled: boolean; txHash?: string; error?: string }> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            try {
                // Check activity for this order
                const activityRes = await axios.get(`${this.relayerUrl}/activity`);
                const activities: RelayerActivity[] = activityRes.data?.orders || [];

                // Look for matching order by intent hash OR by maker/nonce match
                for (const activity of activities) {
                    if (activity.intent.maker.toLowerCase() === makerAddress.toLowerCase()) {
                        // Check if the order hash matches or if it's a recent fill
                        if (activity.hash === intentHash ||
                            (Date.now() - activity.timestamp < timeoutMs * 2)) {
                            if (activity.success) {
                                return { filled: true, txHash: activity.hash };
                            } else {
                                return { filled: false, error: "Order failed on-chain" };
                            }
                        }
                    }
                }

                // Check if order is still pending
                const pendingRes = await axios.get(`${this.relayerUrl}/orders`);
                const pendingOrders: RelayerOrder[] = pendingRes.data?.orders || [];
                const stillPending = pendingOrders.some(
                    o => o.id === intentHash && o.intent.maker.toLowerCase() === makerAddress.toLowerCase()
                );

                if (!stillPending) {
                    // Order not pending but also not in activity - might have just filled
                    // Wait one more poll cycle
                    await this.sleep(pollIntervalMs);
                    continue;
                }

                await this.sleep(pollIntervalMs);

            } catch (error) {
                console.error("Error polling order status:", error);
                await this.sleep(pollIntervalMs);
            }
        }

        return { filled: false, error: "Timeout waiting for order completion" };
    }

    private mapPendingOrder(order: RelayerOrder): Order {
        const intent = order.intent;
        const sellSymbol = TYPE_TO_SYMBOL[intent.sell_token_type] || "UNKNOWN";
        const buySymbol = TYPE_TO_SYMBOL[intent.buy_token_type] || "UNKNOWN";
        const sellDecimals = DECIMALS[sellSymbol] || 8;
        const buyDecimals = DECIMALS[buySymbol] || 8;

        const buyAmount = intent.buy_amount || intent.end_buy_amount || intent.start_buy_amount || "0";

        return {
            id: order.id,
            maker: intent.maker,
            sellToken: sellSymbol,
            buyToken: buySymbol,
            sellAmount: Number(intent.sell_amount) / Math.pow(10, sellDecimals),
            buyAmount: Number(buyAmount) / Math.pow(10, buyDecimals),
            status: 'PENDING',
            timestamp: order.timestamp || Date.now(),
            nonce: intent.nonce
        };
    }

    private mapActivityOrder(activity: RelayerActivity): Order {
        const intent = activity.intent;
        const sellSymbol = TYPE_TO_SYMBOL[intent.sell_token_type] || "UNKNOWN";
        const buySymbol = TYPE_TO_SYMBOL[intent.buy_token_type] || "UNKNOWN";
        const sellDecimals = DECIMALS[sellSymbol] || 8;

        return {
            id: activity.hash,
            maker: intent.maker,
            sellToken: sellSymbol,
            buyToken: buySymbol,
            sellAmount: Number(intent.sell_amount) / Math.pow(10, sellDecimals),
            buyAmount: 0, // Activity doesn't always have buy amount
            status: activity.success ? 'FILLED' : 'CANCELLED',
            timestamp: activity.timestamp,
            txHash: activity.hash,
            nonce: intent.nonce
        };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Format orders for display in Telegram
     */
    formatOrdersMessage(orders: Order[]): string {
        if (orders.length === 0) {
            return "📋 *No orders found*\n\nUse /swap to create a new order.";
        }

        let msg = "📋 *Your Recent Orders*\n\n";

        for (const order of orders) {
            const statusEmoji = order.status === 'FILLED' ? '✅' :
                order.status === 'PENDING' ? '⏳' :
                    order.status === 'CANCELLED' ? '❌' : '⚠️';

            const timeAgo = this.formatTimeAgo(order.timestamp);
            const txLink = order.txHash ?
                `[View](https://explorer.movementnetwork.xyz/txn/${order.txHash}?network=testnet)` : '';

            msg += `${statusEmoji} *${order.status}*\n`;
            msg += `   ${order.sellAmount.toFixed(4)} ${order.sellToken} → ${order.buyToken}\n`;
            msg += `   ${timeAgo}${txLink ? ' | ' + txLink : ''}\n\n`;
        }

        return msg;
    }

    private formatTimeAgo(timestamp: number): string {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);

        if (seconds < 60) return `${seconds}s ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    }
}
