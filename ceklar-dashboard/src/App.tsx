import { useState, useEffect, useRef } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { createPublicClient, createWalletClient, custom, http } from 'viem'
import { CEKLAR_CONFIG } from './ceklar.config'

const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
} as const

const REGISTRY_ABI = [
  { name: 'createPlan', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'planId', type: 'bytes32' }, { name: 'price', type: 'uint256' },
      { name: 'interval', type: 'uint8' }, { name: 'customInterval', type: 'uint256' },
      { name: 'trialDays', type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { name: 'totalPlans', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalSubscriptions', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const VAULT_ABI = [
  { name: 'getBalance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'merchant', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'totalCredited', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable',
    inputs: [], outputs: [] },
] as const

const USDC_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

function encodePlanId(slug: string): `0x${string}` {
  const bytes = new TextEncoder().encode(slug)
  const padded = new Uint8Array(32)
  padded.set(bytes)
  return ('0x' + Array.from(padded).map(b => b.toString(16).padStart(2,'0')).join('')) as `0x${string}`
}

function fmt(n: bigint, dec = 6) { return (Number(n) / 10 ** dec).toFixed(4) }
function fmtShort(n: bigint, dec = 6) { return (Number(n) / 10 ** dec).toFixed(2) }
function shortAddr(a: string) { return a.slice(0,6) + '…' + a.slice(-4) }


// ── Theme ──────────────────────────────────────────────────────────────────────
type ThemeMode = 'dark' | 'light' | 'system'

const THEME_CSS = `
  :root, [data-theme="dark"] {
    --black:   #0A0A0A;
    --white:   #FFFFFF;
    --gray1:   rgba(255,255,255,0.50);
    --gray2:   rgba(255,255,255,0.25);
    --glass:   rgba(255,255,255,0.04);
    --glass2:  rgba(255,255,255,0.08);
    --border:  rgba(255,255,255,0.08);
    --border2: rgba(255,255,255,0.20);
    --nav-bg:  rgba(10,10,10,0.85);
    --logo-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 0 0 1px rgba(255,255,255,0.10);
    --dropdown-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3);
    --r: 10px; --rm: 8px;
    color-scheme: dark;
  }
  [data-theme="light"] {
    /* #FDF8F0 — warm cream, the eye-care magic. Kills the harsh white glare. */
    --black:   #FDF8F0;
    --white:   #111111;
    --gray1:   rgba(0,0,0,0.45);
    --gray2:   rgba(0,0,0,0.28);
    --glass:   rgba(0,0,0,0.04);
    --glass2:  rgba(0,0,0,0.07);
    --border:  rgba(0,0,0,0.09);
    --border2: rgba(0,0,0,0.18);
    --nav-bg:  rgba(253,248,240,0.92);
    --logo-shadow: inset 0 -1px 0 rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.07);
    --dropdown-shadow: 0 12px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06);
    --r: 10px; --rm: 8px;
    color-scheme: light;
  }
  html, body {
    background: var(--black);
    color: var(--white);
    transition: background-color 300ms ease, color 300ms ease;
  }
`

function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    try {
      const saved = (localStorage.getItem('ceklar-theme') as ThemeMode) || 'system'
      const isDark = saved === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : saved === 'dark'
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
      return saved
    } catch { return 'system' }
  })

  useEffect(() => {
    if (!document.getElementById('ceklar-theme-css')) {
      const el = document.createElement('style')
      el.id = 'ceklar-theme-css'
      el.textContent = THEME_CSS
      document.head.appendChild(el)
    }
  }, [])

  useEffect(() => {
    try { localStorage.setItem('ceklar-theme', mode) } catch {}
    const apply = (isDark: boolean) =>
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
    if (mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      apply(mq.matches)
      const h = (e: MediaQueryListEvent) => apply(e.matches)
      mq.addEventListener('change', h)
      return () => mq.removeEventListener('change', h)
    } else {
      apply(mode === 'dark')
    }
  }, [mode])

  return { mode, setMode: setModeState }
}


// ── Theme icons ────────────────────────────────────────────────────────────────
function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2"  x2="12" y2="5"  />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="4.22" y1="4.22"   x2="6.34" y2="6.34"   />
      <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
      <line x1="2"  y1="12" x2="5"  y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <line x1="4.22" y1="19.78"  x2="6.34" y2="17.66"  />
      <line x1="17.66" y1="6.34"  x2="19.78" y2="4.22"  />
    </svg>
  )
}

function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8"  y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}


// ── Theme toggle — icon button → dropdown ──────────────────────────────────────
function ThemeToggle({ mode, onChange }: {
  mode: ThemeMode; onChange: (m: ThemeMode) => void
}) {
  const [open, setOpen]       = useState(false)
  const [hovered, setHovered] = useState<ThemeMode | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // The trigger icon reflects what's currently active
  const TriggerIcon = mode === 'dark' ? MoonIcon : mode === 'light' ? SunIcon : MonitorIcon

  const opts = [
    { v: 'dark'   as ThemeMode, label: 'Dark',   Icon: MoonIcon    },
    { v: 'light'  as ThemeMode, label: 'Light',  Icon: SunIcon     },
    { v: 'system' as ThemeMode, label: 'System', Icon: MonitorIcon },
  ]

  return (
    <div ref={ref} style={{ position: 'relative' }}>

      {/* ── Circular icon button ── */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Change theme"
        style={{
          width: 32, height: 32,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: open ? 'var(--glass2)' : 'var(--glass)',
          border: '1px solid var(--border)',
          borderRadius: '50%',
          cursor: 'pointer',
          color: 'var(--gray1)',
          transition: 'all 200ms ease',
          flexShrink: 0,
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--white)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--gray1)' }}
      >
        <TriggerIcon />
      </button>

      {/* ── Dropdown ── */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0,
          background: 'var(--nav-bg)',
          border: '1px solid var(--border)',
          borderRadius: 10, padding: 4,
          minWidth: 136,
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          boxShadow: 'var(--dropdown-shadow)',
          zIndex: 300,
        }}>
          {opts.map(({ v, label, Icon }) => {
            const isActive  = mode === v
            const isHovered = hovered === v
            return (
              <button
                key={v}
                onClick={() => { onChange(v); setOpen(false) }}
                onMouseEnter={() => setHovered(v)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '7px 10px',
                  fontSize: 12,
                  fontFamily: 'Space Grotesk, sans-serif',
                  fontWeight: isActive ? 600 : 400,
                  border: 'none', borderRadius: 7,
                  cursor: 'pointer',
                  background: isHovered
                    ? 'var(--glass2)'
                    : isActive ? 'var(--glass)' : 'transparent',
                  color: isActive ? 'var(--white)' : 'var(--gray1)',
                  transition: 'all 150ms ease',
                  textAlign: 'left',
                }}
              >
                <span style={{ color: isActive ? 'var(--white)' : 'var(--gray1)',
                  display: 'flex', alignItems: 'center' }}>
                  <Icon />
                </span>
                {label}
                {isActive && (
                  <span style={{ marginLeft: 'auto', fontSize: 10,
                    color: 'var(--gray1)', opacity: 0.7 }}>✓</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}


// ── Logo mark ──────────────────────────────────────────────────────────────────
function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <div style={{
      width: size, height: size,
      borderRadius: Math.round(size * 0.22),
      background: 'var(--white)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
      boxShadow: 'var(--logo-shadow)',
      transition: 'background 300ms ease, box-shadow 300ms ease',
    }}>
      <svg viewBox="0 0 20 20" fill="none"
        width={size * 0.6} height={size * 0.6}
        style={{ color: 'var(--black)' }}>
        <path d="M14 4.5A7 7 0 1 0 14 15.5L14 12.5A4 4 0 1 1 14 7.5Z"
          fill="currentColor" />
        <rect x="11" y="8" width="6" height="6" rx="1.5" fill="currentColor"
          style={{ opacity: 0.35 }} />
      </svg>
    </div>
  )
}

// ── Stat card ──────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, loading }: {
  label: string; value: string; sub?: string; loading?: boolean
}) {
  return (
    <div className="card fade-up" style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 10, fontFamily: 'Space Mono, monospace',
        color: 'var(--gray1)', textTransform: 'uppercase',
        letterSpacing: '.1em', marginBottom: 12 }}>{label}</div>
      {loading
        ? <div className="pulse" style={{ height: 32, width: '60%',
            background: 'var(--glass2)', borderRadius: 6 }} />
        : <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.03em',
            color: 'var(--white)', marginBottom: 4, lineHeight: 1 }}>{value}</div>
      }
      {sub && <div style={{ fontSize: 11, color: 'var(--gray1)', marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

// ── Section header ─────────────────────────────────────────────────────────────
function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em',
        color: 'var(--white)', marginBottom: sub ? 4 : 0 }}>{title}</h2>
      {sub && <p style={{ fontSize: 13, color: 'var(--gray1)' }}>{sub}</p>}
    </div>
  )
}

// ── Nav ────────────────────────────────────────────────────────────────────────
function Nav({ address, onDisconnect, themeMode, onThemeChange }: {
  address: string
  onDisconnect: () => void
  themeMode: ThemeMode
  onThemeChange: (m: ThemeMode) => void
}) {
  return (
    <nav style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 32px', height: 60,
      borderBottom: '1px solid var(--border)',
      background: 'var(--nav-bg)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      position: 'sticky', top: 0, zIndex: 100,
      transition: 'background 300ms ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <LogoMark size={30} />
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.03em' }}>
            ceklar
          </span>
          <span style={{ fontSize: 11, color: 'var(--gray2)',
            marginLeft: 8, fontFamily: 'Space Mono, monospace' }}>
            dashboard
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Moon/sun icon → dropdown */}
        <ThemeToggle mode={themeMode} onChange={onThemeChange} />

        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          background: 'var(--glass)', border: '1px solid var(--border)',
          borderRadius: 99, padding: '5px 12px',
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%',
            background: 'var(--white)', opacity: 0.8 }} />
          <span style={{ fontSize: 11, fontFamily: 'Space Mono, monospace',
            color: 'var(--gray1)' }}>{shortAddr(address)}</span>
        </div>

        <button className="btn btn-ghost btn-sm" onClick={onDisconnect}>
          disconnect
        </button>
      </div>
    </nav>
  )
}

// ── Tab bar ────────────────────────────────────────────────────────────────────
function Tabs({ active, onChange }: {
  active: string; onChange: (t: string) => void
}) {
  const tabs = ['overview', 'plans', 'withdraw']
  return (
    <div style={{
      display: 'flex', gap: 0,
      borderBottom: '1px solid var(--border)',
      marginBottom: 32,
    }}>
      {tabs.map(t => (
        <button key={t} onClick={() => onChange(t)} style={{
          padding: '10px 20px',
          fontSize: 13, fontWeight: 500,
          fontFamily: 'Space Grotesk, sans-serif',
          cursor: 'pointer',
          background: 'transparent',
          border: 'none',
          borderBottom: active === t ? '1px solid var(--white)' : '1px solid transparent',
          color: active === t ? 'var(--white)' : 'var(--gray1)',
          transition: 'all 200ms ease',
          marginBottom: -1,
          letterSpacing: '0.01em',
        }}>{t}</button>
      ))}
    </div>
  )
}

// ── Connect screen ─────────────────────────────────────────────────────────────
function ConnectScreen({ onConnect }: { onConnect: () => void }) {
  return (
    <div style={{
      minHeight: '100vh', background: 'var(--black)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 0,
      transition: 'background 300ms ease',
    }}>
      <div className="fade-up" style={{ textAlign: 'center', maxWidth: 360 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 32 }}>
          <LogoMark size={56} />
        </div>

        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.04em',
          marginBottom: 10, lineHeight: 1.1 }}>
          ceklar
        </h1>

        <p style={{ fontSize: 14, color: 'var(--gray1)', lineHeight: 1.65,
          marginBottom: 36 }}>
          On-chain subscription protocol.<br/>
          Connect your wallet to manage revenue.
        </p>

        <button className="btn btn-primary" style={{ width: '100%', padding: '12px 0',
          fontSize: 14, justifyContent: 'center', borderRadius: 'var(--r)' }}
          onClick={onConnect}>
          Connect Wallet
        </button>

        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8 }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%',
            background: 'var(--white)', opacity: 0.4 }} />
          <span style={{ fontSize: 11, color: 'var(--gray2)',
            fontFamily: 'Space Mono, monospace' }}>
            Arc Testnet · 5042002
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const { address, isConnected } = useAccount()
  const { connect }    = useConnect()
  const { disconnect } = useDisconnect()

  const { mode: themeMode, setMode: setThemeMode } = useTheme()

  const [tab, setTab]               = useState('overview')
  const [stats, setStats]           = useState<any>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [error, setError]           = useState('')
  const [txHash, setTxHash]         = useState('')
  const [planId, setPlanId]         = useState('')
  const [planPrice, setPlanPrice]   = useState('')
  const [planTrial, setPlanTrial]   = useState('0')
  const [creating, setCreating]     = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(CEKLAR_CONFIG.network.rpcUrl),
  })

  async function loadStats() {
    if (!address) return
    setStatsLoading(true); setError('')
    try {
      const [totalPlans, totalSubs, vaultBal, totalCredited, usdcBal] =
        await Promise.all([
          client.readContract({ address: CEKLAR_CONFIG.contracts.registry as `0x${string}`,
            abi: REGISTRY_ABI, functionName: 'totalPlans' }),
          client.readContract({ address: CEKLAR_CONFIG.contracts.registry as `0x${string}`,
            abi: REGISTRY_ABI, functionName: 'totalSubscriptions' }),
          client.readContract({ address: CEKLAR_CONFIG.contracts.vault as `0x${string}`,
            abi: VAULT_ABI, functionName: 'getBalance', args: [address] }),
          client.readContract({ address: CEKLAR_CONFIG.contracts.vault as `0x${string}`,
            abi: VAULT_ABI, functionName: 'totalCredited' }),
          client.readContract({ address: CEKLAR_CONFIG.usdc as `0x${string}`,
            abi: USDC_ABI, functionName: 'balanceOf', args: [address] }),
        ])
      setStats({ totalPlans, totalSubs, vaultBal, totalCredited, usdcBal })
    } catch (e: any) { setError(e.message) }
    finally { setStatsLoading(false) }
  }

  useEffect(() => { if (isConnected && address) loadStats() }, [isConnected, address])

  async function createPlan() {
    if (!planId || !planPrice) return
    setCreating(true); setError(''); setTxHash('')
    try {
      const wc = createWalletClient({ chain: arcTestnet,
        transport: custom((window as any).ethereum) })
      const [acct] = await wc.getAddresses()
      const hash = await wc.writeContract({
        account: acct,
        address: CEKLAR_CONFIG.contracts.registry as `0x${string}`,
        abi: REGISTRY_ABI, functionName: 'createPlan',
        args: [encodePlanId(planId),
          BigInt(Math.round(parseFloat(planPrice) * 1_000_000)),
          0, 0n, BigInt(parseInt(planTrial) || 0)],
      })
      await client.waitForTransactionReceipt({ hash })
      setTxHash(hash); setPlanId(''); setPlanPrice(''); setPlanTrial('0')
      await loadStats()
    } catch (e: any) { setError(e.message) }
    finally { setCreating(false) }
  }

  async function withdrawAll() {
    setWithdrawing(true); setError(''); setTxHash('')
    try {
      const wc = createWalletClient({ chain: arcTestnet,
        transport: custom((window as any).ethereum) })
      const [acct] = await wc.getAddresses()
      const hash = await wc.writeContract({
        account: acct,
        address: CEKLAR_CONFIG.contracts.vault as `0x${string}`,
        abi: VAULT_ABI, functionName: 'withdraw', args: [],
      })
      await client.waitForTransactionReceipt({ hash })
      setTxHash(hash); await loadStats()
    } catch (e: any) { setError(e.message) }
    finally { setWithdrawing(false) }
  }

  if (!isConnected) {
    return <ConnectScreen onConnect={() => connect({ connector: injected() })} />
  }

  const netReceive = planPrice ? (parseFloat(planPrice) * 0.9925).toFixed(4) : '0'
  const fee        = planPrice ? (parseFloat(planPrice) * 0.0075).toFixed(4) : '0'

  return (
    <div style={{ minHeight: '100vh', background: 'var(--black)',
      transition: 'background 300ms ease' }}>
      <Nav
        address={address!}
        onDisconnect={() => disconnect()}
        themeMode={themeMode}
        onThemeChange={setThemeMode}
      />

      <div style={{ maxWidth: 880, margin: '0 auto', padding: '40px 24px' }}>

        {error && <div className="error-box">{error}</div>}

        {txHash && (
          <div className="success-box fade-up">
            <span style={{ color: 'var(--gray1)' }}>Transaction confirmed — </span>
            <a href={`${CEKLAR_CONFIG.network.explorer}/tx/${txHash}`}
              target="_blank" rel="noreferrer"
              style={{ color: 'var(--white)', borderBottom: '1px solid var(--border2)' }}>
              view on ArcScan ↗
            </a>
          </div>
        )}

        <Tabs active={tab} onChange={t => { setTab(t); setTxHash(''); setError('') }} />

        {/* ── OVERVIEW ── */}
        {tab === 'overview' && (
          <div className="fade-up">
            <div style={{ display: 'flex', justifyContent: 'space-between',
              alignItems: 'flex-end', marginBottom: 24 }}>
              <SectionHeader title="Protocol overview" sub="Live data from Arc testnet" />
              <button className="btn btn-ghost btn-sm" onClick={loadStats}
                disabled={statsLoading} style={{ marginBottom: 24 }}>
                {statsLoading ? 'syncing…' : 'refresh'}
              </button>
            </div>

            <div style={{ display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
              <Stat label="Plans"
                value={stats ? stats.totalPlans.toString() : '—'} loading={statsLoading} />
              <Stat label="Subscriptions"
                value={stats ? stats.totalSubs.toString() : '—'} loading={statsLoading} />
              <Stat label="Total credited"
                value={stats ? `$${fmtShort(stats.totalCredited)}` : '—'}
                sub="USDC all time" loading={statsLoading} />
              <Stat label="Vault balance"
                value={stats ? `$${fmtShort(stats.vaultBal)}` : '—'}
                sub="ready to withdraw" loading={statsLoading} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="card">
                <div style={{ fontSize: 10, fontFamily: 'Space Mono, monospace',
                  color: 'var(--gray1)', textTransform: 'uppercase',
                  letterSpacing: '.1em', marginBottom: 16 }}>wallet</div>
                <div style={{ fontFamily: 'Space Mono, monospace', fontSize: 11,
                  color: 'var(--gray1)', marginBottom: 16,
                  wordBreak: 'break-all', lineHeight: 1.8 }}>{address}</div>
                <div className="divider" />
                <div style={{ fontSize: 10, fontFamily: 'Space Mono, monospace',
                  color: 'var(--gray1)', textTransform: 'uppercase',
                  letterSpacing: '.1em', marginBottom: 8 }}>usdc balance</div>
                {statsLoading
                  ? <div className="pulse" style={{ height: 28, width: '50%',
                      background: 'var(--glass2)', borderRadius: 6 }} />
                  : <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.03em' }}>
                      {stats ? fmtShort(stats.usdcBal) : '—'}
                      <span style={{ fontSize: 14, fontWeight: 400,
                        color: 'var(--gray1)', marginLeft: 6 }}>USDC</span>
                    </div>
                }
              </div>

              <div className="card">
                <div style={{ fontSize: 10, fontFamily: 'Space Mono, monospace',
                  color: 'var(--gray1)', textTransform: 'uppercase',
                  letterSpacing: '.1em', marginBottom: 16 }}>contracts</div>
                {[
                  ['Registry', CEKLAR_CONFIG.contracts.registry],
                  ['Vault',    CEKLAR_CONFIG.contracts.vault],
                  ['Pull',     CEKLAR_CONFIG.contracts.pull],
                ].map(([name, addr]) => (
                  <div key={name} style={{ display: 'flex',
                    justifyContent: 'space-between', alignItems: 'center',
                    marginBottom: 14 }}>
                    <span style={{ fontSize: 12, color: 'var(--gray1)' }}>{name}</span>
                    <a href={`${CEKLAR_CONFIG.network.explorer}/address/${addr}`}
                      target="_blank" rel="noreferrer"
                      style={{ fontFamily: 'Space Mono, monospace', fontSize: 11,
                        color: 'var(--white)', opacity: 0.6,
                        transition: 'opacity 200ms ease' }}
                      onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                      onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}>
                      {shortAddr(addr)} ↗
                    </a>
                  </div>
                ))}
                <div className="divider" />
                <div style={{ display: 'flex', justifyContent: 'space-between',
                  fontSize: 11, color: 'var(--gray1)' }}>
                  <span style={{ fontFamily: 'Space Mono, monospace' }}>PROTOCOL FEE</span>
                  <span style={{ color: 'var(--white)' }}>0.75%</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── PLANS ── */}
        {tab === 'plans' && (
          <div className="fade-up">
            <SectionHeader title="Create a plan"
              sub="Deploy a new subscription plan to Arc testnet" />

            <div style={{ maxWidth: 460 }}>
              <div className="card">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  <div>
                    <label>Plan ID</label>
                    <input type="text" placeholder="e.g. pro-monthly"
                      value={planId} onChange={e => setPlanId(e.target.value)} />
                    <div style={{ fontSize: 11, color: 'var(--gray2)',
                      marginTop: 5, fontFamily: 'Space Mono, monospace' }}>
                      lowercase · hyphens only · max 31 chars
                    </div>
                  </div>

                  <div>
                    <label>Price (USDC)</label>
                    <input type="number" placeholder="29"
                      value={planPrice} onChange={e => setPlanPrice(e.target.value)} />
                  </div>

                  <div>
                    <label>Trial days</label>
                    <input type="number" placeholder="0"
                      value={planTrial} onChange={e => setPlanTrial(e.target.value)} />
                  </div>

                  <div className="divider" style={{ margin: '0' }} />

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {[
                      ['Price', `${planPrice || '0'} USDC / month`],
                      ['Protocol fee (0.75%)', `${fee} USDC`],
                      ['You receive', `${netReceive} USDC`],
                    ].map(([k, v], i) => (
                      <div key={k} style={{ display: 'flex',
                        justifyContent: 'space-between', fontSize: 12 }}>
                        <span style={{ color: 'var(--gray1)' }}>{k}</span>
                        <span style={{
                          color: i === 2 ? 'var(--white)' : 'var(--gray1)',
                          fontWeight: i === 2 ? 600 : 400,
                          fontFamily: 'Space Mono, monospace', fontSize: 11 }}>{v}</span>
                      </div>
                    ))}
                  </div>

                  <button className="btn btn-primary"
                    style={{ justifyContent: 'center', padding: '11px 0' }}
                    onClick={createPlan}
                    disabled={creating || !planId || !planPrice}>
                    {creating ? 'deploying to Arc…' : 'Deploy plan →'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── WITHDRAW ── */}
        {tab === 'withdraw' && (
          <div className="fade-up">
            <SectionHeader title="Withdraw revenue"
              sub="Pull USDC from your vault to your wallet instantly" />

            <div style={{ maxWidth: 460 }}>
              <div className="card">
                <div style={{ fontSize: 10, fontFamily: 'Space Mono, monospace',
                  color: 'var(--gray1)', textTransform: 'uppercase',
                  letterSpacing: '.1em', marginBottom: 12 }}>vault balance</div>

                {statsLoading
                  ? <div className="pulse" style={{ height: 48, width: '55%',
                      background: 'var(--glass2)', borderRadius: 6, marginBottom: 20 }} />
                  : <div style={{ marginBottom: 20 }}>
                      <span style={{ fontSize: 48, fontWeight: 700,
                        letterSpacing: '-0.04em', lineHeight: 1 }}>
                        {stats ? fmtShort(stats.vaultBal) : '0.00'}
                      </span>
                      <span style={{ fontSize: 18, color: 'var(--gray1)',
                        marginLeft: 8 }}>USDC</span>
                    </div>
                }

                <div className="divider" />

                <p style={{ fontSize: 12, color: 'var(--gray1)', lineHeight: 1.7,
                  marginBottom: 20 }}>
                  Withdraws your full vault balance to your connected wallet.
                  No minimum. No delay. Credited to your address the moment
                  the transaction confirms on Arc.
                </p>

                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn btn-ghost btn-sm" onClick={loadStats}
                    disabled={statsLoading}>
                    {statsLoading ? 'loading…' : 'refresh'}
                  </button>
                  <button className="btn btn-primary"
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={withdrawAll}
                    disabled={withdrawing || !stats || stats.vaultBal === 0n}>
                    {withdrawing ? 'withdrawing…' : 'Withdraw all →'}
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 16, padding: '14px 16px',
                border: '1px solid var(--border)', borderRadius: 'var(--rm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between',
                  fontSize: 12, color: 'var(--gray1)' }}>
                  <span style={{ fontFamily: 'Space Mono, monospace',
                    fontSize: 10, textTransform: 'uppercase',
                    letterSpacing: '.08em' }}>Total credited (all time)</span>
                  <span style={{ color: 'var(--white)',
                    fontFamily: 'Space Mono, monospace' }}>
                    {stats ? fmt(stats.totalCredited) : '—'} USDC
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}