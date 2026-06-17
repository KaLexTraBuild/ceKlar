import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CEKLAR_CONFIG } from './ceklar.config'

const REGISTRY_ABI = [
  {
    name: 'createPlan',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'planId',         type: 'bytes32' },
      { name: 'price',          type: 'uint256' },
      { name: 'interval',       type: 'uint8'   },
      { name: 'customInterval', type: 'uint256' },
      { name: 'trialDays',      type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'totalPlans',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

// encode plan slug to bytes32
function encodePlanId(slug: string): `0x${string}` {
  const bytes = new TextEncoder().encode(slug)
  const padded = new Uint8Array(32)
  padded.set(bytes)
  return ('0x' + Array.from(padded)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')) as `0x${string}`
}

const arcTestnet = {
  id:   5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [CEKLAR_CONFIG.network.rpcUrl] } },
} as const

async function main() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`
  if (!privateKey) throw new Error('PRIVATE_KEY not set in environment')

  const account = privateKeyToAccount(privateKey)

  const walletClient = createWalletClient({
    account,
    chain:     arcTestnet,
    transport: http(CEKLAR_CONFIG.network.rpcUrl),
  })

  const publicClient = createPublicClient({
    chain:     arcTestnet,
    transport: http(CEKLAR_CONFIG.network.rpcUrl),
  })

  console.log('Creating plan on Arc testnet...')
  console.log('Wallet:', account.address)

  // plan config
  const planId       = encodePlanId('pro-monthly')
  const price        = BigInt(29 * 1_000_000)   // 29 USDC in 6 decimals
  const interval     = 0                         // 0 = Monthly
  const customSecs   = BigInt(0)
  const trialDays    = BigInt(7)                 // 7-day free trial

  const hash = await walletClient.writeContract({
    address:      CEKLAR_CONFIG.contracts.registry as `0x${string}`,
    abi:          REGISTRY_ABI,
    functionName: 'createPlan',
    args:         [planId, price, interval, customSecs, trialDays],
  })

  console.log('Transaction sent:', hash)
  console.log('Waiting for confirmation...')

  const receipt = await publicClient.waitForTransactionReceipt({ hash })

  console.log('')
  console.log('=== PLAN CREATED ON ARC ===')
  console.log('Plan ID:     pro-monthly')
  console.log('Price:       29 USDC / month')
  console.log('Trial:       7 days free')
  console.log('Tx hash:     ', hash)
  console.log('Block:       ', receipt.blockNumber.toString())
  console.log('Explorer:    ', `${CEKLAR_CONFIG.network.explorer}/tx/${hash}`)
  console.log('===========================')

  // confirm on-chain
  const total = await publicClient.readContract({
    address:      CEKLAR_CONFIG.contracts.registry as `0x${string}`,
    abi:          REGISTRY_ABI,
    functionName: 'totalPlans',
  })
  console.log(`\nTotal plans on-chain: ${total}`)
}

main().catch(console.error)
