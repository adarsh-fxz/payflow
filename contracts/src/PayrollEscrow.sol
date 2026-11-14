// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPayrollEscrow} from "./interfaces/IPayrollEscrow.sol";
import {IOrganizationRegistry} from "./interfaces/IOrganizationRegistry.sol";

/// @title PayrollEscrow
/// @notice One shared escrow for every organization's payroll runs. Each run keeps its own
///         ledger (allocated / funded / claimed / refunded); no run can touch another run's money.
///         Recipients claim their own payment; only the designated wallet can succeed.
/// @dev    Payment records live on-chain (bounded batches of MAX_BATCH). Merkle distribution is
///         future work; see docs/PAYMENT_ACCOUNTING.md.
contract PayrollEscrow is IPayrollEscrow, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint8 internal constant ROLE_ADMIN = 1;
    uint8 internal constant ROLE_APPROVER = 2;
    uint8 internal constant ROLE_OPERATOR = 4;

    uint256 public constant MAX_BATCH = 100; // Mezo testnet block gas limit is 10M
    uint256 public constant MAX_CLAIM_BATCH = 50;
    uint32 public constant MAX_PAYMENTS_PER_RUN = 5_000;
    uint32 public constant MIN_CLAIM_WINDOW = 1 hours;
    uint32 public constant MAX_CLAIM_WINDOW = 365 days;

    IERC20 private immutable _token;
    IOrganizationRegistry private immutable _registry;

    uint256 private _runCount;
    uint256 private _totalHeld;

    mapping(uint256 => Run) private _runs;
    mapping(uint256 => Payment) private _payments;
    mapping(uint256 => mapping(bytes32 => uint256)) private _runByRef;
    mapping(uint256 => uint32) private _approvalRound;
    mapping(bytes32 => bool) private _approvedBy; // keccak(runId, round, approver)
    mapping(uint256 => address[]) private _approvers; // current round only

    constructor(address token_, address registry_, address admin) {
        if (token_ == address(0) || registry_ == address(0) || admin == address(0)) revert InvalidRecipient(address(0));
        _token = IERC20(token_);
        _registry = IOrganizationRegistry(registry_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Platform safety
    // ------------------------------------------------------------------

    /// @notice Stops new runs, batches, approvals, funding and publishing.
    ///         Claims, cancellations, expiry and refunds keep working so no money is trapped.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------
    // Run building
    // ------------------------------------------------------------------

    function createRun(uint256 orgId, bytes32 runRef, uint32 claimWindow)
        external
        whenNotPaused
        returns (uint256 runId)
    {
        if (!_registry.exists(orgId)) revert OrgNotFound(orgId);
        _requireAny(orgId, ROLE_OPERATOR | ROLE_ADMIN);
        if (claimWindow < MIN_CLAIM_WINDOW || claimWindow > MAX_CLAIM_WINDOW) revert InvalidClaimWindow(claimWindow);
        if (_runByRef[orgId][runRef] != 0) revert DuplicateRunRef(orgId, runRef);

        runId = ++_runCount;
        _runByRef[orgId][runRef] = runId;

        Run storage r = _runs[runId];
        r.orgId = orgId;
        r.runRef = runRef;
        // The claim window is part of what approvers sign, so nobody can shorten it after review.
        r.paymentsHash = keccak256(abi.encode(block.chainid, address(this), runId, claimWindow));
        r.creator = msg.sender;
        r.status = RunStatus.Draft;
        r.claimWindow = claimWindow;
        r.createdAt = uint64(block.timestamp);

        emit RunCreated(runId, orgId, runRef, msg.sender, claimWindow);
    }

    function addPayments(uint256 runId, uint32 expectedIndex, address[] calldata recipients, uint128[] calldata amounts)
        external
        whenNotPaused
    {
        Run storage r = _run(runId);
        _requireAny(r.orgId, ROLE_OPERATOR | ROLE_ADMIN);
        _requireStatus(runId, r, RunStatus.Draft);

        uint256 n = recipients.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n, MAX_BATCH);
        if (n != amounts.length) revert LengthMismatch();
        uint32 index = r.paymentCount;
        if (expectedIndex != index) revert IndexMismatch(expectedIndex, index);
        if (uint256(index) + n > MAX_PAYMENTS_PER_RUN) revert TooManyPayments();

        bytes32 h = r.paymentsHash;
        uint256 added;
        for (uint256 i; i < n; ++i) {
            address to = recipients[i];
            uint128 amount = amounts[i];
            if (to == address(0) || to == address(this) || to == address(_token) || to == address(_registry)) {
                revert InvalidRecipient(to);
            }
            if (amount == 0) revert InvalidAmount();

            uint256 pid = _paymentId(runId, index);
            _payments[pid] = Payment({recipient: to, claimedAt: 0, status: PaymentStatus.Allocated, amount: amount});
            h = keccak256(abi.encode(h, pid, to, amount));
            added += amount;
            emit PaymentAllocated(pid, runId, to, amount);
            unchecked {
                ++index;
            }
        }
        uint256 newAllocated = uint256(r.allocated) + added;
        if (newAllocated > type(uint128).max) revert InvalidAmount();
        r.allocated = uint128(newAllocated);
        r.paymentCount = index;
        r.paymentsHash = h;
    }

    function cancelPayment(uint256 pid) external {
        uint256 runId = pid >> 32;
        Run storage r = _run(runId);
        Payment storage p = _payments[pid];
        if (p.status == PaymentStatus.None) revert PaymentNotFound(pid);
        if (p.status != PaymentStatus.Allocated) revert PaymentNotClaimable(pid, p.status);

        // Draft only: once submitted, the list the approvers sign is frozen. To change an
        // approved or funded run, return it to draft (unfunded) or cancel it (funded → full refund).
        _requireStatus(runId, r, RunStatus.Draft);
        _requireAny(r.orgId, ROLE_OPERATOR | ROLE_ADMIN);

        p.status = PaymentStatus.Cancelled;
        r.allocated -= p.amount;
        r.paymentsHash = keccak256(abi.encode(r.paymentsHash, pid, address(0), uint128(0)));
        emit PaymentCancelled(pid, runId, p.amount);
    }

    function submitForApproval(uint256 runId) external whenNotPaused {
        Run storage r = _run(runId);
        _requireAny(r.orgId, ROLE_OPERATOR | ROLE_ADMIN);
        _requireStatus(runId, r, RunStatus.Draft);
        if (r.allocated == 0) revert EmptyRun();

        r.approvalsRequired = _registry.getOrganization(r.orgId).approvalsRequired;
        r.approvals = 0;
        r.status = RunStatus.PendingApproval;
        emit RunSubmitted(runId, r.paymentsHash, r.paymentCount, r.allocated, r.approvalsRequired);
    }

    function returnToDraft(uint256 runId) external {
        Run storage r = _run(runId);
        if (r.status == RunStatus.PendingApproval) {
            _requireAny(r.orgId, ROLE_OPERATOR | ROLE_APPROVER | ROLE_ADMIN);
        } else if (r.status == RunStatus.Approved) {
            // A reached threshold is undone only by an admin, so one operator or approver can't block funding.
            _requireAny(r.orgId, ROLE_ADMIN);
        } else {
            revert InvalidStatus(runId, r.status);
        }
        r.status = RunStatus.Draft;
        r.approvals = 0;
        ++_approvalRound[runId];
        delete _approvers[runId];
        emit RunReturnedToDraft(runId, msg.sender);
    }

    // ------------------------------------------------------------------
    // Approval
    // ------------------------------------------------------------------

    function approve(uint256 runId, bytes32 expectedPaymentsHash) external whenNotPaused {
        Run storage r = _run(runId);
        _requireAny(r.orgId, ROLE_APPROVER);
        _requireStatus(runId, r, RunStatus.PendingApproval);
        if (r.paymentsHash != expectedPaymentsHash) revert HashMismatch(expectedPaymentsHash, r.paymentsHash);

        bytes32 key = keccak256(abi.encode(runId, _approvalRound[runId], msg.sender));
        if (_approvedBy[key]) revert AlreadyApproved(runId, msg.sender);
        _approvedBy[key] = true;
        _approvers[runId].push(msg.sender);

        // Count only approvers who still hold the role (an earlier approver may have been removed).
        uint8 approvals = _validApprovals(runId, r.orgId);
        r.approvals = approvals;
        if (approvals >= r.approvalsRequired) r.status = RunStatus.Approved;
        emit RunApproved(runId, msg.sender, approvals);
    }

    // ------------------------------------------------------------------
    // Funding & publication
    // ------------------------------------------------------------------

    function fund(uint256 runId) external whenNotPaused nonReentrant {
        _fund(runId);
    }

    function fundWithPermit(uint256 runId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
        nonReentrant
    {
        uint256 amount = _run(runId).allocated;
        // A front-run permit only consumes the nonce; the allowance still lands, so ignore failure.
        try IERC20Permit(address(_token)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _fund(runId);
    }

    function _fund(uint256 runId) internal {
        Run storage r = _run(runId);
        _requireAny(r.orgId, ROLE_ADMIN);
        _requireStatus(runId, r, RunStatus.Approved);
        uint128 amount = r.allocated;
        if (amount == 0) revert EmptyRun();
        // Approvals must still be backed by wallets that hold APPROVER right now.
        uint8 valid = _validApprovals(runId, r.orgId);
        if (valid < r.approvalsRequired) revert ApprovalsRevoked(runId, valid, r.approvalsRequired);

        // Effects before the external call; status change also blocks double funding.
        r.status = RunStatus.Funded;
        r.funder = msg.sender;
        r.funded = amount;
        r.fundedAt = uint64(block.timestamp);
        _totalHeld += amount;

        uint256 before = _token.balanceOf(address(this));
        _token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = _token.balanceOf(address(this)) - before;
        if (received != amount) revert FundingShortfall(amount, received);

        emit RunFunded(runId, msg.sender, amount);
    }

    function publish(uint256 runId) external whenNotPaused {
        Run storage r = _run(runId);
        _requireAny(r.orgId, ROLE_ADMIN);
        _requireStatus(runId, r, RunStatus.Funded);
        if (r.allocated == 0) revert EmptyRun();

        uint64 deadline = uint64(block.timestamp) + r.claimWindow;
        r.status = RunStatus.Published;
        r.publishedAt = uint64(block.timestamp);
        r.claimDeadline = deadline;
        emit RunPublished(runId, deadline);
    }

    // ------------------------------------------------------------------
    // Claims
    // ------------------------------------------------------------------

    function claim(uint256 pid) external nonReentrant {
        (address to, uint128 amount) = _claim(pid);
        _token.safeTransfer(to, amount);
    }

    function claimMany(uint256[] calldata pids) external nonReentrant {
        uint256 n = pids.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_CLAIM_BATCH) revert BatchTooLarge(n, MAX_CLAIM_BATCH);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            (, uint128 amount) = _claim(pids[i]);
            total += amount;
        }
        _token.safeTransfer(msg.sender, total);
    }

    /// @dev Effects only. Caller transfers. Recipient is always msg.sender.
    function _claim(uint256 pid) internal returns (address, uint128) {
        uint256 runId = pid >> 32;
        Run storage r = _run(runId);
        Payment storage p = _payments[pid];
        if (p.status == PaymentStatus.None) revert PaymentNotFound(pid);
        if (p.recipient != msg.sender) revert NotRecipient(pid, msg.sender);
        if (p.status != PaymentStatus.Allocated) revert PaymentNotClaimable(pid, p.status);
        _requireStatus(runId, r, RunStatus.Published);
        if (block.timestamp > r.claimDeadline) revert ClaimWindowClosed(runId, r.claimDeadline);

        uint128 amount = p.amount;
        p.status = PaymentStatus.Claimed;
        p.claimedAt = uint64(block.timestamp);
        r.claimed += amount;
        r.claimedCount += 1;
        _totalHeld -= amount;

        emit PaymentClaimed(pid, runId, msg.sender, amount);
        return (msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Cancellation, expiry, refunds
    // ------------------------------------------------------------------

    function cancelRun(uint256 runId) external {
        Run storage r = _run(runId);
        RunStatus s = r.status;
        if (s == RunStatus.Funded || s == RunStatus.Approved) {
            // Approved runs carry the approvers' sign-off; only an admin may throw it away.
            _requireAny(r.orgId, ROLE_ADMIN);
        } else if (s == RunStatus.Draft || s == RunStatus.PendingApproval) {
            _requireAny(r.orgId, ROLE_OPERATOR | ROLE_ADMIN);
        } else {
            revert InvalidStatus(runId, s);
        }
        r.status = RunStatus.Cancelled;
        emit RunCancelled(runId, msg.sender);
    }

    /// @notice Permissionless once the claim window has closed: it only moves unclaimed money
    ///         from "owed" to "refundable to the funder", so nothing sits stuck without an admin.
    function expireRun(uint256 runId) external {
        Run storage r = _run(runId);
        _requireStatus(runId, r, RunStatus.Published);
        if (block.timestamp <= r.claimDeadline) revert ClaimWindowOpen(runId, r.claimDeadline);
        r.status = RunStatus.Expired;
        emit RunExpired(runId, r.allocated - r.claimed);
    }

    /// @notice Anyone may call: the amount is fixed by the ledger and always goes to `run.funder`,
    ///         so a funder who left the org (or an org with no admin) can still get unclaimed money back.
    function refund(uint256 runId) external nonReentrant returns (uint128 amount) {
        Run storage r = _run(runId);
        amount = _refundable(r);
        if (amount == 0) revert NothingToRefund(runId);

        r.refunded += amount;
        _totalHeld -= amount;
        address to = r.funder;
        _token.safeTransfer(to, amount);
        emit Refunded(runId, to, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function token() external view returns (address) {
        return address(_token);
    }

    function registry() external view returns (address) {
        return address(_registry);
    }

    function runCount() external view returns (uint256) {
        return _runCount;
    }

    function totalHeld() external view returns (uint256) {
        return _totalHeld;
    }

    function getRun(uint256 runId) external view returns (Run memory) {
        return _run(runId);
    }

    function getPayment(uint256 pid) external view returns (Payment memory p) {
        p = _payments[pid];
        if (p.status == PaymentStatus.None) revert PaymentNotFound(pid);
    }

    function getPayments(uint256 runId, uint32 fromIndex, uint32 count) external view returns (Payment[] memory out) {
        Run storage r = _run(runId);
        uint256 total = r.paymentCount;
        if (fromIndex >= total) return new Payment[](0);
        uint256 end = uint256(fromIndex) + count > total ? total : uint256(fromIndex) + count;
        out = new Payment[](end - fromIndex);
        for (uint256 i = fromIndex; i < end; ++i) {
            out[i - fromIndex] = _payments[_paymentId(runId, uint32(i))];
        }
    }

    function paymentId(uint256 runId, uint32 index) external pure returns (uint256) {
        return _paymentId(runId, index);
    }

    function liability(uint256 runId) external view returns (uint128) {
        return _liability(_run(runId));
    }

    function refundable(uint256 runId) external view returns (uint128) {
        return _refundable(_run(runId));
    }

    function hasApproved(uint256 runId, address approver) external view returns (bool) {
        return _approvedBy[keccak256(abi.encode(runId, _approvalRound[runId], approver))];
    }

    function approversOf(uint256 runId) external view returns (address[] memory) {
        return _approvers[runId];
    }

    function validApprovals(uint256 runId) external view returns (uint8) {
        return _validApprovals(runId, _run(runId).orgId);
    }

    function runIdByRef(uint256 orgId, bytes32 runRef) external view returns (uint256) {
        return _runByRef[orgId][runRef];
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _paymentId(uint256 runId, uint32 index) internal pure returns (uint256) {
        return (runId << 32) | uint256(index);
    }

    function _run(uint256 runId) internal view returns (Run storage r) {
        r = _runs[runId];
        if (r.status == RunStatus.None) revert RunNotFound(runId);
    }

    function _requireStatus(uint256 runId, Run storage r, RunStatus expected) internal view {
        if (r.status != expected) revert InvalidStatus(runId, r.status);
    }

    function _requireAny(uint256 orgId, uint8 mask) internal view {
        if (_registry.rolesOf(orgId, msg.sender) & mask == 0) revert NotAuthorized(orgId, msg.sender, mask);
    }

    function _validApprovals(uint256 runId, uint256 orgId) internal view returns (uint8 n) {
        address[] storage list = _approvers[runId];
        for (uint256 i; i < list.length; ++i) {
            if (_registry.rolesOf(orgId, list[i]) & ROLE_APPROVER != 0) ++n;
        }
    }

    function _liability(Run storage r) internal view returns (uint128) {
        if (r.status == RunStatus.Funded || r.status == RunStatus.Published) return r.allocated - r.claimed;
        return 0;
    }

    function _refundable(Run storage r) internal view returns (uint128) {
        return r.funded - r.claimed - r.refunded - _liability(r);
    }
}
