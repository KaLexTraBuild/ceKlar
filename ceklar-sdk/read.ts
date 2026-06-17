import { createPublicClient, http } from 'viem'
import { CEKLAR_CONFIG } from './ceklar.config'

const client = createPublicClient({
  transport: http(CEKLAR_CONFIG.network.rpcUrl),
})

async function main() {
  // Read total plans
  const totalPlans = await client.readContract({
    address:      CEKLAR_CONFIG.contracts.registry as `0x${string}`,
    abi:          [{ name: 'totalPlans', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
    functionName: 'totalPlans',
  })

  // Read protocol fee
  const feeBps = await client.readContract({
    address:      CEKLAR_CONFIG.contracts.pull as `0x${string}`,
    abi:          [{ name: 'protocolFeeBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
    functionName: 'protocolFeeBps',
  })

  // Read vault total credited
  const totalCredited = await client.readContract({
    address:      CEKLAR_CONFIG.contracts.vault as `0x${string}`,
    abi:          [{ name: 'totalCredited', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
    functionName: 'totalCredited',
  })

  console.log('=== CEKLAR LIVE ON ARC TESTNET ===')
  console.log(`Total plans:       ${totalPlans}`)
  console.log(`Protocol fee:      ${Number(feeBps) / 100}%`)
  console.log(`Total credited:    ${totalCredited} USDC units`)
  console.log(`Registry:          ${CEKLAR_CONFIG.contracts.registry}`)
  console.log(`Vault:             ${CEKLAR_CONFIG.contracts.vault}`)
  console.log(`PullPayment:       ${CEKLAR_CONFIG.contracts.pull}`)
  console.log('==================================')
}

main().catch(console.error)
