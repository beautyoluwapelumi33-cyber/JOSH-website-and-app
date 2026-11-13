'use strict';

/**
 * USDT (BEP20 / BNB Smart Chain) payouts.
 *
 * Two independent capabilities, deliberately separated:
 *
 *  1. On-chain verification — needs NO credentials. A read-only BSC RPC call
 *     proves whether a transaction really transferred at least the requested
 *     amount of USDT to the creator's address. This is what stops an
 *     administrator from marking a payment "paid" without proof.
 *  2. Automated sending — needs a real payout provider (PAYOUT_PROVIDER,
 *     PAYOUT_API_KEY, PAYOUT_WALLET_ADDRESS). Until those exist this module
 *     reports `configured: false` and never pretends a payout was sent.
 */

const USDT_CONTRACT = '0x55d398326f99059ff775485246999027b3197955';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MIN_WITHDRAWAL = 0.5;
const DEFAULT_RPC = 'https://bsc-dataseed.binance.org';
const DECIMALS = 18;

const isAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
const isTxHash = (value) => /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());

function config() {
  return {
    provider: (process.env.PAYOUT_PROVIDER || '').trim(),
    apiKey: (process.env.PAYOUT_API_KEY || '').trim(),
    wallet: (process.env.PAYOUT_WALLET_ADDRESS || '').trim(),
    rpcUrl: (process.env.BSC_RPC_URL || DEFAULT_RPC).trim(),
  };
}

/** Honest connection status for the administrator dashboard. */
function status() {
  const { provider, apiKey, wallet, rpcUrl } = config();
  const missing = [];
  if (!provider) missing.push('PAYOUT_PROVIDER');
  if (!apiKey) missing.push('PAYOUT_API_KEY');
  if (!wallet) missing.push('PAYOUT_WALLET_ADDRESS');
  return {
    network: 'BEP20',
    asset: 'USDT',
    contract: USDT_CONTRACT,
    minWithdrawal: MIN_WITHDRAWAL,
    autoPayoutConfigured: missing.length === 0 && isAddress(wallet),
    provider: provider || null,
    payoutWallet: isAddress(wallet) ? wallet : null,
    missing,
    verificationRpc: rpcUrl,
    detail:
      missing.length === 0 && isAddress(wallet)
        ? 'Automatic USDT payouts are configured.'
        : 'Automatic payouts are not configured. Withdrawals are approved manually and each transaction hash is verified on-chain before a payment is marked paid.',
  };
}

async function rpcCall(method, params, { fetchImpl = fetch, rpcUrl } = {}) {
  const url = rpcUrl || config().rpcUrl;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(12_000) : undefined,
  });
  if (!res.ok) throw new Error(`RPC ${method} returned HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`RPC ${method} error: ${data.error.message || 'unknown'}`);
  return data.result;
}

/** Converts a decimal USDT amount into 18-decimal base units without float drift. */
function toBaseUnits(amount) {
  const millionths = Math.round(Number(amount) * 1e6);
  return BigInt(millionths) * 10n ** BigInt(DECIMALS - 6);
}

/**
 * Verifies that `txHash` really moved at least `amount` USDT to `to`.
 * Returns a structured verdict; never throws for a bad transaction.
 */
async function verifyUsdtTransfer({ txHash, to, amount, fetchImpl = fetch, rpcUrl } = {}) {
  const hash = String(txHash || '').trim();
  if (!isTxHash(hash)) return { verified: false, reason: 'invalid_tx_hash', detail: 'That is not a valid BSC transaction hash.' };
  if (!isAddress(to)) return { verified: false, reason: 'invalid_address', detail: 'The withdrawal wallet address is not a valid BEP20 address.' };
  const expected = toBaseUnits(amount);
  if (expected <= 0n) return { verified: false, reason: 'invalid_amount', detail: 'The withdrawal amount must be greater than zero.' };

  let receipt;
  try {
    receipt = await rpcCall('eth_getTransactionReceipt', [hash], { fetchImpl, rpcUrl });
  } catch (err) {
    return { verified: false, reason: 'rpc_unavailable', detail: `Could not reach the BSC node: ${err.message}` };
  }
  if (!receipt) return { verified: false, reason: 'not_found', detail: 'That transaction is not confirmed on BNB Smart Chain.' };
  if (receipt.status && receipt.status !== '0x1') {
    return { verified: false, reason: 'failed_on_chain', detail: 'The transaction reverted on-chain and moved no funds.' };
  }

  const target = String(to).toLowerCase().replace(/^0x/, '');
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  for (const log of logs) {
    if (String(log.address || '').toLowerCase() !== USDT_CONTRACT) continue;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue;
    const recipient = String(topics[2] || '').toLowerCase().replace(/^0x/, '');
    if (!recipient.endsWith(target)) continue;
    let value;
    try {
      value = BigInt(log.data);
    } catch {
      continue;
    }
    if (value >= expected) {
      return {
        verified: true,
        reason: 'verified',
        detail: 'Confirmed on BNB Smart Chain: a USDT transfer of at least the requested amount reached the creator wallet.',
        txHash: hash,
        from: `0x${String(topics[1] || '').slice(-40)}`,
        to: `0x${target}`,
        amount: Number(value) / 10 ** DECIMALS,
        blockNumber: receipt.blockNumber || null,
        contract: USDT_CONTRACT,
      };
    }
  }

  return {
    verified: false,
    reason: 'transfer_not_found',
    detail: 'The transaction is confirmed but contains no USDT transfer of at least this amount to the creator wallet.',
    blockNumber: receipt.blockNumber || null,
  };
}

module.exports = {
  MIN_WITHDRAWAL,
  USDT_CONTRACT,
  TRANSFER_TOPIC,
  DEFAULT_RPC,
  config,
  status,
  isAddress,
  isTxHash,
  toBaseUnits,
  verifyUsdtTransfer,
};
