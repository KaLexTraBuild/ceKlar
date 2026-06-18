# Ceklar — On-Chain Subscription Protocol

The open infrastructure layer for recurring payments on Arc Network. Permissionless, non-custodial, fully autonomous. Think Stripe Billing rebuilt as a public good — no platform risk, no middlemen, no lock-in.

## Deployed Contracts — Arc Testnet (chainId: 5042002)

| Contract | Address |
|---|---|
| SubscriptionRegistry | 0xfe94eAADE67DDFE76c3fd4F0f47b6f0E89E5f4A5 |
| RevenueVault | 0xED6B058FbCd55b43A553a86f8b13aD9C54fbA506 |
| PullPayment | 0x44ffcEFc75e893F11958b3d9f84ec69496331B8F |

Protocol fee: 0.75% per billing cycle.

## How It Works

1. Merchant creates a plan — price, interval, optional trial period
2. Subscriber approves USDC once and subscribes
3. Keeper network fires triggerBilling() automatically when each cycle ends
4. USDC flows: subscriber wallet to protocol fee to merchant vault
5. Merchant withdraws earned revenue anytime, no permission needed

Failed billing opens a 3-day grace window with up to 3 contract-native retries before expiry. The keeper is stateless with respect to retry logic — the contract owns that entirely.

## Structure

    ceklar/              Foundry smart contracts
    ceklar-sdk/          TypeScript SDK
    ceklar-dashboard/    Merchant dashboard (React + Vite)
    ceklar-keeper/       Autonomous billing engine (Node + viem)

## Quickstart

    # Keeper
    cd ceklar-keeper
    npm install
    cp .env.example .env
    npx tsx keeper.ts

    # Contracts
    cd ceklar
    forge install && forge build
    forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast

    # Dashboard
    cd ceklar-dashboard
    npm install
    npm run dev

## License

MIT
