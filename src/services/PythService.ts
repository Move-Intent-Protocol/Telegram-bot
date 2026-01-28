import axios from 'axios';

// Pyth Hermes API Endpoint
const HERMES_URL = "https://hermes.pyth.network";

// Price Feed IDs (Mainnet Beta) - same as frontend
export const PRICE_FEEDS: Record<string, string> = {
    MOVE: "0x6bf748c908767baa762a1563d454ebec2d5108f8ee36d806aadacc8f0a075b6d",
    ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    USDC: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    USDT: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
    // Mappings for bridged tokens
    "WETH.e": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    "USDC.e": "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    "USDT.e": "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
};

export interface PriceData {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
}

export const PythService = {
    /**
     * Fetch latest prices for all configured feeds from Pyth Hermes
     */
    async getLatestPrices(): Promise<Record<string, PriceData>> {
        try {
            const ids = [...new Set(Object.values(PRICE_FEEDS))]; // Unique IDs
            const response = await axios.get(`${HERMES_URL}/v2/updates/price/latest`, {
                params: {
                    ids: ids,
                    encoding: "hex",
                    parsed: true,
                },
                timeout: 10000
            });

            const prices: Record<string, PriceData> = {};

            const parsed = response.data.parsed;
            if (parsed) {
                for (const [symbol, id] of Object.entries(PRICE_FEEDS)) {
                    const feed = parsed.find((p: any) => p.id === id.replace("0x", ""));
                    if (feed) {
                        prices[symbol] = feed.price;
                    }
                }
            }
            return prices;

        } catch (error) {
            console.error("Failed to fetch Pyth prices:", error);
            return {};
        }
    },

    /**
     * Get price for a specific symbol
     */
    async getPrice(symbol: string): Promise<number | null> {
        const prices = await this.getLatestPrices();
        const priceData = prices[symbol];
        if (priceData) {
            return this.formatPrice(priceData);
        }
        return null;
    },

    /**
     * Format price with human readable decimals
     */
    formatPrice(price: PriceData): number {
        if (!price) return 0;
        return Number(price.price) * Math.pow(10, price.expo);
    },

    /**
     * Get formatted prices as a simple symbol -> USD map
     */
    async getPricesMap(): Promise<Record<string, number>> {
        const rawPrices = await this.getLatestPrices();
        const prices: Record<string, number> = {};

        for (const [symbol, priceData] of Object.entries(rawPrices)) {
            prices[symbol] = this.formatPrice(priceData);
        }

        return prices;
    }
};
