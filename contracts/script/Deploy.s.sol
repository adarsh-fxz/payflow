// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OrganizationRegistry} from "../src/OrganizationRegistry.sol";
import {PayrollEscrow} from "../src/PayrollEscrow.sol";

/// forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --legacy
/// Env: DEPLOYER_PRIVATE_KEY, MUSD_ADDRESS (defaults to verified testnet MUSD), PLATFORM_ADMIN (defaults to deployer)
contract Deploy is Script {
    address constant MUSD_TESTNET = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address musd = vm.envOr("MUSD_ADDRESS", MUSD_TESTNET);
        address platformAdmin = vm.envOr("PLATFORM_ADMIN", deployer);

        if (block.chainid == 31611) {
            require(musd == MUSD_TESTNET, "testnet must use the verified MUSD");
            require(musd.code.length > 0, "MUSD has no code");
        }

        vm.startBroadcast(pk);
        OrganizationRegistry registry = new OrganizationRegistry();
        PayrollEscrow escrow = new PayrollEscrow(musd, address(registry), platformAdmin);
        vm.stopBroadcast();

        console2.log("registry", address(registry));
        console2.log("escrow  ", address(escrow));
        console2.log("musd    ", musd);
        console2.log("block   ", block.number);

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "musd", musd);
        vm.serializeAddress(key, "registry", address(registry));
        vm.serializeAddress(key, "escrow", address(escrow));
        vm.serializeAddress(key, "platformAdmin", platformAdmin);
        string memory json = vm.serializeUint(key, "block", block.number);
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
