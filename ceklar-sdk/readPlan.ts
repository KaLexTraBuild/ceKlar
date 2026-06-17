import { createPublicClient, http } from 'viem'
import { CEKLAR_CONFIG } from './ceklar.config'

const client = createPublicClient({
  transport: http(CEKLAR_CONFIG.network.rpcUrl),
})

function encodePlanId(slug: string): `0x${string}` {
  const bytes  = new TextEncoder().encode(slug)
  const padded = new Uint8Array(32)
  padded.set(bytes)
  return ('0x' + Array.from(padded)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')) as `0x${string}`
}

async function main() {
  const plan = await client.readContract({
    address: CEKLAR_CONFIG.contracts.registry as `0x${string}`,
    abi: [{
      name: 'getPlan',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'planId', type: 'bytes32' }],
      outputs: [{
        type: 'tuple',
        components: [
          { name: 'id',             type: 'bytes32' },
          { name: 'merchant',       type: 'address' },
          { name: 'price',          type: 'uint256' },
          { name: 'interval',       type: 'uint8'   },
          { name: 'customInterval', type: 'uint256' },
          { name: 'trialDays',      type: 'uint256' },
          { name: 'active',         type: 'bool'    },
          { name: 'createdAt',      type: 'uint256' },
        ],
      }],
    }] as const,
    functionName: 'getPlan',
    args: [encodePlanId('pro-monthly')],
  })

  console.log('=== PLAN ON ARC TESTNET ===')
  console.log('Merchant:  ', plan.merchant)
  console.log('Price:     ', Number(plan.price) / 1_000_000, 'USDC')
  console.log('Interval:  ', plan.interval === 0 ? 'Monthly' : plan.interval)
  console.log('Trial days:', plan.trialDays.toString())
  console.log('Active:    ', plan.active)
  console.log('Created:   ', new Date(Number(plan.createdAt) * 1000).toUTCString())
  console.log('===========================')
}

main().catch(console.error)
