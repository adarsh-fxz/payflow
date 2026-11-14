// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {IPayrollEscrow} from "../src/interfaces/IPayrollEscrow.sol";
import {IOrganizationRegistry} from "../src/interfaces/IOrganizationRegistry.sol";

/// Regression tests for the Nov 2026 independent audit. Each test reproduces an attack or
/// edge case the auditors demonstrated and asserts it is now blocked.
contract AuditRegressions is Base {
    function _accomplicePayRun(address payee, uint128 amount, bytes32 ref) internal returns (uint256 runId) {
        vm.prank(admin);
        runId = esc.createRun(orgId, ref, WINDOW);
        address[] memory r = new address[](1);
        uint128[] memory a = new uint128[](1);
        (r[0], a[0]) = (payee, amount);
        vm.prank(admin);
        esc.addPayments(runId, 0, r, a);
        vm.prank(admin);
        esc.submitForApproval(runId);
    }

    /// C1: an admin could mint throwaway approvers and approve their own run.
    function test_adminCannotMintApprovers() public {
        vm.prank(owner);
        reg.setApprovalsRequired(orgId, 3);
        address sock = makeAddr("sock");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotOwner.selector, orgId, admin));
        reg.setMemberRoles(orgId, sock, 2);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotOwner.selector, orgId, admin));
        reg.setMemberRoles(orgId, sock, uint8(6));
    }

    /// C1b: an admin could strip the real approvers.
    function test_adminCannotRevokeApprovers() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotOwner.selector, orgId, admin));
        reg.setMemberRoles(orgId, approver, 0);
        assertEq(reg.rolesOf(orgId, approver), reg.ROLE_APPROVER());
    }

    /// C2: an approval kept counting after the approver's role was revoked.
    function test_revokedApprovalBlocksFunding() public {
        vm.prank(owner);
        reg.setApprovalsRequired(orgId, 2);
        uint256 runId = _accomplicePayRun(stranger, 100e18, "c2");
        _approveAs(esc, approver, runId);
        _approveAs(esc, approver2, runId);
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.Approved));
        vm.prank(owner);
        reg.setMemberRoles(orgId, approver2, 0);
        assertEq(esc.validApprovals(runId), 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.ApprovalsRevoked.selector, runId, uint8(1), uint8(2)));
        esc.fund(runId);
        // restoring the role restores the approval
        vm.prank(owner);
        reg.setMemberRoles(orgId, approver2, 2);
        vm.prank(admin);
        esc.fund(runId);
    }

    /// C2c: a removed approver's earlier approval doesn't count toward the threshold.
    function test_revokedApproverNotCountedAtApproval() public {
        vm.prank(owner);
        reg.setApprovalsRequired(orgId, 2);
        uint256 runId = _accomplicePayRun(alice, 1e18, "c2c");
        _approveAs(esc, approver, runId);
        vm.prank(owner);
        reg.setMemberRoles(orgId, approver, 0);
        _approveAs(esc, approver2, runId);
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.PendingApproval));
        assertEq(esc.getRun(runId).approvals, 1);
    }

    /// C2b: approvals given before returnToDraft are forgotten.
    function test_approverListResetsOnReturnToDraft() public {
        uint256 runId = _accomplicePayRun(alice, 1e18, "c2b");
        _approveAs(esc, approver, runId);
        assertEq(esc.approversOf(runId).length, 1);
        vm.prank(admin); // the run is Approved now, so only an admin can send it back
        esc.returnToDraft(runId);
        assertEq(esc.approversOf(runId).length, 0);
    }

    /// C3: after funding, an admin cancelled approved payments, refunded and published a different list.
    function test_fundedRunListIsFrozen() public {
        uint256 runId = _funded("c3");
        bytes32 approvedHash = esc.getRun(runId).paymentsHash;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.Funded));
        esc.cancelPayment(_pid(runId, 0));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NothingToRefund.selector, runId));
        esc.refund(runId);
        vm.prank(admin);
        esc.publish(runId);
        assertEq(esc.getRun(runId).paymentsHash, approvedHash);
        assertEq(esc.liability(runId), 1500e18);
    }

    /// Expiry no longer depends on an org admin showing up.
    function test_anyoneCanExpireAfterDeadlineOnly() public {
        uint256 runId = _published("exp");
        uint64 dl = esc.getRun(runId).claimDeadline;
        vm.warp(dl);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.ClaimWindowOpen.selector, runId, dl));
        esc.expireRun(runId); // exactly at the deadline a claim is still valid
        vm.prank(alice);
        esc.claim(_pid(runId, 0));
        vm.warp(dl + 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.ClaimWindowClosed.selector, runId, dl));
        esc.claim(_pid(runId, 1));
        vm.prank(stranger);
        esc.expireRun(runId);
        assertEq(esc.refundable(runId), 1000e18);
        uint256 before = musd.balanceOf(admin);
        vm.prank(stranger); // anyone can trigger the refund, and it goes only to the funder
        esc.refund(runId);
        assertEq(musd.balanceOf(admin) - before, 1000e18);
        assertEq(musd.balanceOf(stranger), 0);
    }

    function test_tokenAddressRejectedAsRecipient() public {
        vm.prank(operator);
        uint256 runId = esc.createRun(orgId, "tok", WINDOW);
        address[] memory r = new address[](1);
        uint128[] memory a = new uint128[](1);
        (r[0], a[0]) = (address(musd), 1e18);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidRecipient.selector, address(musd)));
        esc.addPayments(runId, 0, r, a);
    }

    function test_pendingOwnerCanBeCleared() public {
        vm.prank(owner);
        reg.transferOwnership(orgId, admin);
        vm.prank(owner);
        reg.transferOwnership(orgId, address(0));
        assertEq(reg.getOrganization(orgId).pendingOwner, address(0));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotPendingOwner.selector, orgId, admin));
        reg.acceptOwnership(orgId);
    }

    /// Mutation M13 survived: an ex-owner must not keep role bits, and the new owner's old bits are cleared.
    function test_ownershipTransferRoleHygiene() public {
        vm.prank(owner);
        reg.transferOwnership(orgId, admin);
        vm.prank(admin);
        reg.acceptOwnership(orgId);
        assertEq(reg.rolesOf(orgId, owner), 0);
        assertFalse(reg.hasRole(orgId, owner, reg.ROLE_ADMIN()));
        // admin's explicit ADMIN bit was cleared; removing them later as owner isn't possible, but
        // if ownership moves on again they hold nothing.
        vm.prank(admin);
        reg.transferOwnership(orgId, approver);
        vm.prank(approver);
        reg.acceptOwnership(orgId);
        assertEq(reg.rolesOf(orgId, admin), 0);
    }

    function test_getPaymentsHugeCountDoesNotOverflow() public {
        uint256 runId = _draft("pg");
        assertEq(esc.getPayments(runId, 1, type(uint32).max).length, 2);
    }

    function test_claimManyDuplicateIdReverts() public {
        uint256 runId = _published("dup");
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (_pid(runId, 0), _pid(runId, 0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.PaymentNotClaimable.selector, ids[0], IPayrollEscrow.PaymentStatus.Claimed));
        esc.claimMany(ids);
    }

    function test_pauseNeverTrapsFunds() public {
        uint256 published = _published("p1");
        uint256 funded = _funded("p2");
        vm.prank(platform);
        esc.pause();
        vm.prank(alice);
        esc.claim(_pid(published, 0));
        vm.prank(admin);
        esc.cancelRun(funded);
        vm.prank(admin);
        esc.refund(funded);
        vm.warp(block.timestamp + WINDOW + 1);
        esc.expireRun(published);
        vm.prank(admin);
        esc.refund(published);
        assertEq(esc.totalHeld(), 0);
        assertEq(musd.balanceOf(address(esc)), 0);
    }

    // ------------------------------------------------------------ solidity-auditor scan (2026-11-12)

    /// S1: approvers signed a hash that did not cover the claim window, so an operator could set 1 hour.
    function test_claimWindowIsPartOfApprovedHash() public {
        vm.prank(operator);
        uint256 runId = esc.createRun(orgId, "s1", 1 hours);
        (address[] memory r, uint128[] memory a) = _three();
        vm.prank(operator);
        esc.addPayments(runId, 0, r, a);
        vm.prank(operator);
        esc.submitForApproval(runId);
        // What the approver reviewed: the same payments with the org's 30-day window.
        bytes32 reviewed = keccak256(abi.encode(block.chainid, address(esc), runId, WINDOW));
        for (uint32 i; i < 3; ++i) reviewed = keccak256(abi.encode(reviewed, _pid(runId, i), r[i], a[i]));
        bytes32 actual = esc.getRun(runId).paymentsHash;
        // The on-chain commitment includes the 1-hour window the operator chose...
        bytes32 committed = keccak256(abi.encode(block.chainid, address(esc), runId, uint32(1 hours)));
        for (uint32 i; i < 3; ++i) committed = keccak256(abi.encode(committed, _pid(runId, i), r[i], a[i]));
        assertEq(actual, committed);
        // ...so an approval for the reviewed 30-day run cannot be used on it.
        assertTrue(actual != reviewed);
        vm.prank(approver);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.HashMismatch.selector, reviewed, actual));
        esc.approve(runId, reviewed);
    }

    /// S2: an operator could cancel a run that approvers had already signed.
    function test_operatorCannotCancelApprovedRun() public {
        uint256 runId = _approved("s2");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, operator, uint8(1)));
        esc.cancelRun(runId);
        vm.prank(approver);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, approver, uint8(1)));
        esc.cancelRun(runId);
        vm.prank(admin);
        esc.fund(runId); // still fundable
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.Funded));
    }

    /// S3: one operator or approver could reset an Approved run before every fund call.
    function test_singleHolderCannotUnapprove() public {
        uint256 runId = _approved("s3");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, operator, uint8(1)));
        esc.returnToDraft(runId);
        vm.prank(approver);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, approver, uint8(1)));
        esc.returnToDraft(runId);
        vm.prank(admin);
        esc.fund(runId);
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.Funded));

        // While still pending, an operator or approver may send it back for edits.
        uint256 pending = _draft("s3b");
        vm.prank(operator);
        esc.submitForApproval(pending);
        vm.prank(approver);
        esc.returnToDraft(pending);
        assertEq(uint8(_status(pending)), uint8(IPayrollEscrow.RunStatus.Draft));
    }

    /// S4: refund needed an admin although it only ever pays the funder.
    function test_funderRecoversWithoutAdmin() public {
        uint256 runId = _published("s4"); // funded by `admin`
        vm.prank(owner);
        reg.setMemberRoles(orgId, admin, 0); // funder leaves the org
        vm.warp(esc.getRun(runId).claimDeadline + 1);
        vm.prank(stranger);
        esc.expireRun(runId);
        uint256 before = musd.balanceOf(admin);
        vm.prank(admin); // no roles any more
        uint128 amt = esc.refund(runId);
        assertEq(amt, 1500e18);
        assertEq(musd.balanceOf(admin) - before, 1500e18);
        assertEq(esc.totalHeld(), 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NothingToRefund.selector, runId));
        esc.refund(runId);
    }

    /// S4b: an open refund can never pull money that recipients are still owed.
    function test_openRefundCannotTouchLiveRuns() public {
        uint256 funded = _funded("s4b");
        uint256 published = _published("s4c");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NothingToRefund.selector, funded));
        esc.refund(funded);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NothingToRefund.selector, published));
        esc.refund(published);
        vm.stopPrank();
        assertEq(esc.liability(published), 1500e18);
    }

    /// S5: the registry was accepted as a recipient (it can never claim).
    function test_registryRejectedAsRecipient() public {
        vm.prank(operator);
        uint256 runId = esc.createRun(orgId, "s5", WINDOW);
        address[] memory r = new address[](1);
        uint128[] memory a = new uint128[](1);
        (r[0], a[0]) = (address(reg), 1e18);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidRecipient.selector, address(reg)));
        esc.addPayments(runId, 0, r, a);
    }
}
