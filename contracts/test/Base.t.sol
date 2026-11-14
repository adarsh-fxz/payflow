// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrganizationRegistry} from "../src/OrganizationRegistry.sol";
import {PayrollEscrow} from "../src/PayrollEscrow.sol";
import {IPayrollEscrow} from "../src/interfaces/IPayrollEscrow.sol";
import {MockMUSD} from "./mocks/MockMUSD.sol";

abstract contract Base is Test {
    OrganizationRegistry internal reg;
    PayrollEscrow internal esc;
    MockMUSD internal musd;

    address internal platform = makeAddr("platform");
    address internal owner = makeAddr("owner");
    address internal admin = makeAddr("admin");
    address internal approver = makeAddr("approver");
    address internal approver2 = makeAddr("approver2");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal orgId;
    uint32 internal constant WINDOW = 30 days;

    function setUp() public virtual {
        musd = new MockMUSD();
        reg = new OrganizationRegistry();
        esc = new PayrollEscrow(address(musd), address(reg), platform);

        vm.startPrank(owner);
        orgId = reg.createOrganization(keccak256("acme"));
        reg.setMemberRoles(orgId, admin, reg.ROLE_ADMIN());
        reg.setMemberRoles(orgId, approver, reg.ROLE_APPROVER());
        reg.setMemberRoles(orgId, approver2, reg.ROLE_APPROVER());
        reg.setMemberRoles(orgId, operator, reg.ROLE_OPERATOR());
        vm.stopPrank();

        musd.mint(admin, 1_000_000e18);
        musd.mint(owner, 1_000_000e18);
        vm.prank(admin);
        musd.approve(address(esc), type(uint256).max);
        vm.prank(owner);
        musd.approve(address(esc), type(uint256).max);
    }

    function _three() internal view returns (address[] memory r, uint128[] memory a) {
        r = new address[](3);
        a = new uint128[](3);
        (r[0], r[1], r[2]) = (alice, bob, carol);
        (a[0], a[1], a[2]) = (500e18, 750e18, 250e18);
    }

    function _draft(bytes32 ref) internal returns (uint256 runId) {
        vm.prank(operator);
        runId = esc.createRun(orgId, ref, WINDOW);
        (address[] memory r, uint128[] memory a) = _three();
        vm.prank(operator);
        esc.addPayments(runId, 0, r, a);
    }

    function _approved(bytes32 ref) internal returns (uint256 runId) {
        runId = _draft(ref);
        vm.prank(operator);
        esc.submitForApproval(runId);
        bytes32 h = esc.getRun(runId).paymentsHash;
        vm.prank(approver);
        esc.approve(runId, h);
    }

    function _funded(bytes32 ref) internal returns (uint256 runId) {
        runId = _approved(ref);
        vm.prank(admin);
        esc.fund(runId);
    }

    function _published(bytes32 ref) internal returns (uint256 runId) {
        runId = _funded(ref);
        vm.prank(admin);
        esc.publish(runId);
    }

    function _pid(uint256 runId, uint32 index) internal pure returns (uint256) {
        return (runId << 32) | uint256(index);
    }

    function _approveAs(PayrollEscrow e, address who, uint256 runId) internal {
        bytes32 h = e.getRun(runId).paymentsHash;
        vm.prank(who);
        e.approve(runId, h);
    }

    function _status(uint256 runId) internal view returns (IPayrollEscrow.RunStatus) {
        return esc.getRun(runId).status;
    }
}
