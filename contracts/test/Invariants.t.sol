// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrganizationRegistry} from "../src/OrganizationRegistry.sol";
import {PayrollEscrow} from "../src/PayrollEscrow.sol";
import {IPayrollEscrow} from "../src/interfaces/IPayrollEscrow.sol";
import {MockMUSD} from "./mocks/MockMUSD.sol";

/// @dev Drives random sequences of run building, funding, cancels, claims (incl. hostile ones),
///      expiry and refunds across two organizations.
contract Handler is Test {
    PayrollEscrow public esc;
    OrganizationRegistry public reg;
    MockMUSD public musd;

    address[2] public owners;
    uint256[2] public orgs;
    address[4] public recipients;
    uint256[] public runIds;

    // ghost accounting
    uint256 public ghostFunded;
    uint256 public ghostClaimed;
    uint256 public ghostRefunded;
    uint256 public ghostForeignClaimSuccesses;
    uint256 public ghostDoubleClaimSuccesses;
    mapping(uint256 => bool) public claimedOnce;

    constructor(PayrollEscrow e, OrganizationRegistry r, MockMUSD m) {
        esc = e;
        reg = r;
        musd = m;
        for (uint256 i; i < 2; ++i) {
            owners[i] = makeAddr(string(abi.encodePacked("owner", i)));
            vm.prank(owners[i]);
            orgs[i] = reg.createOrganization(bytes32(i));
            musd.mint(owners[i], 1e30);
            vm.prank(owners[i]);
            musd.approve(address(esc), type(uint256).max);
        }
        for (uint256 i; i < 4; ++i) recipients[i] = makeAddr(string(abi.encodePacked("rcpt", i)));
    }

    function runCount() external view returns (uint256) {
        return runIds.length;
    }

    function createAndPublish(uint256 orgSeed, uint256 nSeed, uint256 amtSeed, bool publish) external {
        uint256 o = orgSeed % 2;
        uint256 n = bound(nSeed, 1, 6);
        address[] memory r = new address[](n);
        uint128[] memory a = new uint128[](n);
        for (uint256 i; i < n; ++i) {
            r[i] = recipients[(amtSeed + i) % 4];
            a[i] = uint128(bound(uint256(keccak256(abi.encode(amtSeed, i))), 1, 1e22));
        }
        vm.startPrank(owners[o]);
        uint256 runId = esc.createRun(orgs[o], keccak256(abi.encode(runIds.length, amtSeed)), 1 days);
        esc.addPayments(runId, 0, r, a);
        esc.submitForApproval(runId);
        esc.approve(runId, esc.getRun(runId).paymentsHash);
        esc.fund(runId);
        ghostFunded += esc.getRun(runId).funded;
        if (publish) esc.publish(runId);
        vm.stopPrank();
        runIds.push(runId);
    }

    uint256 public ghostClaimManySuccesses;
    uint256 public ghostDraftCancels;
    bool public paused;

    /// Multi-batch run with a draft-stage cancel, built by the operator path.
    function createWithDraftCancel(uint256 orgSeed, uint256 amtSeed, uint256 cancelSeed) external {
        uint256 o = orgSeed % 2;
        vm.startPrank(owners[o]);
        uint256 runId;
        try esc.createRun(orgs[o], keccak256(abi.encode("dc", runIds.length, amtSeed)), 1 days) returns (uint256 id) {
            runId = id;
        } catch {
            vm.stopPrank();
            return;
        }
        uint32 idx;
        for (uint256 b; b < 2; ++b) {
            address[] memory r = new address[](3);
            uint128[] memory a = new uint128[](3);
            for (uint256 i; i < 3; ++i) {
                r[i] = recipients[(amtSeed + b + i) % 4];
                a[i] = uint128(bound(uint256(keccak256(abi.encode(amtSeed, b, i))), 1, 1e21));
            }
            esc.addPayments(runId, idx, r, a);
            idx += 3;
        }
        esc.cancelPayment(esc.paymentId(runId, uint32(cancelSeed % 6)));
        ghostDraftCancels++;
        esc.submitForApproval(runId);
        bytes32 h = esc.getRun(runId).paymentsHash;
        esc.approve(runId, h);
        esc.fund(runId);
        ghostFunded += esc.getRun(runId).funded;
        esc.publish(runId);
        vm.stopPrank();
        runIds.push(runId);
    }

    function claimAll(uint256 runSeed, uint256 rcptSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        address who = recipients[rcptSeed % 4];
        IPayrollEscrow.Payment[] memory ps = esc.getPayments(runId, 0, type(uint32).max);
        uint256 n;
        for (uint256 i; i < ps.length; ++i) if (ps[i].recipient == who && ps[i].status == IPayrollEscrow.PaymentStatus.Allocated) ++n;
        if (n == 0) return;
        uint256[] memory ids = new uint256[](n);
        uint256 total;
        uint256 k;
        for (uint256 i; i < ps.length; ++i) {
            if (ps[i].recipient == who && ps[i].status == IPayrollEscrow.PaymentStatus.Allocated) {
                ids[k++] = esc.paymentId(runId, uint32(i));
                total += ps[i].amount;
            }
        }
        vm.prank(who);
        try esc.claimMany(ids) {
            for (uint256 i; i < n; ++i) {
                if (claimedOnce[ids[i]]) ghostDoubleClaimSuccesses++;
                claimedOnce[ids[i]] = true;
            }
            ghostClaimed += total;
            ghostClaimManySuccesses++;
        } catch {}
    }

    function togglePause() external {
        if (paused) esc.unpause();
        else esc.pause();
        paused = !paused;
    }

    function cancelPayment(uint256 runSeed, uint256 idxSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        IPayrollEscrow.Run memory run = esc.getRun(runId);
        uint256 pid = esc.paymentId(runId, uint32(idxSeed % run.paymentCount));
        vm.prank(reg.getOrganization(run.orgId).owner);
        try esc.cancelPayment(pid) {} catch {}
    }

    function publish(uint256 runSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        vm.prank(reg.getOrganization(esc.getRun(runId).orgId).owner);
        try esc.publish(runId) {} catch {}
    }

    function claim(uint256 runSeed, uint256 idxSeed, uint256 callerSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        IPayrollEscrow.Run memory run = esc.getRun(runId);
        uint256 pid = esc.paymentId(runId, uint32(idxSeed % run.paymentCount));
        IPayrollEscrow.Payment memory p = esc.getPayment(pid);
        address caller = callerSeed % 3 == 0 ? recipients[callerSeed % 4] : p.recipient;
        vm.prank(caller);
        try esc.claim(pid) {
            if (caller != p.recipient) ghostForeignClaimSuccesses++;
            if (claimedOnce[pid]) ghostDoubleClaimSuccesses++;
            claimedOnce[pid] = true;
            ghostClaimed += p.amount;
        } catch {}
    }

    function cancelRun(uint256 runSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        vm.prank(reg.getOrganization(esc.getRun(runId).orgId).owner);
        try esc.cancelRun(runId) {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 days));
    }

    function expire(uint256 runSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        vm.prank(reg.getOrganization(esc.getRun(runId).orgId).owner);
        try esc.expireRun(runId) {} catch {}
    }

    function refund(uint256 runSeed, bool asOtherOrg) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        IPayrollEscrow.Run memory run = esc.getRun(runId);
        address caller = reg.getOrganization(run.orgId).owner;
        if (asOtherOrg) caller = caller == owners[0] ? owners[1] : owners[0];
        vm.prank(caller);
        try esc.refund(runId) returns (uint128 amt) {
            ghostRefunded += amt;
        } catch {}
    }
}

contract PayrollInvariants is Test {
    PayrollEscrow esc;
    OrganizationRegistry reg;
    MockMUSD musd;
    Handler h;

    function setUp() public {
        musd = new MockMUSD();
        reg = new OrganizationRegistry();
        esc = new PayrollEscrow(address(musd), address(reg), address(this));
        h = new Handler(esc, reg, musd);
        esc.grantRole(esc.PAUSER_ROLE(), address(h));
        targetContract(address(h));
    }

    /// Outstanding claims are fully backed by escrow.
    function invariant_balanceCoversHeld() public view {
        assertGe(musd.balanceOf(address(esc)), esc.totalHeld());
        assertEq(esc.totalHeld(), h.ghostFunded() - h.ghostClaimed() - h.ghostRefunded());
    }

    /// Per run: claimed ≤ allocated ≤ funded (once funded); refunded ≤ funded - claimed;
    /// liability + refundable + claimed + refunded == funded.
    function invariant_perRunAccounting() public view {
        uint256 n = h.runCount();
        uint256 sumLiability;
        for (uint256 i; i < n; ++i) {
            uint256 runId = h.runIds(i);
            IPayrollEscrow.Run memory r = esc.getRun(runId);
            assertLe(r.claimed, r.allocated);
            assertLe(r.allocated, r.funded);
            assertLe(uint256(r.claimed) + r.refunded, r.funded);
            uint256 l = esc.liability(runId);
            assertEq(l + esc.refundable(runId) + r.claimed + r.refunded, r.funded);
            sumLiability += l;
        }
        assertGe(esc.totalHeld(), sumLiability);
    }

    /// Liability equals the sum of still-claimable payment amounts on every live run.
    function invariant_liabilityMatchesOpenPayments() public view {
        uint256 n = h.runCount();
        for (uint256 i; i < n; ++i) {
            uint256 runId = h.runIds(i);
            IPayrollEscrow.Run memory r = esc.getRun(runId);
            if (r.status != IPayrollEscrow.RunStatus.Funded && r.status != IPayrollEscrow.RunStatus.Published) continue;
            IPayrollEscrow.Payment[] memory ps = esc.getPayments(runId, 0, type(uint32).max);
            uint256 open;
            for (uint256 j; j < ps.length; ++j) if (ps[j].status == IPayrollEscrow.PaymentStatus.Allocated) open += ps[j].amount;
            assertEq(open, esc.liability(runId));
        }
    }

    /// Nobody but the designated wallet ever claims, and nothing is claimed twice.
    function invariant_claimSafety() public view {
        assertEq(h.ghostForeignClaimSuccesses(), 0);
        assertEq(h.ghostDoubleClaimSuccesses(), 0);
    }
}
