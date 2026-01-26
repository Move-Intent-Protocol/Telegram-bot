import axios from 'axios';
import { CONFIG, TOKENS } from '../config';

export class PriceService {
    async getPrices(): Promise<Record<string, number>> {
        try {
            console.log(`Fetching prices from ${CONFIG.RELAYER_API_URL}/prices...`);
            const response = await axios.get(`${CONFIG.RELAYER_API_URL}/prices`);
            console.log("Prices fetched:", response.data);
            return response.data;
        } catch (error) {
            console.error("Failed to fetch prices from Relayer:", error);
            return {};
        }
    }

    async getPrice(symbol: string): Promise<number | null> {
        const token = TOKENS.find(t => t.symbol.toUpperCase() === symbol.toUpperCase());
        if (!token) return null;

        const prices = await this.getPrices();
        return prices[token.type] || null;
    }

    getFormattedPrices(prices: Record<string, number>): string {
        let output = "📊 *Market Prices* 📊\n\n";

        for (const token of TOKENS) {
            const price = prices[token.type];
            if (price !== undefined) {
                output += `• *${token.symbol}*: $${price.toFixed(4)}\n`;
            } else {
                output += `• *${token.symbol}*: _Unavailable_\n`;
            }
        }

        return output;
    }
}
