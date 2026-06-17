# Ceklar — On-Chain Subscription Protocol

The open infrastructure layer for recurring payments on Arc Network. Permissionless, non-custodial, fully autonomous. Think Stripe Billing rebuilt as a public good — no platform risk, no middlemen, no lock-in.

## Deployed Contracts — Arc Testnet (chainId: 5042002)

| Contract | Address |
|---|---|
| SubscriptionRegistry | 0x324Dc43ECCBE15a5899fB8EB7F3aE10b5972f36b |
| RevenueVault | 0x65a02A59F1879509b8d0BcBa032CD7e707Cf00A9 |
| PullPayment | 0x5f5C2cA1EbFEDc56D67aD7e9d336140A56513B77 |

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
