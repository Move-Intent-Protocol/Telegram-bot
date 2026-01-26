import { Telegraf } from 'telegraf';
import { CONFIG } from './config';
import { PriceService } from './services/PriceService';
import { ActivityMonitor } from './services/ActivityMonitor';
import { PrivyService } from './services/PrivyService';
import { BotCommands } from './bot/commands';
import chalk from 'chalk';

async function main() {
    console.log(chalk.blue("🤖 Starting Telegram Price Bot..."));

    if (!CONFIG.TELEGRAM_BOT_TOKEN) {
        console.error(chalk.red("❌ Error: TELEGRAM_BOT_TOKEN is missing in .env"));
        process.exit(1);
    }

    const bot = new Telegraf(CONFIG.TELEGRAM_BOT_TOKEN);

    // Debug logging
    bot.use(async (ctx, next) => {
        console.log("📩 Received update:", JSON.stringify(ctx.update, null, 2));
        await next();
    });

    // Initialize Services
    const priceService = new PriceService();
    const activityMonitor = new ActivityMonitor(bot);
    const privyService = new PrivyService();

    // Register Commands
    const commands = new BotCommands(bot, priceService, activityMonitor, privyService);
    commands.register();

    // Start Bot with retry logic
    const startBot = async () => {
        let retries = 5;
        while (retries > 0) {
            try {
                await bot.launch();
                console.log(chalk.green("✅ Bot is online and polling!"));
                break;
            } catch (err: any) {
                console.error(chalk.yellow(`❌ Failed to start bot (Retries left: ${retries - 1}):`), err.message);
                retries--;
                if (retries === 0) {
                    console.error(chalk.red("❌ Could not connect to Telegram. Exiting."));
                    process.exit(1);
                }
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    };

    await startBot();

    // Graceful Stop
    process.once('SIGINT', () => {
        bot.stop('SIGINT');
        activityMonitor.stop();
    });
    process.once('SIGTERM', () => {
        bot.stop('SIGTERM');
        activityMonitor.stop();
    });
}

main().catch(err => {
    console.error("Fatal Error:", err);
});
