import { useAccount, useDisconnect } from 'wagmi'

function truncate(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export default function ConnectedAddress() {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()

  if (!isConnected || !address) return null

  return (
    <div style={{
      position: 'fixed', top: '12px', right: '12px', zIndex: 9998,
      display: 'flex', alignItems: 'center', gap: '0.5rem',
      background: '#18181B', border: '1px solid #2A2A30',
      borderRadius: '999px', padding: '0.4rem 0.6rem 0.4rem 0.9rem',
      fontFamily: 'monospace', fontSize: '0.78rem', color: '#D4D4D8',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    }}>
      <span style={{
        width: '7px', height: '7px', borderRadius: '50%',
        background: '#4ADE80', display: 'inline-block', flexShrink: 0,
      }} />
      <span>Connected as {truncate(address)}</span>
      <button
        onClick={() => disconnect()}
        title="Disconnect"
        style={{
          background: 'transparent', border: 'none', color: '#71717A',
          cursor: 'pointer', fontSize: '0.95rem', lineHeight: 1,
          padding: '0 0.15rem', fontFamily: 'inherit',
        }}
      >
        ×
      </button>
    </div>
  )
}
