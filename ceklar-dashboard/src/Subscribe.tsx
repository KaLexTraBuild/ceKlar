import { useState, useEffect } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { createPublicClient, createWalletClient, custom, http } from 'viem'
import { CEKLAR_CONFIG } from './ceklar.config'

const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
} as const

const PLAN_ABI = [
  { name: 'getPlan', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'planId', type: 'bytes32' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'id',             type: 'bytes32' },
      { name: 'merchant',       type: 'address' },
      { name: 'price',          type: 'uint256' },
      { name: 'interval',       type: 'uint8'   },
      { name: 'customInterval', type: 'uint256' },
      { name: 'trialDays',      type: 'uint256' },
      { name: 'active',         type: 'bool'    },
      { name: 'createdAt',      type: 'uint256' },
    ]}],
  },
] as const

const PULL_ABI = [
  { name: 'subscribe', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'planId',          type: 'bytes32' },
      { name: 'allowanceAmount', type: 'uint256' },
    ],
    outputs: [{ name: 'subscriptionId', type: 'bytes32' }],
  },
] as const

const USDC_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

const REGISTRY_ABI = [
  { name: 'subscriptionId', type: 'function', stateMutability: 'pure',
    inputs: [
      { name: 'planId',     type: 'bytes32' },
      { name: 'subscriber', type: 'address' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  { name: 'getSubscription', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'subscriptionId', type: 'bytes32' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'planId',        type: 'bytes32' },
      { name: 'subscriber',    type: 'address' },
      { name: 'startedAt',     type: 'uint256' },
      { name: 'trialEndsAt',   type: 'uint256' },
      { name: 'nextBillingAt', type: 'uint256' },
      { name: 'billingCount',  type: 'uint256' },
      { name: 'active',        type: 'bool'    },
      { name: 'paused',        type: 'bool'    },
    ]}],
  },
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────
function encodePlanId(slug: string): `0x${string}` {
  const bytes = new TextEncoder().encode(slug)
  const padded = new Uint8Array(32)
  padded.set(bytes)
  return ('0x' + Array.from(padded)
    .map(b => b.toString(16).padStart(2,'0')).join('')) as `0x${string}`
}

function decodePlanId(hex: string): string {
  let result = ''
  for (let i = 2; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16)
    if (byte === 0) break
    result += String.fromCharCode(byte)
  }
  return result
}

const INTERVALS = ['Monthly', 'Quarterly', 'Yearly', 'Custom']
const short     = (a: string) => a.slice(0,6) + '…' + a.slice(-4)
const fmtUSDC   = (n: bigint) => (Number(n) / 1_000_000).toFixed(2)

const pc = createPublicClient({
  chain: arcTestnet,
  transport: http(CEKLAR_CONFIG.network.rpcUrl),
})

// ── Logo — white mark, black background ───────────────────────────────────────
function Logo({ size = 28 }: { size?: number }) {
  return (
    <div style={{
      width: size, height: size,
      borderRadius: Math.round(size * 0.25),
      background: 'var(--white)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
      boxShadow: '0 0 0 1px rgba(255,255,255,0.15)',
    }}>
      <svg viewBox="0 0 20 20" fill="none"
        width={size * 0.58} height={size * 0.58}>
        <path d="M14 4.5A7 7 0 1 0 14 15.5L14 12.5A4 4 0 1 1 14 7.5Z"
          fill="#0A0A0A"/>
        <rect x="11" y="8" width="6" height="6" rx="1.5"
          fill="#0A0A0A" opacity="0.35"/>
      </svg>
    </div>
  )
}

// ── Step indicator ─────────────────────────────────────────────────────────────
function Steps({ current }: { current: number }) {
  const steps = ['Connect', 'Review', 'Subscribe', 'Done']
  return (
    <div style={{ display: 'flex', alignItems: 'center',
      gap: 0, marginBottom: 32 }}>
      {steps.map((s, i) => (
        <div key={s} style={{ display: 'flex', alignItems: 'center',
          flex: i < steps.length - 1 ? 1 : 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
              background: i < current
                ? 'var(--white)'
                : i === current
                  ? 'rgba(255,255,255,0.08)'
                  : 'var(--bg3)',
              border: i === current
                ? '1px solid rgba(255,255,255,0.4)'
                : i < current
                  ? '1px solid var(--white)'
                  : '1px solid var(--border)',
              color: i < current
                ? 'var(--black)'
                : i === current
                  ? 'var(--white)'
                  : 'var(--gray2)',
              transition: 'all 300ms ease',
            }}>
              {i < current ? '✓' : i + 1}
            </div>
            <span style={{
              fontSize: 10,
              color: i <= current ? 'var(--white)' : 'var(--gray2)',
              fontFamily: 'Space Mono, monospace',
              whiteSpace: 'nowrap',
              transition: 'color 300ms ease',
            }}>{s}</span>
          </div>
          {i < steps.length - 1 && (
            <div style={{
              flex: 1, height: 1, marginBottom: 18,
              background: i < current
                ? 'rgba(255,255,255,0.4)'
                : 'var(--border)',
              transition: 'background 300ms ease',
            }}/>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Main Subscribe page ────────────────────────────────────────────────────────
export default function Subscribe() {
  const { address, isConnected } = useAccount()
  const { connect }    = useConnect()
  const { disconnect } = useDisconnect()

  const PLAN_SLUG = 'basic-instant'

  const [step, setStep]               = useState(0)
  const [plan, setPlan]               = useState<any>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [usdcBal, setUsdcBal]         = useState<bigint>(0n)
  const [usdcAllowance, setUsdcAllowance] = useState<bigint>(0n)
  const [approving, setApproving]     = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  const [error, setError]             = useState('')
  const [txHash, setTxHash]           = useState('')
  const [subId, setSubId]             = useState('')
  const [subData, setSubData]         = useState<any>(null)

  useEffect(() => {
    async function load() {
      setPlanLoading(true)
      try {
        const raw = await pc.readContract({
          address: CEKLAR_CONFIG.contracts.registry as `0x${string}`,
          abi: PLAN_ABI,
          functionName: 'getPlan',
          args: [encodePlanId(PLAN_SLUG)],
        }) as any
        setPlan(raw)
      } catch (e: any) {
        setError('Could not load plan: ' + e.message)
      } finally {
        setPlanLoading(false)
      }
    }
    load()
  }, [])

  useEffect(() => {
    if (!isConnected || !address) return
    async function loadWallet() {
      const [bal, allowance] = await Promise.all([
        pc.readContract({
          address: CEKLAR_CONFIG.usdc as `0x${string}`,
          abi: USDC_ABI, functionName: 'balanceOf', args: [address!],
        }) as Promise<bigint>,
        pc.readContract({
          address: CEKLAR_CONFIG.usdc as `0x${string}`,
          abi: USDC_ABI, functionName: 'allowance',
          args: [address!, CEKLAR_CONFIG.contracts.pull as `0x${string}`],
        }) as Promise<bigint>,
      ])
      setUsdcBal(bal)
      setUsdcAllowance(allowance)
    }
    loadWallet()
    if (step === 0) setStep(1)
  }, [isConnected, address])

  async function approveUSDC() {
    if (!plan) return
    setApproving(true); setError('')
    try {
      const wc = createWalletClient({ chain: arcTestnet,
        transport: custom((window as any).ethereum) })
      const [acct] = await wc.getAddresses()
      const approvalAmount = plan.price * 13n
      const hash = await wc.writeContract({
        account: acct,
        address: CEKLAR_CONFIG.usdc as `0x${string}`,
        abi: USDC_ABI, functionName: 'approve',
        args: [CEKLAR_CONFIG.contracts.pull as `0x${string}`, approvalAmount],
      })
      await pc.waitForTransactionReceipt({ hash })
      setUsdcAllowance(approvalAmount)
    } catch (e: any) { setError(e.message) }
    finally { setApproving(false) }
  }

  async function handleSubscribe() {
    if (!plan || !address) return
    setSubscribing(true); setError('')
    try {
      const wc = createWalletClient({ chain: arcTestnet,
        transport: custom((window as any).ethereum) })
      const [acct] = await wc.getAddresses()
      const approvalAmount = plan.price * 13n

      if (usdcAllowance < plan.price) {
        const ah = await wc.writeContract({
          account: acct,
          address: CEKLAR_CONFIG.usdc as `0x${string}`,
          abi: USDC_ABI, functionName: 'approve',
          args: [CEKLAR_CONFIG.contracts.pull as `0x${string}`, approvalAmount],
        })
        await pc.waitForTransactionReceipt({ hash: ah })
        setUsdcAllowance(approvalAmount)
      }

      const hash = await wc.writeContract({
        account: acct,
        address: CEKLAR_CONFIG.contracts.pull as `0x${string}`,
        abi: PULL_ABI, functionName: 'subscribe',
        args: [encodePlanId(PLAN_SLUG), approvalAmount],
      })
      await pc.waitForTransactionReceipt({ hash })
      setTxHash(hash)

      const id = await pc.readContract({
        address: CEKLAR_CONFIG.contracts.registry as `0x${string}`,
        abi: REGISTRY_ABI, functionName: 'subscriptionId',
        args: [encodePlanId(PLAN_SLUG), address],
      }) as string
      setSubId(id)

      const sub = await pc.readContract({
        address: CEKLAR_CONFIG.contracts.registry as `0x${string}`,
        abi: REGISTRY_ABI, functionName: 'getSubscription',
        args: [id as `0x${string}`],
      }) as any
      setSubData(sub)
      setStep(3)

    } catch (e: any) { setError(e.message) }
    finally { setSubscribing(false) }
  }

  const hasEnough  = plan ? usdcBal >= plan.price : false
  const isApproved = plan ? usdcAllowance >= plan.price : false
  const fee        = plan ? Number(plan.price) / 1_000_000 * 0.0075 : 0
  const net        = plan ? Number(plan.price) / 1_000_000 * 0.9925 : 0

  // ── shared card style ──
  const cardStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 12,
    padding: 24,
  }

  const innerCardStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 8,
    padding: '12px 14px',
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '40px 20px',
    }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10,
        marginBottom: 40 }}>
        <Logo size={32}/>
        <span style={{ fontSize: 16, fontWeight: 700,
          letterSpacing: '-0.02em', color: 'var(--white)' }}>ceklar</span>
        <span style={{ fontSize: 11, color: 'var(--gray2)',
          fontFamily: 'Space Mono, monospace' }}>/ subscribe</span>
      </div>

      <div style={{ width: '100%', maxWidth: 440 }}>

        <Steps current={step}/>

        {error && (
          <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>
        )}

        {/* ── STEP 0 — Connect wallet ── */}
        {step === 0 && (
          <div style={cardStyle} className="fade-up">
            {planLoading ? (
              <div style={{ padding: '20px 0', textAlign: 'center' }}>
                <div className="pulse" style={{ height: 20, width: '60%',
                  background: 'rgba(255,255,255,0.06)', borderRadius: 4,
                  margin: '0 auto 10px' }}/>
                <div className="pulse" style={{ height: 14, width: '40%',
                  background: 'rgba(255,255,255,0.06)', borderRadius: 4,
                  margin: '0 auto' }}/>
              </div>
            ) : plan ? (
              <>
                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                  <div style={{ fontSize: 10, color: 'var(--gray1)',
                    fontFamily: 'Space Mono, monospace', textTransform: 'uppercase',
                    letterSpacing: '.1em', marginBottom: 10 }}>
                    {decodePlanId(plan.id)}
                  </div>
                  <div style={{ fontSize: 44, fontWeight: 700,
                    letterSpacing: '-0.04em', color: 'var(--white)',
                    lineHeight: 1, marginBottom: 6 }}>
                    ${fmtUSDC(plan.price)}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--gray1)' }}>
                    per {INTERVALS[plan.interval]?.toLowerCase() ?? 'cycle'}
                    {Number(plan.trialDays) > 0 &&
                      ` · ${plan.trialDays}-day free trial`}
                  </div>
                </div>
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)',
                  margin: '0 0 20px' }}/>
              </>
            ) : null}

            <p style={{ fontSize: 13, color: 'var(--gray1)',
              marginBottom: 20, lineHeight: 1.6, textAlign: 'center' }}>
              Connect your wallet to subscribe. Approve USDC once —
              billing runs automatically every cycle.
            </p>

            <button className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '12px 0' }}
              onClick={() => connect({ connector: injected() })}>
              Connect Wallet
            </button>

            <div style={{ marginTop: 14, textAlign: 'center',
              fontSize: 11, color: 'var(--gray2)',
              fontFamily: 'Space Mono, monospace' }}>
              Arc Testnet · chainId 5042002
            </div>
          </div>
        )}

        {/* ── STEP 1 — Review plan ── */}
        {step === 1 && plan && (
          <div style={cardStyle} className="fade-up">
            <div style={{ fontSize: 10, color: 'var(--gray1)',
              fontFamily: 'Space Mono, monospace', textTransform: 'uppercase',
              letterSpacing: '.1em', marginBottom: 16 }}>plan details</div>

            <div style={{ display: 'flex', alignItems: 'baseline',
              gap: 8, marginBottom: 24 }}>
              <span style={{ fontSize: 44, fontWeight: 700,
                letterSpacing: '-0.04em', color: 'var(--white)', lineHeight: 1 }}>
                ${fmtUSDC(plan.price)}
              </span>
              <span style={{ fontSize: 14, color: 'var(--gray1)' }}>
                USDC / {INTERVALS[plan.interval]?.toLowerCase()}
              </span>
            </div>

            {[
              ['Plan',     decodePlanId(plan.id)],
              ['Merchant', short(plan.merchant)],
              ['Trial',    Number(plan.trialDays) > 0
                ? `${plan.trialDays} days free` : 'None'],
              ['Status',   plan.active ? 'Active' : 'Paused'],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', padding: '9px 0',
                borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ fontSize: 12, color: 'var(--gray1)' }}>{k}</span>
                <span style={{ fontSize: 12, color: 'var(--white)',
                  fontFamily: 'Space Mono, monospace' }}>{v}</span>
              </div>
            ))}

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)',
              margin: '20px 0 14px' }}/>

            <div style={{ fontSize: 10, color: 'var(--gray1)',
              fontFamily: 'Space Mono, monospace', textTransform: 'uppercase',
              letterSpacing: '.1em', marginBottom: 12 }}>your wallet</div>

            {[
              ['Address',      short(address!)],
              ['USDC balance', `${fmtUSDC(usdcBal)} USDC`],
              ['Approved',     isApproved ? 'Yes' : 'Not yet'],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', padding: '9px 0',
                borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ fontSize: 12, color: 'var(--gray1)' }}>{k}</span>
                <span style={{ fontSize: 12,
                  color: k === 'Approved' && !isApproved
                    ? '#FF6B6B' : 'var(--white)',
                  fontFamily: 'Space Mono, monospace' }}>{v}</span>
              </div>
            ))}

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)',
              margin: '20px 0 14px' }}/>

            <div style={{ ...innerCardStyle, marginBottom: 16 }}>
              {[
                ['You pay',           `${fmtUSDC(plan.price)} USDC`],
                ['Protocol fee',      `${fee.toFixed(4)} USDC`],
                ['Merchant receives', `${net.toFixed(4)} USDC`],
              ].map(([k, v], i) => (
                <div key={k} style={{ display: 'flex',
                  justifyContent: 'space-between', marginBottom: i < 2 ? 7 : 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--gray1)' }}>{k}</span>
                  <span style={{ fontSize: 11, fontFamily: 'Space Mono, monospace',
                    color: 'var(--white)' }}>{v}</span>
                </div>
              ))}
            </div>

            {!hasEnough && (
              <div className="error-box" style={{ marginBottom: 12 }}>
                Insufficient USDC. Need at least ${fmtUSDC(plan.price)}.
                Get testnet USDC at faucet.circle.com
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost btn-sm"
                onClick={() => disconnect()}>Disconnect</button>
              <button className="btn btn-primary"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => setStep(2)}
                disabled={!hasEnough || !plan.active}>
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2 — Approve + Subscribe ── */}
        {step === 2 && plan && (
          <div style={cardStyle} className="fade-up">
            <div style={{ fontSize: 10, color: 'var(--gray1)',
              fontFamily: 'Space Mono, monospace', textTransform: 'uppercase',
              letterSpacing: '.1em', marginBottom: 20 }}>confirm subscription</div>

            <div style={{ ...innerCardStyle, marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600,
                  color: 'var(--white)' }}>
                  {decodePlanId(plan.id)}
                </span>
                <span style={{ fontSize: 20, fontWeight: 700,
                  color: 'var(--white)', fontFamily: 'Space Mono, monospace' }}>
                  ${fmtUSDC(plan.price)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--gray1)', lineHeight: 1.6 }}>
                Billed {INTERVALS[plan.interval]?.toLowerCase()}.
                {Number(plan.trialDays) > 0
                  ? ` First ${plan.trialDays} days free.`
                  : ' First payment charged immediately.'}
                {' '}Cancel any time on-chain.
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column',
              gap: 8, marginBottom: 20 }}>

              {/* Approve step */}
              <div style={{
                padding: '12px 14px', borderRadius: 8,
                border: `1px solid ${isApproved
                  ? 'rgba(255,255,255,0.2)'
                  : 'rgba(255,255,255,0.08)'}`,
                background: isApproved
                  ? 'rgba(255,255,255,0.06)'
                  : 'rgba(255,255,255,0.03)',
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', gap: 12,
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2,
                    color: 'var(--white)' }}>
                    {isApproved ? '✓ ' : '1. '}Approve USDC
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--gray1)' }}>
                    Allow Ceklar to pull recurring payments
                  </div>
                </div>
                {!isApproved && (
                  <button className="btn btn-primary btn-sm"
                    onClick={approveUSDC} disabled={approving}
                    style={{ flexShrink: 0 }}>
                    {approving ? 'Approving…' : 'Approve'}
                  </button>
                )}
              </div>

              {/* Subscribe step */}
              <div style={{
                padding: '12px 14px', borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.03)',
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', gap: 12,
                opacity: isApproved ? 1 : 0.4,
                transition: 'opacity 300ms ease',
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600,
                    marginBottom: 2, color: 'var(--white)' }}>
                    2. Subscribe
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--gray1)' }}>
                    Create your on-chain subscription
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost btn-sm"
                onClick={() => setStep(1)}>← Back</button>
              <button className="btn btn-primary"
                style={{ flex: 1, justifyContent: 'center', padding: '11px 0' }}
                onClick={handleSubscribe}
                disabled={subscribing || !isApproved}>
                {subscribing
                  ? 'Confirming on Arc…'
                  : `Subscribe — $${fmtUSDC(plan.price)} USDC`}
              </button>
            </div>

            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--gray2)',
              textAlign: 'center', lineHeight: 1.5 }}>
              By subscribing you authorize Ceklar to charge ${fmtUSDC(plan.price)} USDC
              every {INTERVALS[plan.interval]?.toLowerCase()}.
              Your USDC stays in your wallet until billing date.
            </div>
          </div>
        )}

        {/* ── STEP 3 — Confirmed ── */}
        {step === 3 && subData && (
          <div style={{ ...cardStyle, textAlign: 'center' }} className="fade-up">
            <div style={{ display: 'flex', justifyContent: 'center',
              marginBottom: 20, position: 'relative' }}>
              <div style={{
                position: 'absolute', width: 80, height: 80,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%)',
              }}/>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 22, color: 'var(--white)', zIndex: 1,
              }}>✓</div>
            </div>

            <h2 style={{ fontSize: 20, fontWeight: 700,
              letterSpacing: '-0.02em', marginBottom: 6,
              color: 'var(--white)' }}>Subscribed</h2>

            <p style={{ fontSize: 13, color: 'var(--gray1)',
              marginBottom: 24, lineHeight: 1.6 }}>
              Your subscription is live on Arc testnet.
              {Number(subData.trialEndsAt) > 0
                ? ` Free trial ends ${new Date(Number(subData.trialEndsAt) * 1000)
                    .toLocaleDateString()}.`
                : ' First payment has been processed.'}
            </p>

            <div style={{ ...innerCardStyle, marginBottom: 20, textAlign: 'left' }}>
              {[
                ['Subscription ID', subId.slice(0,10) + '…'],
                ['Plan',            decodePlanId(plan?.id ?? '')],
                ['Next billing',    new Date(Number(subData.nextBillingAt) * 1000)
                  .toLocaleDateString()],
                ['Status',          'Active'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex',
                  justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--gray1)' }}>{k}</span>
                  <span style={{ fontSize: 11, fontFamily: 'Space Mono, monospace',
                    color: 'var(--white)' }}>{v}</span>
                </div>
              ))}
            </div>

            <a href={`${CEKLAR_CONFIG.network.explorer}/tx/${txHash}`}
              target="_blank" rel="noreferrer"
              className="btn btn-ghost"
              style={{ width: '100%', justifyContent: 'center',
                display: 'flex', marginBottom: 12 }}>
              View on ArcScan ↗
            </a>

            <div style={{ fontSize: 11, color: 'var(--gray2)',
              fontFamily: 'Space Mono, monospace' }}>
              powered by ceklar · arc network
            </div>
          </div>
        )}

      </div>
    </div>
  )
}