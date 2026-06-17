import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CEKLAR_CONFIG } from './ceklar.config'

const arcTestnet = {
  id:   5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [CEKLAR_CONFIG.network.rpcUrl] } },
} as const

const PULL_ABI = [
  {
    name: 'subscribe',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'planId',          type: 'bytes32' },
      { name: 'allowanceAmount', type: 'uint256' },
    ],
    outputs: [{ name: 'subscriptionId', type: 'bytes32' }],
  },
] as const

const USDC_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

const REGISTRY_ABI = [
  {
    name: 'subscriptionId',
    type: 'function',
    stateMutability: 'pure',
    inputs: [
      { name: 'planId',     type: 'bytes32' },
      { name: 'subscriber', type: 'address' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'getSubscription',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'subscriptionId', type: 'bytes32' }],
    outputs: [{
      type: 'tuple',
      components: [
        { name: 'planId',        type: 'bytes32' },
        { name: 'subscriber',    type: 'address' },
        { name: 'startedAt',     type: 'uint256' },
        { name: 'trialEndsAt',   type: 'uint256' },
        { name: 'nextBillingAt', type: 'uint256' },
        { name: 'billingCount',  type: 'uint256' },
        { name: 'active',        type: 'bool'    },
        { name: 'paused',        type: 'bool'    },
      ],
    }],
  },
] as const

function encodePlanId(slug: string): `0x${string}` {
  const bytes  = new TextEncoder().encode(slug)
  const padded = new Uint8Array(32)
  padded.set(bytes)
  return ('0x' + Array.from(padded)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')) as `0x${string}`
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`
  if (!privateKey) throw new Error('PRIVATE_KEY not set')

  const account = privateKeyToAccount(privateKey)

  const wallet = createWalletClient({
    account,
    chain:     arcTestnet,
    transport: http(CEKLAR_CONFIG.network.rpcUrl),
  })

  const client = createPublicClient({
    chain:     arcTestnet,
    transport: http(CEKLAR_CONFIG.network.rpcUrl),
  })

  const planId         = encodePlanId('pro-monthly')
  const approvalAmount = BigInt(377 * 1_000_000) // 13 months headroom

  console.log('Wallet:', account.address)
  console.log('Plan:   pro-monthly')
  console.log('')

  // step 1 — approve USDC
  console.log('Step 1: Approving USDC...')
  const approveHash = await wallet.writeContract({
    address:      CEKLAR_CONFIG.usdc as `0x${string}`,
    abi:          USDC_ABI,
    functionName: 'approve',
    args:         [CEKLAR_CONFIG.contracts.pull as `0x${string}`, approvalAmount],
  })
  await client.waitForTransactionReceipt({ hash: approveHash })
  console.log('USDC approved:', approveHash)

  // step 2 — subscribe
  console.log('')
  console.log('Step 2: Subscribing...')
  const subHash = await wallet.writeContract({
    address:      CEKLAR_CONFIG.contracts.pull as `0x${string}`,
    abi:          PULL_ABI,
    functionName: 'subscribe',
    args:         [planId, approvalAmount],
  })
  await client.waitForTransactionReceipt({ hash: subHash })
  console.log('Subscribed:', subHash)

  // step 3 — read subscription state
  const subId = await client.readContract({
    address:      CEKLAR_CONFIG.contracts.registry as `0x${string}`,
    abi:          REGISTRY_ABI,
    functionName: 'subscriptionId',
    args:         [planId, account.address],
  })

  const sub = await client.readContract({
    address:      CEKLAR_CONFIG.contracts.registry as `0x${string}`,
    abi:          REGISTRY_ABI,
    functionName: 'getSubscription',
    args:         [subId],
  })

  console.log('')
  console.log('=== SUBSCRIPTION LIVE ON ARC ===')
  console.log('Subscription ID:', subId)
  console.log('Subscriber:     ', sub.subscriber)
  console.log('Active:         ', sub.active)
  console.log('Trial ends:     ', sub.trialEndsAt > 0n
    ? new Date(Number(sub.trialEndsAt) * 1000).toUTCString()
    : 'No trial')
  console.log('Next billing:   ', new Date(Number(sub.nextBillingAt) * 1000).toUTCString())
  console.log('Billing count:  ', sub.billingCount.toString())
  console.log('Explorer:       ', `${CEKLAR_CONFIG.network.explorer}/tx/${subHash}`)
  console.log('================================')
}

main().catch(console.error)
