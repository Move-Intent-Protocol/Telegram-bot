import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { CONFIG, TOKENS } from '../config';

export class BalanceService {
    private client: Aptos;

    constructor() {
        const config = new AptosConfig({
            network: Network.CUSTOM,
            fullnode: 'https://testnet.movementnetwork.xyz/v1'
        });
        this.client = new Aptos(config);
    }

    async getBalances(address: string): Promise<{ symbol: string; walletBalance: string; escrowBalance: string }[]> {
        const balances: { symbol: string; walletBalance: string; escrowBalance: string }[] = [];
        const INTENT_SWAP_ADDRESS = "0xbd128d4f1dbb87783658bed4a4046f3811015952110f321863c34f161eb07611";

        for (const token of TOKENS) {
            let walletBal = 0n;
            let escrowBal = 0n;

            try {
                // 1. Fetch Wallet Balance
                if (token.type === '0x1::aptos_coin::AptosCoin') {
                    const resources = await this.client.getAccountResources({ accountAddress: address });
                    const coinResource = resources.find(
                        (r: any) => r.type === '0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>'
                    );
                    if (coinResource) walletBal = BigInt((coinResource.data as any).coin.value);
                } else {
                    // FA tokens use primary_fungible_store
                    const result = await this.client.view({
                        payload: {
                            function: '0x1::primary_fungible_store::balance',
                            typeArguments: ['0x1::fungible_asset::Metadata'],
                            functionArguments: [address, token.type]
                        }
                    });
                    walletBal = BigInt(result[0] as string);
                }

                // 2. Fetch Escrow Balance
                const isFA = !token.type.includes("::");
                const func = isFA ? "get_fa_balance" : "get_balance";
                const typeArgs = isFA ? [] : [token.type];
                const funcArgs = isFA ? [address, token.type] : [address];

                const escrowRes = await this.client.view({
                    payload: {
                        function: `${INTENT_SWAP_ADDRESS}::escrow::${func}`,
                        typeArguments: typeArgs,
                        functionArguments: funcArgs
                    }
                });
                escrowBal = BigInt(escrowRes[0] as string);

            } catch (e) {
                // Ignore errors (account not found, etc)
            }

            const format = (val: bigint) => (Number(val) / Math.pow(10, token.decimals)).toFixed(4);

            balances.push({
                symbol: token.symbol,
                walletBalance: format(walletBal),
                escrowBalance: format(escrowBal)
            });
        }

        return balances;
    }

    formatBalancesMessage(balances: { symbol: string; walletBalance: string; escrowBalance: string }[]): string {
        let msg = `💰 *Your Balances*\n\n`;
        msg += `*Wallet* | *Escrow*\n`;
        msg += `-------------------\n`;

        for (const b of balances) {
            const emoji = b.symbol === 'MOVE' ? '🔷' : b.symbol.includes('USDC') ? '💵' : '🪙';
            // Simple table-like format
            msg += `${emoji} *${b.symbol}*\n`;
            msg += `💼 ${b.walletBalance} | 🏦 ${b.escrowBalance}\n\n`;
        }

        return msg;
    }
}
