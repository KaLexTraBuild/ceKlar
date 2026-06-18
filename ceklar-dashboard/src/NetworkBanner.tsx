import { useAccount } from 'wagmi'

const ARC_CHAIN_ID = 5042002
const ARC_CHAIN_HEX = '0x4cef52'

async function switchToArc(): Promise<void> {
  const eth = (window as any).ethereum
  if (!eth) return

  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ARC_CHAIN_HEX }],
    })
  } catch (err: any) {
    // 4902 = chain not yet added to the wallet
    if (err?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: ARC_CHAIN_HEX,
          chainName: 'Arc Testnet',
          nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
          rpcUrls: ['https://rpc.testnet.arc.network'],
          blockExplorerUrls: ['https://testnet.arcscan.app'],
        }],
      })
    } else {
      console.error('Failed to switch network:', err)
    }
  }
}

export default function NetworkBanner() {
  const { isConnected, chainId } = useAccount()

  if (!isConnected || chainId === ARC_CHAIN_ID) return null

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
      background: '#7C2D12', color: '#FED7AA', padding: '0.75rem 1.5rem',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: '1rem', fontFamily: 'monospace', fontSize: '0.85rem',
      borderBottom: '1px solid #9A3412',
    }}>
      <span>Wrong network — your wallet is on chain {chainId}, Ceklar runs on Arc Testnet (5042002)</span>
      <button
        onClick={switchToArc}
        style={{
          background: '#FED7AA', color: '#7C2D12', border: 'none',
          padding: '0.4rem 1rem', borderRadius: '4px', fontWeight: 600,
          cursor: 'pointer', fontFamily: 'monospace', fontSize: '0.8rem',
        }}
      >
        Switch to Arc Testnet
      </button>
    </div>
  )
}
