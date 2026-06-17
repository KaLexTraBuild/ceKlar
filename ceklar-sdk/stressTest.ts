import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CEKLAR_CONFIG } from './ceklar.config'

const arcTestnet = {
  id:   5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [CEKLAR_CONFIG.network.rpcUrl] } },
} as const

const REGISTRY_ABI = [
  {
    name: 'createPlan', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'planId', type: 'bytes32' },
      { name: 'price', type: 'uint256' },
      { name: 'interval', type: 'uint8' },
      { name: 'customInterval', type: 'uint256' },
      { name: 'trialDays', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'subscriptionId', type: 'function', stateMutability: 'pure',
    inputs: [
      { name: 'planId', type: 'bytes32' },
      { name: 'subscriber', type: 'address' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
] as const

const PULL_ABI = [
  {
    name: 'subscribe', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'planId', type: 'bytes32' },
      { name: 'allowanceAmount', type: 'uint256' },
    ],
    outputs: [{ name: 'subscriptionId', type: 'bytes32' }],
  },
] as const

const USDC_ABI = [
  {
    name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

function encodePlanId(slug: string): `0x${string}` {
  const bytes  = new TextEncoder().encode(slug)
  const padded = new Uint8Array(32)
  padded.set(bytes)
  return ('0x' + Array.from(padded).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}

// ─── Stress Plans ───────────────────────────────────────────────────────────
// Interval enum: Monthly=0, Quarterly=1, Yearly=2, Custom=3
// Staggered short intervals so billing fires at different times — proves
// the keeper handles concurrent, independent subscriptions correctly.
const PLANS = [
  { slug: 'stress-1', priceUsdc: 1, intervalSec: 120 },  // bills every 2 min
  { slug: 'stress-2', priceUsdc: 2, intervalSec: 150 },  // bills every 2.5 min
  { slug: 'stress-3', priceUsdc: 3, intervalSec: 180 },  // bills every 3 min
  { slug: 'stress-4', priceUsdc: 1, intervalSec: 210 },  // bills every 3.5 min
  { slug: 'stress-5', priceUsdc: 2, intervalSec: 240 },  // bills every 4 min
]

async function main() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`
  if (!privateKey) throw new Error('PRIVATE_KEY not set')

  const account = privateKeyToAccount(privateKey)
  const wallet  = createWalletClient({ account, chain: arcTestnet, transport: http(CEKLAR_CONFIG.network.rpcUrl) })
  const client  = createPublicClient({ chain: arcTestnet, transport: http(CEKLAR_CONFIG.network.rpcUrl) })

  console.log('╔══════════════════════════════════════════════╗')
  console.log('║         CEKLAR STRESS TEST                   ║')
  console.log('║   5 subscriptions, staggered intervals       ║')
  console.log('╚══════════════════════════════════════════════╝')
  console.log('Wallet:', account.address)
  console.log('')

  // One large approval covers every plan's billing cycles for a long while
  console.log('Approving USDC allowance (500 USDC)...')
  const approveHash = await wallet.writeContract({
    address:      CEKLAR_CONFIG.usdc as `0x${string}`,
    abi:          USDC_ABI,
    functionName: 'approve',
    args:         [CEKLAR_CONFIG.contracts.pull as `0x${string}`, BigInt(500 * 1_000_000)],
  })
  await client.waitForTransactionReceipt({ hash: approveHash })
  console.log('Allowance confirmed:', approveHash)
  console.log('')

  const results: { slug: string; subId: string; interval: number; price: number }[] = []

  for (const plan of PLANS) {
    const planId = encodePlanId(plan.slug)
    const price  = BigInt(plan.priceUsdc * 1_000_000)

    console.log(`── ${plan.slug} ──────────────────────────────`)
    console.log(`Price: ${plan.priceUsdc} USDC | Interval: ${plan.intervalSec}s`)

    // Create plan — Custom interval (enum value 3), no trial
    const planHash = await wallet.writeContract({
      address:      CEKLAR_CONFIG.contracts.registry as `0x${string}`,
      abi:          REGISTRY_ABI,
      functionName: 'createPlan',
      args:         [planId, price, 3, BigInt(plan.intervalSec), 0n],
    })
    await client.waitForTransactionReceipt({ hash: planHash })
    console.log('Plan created:', planHash)

    // Subscribe — first billing fires immediately (no trial)
    const subHash = await wallet.writeContract({
      address:      CEKLAR_CONFIG.contracts.pull as `0x${string}`,
      abi:          PULL_ABI,
      functionName: 'subscribe',
      args:         [planId, BigInt(500 * 1_000_000)],
    })
    await client.waitForTransactionReceipt({ hash: subHash })
    console.log('Subscribed:', subHash)

    const subId = await client.readContract({
      address:      CEKLAR_CONFIG.contracts.registry as `0x${string}`,
      abi:          REGISTRY_ABI,
      functionName: 'subscriptionId',
      args:         [planId, account.address],
    })

    console.log('Subscription ID:', subId)
    console.log('')

    results.push({ slug: plan.slug, subId, interval: plan.intervalSec, price: plan.priceUsdc })
  }

  console.log('═══════════════════════════════════════════════')
  console.log('STRESS TEST DEPLOYED — 5 active subscriptions')
  console.log('═══════════════════════════════════════════════')
  results.forEach(r => {
    console.log(`${r.slug.padEnd(10)} | ${r.subId} | every ${r.interval}s | ${r.price} USDC`)
  })
  console.log('')
  console.log('Watch the keeper bill these automatically:')
  console.log('  pm2 logs ceklar-keeper')
  console.log('')
  console.log('First billing already executed on subscribe.')
  console.log('Next cycles will fire on schedule — fastest in ~2 minutes.')
}

main().catch(console.error)
