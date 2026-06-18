// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/SubscriptionRegistry.sol";
import "../src/RevenueVault.sol";
import "../src/PullPayment.sol";

contract DeployCeklar is Script {

    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 deployerKey  = vm.envUint("PRIVATE_KEY");
        address deployerAddr = vm.envAddress("DEPLOYER_ADDRESS");

        vm.startBroadcast(deployerKey);

        // 1. Deploy Registry
        SubscriptionRegistry registry = new SubscriptionRegistry();
        console.log("SubscriptionRegistry:", address(registry));

        // 2. Deploy Vault
        RevenueVault vault = new RevenueVault(ARC_USDC);
        console.log("RevenueVault:        ", address(vault));

        // 3. Deploy PullPayment
        PullPayment pull = new PullPayment(
            ARC_USDC,
            address(registry),
            address(vault),
            deployerAddr
        );
        console.log("PullPayment:         ", address(pull));

        // 4. Wire vault and registry to PullPayment
        vault.setPullPayment(address(pull));
        console.log("Vault wired: OK");

        registry.setPullPayment(address(pull));
        console.log("Registry wired: OK");

        vm.stopBroadcast();

        console.log("\n=== CEKLAR DEPLOYED ON ARC TESTNET ===");
        console.log("Registry: ", address(registry));
        console.log("Vault:    ", address(vault));
        console.log("Pull:     ", address(pull));
        console.log("======================================");
    }
}
