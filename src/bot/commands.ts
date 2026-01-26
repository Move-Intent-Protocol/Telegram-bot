import { Context, Telegraf } from 'telegraf';
import { PriceService } from '../services/PriceService';
import { ActivityMonitor } from '../services/ActivityMonitor';
import { PrivyService } from '../services/PrivyService';
import { BalanceService } from '../services/BalanceService';
import { SwapService, SwapQuote } from '../services/SwapService';
import { TOKENS } from '../config';

// Store pending quotes per user
const pendingQuotes: Map<string, SwapQuote> = new Map();

export class BotCommands {
    private bot: Telegraf;
    private priceService: PriceService;
    private activityMonitor: ActivityMonitor;
    private privyService: PrivyService;
    private balanceService: BalanceService;
    private swapService: SwapService;

    constructor(bot: Telegraf, priceService: PriceService, activityMonitor: ActivityMonitor, privyService: PrivyService) {
        this.bot = bot;
        this.priceService = priceService;
        this.activityMonitor = activityMonitor;
        this.privyService = privyService;
        this.balanceService = new BalanceService();
        this.swapService = new SwapService(privyService);
    }

    register() {
        this.bot.command('start', (ctx) => this.handleStart(ctx));
        this.bot.command('price', (ctx) => this.handlePrice(ctx));
        this.bot.command('prices', (ctx) => this.handlePrices(ctx));
        this.bot.command('swaps', (ctx) => this.handleSwaps(ctx));
        this.bot.command('monitor', (ctx) => this.handleMonitor(ctx));
        this.bot.command('test', (ctx) => this.handleTest(ctx));
        this.bot.command('stop', (ctx) => this.handleStop(ctx));
        this.bot.command('help', (ctx) => this.handleHelp(ctx));

        // Wallet Commands
        this.bot.command('deposit', (ctx) => this.handleDeposit(ctx));
        this.bot.command('balance', (ctx) => this.handleBalance(ctx));
        this.bot.command('reset_wallet', (ctx) => this.handleResetWallet(ctx));

        // Trading Commands
        this.bot.command('swap', (ctx) => this.handleSwap(ctx));
        this.bot.command('confirm', (ctx) => this.handleConfirm(ctx));
        this.bot.command('withdraw', (ctx) => this.handleWithdraw(ctx));
    }

    private async handleWithdraw(ctx: Context) {
        if (!ctx.from) return;

        // @ts-ignore
        const text = ctx.message?.text || '';
        const parts = text.split(' ');

        // /withdraw TOKEN AMOUNT
        if (parts.length < 3) {
            const tokenList = TOKENS.map(t => t.symbol).join(', ');
            await ctx.reply(
                `📉 *Withdraw Usage*\n\n` +
                `/withdraw <token> <amount>\n\n` +
                `*Available Tokens:* ${tokenList}\n\n` +
                `*Example:* /withdraw MOVE 2`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const symbol = parts[1].toUpperCase();
        const amount = parseFloat(parts[2]);

        if (isNaN(amount) || amount <= 0) {
            await ctx.reply("❌ Invalid amount. Please enter a positive number.");
            return;
        }

        await ctx.reply(`⏳ Withdrawing ${amount} ${symbol} from Escrow...`);

        try {
            const result = await this.swapService.withdrawFromEscrow(ctx.from.id.toString(), symbol, amount);

            if (result.success) {
                await ctx.reply(result.message);
            } else {
                await ctx.reply(`❌ Withdrawal failed: ${result.message}`);
            }
        } catch (error: any) {
            console.error("Withdraw Error:", error);
            await ctx.reply(`❌ Failed to withdraw: ${error.message || 'Unknown error'}`);
        }
    }

    private async handleStart(ctx: Context) {
        const welcome =
            `🚀 *Intent Protocol Swap Bot*\n\n` +
            `Trade tokens on Movement Network directly from Telegram!\n\n` +
            `*💼 Wallet Commands:*\n` +
            `/deposit - Get your wallet address\n` +
            `/withdraw <token> <amount> - Withdraw from escrow\n` +
            `/balance - Check your balances\n\n` +
            `*💱 Trading Commands:*\n` +
            `/swap <sell> <buy> <amount> - Get a swap quote\n` +
            `/confirm - Execute pending swap\n\n` +
            `*📊 Market Commands:*\n` +
            `/prices - View all token prices\n` +
            `/swaps - View recent swaps\n` +
            `/monitor - Enable live swap alerts\n\n` +
            `*Example:* /swap MOVE USDC.e 5`;

        await ctx.reply(welcome, { parse_mode: 'Markdown' });
    }

    private async handleHelp(ctx: Context) {
        await this.handleStart(ctx);
    }

    private async handlePrice(ctx: Context) {
        // @ts-ignore
        const text = ctx.message?.text || '';
        const parts = text.split(' ');

        if (parts.length > 1) {
            const symbol = parts[1];
            const price = await this.priceService.getPrice(symbol);
            if (price !== null) {
                await ctx.reply(`💰 *${symbol.toUpperCase()}*: $${price.toFixed(4)}`, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(`❌ Token *${symbol}* not found or price unavailable.`, { parse_mode: 'Markdown' });
            }
        } else {
            await ctx.reply(`Usage: /price <symbol>\nExample: /price MOVE`, { parse_mode: 'Markdown' });
        }
    }

    private async handlePrices(ctx: Context) {
        const prices = await this.priceService.getPrices();
        const message = this.priceService.getFormattedPrices(prices);
        await ctx.reply(message, { parse_mode: 'Markdown' });
    }

    private async handleSwaps(ctx: Context) {
        await ctx.reply("🔄 Fetching recent swaps...");
        const message = await this.activityMonitor.getRecentSwaps(5);
        await ctx.reply(message, { parse_mode: 'Markdown' });
    }

    private async handleTest(ctx: Context) {
        const dummySwap = {
            hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            success: true,
            timestamp: Date.now(),
            intent: {
                maker: "0x1234567890abcdef1234567890abcdef12345678",
                sell_token_type: "0x1::aptos_coin::AptosCoin",
                buy_token_type: "0x4514...::USDC",
                sell_amount: "100000000",
                buy_amount: "5000000",
                nonce: "1"
            },
            executionRateLabel: "5.0000"
        };

        await ctx.reply("🧪 *Sending Test Alert...*", { parse_mode: 'Markdown' });
        const message = this.activityMonitor.formatSwap(dummySwap as any);
        await ctx.reply(message, { parse_mode: 'Markdown' });
    }

    private async handleMonitor(ctx: Context) {
        if (!ctx.chat) return;

        this.activityMonitor.subscribe(ctx.chat.id.toString());
        await ctx.reply(
            `✅ *Swap Alerts Enabled!*\n\n` +
            `You will receive notifications for new swaps.\n` +
            `Send /stop to disable alerts.`,
            { parse_mode: 'Markdown' }
        );
    }

    private async handleStop(ctx: Context) {
        if (!ctx.chat) return;

        this.activityMonitor.unsubscribe(ctx.chat.id.toString());
        await ctx.reply(
            `🛑 *Swap Alerts Disabled*\n\n` +
            `Send /monitor to enable alerts again.`,
            { parse_mode: 'Markdown' }
        );
    }

    private async handleDeposit(ctx: Context) {
        if (!ctx.from) return;

        await ctx.reply("⏳ Creating/Retrieving your Privy Wallet... (This may take a moment)");

        try {
            const user = await this.privyService.getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
            const wallet = user.wallet as any;

            await ctx.reply(
                `💳 *Your Movement Wallet*\n\n` +
                `Address: \`${wallet.address}\`\n\n` +
                `Send MOVE, USDC, or WETH to this address to start trading.`,
                { parse_mode: 'Markdown' }
            );

        } catch (error: any) {
            console.error("Deposit Error:", error);
            await ctx.reply(`❌ Failed to create wallet: ${error.message || 'Unknown error'}`);
        }
    }

    private async handleBalance(ctx: Context) {
        if (!ctx.from) return;

        await ctx.reply("⏳ Fetching your balances...");

        try {
            const user = await this.privyService.getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
            const wallet = user.wallet as any;

            const balances = await this.balanceService.getBalances(wallet.address);
            const message = this.balanceService.formatBalancesMessage(balances);

            await ctx.reply(message + `\n📍 Address: \`${wallet.address.slice(0, 8)}...${wallet.address.slice(-6)}\``, { parse_mode: 'Markdown' });

        } catch (error: any) {
            console.error("Balance Error:", error);
            await ctx.reply(`❌ Failed to fetch balances: ${error.message || 'Unknown error'}`);
        }
    }

    private async handleSwap(ctx: Context) {
        if (!ctx.from) return;

        // @ts-ignore
        const text = ctx.message?.text || '';
        const parts = text.split(' ');

        // /swap SELL_TOKEN BUY_TOKEN AMOUNT
        if (parts.length < 4) {
            const tokenList = TOKENS.map(t => t.symbol).join(', ');
            await ctx.reply(
                `📊 *Swap Usage*\n\n` +
                `/swap <sell_token> <buy_token> <amount>\n\n` +
                `*Available Tokens:* ${tokenList}\n\n` +
                `*Example:* /swap MOVE USDC.e 5`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const sellSymbol = parts[1].toUpperCase();
        const buySymbol = parts[2].toUpperCase();
        const amount = parseFloat(parts[3]);

        if (isNaN(amount) || amount <= 0) {
            await ctx.reply("❌ Invalid amount. Please enter a positive number.");
            return;
        }

        await ctx.reply("⏳ Fetching quote...");

        try {
            const quote = await this.swapService.getQuote(sellSymbol, buySymbol, amount);

            if (!quote) {
                await ctx.reply(`❌ Could not get quote. Check token symbols: ${sellSymbol}, ${buySymbol}`);
                return;
            }

            // Store quote for confirmation
            pendingQuotes.set(ctx.from.id.toString(), quote);

            const message = this.swapService.formatQuoteMessage(quote);
            await ctx.reply(message, { parse_mode: 'Markdown' });

        } catch (error: any) {
            console.error("Swap Quote Error:", error);
            await ctx.reply(`❌ Failed to get quote: ${error.message || 'Unknown error'}`);
        }
    }

    private async handleConfirm(ctx: Context) {
        if (!ctx.from) return;

        const quote = pendingQuotes.get(ctx.from.id.toString());

        if (!quote) {
            await ctx.reply("❌ No pending swap. Use /swap first to get a quote.");
            return;
        }

        await ctx.reply("⏳ Executing swap... This may take a moment.");

        try {
            const result = await this.swapService.executeSwap(ctx.from.id.toString(), quote);

            // Clear the pending quote
            pendingQuotes.delete(ctx.from.id.toString());

            if (result.success) {
                await ctx.reply(
                    `✅ *Swap Submitted!*\n\n` +
                    `${result.message}\n\n` +
                    `Your order will be filled when market conditions are met.\n` +
                    `Use /balance to check your updated balances.`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await ctx.reply(`❌ Swap failed: ${result.message}`);
            }

        } catch (error: any) {
            console.error("Confirm Error:", error);
            await ctx.reply(`❌ Failed to execute swap: ${error.message || 'Unknown error'}`);
        }
    }

    private async handleResetWallet(ctx: Context) {
        if (!ctx.from) return;

        await ctx.reply("🔄 Creating a new server wallet with proper authorization...\n\nThis will generate a NEW address. You'll need to fund it again.");

        try {
            const user = await this.privyService.resetWallet(ctx.from.id.toString(), ctx.from.username);
            const wallet = user.wallet as any;

            await ctx.reply(
                `✅ *New Wallet Created!*\n\n` +
                `Address: \`${wallet.address}\`\n\n` +
                `⚠️ This is a NEW address. Please send MOVE to this address to fund it.`,
                { parse_mode: 'Markdown' }
            );

        } catch (error: any) {
            console.error("Reset Wallet Error:", error);
            await ctx.reply(`❌ Failed to reset wallet: ${error.message || 'Unknown error'}`);
        }
    }
}
