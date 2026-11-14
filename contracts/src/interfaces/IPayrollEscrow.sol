// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IPayrollEscrow — central MUSD escrow for every PayFlow payroll run.
/// @notice FROZEN INTERFACE.
///
/// Lifecycle:  Draft → PendingApproval → Approved → Funded → Published → Expired
///             (Draft..Funded) → Cancelled;   PendingApproval/Approved → Draft (returnToDraft)
///
/// Payment ids are deterministic: paymentId = (runId << 32) | index, index starting at 0.
///
/// Accounting per run (all MUSD wei):
///   allocated  = sum of non-cancelled payment amounts
///   liability  = allocated - claimed   while Funded or Published, else 0
///   (refundable is therefore 0 while Funded/Published: only Cancelled or Expired runs refund)
///   refundable = funded - claimed - refunded - liability
/// Global: token.balanceOf(escrow) >= totalHeld = Σ (funded - claimed - refunded)
interface IPayrollEscrow {
    enum RunStatus {
        None,
        Draft,
        PendingApproval,
        Approved,
        Funded,
        Published,
        Cancelled,
        Expired
    }

    enum PaymentStatus {
        None,
        Allocated,
        Claimed,
        Cancelled
    }

    struct Run {
        uint256 orgId;
        bytes32 runRef; // keccak of the off-chain run UUID; unique per org
        bytes32 paymentsHash; // rolling commitment over the claim window and every add/cancel
        address creator;
        address funder; // refunds always go here
        RunStatus status;
        uint8 approvalsRequired; // snapshotted at submit
        uint8 approvals;
        uint32 paymentCount;
        uint32 claimedCount;
        uint32 claimWindow; // seconds, counted from publish
        uint64 createdAt;
        uint64 fundedAt;
        uint64 publishedAt;
        uint64 claimDeadline;
        uint128 allocated;
        uint128 funded;
        uint128 claimed;
        uint128 refunded;
    }

    struct Payment {
        address recipient;
        uint64 claimedAt;
        PaymentStatus status;
        uint128 amount;
    }

    event RunCreated(uint256 indexed runId, uint256 indexed orgId, bytes32 indexed runRef, address creator, uint32 claimWindow);
    event PaymentAllocated(uint256 indexed paymentId, uint256 indexed runId, address indexed recipient, uint128 amount);
    event PaymentCancelled(uint256 indexed paymentId, uint256 indexed runId, uint128 amount);
    event RunSubmitted(uint256 indexed runId, bytes32 paymentsHash, uint32 paymentCount, uint128 allocated, uint8 approvalsRequired);
    event RunApproved(uint256 indexed runId, address indexed approver, uint8 approvals);
    event RunReturnedToDraft(uint256 indexed runId, address indexed by);
    event RunFunded(uint256 indexed runId, address indexed funder, uint128 amount);
    event RunPublished(uint256 indexed runId, uint64 claimDeadline);
    event PaymentClaimed(uint256 indexed paymentId, uint256 indexed runId, address indexed recipient, uint128 amount);
    event RunCancelled(uint256 indexed runId, address indexed by);
    event RunExpired(uint256 indexed runId, uint128 unclaimed);
    event Refunded(uint256 indexed runId, address indexed to, uint128 amount);

    error RunNotFound(uint256 runId);
    error PaymentNotFound(uint256 paymentId);
    error InvalidStatus(uint256 runId, RunStatus status);
    error NotAuthorized(uint256 orgId, address caller, uint8 role);
    error DuplicateRunRef(uint256 orgId, bytes32 runRef);
    error InvalidClaimWindow(uint32 claimWindow);
    error EmptyBatch();
    error BatchTooLarge(uint256 length, uint256 max);
    error LengthMismatch();
    error IndexMismatch(uint32 expected, uint32 actual);
    error InvalidRecipient(address recipient);
    error InvalidAmount();
    error TooManyPayments();
    error EmptyRun();
    error HashMismatch(bytes32 expected, bytes32 actual);
    error AlreadyApproved(uint256 runId, address approver);
    error NotRecipient(uint256 paymentId, address caller);
    error PaymentNotClaimable(uint256 paymentId, PaymentStatus status);
    error ClaimWindowClosed(uint256 runId, uint64 claimDeadline);
    error ClaimWindowOpen(uint256 runId, uint64 claimDeadline);
    error NothingToRefund(uint256 runId);
    error FundingShortfall(uint256 expected, uint256 received);
    error OrgNotFound(uint256 orgId);
    error ApprovalsRevoked(uint256 runId, uint8 valid, uint8 required);

    // ---- run building (OPERATOR) ----
    function createRun(uint256 orgId, bytes32 runRef, uint32 claimWindow) external returns (uint256 runId);
    /// @param expectedIndex must equal the run's current paymentCount — makes replayed batches revert.
    function addPayments(uint256 runId, uint32 expectedIndex, address[] calldata recipients, uint128[] calldata amounts) external;
    /// @notice OPERATOR/ADMIN, Draft only. After submit the approved list is frozen.
    function cancelPayment(uint256 paymentId) external;
    function submitForApproval(uint256 runId) external;
    /// @notice PendingApproval: OPERATOR, APPROVER or ADMIN. Approved: ADMIN only. Resets approvals.
    function returnToDraft(uint256 runId) external;

    // ---- approval (APPROVER) ----
    /// @param expectedPaymentsHash the commitment the approver reviewed.
    function approve(uint256 runId, bytes32 expectedPaymentsHash) external;

    // ---- money (ADMIN) ----
    /// @notice Reverts ApprovalsRevoked if fewer than approvalsRequired approvers still hold APPROVER.
    function fund(uint256 runId) external;
    function fundWithPermit(uint256 runId, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
    function publish(uint256 runId) external;
    /// @notice Draft/PendingApproval: OPERATOR or ADMIN. Approved/Funded: ADMIN only.
    function cancelRun(uint256 runId) external;
    /// @notice Anyone, once block.timestamp > claimDeadline.
    function expireRun(uint256 runId) external;
    /// @notice Anyone; pays refundable(runId) to run.funder only.
    function refund(uint256 runId) external returns (uint128 amount);

    // ---- recipients (permissionless to submit, only the designated wallet succeeds) ----
    function claim(uint256 paymentId) external;
    function claimMany(uint256[] calldata paymentIds) external;

    // ---- views ----
    function token() external view returns (address);
    function registry() external view returns (address);
    function MAX_BATCH() external view returns (uint256);
    function runCount() external view returns (uint256);
    function totalHeld() external view returns (uint256);
    function getRun(uint256 runId) external view returns (Run memory);
    function getPayment(uint256 paymentId) external view returns (Payment memory);
    function getPayments(uint256 runId, uint32 fromIndex, uint32 count) external view returns (Payment[] memory);
    function paymentId(uint256 runId, uint32 index) external pure returns (uint256);
    function liability(uint256 runId) external view returns (uint128);
    function refundable(uint256 runId) external view returns (uint128);
    function approversOf(uint256 runId) external view returns (address[] memory);
    function validApprovals(uint256 runId) external view returns (uint8);
    function hasApproved(uint256 runId, address approver) external view returns (bool);
    function runIdByRef(uint256 orgId, bytes32 runRef) external view returns (uint256);
}
