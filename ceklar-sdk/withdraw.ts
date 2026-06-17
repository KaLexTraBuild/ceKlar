import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CEKLAR_CONFIG } from './ceklar.config'

const arcTestnet = {
  id:   5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [CEKLAR_CONFIG.network.rpcUrl] } },
} as const

const VAULT_ABI = [
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    name: 'getBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'merchant', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

const USDC_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

async function main() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`
  if (!privateKey) throw new Error('PRIVATE_KEY not set')

  const account = privateKeyToAccount(privateKey)
  const wallet  = createWalletClient({ account, chain: arcTestnet, transport: http(CEKLAR_CONFIG.network.rpcUrl) })
  const client  = createPublicClient({ chain: arcTestnet, transport: http(CEKLAR_CONFIG.network.rpcUrl) })

  // check vault balance before
  const vaultBefore = await client.readContract({
    address:      CEKLAR_CONFIG.contracts.vault as `0x${string}`,
    abi:          VAULT_ABI,
    functionName: 'getBalance',
    args:         [account.address],
  })

  const walletBefore = await client.readContract({
    address:      CEKLAR_CONFIG.usdc as `0x${string}`,
    abi:          USDC_ABI,
    functionName: 'balanceOf',
    args:         [account.address],
  })

  console.log('=== BEFORE WITHDRAWAL ===')
  console.log('Vault balance:  ', Number(vaultBefore)  / 1_000_000, 'USDC')
  console.log('Wallet balance: ', Number(walletBefore) / 1_000_000, 'USDC')
  console.log('')

  if (vaultBefore === 0n) {
    console.log('Nothing to withdraw.')
    return
  }

  // withdraw everything
  console.log('Withdrawing all USDC from vault...')
  const hash = await wallet.writeContract({
    address:      CEKLAR_CONFIG.contracts.vault as `0x${string}`,
    abi:          VAULT_ABI,
    functionName: 'withdraw',
    args:         [],
  })
  await client.waitForTransactionReceipt({ hash })
  console.log('Withdrawn:', hash)

  // check balances after
  const vaultAfter = await client.readContract({
    address:      CEKLAR_CONFIG.contracts.vault as `0x${string}`,
    abi:          VAULT_ABI,
    functionName: 'getBalance',
    args:         [account.address],
  })

  const walletAfter = await client.readContract({
    address:      CEKLAR_CONFIG.usdc as `0x${string}`,
    abi:          USDC_ABI,
    functionName: 'balanceOf',
    args:         [account.address],
  })

  console.log('')
  console.log('=== AFTER WITHDRAWAL ===')
  console.log('Vault balance:  ', Number(vaultAfter)  / 1_000_000, 'USDC')
  console.log('Wallet balance: ', Number(walletAfter) / 1_000_000, 'USDC')
  console.log('USDC received:  ', (Number(walletAfter) - Number(walletBefore)) / 1_000_000, 'USDC')
  console.log('Explorer:       ', `${CEKLAR_CONFIG.network.explorer}/tx/${hash}`)
  console.log('========================')
}

main().catch(console.error)
