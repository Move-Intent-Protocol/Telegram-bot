import { sha3_256 } from 'js-sha3';

// Helper to append byte arrays
function appendBytes(data: number[], toAppend: number[]): number[] {
    return data.concat(toAppend);
}

// Helper to write u64 LE
function serializeU64(val: bigint): number[] {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setBigUint64(0, val, true); // true = littleEndian
    return Array.from(new Uint8Array(buffer));
}

function serializeBytes(str: string): number[] {
    return Array.from(Buffer.from(str, 'utf-8'));
}

function hexToBytes(hex: string): number[] {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const len = clean.length;
    const bytes: number[] = [];
    for (let i = 0; i < len; i += 2) {
        bytes.push(parseInt(clean.substring(i, i + 2), 16));
    }
    return bytes;
}

export function serializeIntent(
    maker: string, // "0x..."
    nonce: string, // u64 string
    sellToken: string,
    buyToken: string,
    sellAmount: number,
    startBuyAmount: number,
    endBuyAmount: number,
    startTime: number,
    endTime: number
): Uint8Array {
    let data: number[] = [];

    // 1. Domain Separator
    data = appendBytes(data, serializeBytes("MOVE_INTENT_SWAP_V1"));

    // 2. Maker Address (32 bytes)
    const makerBytes = hexToBytes(maker);
    if (makerBytes.length !== 32) {
        // Pad to 32 bytes (right align)
        const padded = new Array(32).fill(0);
        for (let i = 0; i < makerBytes.length; i++) {
            padded[32 - makerBytes.length + i] = makerBytes[i];
        }
        data = appendBytes(data, padded);
    } else {
        data = appendBytes(data, makerBytes);
    }

    // 3. Nonce
    data = appendBytes(data, serializeU64(BigInt(nonce)));

    // 4. Sell Token
    data = appendBytes(data, serializeBytes(sellToken));

    // 5. Buy Token
    data = appendBytes(data, serializeBytes(buyToken));

    // 6. Amounts & Times
    data = appendBytes(data, serializeU64(BigInt(Math.floor(sellAmount))));
    data = appendBytes(data, serializeU64(BigInt(Math.floor(startBuyAmount))));
    data = appendBytes(data, serializeU64(BigInt(Math.floor(endBuyAmount))));
    data = appendBytes(data, serializeU64(BigInt(startTime)));
    data = appendBytes(data, serializeU64(BigInt(endTime)));

    return new Uint8Array(data);
}

export function hashIntent(serialized: Uint8Array): string {
    return sha3_256(serialized); // Returns hex string
}
