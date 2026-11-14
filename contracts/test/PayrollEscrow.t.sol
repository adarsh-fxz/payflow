// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {IPayrollEscrow} from "../src/interfaces/IPayrollEscrow.sol";
import {PayrollEscrow} from "../src/PayrollEscrow.sol";
import {ReentrantToken, FeeToken} from "./mocks/MockMUSD.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract PayrollEscrowTest is Base {
    // ---------------------------------------------------------------- happy path

    function test_fullLifecycle() public {
        uint256 runId = _published("jan");
        IPayrollEscrow.Run memory r = esc.getRun(runId);
        assertEq(uint8(r.status), uint8(IPayrollEscrow.RunStatus.Published));
        assertEq(r.allocated, 1500e18);
        assertEq(r.funded, 1500e18);
        assertEq(r.paymentCount, 3);
        assertEq(r.funder, admin);
        assertEq(r.claimDeadline, block.timestamp + WINDOW);
        assertEq(musd.balanceOf(address(esc)), 1500e18);
        assertEq(esc.totalHeld(), 1500e18);
        assertEq(esc.liability(runId), 1500e18);
        assertEq(esc.refundable(runId), 0);

        uint256 pid = _pid(runId, 1);
        vm.prank(bob);
        esc.claim(pid);
        assertEq(musd.balanceOf(bob), 750e18);
        IPayrollEscrow.Payment memory p = esc.getPayment(pid);
        assertEq(uint8(p.status), uint8(IPayrollEscrow.PaymentStatus.Claimed));
        assertEq(p.claimedAt, block.timestamp);
        r = esc.getRun(runId);
        assertEq(r.claimed, 750e18);
        assertEq(r.claimedCount, 1);
        assertEq(esc.liability(runId), 750e18);
        assertEq(esc.totalHeld(), 750e18);
    }

    function test_paymentIdLayout() public {
        uint256 runId = _draft("x");
        assertEq(_pid(runId, 2), (runId << 32) | 2);
        assertEq(esc.getPayment((runId << 32) | 2).recipient, carol);
    }

    function test_getPaymentsPagination() public {
        uint256 runId = _draft("x");
        assertEq(esc.getPayments(runId, 0, 10).length, 3);
        assertEq(esc.getPayments(runId, 1, 1)[0].recipient, bob);
        assertEq(esc.getPayments(runId, 5, 1).length, 0);
    }

    function test_paymentsHashMatchesOffchainFormula() public {
        uint256 runId = _draft("x");
        (address[] memory r, uint128[] memory a) = _three();
        bytes32 h = keccak256(abi.encode(block.chainid, address(esc), runId, WINDOW));
        for (uint32 i; i < 3; ++i) {
            h = keccak256(abi.encode(h, _pid(runId, i), r[i], a[i]));
        }
        assertEq(esc.getRun(runId).paymentsHash, h);
        vm.prank(operator);
        esc.cancelPayment(_pid(runId, 1));
        h = keccak256(abi.encode(h, _pid(runId, 1), address(0), uint128(0)));
        assertEq(esc.getRun(runId).paymentsHash, h);
    }

    function test_claimMany() public {
        vm.prank(operator);
        uint256 runId = esc.createRun(orgId, "multi", WINDOW);
        address[] memory r = new address[](2);
        uint128[] memory a = new uint128[](2);
        (r[0], r[1]) = (alice, alice);
        (a[0], a[1]) = (100e18, 200e18);
        vm.prank(operator);
        esc.addPayments(runId, 0, r, a);
        vm.prank(operator);
        esc.submitForApproval(runId);
        _approveAs(esc, approver, runId);
        vm.startPrank(admin);
        esc.fund(runId);
        esc.publish(runId);
        vm.stopPrank();

        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (_pid(runId, 0), _pid(runId, 1));
        vm.prank(alice);
        esc.claimMany(ids);
        assertEq(musd.balanceOf(alice), 300e18);
        assertEq(esc.getRun(runId).claimed, 300e18);
    }

    function test_claimManyRejectsForeignPayment() public {
        uint256 runId = _published("x");
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (_pid(runId, 0), _pid(runId, 1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotRecipient.selector, ids[1], alice));
        esc.claimMany(ids);
    }

    // ---------------------------------------------------------------- claim safety

    function test_duplicateClaimReverts() public {
        uint256 runId = _published("x");
        uint256 pid = _pid(runId, 0);
        vm.prank(alice);
        esc.claim(pid);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.PaymentNotClaimable.selector, pid, IPayrollEscrow.PaymentStatus.Claimed));
        esc.claim(pid);
    }

    function test_otherWalletCannotClaim() public {
        uint256 runId = _published("x");
        uint256 pid = _pid(runId, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotRecipient.selector, pid, bob));
        esc.claim(pid);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotRecipient.selector, pid, admin));
        esc.claim(pid);
    }

    function test_claimBeforePublishReverts() public {
        uint256 runId = _funded("x");
        uint256 pid = _pid(runId, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.Funded));
        esc.claim(pid);
    }

    function test_claimNonexistentPayment() public {
        uint256 runId = _published("x");
        uint256 pid = _pid(runId, 9);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.PaymentNotFound.selector, pid));
        esc.claim(pid);
    }

    function test_claimAfterDeadlineReverts() public {
        uint256 runId = _published("x");
        uint64 deadline = esc.getRun(runId).claimDeadline;
        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.ClaimWindowClosed.selector, runId, deadline));
        esc.claim(_pid(runId, 0));
    }

    function test_claimAtDeadlineWorks() public {
        uint256 runId = _published("x");
        vm.warp(esc.getRun(runId).claimDeadline);
        vm.prank(alice);
        esc.claim(_pid(runId, 0));
        assertEq(musd.balanceOf(alice), 500e18);
    }

    function test_claimWorksWhilePaused() public {
        uint256 runId = _published("x");
        vm.prank(platform);
        esc.pause();
        vm.prank(alice);
        esc.claim(_pid(runId, 0));
        assertEq(musd.balanceOf(alice), 500e18);
    }

    // ---------------------------------------------------------------- building & replay

    function test_duplicateRunRefReverts() public {
        vm.prank(operator);
        esc.createRun(orgId, "dup", WINDOW);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.DuplicateRunRef.selector, orgId, bytes32("dup")));
        esc.createRun(orgId, "dup", WINDOW);
    }

    function test_sameRefDifferentOrgOk() public {
        vm.prank(stranger);
        uint256 org2 = reg.createOrganization(bytes32(0));
        vm.prank(operator);
        uint256 a = esc.createRun(orgId, "same", WINDOW);
        vm.prank(stranger);
        uint256 b = esc.createRun(org2, "same", WINDOW);
        assertTrue(a != b);
        assertEq(esc.runIdByRef(orgId, "same"), a);
        assertEq(esc.runIdByRef(org2, "same"), b);
    }

    function test_replayedBatchReverts() public {
        uint256 runId = _draft("x");
        (address[] memory r, uint128[] memory a) = _three();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.IndexMismatch.selector, uint32(0), uint32(3)));
        esc.addPayments(runId, 0, r, a);
        vm.prank(operator);
        esc.addPayments(runId, 3, r, a);
        assertEq(esc.getRun(runId).paymentCount, 6);
        assertEq(esc.getRun(runId).allocated, 3000e18);
    }

    function test_batchValidation() public {
        vm.prank(operator);
        uint256 runId = esc.createRun(orgId, "v", WINDOW);
        address[] memory r = new address[](1);
        uint128[] memory a = new uint128[](1);

        vm.startPrank(operator);
        vm.expectRevert(IPayrollEscrow.EmptyBatch.selector);
        esc.addPayments(runId, 0, new address[](0), new uint128[](0));

        vm.expectRevert(IPayrollEscrow.LengthMismatch.selector);
        esc.addPayments(runId, 0, r, new uint128[](2));

        r[0] = address(0);
        a[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidRecipient.selector, address(0)));
        esc.addPayments(runId, 0, r, a);

        r[0] = address(esc);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidRecipient.selector, address(esc)));
        esc.addPayments(runId, 0, r, a);

        r[0] = alice;
        a[0] = 0;
        vm.expectRevert(IPayrollEscrow.InvalidAmount.selector);
        esc.addPayments(runId, 0, r, a);

        address[] memory big = new address[](101);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.BatchTooLarge.selector, 101, 100));
        esc.addPayments(runId, 0, big, new uint128[](101));
        vm.stopPrank();
    }

    function test_maxBatchGas() public {
        vm.prank(operator);
        uint256 runId = esc.createRun(orgId, "gas", WINDOW);
        address[] memory r = new address[](100);
        uint128[] memory a = new uint128[](100);
        for (uint256 i; i < 100; ++i) {
            r[i] = address(uint160(0x1000 + i));
            a[i] = 1e18;
        }
        vm.prank(operator);
        uint256 g = gasleft();
        esc.addPayments(runId, 0, r, a);
        uint256 used = g - gasleft();
        emit log_named_uint("addPayments(100) gas", used);
        assertLt(used, 8_000_000, "must fit Mezo 10M block gas limit");
    }

    function test_claimWindowBounds() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidClaimWindow.selector, uint32(59 minutes)));
        esc.createRun(orgId, "a", 59 minutes);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidClaimWindow.selector, uint32(366 days)));
        esc.createRun(orgId, "b", 366 days);
        vm.stopPrank();
    }

    function test_cannotAddAfterSubmit() public {
        uint256 runId = _draft("x");
        vm.prank(operator);
        esc.submitForApproval(runId);
        (address[] memory r, uint128[] memory a) = _three();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.PendingApproval));
        esc.addPayments(runId, 3, r, a);
    }

    function test_submitEmptyRunReverts() public {
        vm.prank(operator);
        uint256 runId = esc.createRun(orgId, "e", WINDOW);
        vm.prank(operator);
        vm.expectRevert(IPayrollEscrow.EmptyRun.selector);
        esc.submitForApproval(runId);
    }

    function test_createRunUnknownOrg() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.OrgNotFound.selector, 99));
        esc.createRun(99, "x", WINDOW);
    }

    // ---------------------------------------------------------------- approvals

    function test_approveRequiresMatchingHash() public {
        uint256 runId = _draft("x");
        vm.prank(operator);
        esc.submitForApproval(runId);
        bytes32 actual = esc.getRun(runId).paymentsHash;
        vm.prank(approver);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.HashMismatch.selector, bytes32("stale"), actual));
        esc.approve(runId, "stale");
    }

    function test_multiApproval() public {
        vm.prank(owner);
        reg.setApprovalsRequired(orgId, 2);
        uint256 runId = _draft("x");
        vm.prank(operator);
        esc.submitForApproval(runId);
        bytes32 h = esc.getRun(runId).paymentsHash;

        vm.prank(approver);
        esc.approve(runId, h);
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.PendingApproval));
        assertTrue(esc.hasApproved(runId, approver));

        vm.prank(approver);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.AlreadyApproved.selector, runId, approver));
        esc.approve(runId, h);

        vm.prank(approver2);
        esc.approve(runId, h);
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.Approved));
    }

    function test_thresholdSnapshottedAtSubmit() public {
        uint256 runId = _draft("x");
        vm.prank(operator);
        esc.submitForApproval(runId);
        vm.prank(owner);
        reg.setApprovalsRequired(orgId, 3); // later change does not affect this run
        _approveAs(esc, approver, runId);
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.Approved));
    }

    function test_returnToDraftResetsApprovals() public {
        vm.prank(owner);
        reg.setApprovalsRequired(orgId, 2);
        uint256 runId = _draft("x");
        vm.prank(operator);
        esc.submitForApproval(runId);
        _approveAs(esc, approver, runId);

        vm.prank(approver2);
        esc.returnToDraft(runId);
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.Draft));
        assertFalse(esc.hasApproved(runId, approver));

        vm.prank(operator);
        esc.cancelPayment(_pid(runId, 2));
        vm.prank(operator);
        esc.submitForApproval(runId);
        bytes32 h = esc.getRun(runId).paymentsHash;
        vm.prank(approver);
        esc.approve(runId, h); // allowed again in the new round
        vm.prank(approver2);
        esc.approve(runId, h);
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.Approved));
        assertEq(esc.getRun(runId).allocated, 1250e18);
    }

    function test_operatorCannotApprove() public {
        uint256 runId = _draft("x");
        vm.prank(operator);
        esc.submitForApproval(runId);
        bytes32 h = esc.getRun(runId).paymentsHash;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, operator, uint8(2)));
        esc.approve(runId, h);
        vm.prank(admin); // admin without APPROVER bit cannot approve either
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, admin, uint8(2)));
        esc.approve(runId, h);
        vm.prank(owner);
        esc.approve(runId, h);
    }

    // ---------------------------------------------------------------- funding

    function test_fundRequiresApproval() public {
        uint256 runId = _draft("x");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.Draft));
        esc.fund(runId);
    }

    function test_cannotFundTwice() public {
        uint256 runId = _funded("x");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.Funded));
        esc.fund(runId);
        assertEq(musd.balanceOf(address(esc)), 1500e18);
    }

    function test_operatorAndApproverCannotFundOrPublish() public {
        uint256 runId = _approved("x");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, operator, uint8(1)));
        esc.fund(runId);
        vm.prank(approver);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, approver, uint8(1)));
        esc.fund(runId);
        vm.prank(admin);
        esc.fund(runId);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, operator, uint8(1)));
        esc.publish(runId);
    }

    function test_publishRequiresFunding() public {
        uint256 runId = _approved("x");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.Approved));
        esc.publish(runId);
    }

    function test_fundInsufficientBalanceReverts() public {
        uint256 runId = _approved("x");
        address poor = makeAddr("poor");
        vm.prank(owner);
        reg.setMemberRoles(orgId, poor, 1);
        vm.prank(poor);
        musd.approve(address(esc), type(uint256).max);
        vm.prank(poor);
        vm.expectRevert();
        esc.fund(runId);
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.Approved));
    }

    function test_fundWithPermit() public {
        uint256 runId = _approved("x");
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        musd.mint(signer, 2000e18);
        vm.prank(owner);
        reg.setMemberRoles(orgId, signer, 1);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                signer, address(esc), uint256(1500e18), musd.nonces(signer), deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", musd.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        vm.prank(signer);
        esc.fundWithPermit(runId, deadline, v, r, s);
        assertEq(esc.getRun(runId).funded, 1500e18);
        assertEq(esc.getRun(runId).funder, signer);
        assertEq(musd.balanceOf(signer), 500e18);
    }

    function test_fundWithBadPermitFallsBackToAllowance() public {
        uint256 runId = _approved("x");
        vm.prank(admin); // admin already has max allowance; junk permit is ignored
        esc.fundWithPermit(runId, block.timestamp, 27, bytes32(0), bytes32(0));
        assertEq(esc.getRun(runId).funded, 1500e18);
    }

    function test_feeOnTransferTokenRejected() public {
        FeeToken fee = new FeeToken();
        PayrollEscrow e2 = new PayrollEscrow(address(fee), address(reg), platform);
        fee.mint(admin, 10_000e18);
        vm.prank(admin);
        fee.approve(address(e2), type(uint256).max);
        vm.prank(operator);
        uint256 runId = e2.createRun(orgId, "f", WINDOW);
        (address[] memory r, uint128[] memory a) = _three();
        vm.prank(operator);
        e2.addPayments(runId, 0, r, a);
        vm.prank(operator);
        e2.submitForApproval(runId);
        _approveAs(e2, approver, runId);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.FundingShortfall.selector, 1500e18, 1485e18));
        e2.fund(runId);
    }

    // ---------------------------------------------------------------- cancellation, expiry, refunds

    function test_cannotCancelPaymentOnceFunded() public {
        // The approved list is frozen: a funded run can only be cancelled as a whole.
        uint256 runId = _funded("x");
        uint256 pid = _pid(runId, 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.Funded));
        esc.cancelPayment(pid);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.Funded));
        esc.cancelPayment(pid);
        assertEq(esc.refundable(runId), 0);
        assertEq(esc.liability(runId), 1500e18);
    }

    function test_draftCancelExcludedFromFunding() public {
        uint256 runId = _draft("x");
        uint256 pid = _pid(runId, 1);
        vm.prank(operator);
        esc.cancelPayment(pid);
        vm.prank(operator);
        esc.submitForApproval(runId);
        _approveAs(esc, approver, runId);
        uint256 before = musd.balanceOf(admin);
        vm.prank(admin);
        esc.fund(runId);
        assertEq(before - musd.balanceOf(admin), 750e18);
        vm.prank(admin);
        esc.publish(runId);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.PaymentNotClaimable.selector, pid, IPayrollEscrow.PaymentStatus.Cancelled));
        esc.claim(pid);
        vm.prank(alice);
        esc.claim(_pid(runId, 0));
        vm.prank(carol);
        esc.claim(_pid(runId, 2));
        assertEq(musd.balanceOf(address(esc)), 0);
        assertEq(esc.totalHeld(), 0);
    }

    function test_cannotCancelPaymentAfterPublish() public {
        uint256 runId = _published("x");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.Published));
        esc.cancelPayment(_pid(runId, 0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.Published));
        esc.cancelRun(runId);
    }

    function test_cannotCancelPaymentWhilePendingApproval() public {
        uint256 runId = _draft("x");
        vm.prank(operator);
        esc.submitForApproval(runId);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.PendingApproval));
        esc.cancelPayment(_pid(runId, 0));
    }

    function test_employerCannotWithdrawAllocatedFunds() public {
        uint256 runId = _published("x");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NothingToRefund.selector, runId));
        esc.refund(runId);
        uint64 dl = esc.getRun(runId).claimDeadline;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.ClaimWindowOpen.selector, runId, dl));
        esc.expireRun(runId);
    }

    function test_cancelFundedRunRefundsEverything() public {
        uint256 runId = _funded("x");
        vm.prank(admin);
        esc.cancelRun(runId);
        assertEq(esc.refundable(runId), 1500e18);
        uint256 before = musd.balanceOf(admin);
        vm.prank(stranger); // anyone may trigger it; the money still goes only to the funder (admin)
        esc.refund(runId);
        assertEq(musd.balanceOf(admin) - before, 1500e18);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NothingToRefund.selector, runId));
        esc.refund(runId);
    }

    function test_cancelUnfundedRun() public {
        uint256 runId = _approved("x");
        vm.prank(operator); // approved runs carry sign-off: admin only
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, operator, uint8(1)));
        esc.cancelRun(runId);
        vm.prank(admin);
        esc.cancelRun(runId);
        assertEq(uint8(_status(runId)), uint8(IPayrollEscrow.RunStatus.Cancelled));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NothingToRefund.selector, runId));
        esc.refund(runId);
    }

    function test_expiryAndRefundOfUnclaimed() public {
        uint256 runId = _published("x");
        vm.prank(alice);
        esc.claim(_pid(runId, 0));
        vm.warp(esc.getRun(runId).claimDeadline + 1);
        vm.prank(stranger); // expiry is permissionless once the window has closed
        esc.expireRun(runId);
        assertEq(esc.refundable(runId), 1000e18);
        uint256 before = musd.balanceOf(admin);
        vm.prank(admin);
        esc.refund(runId);
        assertEq(musd.balanceOf(admin) - before, 1000e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runId, IPayrollEscrow.RunStatus.Expired));
        esc.claim(_pid(runId, 1));
        assertEq(esc.totalHeld(), 0);
    }

    // ---------------------------------------------------------------- isolation

    function test_crossOrgIsolation() public {
        uint256 runA = _published("a");
        vm.prank(stranger);
        uint256 org2 = reg.createOrganization(bytes32(0));
        musd.mint(stranger, 10_000e18);
        vm.prank(stranger);
        musd.approve(address(esc), type(uint256).max);

        // stranger has no role in org 1; refund is open to anyone but a live run has nothing refundable
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NothingToRefund.selector, runA));
        esc.refund(runA);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.InvalidStatus.selector, runA, IPayrollEscrow.RunStatus.Published));
        esc.cancelPayment(_pid(runA, 0));

        // org2 runs its own payroll, cancels it and refunds — org1 liability untouched
        vm.startPrank(stranger);
        uint256 runB = esc.createRun(org2, "b", WINDOW);
        address[] memory r = new address[](1);
        uint128[] memory a = new uint128[](1);
        (r[0], a[0]) = (alice, 999e18);
        esc.addPayments(runB, 0, r, a);
        esc.submitForApproval(runB);
        bytes32 hb = esc.getRun(runB).paymentsHash;
        esc.approve(runB, hb);
        esc.fund(runB);
        esc.cancelRun(runB);
        esc.refund(runB);
        vm.stopPrank();

        assertEq(esc.liability(runA), 1500e18);
        assertEq(musd.balanceOf(address(esc)), 1500e18);
        assertEq(esc.totalHeld(), 1500e18);
        vm.prank(alice);
        esc.claim(_pid(runA, 0));
        assertEq(musd.balanceOf(alice), 500e18);
    }

    function test_paymentIdFromAnotherRunIsIndependent() public {
        uint256 run1 = _published("1");
        uint256 run2 = _published("2");
        vm.prank(alice);
        esc.claim(_pid(run1, 0));
        vm.prank(alice);
        esc.claim(_pid(run2, 0));
        assertEq(musd.balanceOf(alice), 1000e18);
        assertEq(esc.getRun(run1).claimed, 500e18);
        assertEq(esc.getRun(run2).claimed, 500e18);
    }

    // ---------------------------------------------------------------- pause & admin

    function test_pauseBlocksNewActions() public {
        uint256 runId = _approved("x");
        vm.prank(stranger);
        vm.expectRevert();
        esc.pause();
        vm.prank(platform);
        esc.pause();
        vm.prank(admin);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        esc.fund(runId);
        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        esc.createRun(orgId, "p", WINDOW);
        // cancellation still works so nothing gets stuck
        vm.prank(admin);
        esc.cancelRun(runId);
        vm.prank(platform);
        esc.unpause();
    }

    function test_strangerCannotBuildRuns() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, stranger, uint8(5)));
        esc.createRun(orgId, "s", WINDOW);
    }

    function test_revokedOperatorLosesAccess() public {
        uint256 runId = _draft("x");
        vm.prank(owner);
        reg.setMemberRoles(orgId, operator, 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IPayrollEscrow.NotAuthorized.selector, orgId, operator, uint8(5)));
        esc.submitForApproval(runId);
    }

    // ---------------------------------------------------------------- reentrancy

    function test_reentrantTokenCannotDoubleClaim() public {
        ReentrantToken evil = new ReentrantToken();
        PayrollEscrow e2 = new PayrollEscrow(address(evil), address(reg), platform);
        evil.mint(admin, 10_000e18);
        vm.prank(admin);
        evil.approve(address(e2), type(uint256).max);

        vm.prank(operator);
        uint256 runId = e2.createRun(orgId, "r", WINDOW);
        address[] memory r = new address[](1);
        uint128[] memory a = new uint128[](1);
        (r[0], a[0]) = (alice, 100e18);
        vm.prank(operator);
        e2.addPayments(runId, 0, r, a);
        vm.prank(operator);
        e2.submitForApproval(runId);
        _approveAs(e2, approver, runId);
        vm.startPrank(admin);
        e2.fund(runId);
        e2.publish(runId);
        vm.stopPrank();

        uint256 pid = _pid(runId, 0);
        evil.arm(address(e2), abi.encodeCall(e2.claim, (pid)));
        vm.prank(alice);
        vm.expectRevert(); // ReentrancyGuardReentrantCall bubbles up
        e2.claim(pid);
        assertEq(evil.balanceOf(alice), 0);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_claimsNeverExceedFunding(uint96[5] memory raw, uint8 claimMask, uint8 cancelIdx) public {
        vm.prank(operator);
        uint256 runId = esc.createRun(orgId, "fz", WINDOW);
        address[] memory r = new address[](5);
        uint128[] memory a = new uint128[](5);
        uint256 total;
        for (uint256 i; i < 5; ++i) {
            r[i] = address(uint160(0xA000 + i));
            a[i] = uint128(bound(raw[i], 1, 1e24));
            total += a[i];
        }
        musd.mint(admin, total);
        vm.prank(operator);
        esc.addPayments(runId, 0, r, a);
        uint256 c = cancelIdx % 6; // 5 = no cancel
        if (c < 5) {
            vm.prank(operator);
            esc.cancelPayment(_pid(runId, uint32(c)));
        }
        vm.prank(operator);
        esc.submitForApproval(runId);
        _approveAs(esc, approver, runId);
        vm.prank(admin);
        esc.fund(runId);
        vm.prank(admin);
        esc.publish(runId);
        for (uint256 i; i < 5; ++i) {
            if (claimMask & (1 << i) != 0 && i != c) {
                vm.prank(r[i]);
                esc.claim(_pid(runId, uint32(i)));
            }
        }
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(admin);
        esc.expireRun(runId);
        if (esc.refundable(runId) > 0) {
            vm.prank(admin);
            esc.refund(runId);
        }
        IPayrollEscrow.Run memory run = esc.getRun(runId);
        assertLe(run.claimed, run.allocated);
        assertLe(run.allocated, run.funded);
        assertEq(uint256(run.claimed) + run.refunded, run.funded);
        assertEq(musd.balanceOf(address(esc)), 0);
    }
}
