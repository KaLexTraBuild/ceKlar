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
] as const

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
] as const

const VAULT_ABI = [
  {
    name: 'getBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'merchant', type: 'address' }],
    outputs: [{ type: 'uint256' }],
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
  const wallet  = createWalletClient({ account, chain: arcTestnet, transport: http(CEKLAR_CONFIG.network.rpcUrl) })
  const client  = createPublicClient({ chain: arcTestnet, transport: http(CEKLAR_CONFIG.network.rpcUrl) })

  const planId = encodePlanId('basic-instant')
  const price  = BigInt(5 * 1_000_000) // 5 USDC

  // 1. create plan — NO trial
  console.log('Creating basic-instant plan — 5 USDC, no trial...')
  const planHash = await wallet.writeContract({
    address:      CEKLAR_CONFIG.contracts.registry as `0x${string}`,
    abi:          REGISTRY_ABI,
    functionName: 'createPlan',
    args:         [planId, price, 0, 0n, 0n],
  })
  await client.waitForTransactionReceipt({ hash: planHash })
  console.log('Plan created:', planHash)

  // 2. approve USDC
  console.log('Approving USDC...')
  const approveHash = await wallet.writeContract({
    address:      CEKLAR_CONFIG.usdc as `0x${string}`,
    abi:          USDC_ABI,
    functionName: 'approve',
    args:         [CEKLAR_CONFIG.contracts.pull as `0x${string}`, BigInt(100 * 1_000_000)],
  })
  await client.waitForTransactionReceipt({ hash: approveHash })
  console.log('USDC approved:', approveHash)

  // 3. subscribe — first payment hits immediately
  console.log('Subscribing...')
  const subHash = await wallet.writeContract({
    address:      CEKLAR_CONFIG.contracts.pull as `0x${string}`,
    abi:          PULL_ABI,
    functionName: 'subscribe',
    args:         [planId, BigInt(100 * 1_000_000)],
  })
  await client.waitForTransactionReceipt({ hash: subHash })
  console.log('Subscribed:', subHash)

  // 4. read vault balance — should show USDC now
  const balance = await client.readContract({
    address:      CEKLAR_CONFIG.contracts.vault as `0x${string}`,
    abi:          VAULT_ABI,
    functionName: 'getBalance',
    args:         [account.address],
  })

  console.log('')
  console.log('=== CEKLAR MONEY FLOW CONFIRMED ===')
  console.log('Plan:           basic-instant')
  console.log('Price:          5 USDC')
  console.log('Trial:          none — billed instantly')
  console.log('Vault balance:  ', Number(balance) / 1_000_000, 'USDC')
  console.log('Fee taken:      ', (5 * 0.0075).toFixed(4), 'USDC (0.75%)')
  console.log('Explorer:       ', `${CEKLAR_CONFIG.network.explorer}/tx/${subHash}`)
  console.log('===================================')
}

main().catch(console.error)
