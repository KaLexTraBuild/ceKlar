import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  defineChain,
  formatEther,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ─── Chain ────────────────────────────────────────────────────────────────────
const arc = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL!] } },
})

// ─── Contracts ────────────────────────────────────────────────────────────────
const REGISTRY = '0xfe94eAADE67DDFE76c3fd4F0f47b6f0E89E5f4A5' as Hex
const PULL     = '0x44ffcEFc75e893F11958b3d9f84ec69496331B8F' as Hex

// ─── Clients ──────────────────────────────────────────────────────────────────
const account = privateKeyToAccount(`0x${process.env.KEEPER_KEY!}` as Hex)
const pub      = createPublicClient({ chain: arc, transport: http(process.env.RPC_URL!) })
const wallet   = createWalletClient({ account, chain: arc, transport: http(process.env.RPC_URL!) })

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const EV_CREATED   = parseAbi(['event SubscriptionCreated(bytes32 indexed subscriptionId, bytes32 indexed planId, address indexed subscriber, uint256 trialEndsAt, uint256 nextBillingAt)'])[0]
const EV_CANCELLED = parseAbi(['event SubscriptionCancelled(bytes32 indexed subscriptionId, address indexed subscriber)'])[0]
const EV_EXPIRED   = parseAbi(['event SubscriptionExpired(bytes32 indexed subscriptionId, address indexed subscriber)'])[0]
const FN_DUE       = parseAbi(['function isBillingDue(bytes32 subscriptionId) view returns (bool)'])
const FN_BILL      = parseAbi(['function triggerBilling(bytes32 subscriptionId) external'])

// ─── State ────────────────────────────────────────────────────────────────────
// Persisted to disk so we never re-scan from genesis
const STATE_FILE = './keeper-state.json'

interface State {
  lastBlock: string    // stored as string — bigint doesn't JSON-serialize
  known:     string[]  // all subscription IDs ever seen
  dead:      string[]  // cancelled + expired — skip these
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) return { lastBlock: '0', known: [], dead: [] }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}

function saveState(s: State) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

// ─── Utils ────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const CHUNK = 9000n // block range per getLogs call — keeps RPC happy

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`)
}

// ─── Event Scanner ────────────────────────────────────────────────────────────
// Scans logs incrementally from last known block. Single source of truth for
// which subscriptions exist and which are dead.
async function syncEvents(state: State): Promise<State> {
  const latest = await pub.getBlockNumber()
  const from   = BigInt(state.lastBlock)

  if (from >= latest) return state

  const known = new Set(state.known)
  const dead  = new Set(state.dead)

  for (let start = from; start <= latest; start += CHUNK) {
    const end = start + CHUNK - 1n < latest ? start + CHUNK - 1n : latest

    const [created, cancelled, expired] = await Promise.all([
      pub.getLogs({ address: REGISTRY, event: EV_CREATED,   fromBlock: start, toBlock: end }),
      pub.getLogs({ address: REGISTRY, event: EV_CANCELLED, fromBlock: start, toBlock: end }),
      pub.getLogs({ address: PULL,     event: EV_EXPIRED,   fromBlock: start, toBlock: end }),
    ])

    for (const e of created)   { const id = (e.args as any).subscriptionId; if (id) known.add(id) }
    for (const e of cancelled) { const id = (e.args as any).subscriptionId; if (id) dead.add(id)  }
    for (const e of expired)   { const id = (e.args as any).subscriptionId; if (id) dead.add(id)  }
  }

  const next: State = {
    lastBlock: latest.toString(),
    known:     [...known],
    dead:      [...dead],
  }

  saveState(next)
  return next
}

// ─── Due Filter ───────────────────────────────────────────────────────────────
// Single multicall round-trip — doesn't matter if we have 10 or 10,000 subs
async function getDue(state: State): Promise<Hex[]> {
  const deadSet = new Set(state.dead)
  const active  = state.known.filter(id => !deadSet.has(id)) as Hex[]
  if (active.length === 0) return []

  const results = await Promise.all(
    active.map(id =>
      pub.readContract({
        address:      REGISTRY,
        abi:          FN_DUE,
        functionName: 'isBillingDue',
        args:         [id],
      }).then(due => ({ id, due })).catch(() => ({ id, due: false }))
    )
  )

  return results.filter(r => r.due).map(r => r.id)
}


// ─── Executor ─────────────────────────────────────────────────────────────────
// Contract handles grace periods and retry counts internally.
// Keeper fires once per cycle — clean separation of concerns.
async function bill(id: Hex): Promise<{ ok: boolean; hash?: string; err?: string }> {
  try {
    const hash    = await wallet.writeContract({ address: PULL, abi: FN_BILL, functionName: 'triggerBilling', args: [id] })
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 })
    return { ok: receipt.status === 'success', hash }
  } catch (e: any) {
    return { ok: false, err: e.shortMessage ?? e.message?.slice(0, 100) }
  }
}

// ─── Gas Guard ────────────────────────────────────────────────────────────────
async function checkGas() {
  const bal = await pub.getBalance({ address: account.address })
  if (bal < BigInt(5e15)) throw new Error(`Low gas: ${formatEther(bal)} ARC — top up keeper wallet`)
  log('GAS', `${formatEther(bal)} ARC`)
}

// ─── Cycle ────────────────────────────────────────────────────────────────────
async function cycle(state: State): Promise<State> {
  console.log('\n' + '─'.repeat(56))

  await checkGas()

  // Sync new events since last run
  log('SYNC', `From block ${state.lastBlock}...`)
  const updated = await syncEvents(state)
  const deadSet = new Set(updated.dead)
  const active  = updated.known.filter(id => !deadSet.has(id)).length
  log('SYNC', `${updated.known.length} total | ${active} active | ${updated.dead.length} dead`)

  // Find what's due
  const due = await getDue(updated)

  if (due.length === 0) {
    log('SCAN', 'Nothing due. All subscriptions current.')
    return updated
  }

  log('SCAN', `${due.length} due for billing — executing`)

  // Bill sequentially — same wallet, same nonce sequence.
  // Parallel calls here cause nonce collisions and silent failures.
  const results: { status: 'fulfilled' | 'rejected'; value?: any; reason?: any }[] = []
  for (const id of due) {
    try {
      const r = await bill(id)
      results.push({ status: 'fulfilled', value: r })
    } catch (e) {
      results.push({ status: 'rejected', reason: e })
    }
  }

  let passed = 0, failed = 0
  results.forEach((r, i) => {
    const short = due[i].slice(0, 10) + '...'
    if (r.status === 'fulfilled' && r.value.ok) {
      log('BILL ✓', `${short} → ${r.value.hash}`)
      passed++
    } else {
      const err = r.status === 'fulfilled' ? r.value.err : r.reason
      log('BILL ✗', `${short} → ${err}`)
      failed++
    }
  })

  log('CYCLE', `Done — ${passed} billed, ${failed} failed`)
  return updated
}

// ─── Entry ────────────────────────────────────────────────────────────────────
const POLL_MS = Number(process.env.INTERVAL_MS ?? 60_000)

async function main() {
  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║         CEKLAR KEEPER v2.0.0                     ║')
  console.log('║   Event-driven billing engine — Arc Testnet      ║')
  console.log('╚══════════════════════════════════════════════════╝')
  log('BOOT', `Keeper  : ${account.address}`)
  log('BOOT', `Poll    : ${POLL_MS / 1000}s`)
  log('BOOT', `Registry: ${REGISTRY}`)
  log('BOOT', `Pull    : ${PULL}`)

  let state = loadState()
  log('BOOT', `State   : block ${state.lastBlock} | ${state.known.length} known subs`)

  while (true) {
    try { state = await cycle(state) }
    catch (e: any) { log('ERROR', e.message) }
    await sleep(POLL_MS)
  }
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1) })
