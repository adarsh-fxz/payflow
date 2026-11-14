// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IOrganizationRegistry — on-chain identity and roles for PayFlow organizations.
/// @notice FROZEN INTERFACE. Only data that benefits from being on-chain lives here:
///         the owner, member role bitmasks and the approval threshold. Names, logos and
///         descriptions stay off-chain; `metadataHash` commits to them.
interface IOrganizationRegistry {
    /// Role bits. The owner implicitly holds every role.
    /// ADMIN    — fund, publish, cancel and refund runs; manage OPERATOR members.
    /// APPROVER — approve runs that are pending approval.
    /// OPERATOR — create runs, add/cancel draft payments, submit for approval. Cannot move funds.
    // uint8 constant ROLE_ADMIN = 1; ROLE_APPROVER = 2; ROLE_OPERATOR = 4;

    struct Organization {
        address owner;
        address pendingOwner;
        uint8 approvalsRequired; // 1..10
        uint64 createdAt;
        bytes32 metadataHash;
    }

    event OrganizationCreated(uint256 indexed orgId, address indexed owner, bytes32 metadataHash);
    event MetadataUpdated(uint256 indexed orgId, bytes32 metadataHash);
    event MemberRolesSet(uint256 indexed orgId, address indexed member, uint8 roles, address indexed by);
    event ApprovalsRequiredSet(uint256 indexed orgId, uint8 approvalsRequired);
    event OwnershipTransferStarted(uint256 indexed orgId, address indexed from, address indexed to);
    event OwnershipTransferred(uint256 indexed orgId, address indexed from, address indexed to);

    error OrgNotFound(uint256 orgId);
    error NotOwner(uint256 orgId, address caller);
    error NotAuthorized(uint256 orgId, address caller, uint8 role);
    error InvalidRoles(uint8 roles);
    error InvalidMember(address member);
    error InvalidApprovals(uint8 approvalsRequired);
    error NotPendingOwner(uint256 orgId, address caller);

    function ROLE_ADMIN() external view returns (uint8);
    function ROLE_APPROVER() external view returns (uint8);
    function ROLE_OPERATOR() external view returns (uint8);

    function createOrganization(bytes32 metadataHash) external returns (uint256 orgId);
    function setMetadata(uint256 orgId, bytes32 metadataHash) external;
    /// @notice Owner may set any roles. An ADMIN may only grant/remove OPERATOR on members that hold
    ///         no ADMIN or APPROVER bit. roles = 0 removes the member.
    function setMemberRoles(uint256 orgId, address member, uint8 roles) external;
    function setApprovalsRequired(uint256 orgId, uint8 approvalsRequired) external;
    /// @notice Two-step; address(0) cancels a pending transfer.
    function transferOwnership(uint256 orgId, address newOwner) external;
    function acceptOwnership(uint256 orgId) external;

    function organizationCount() external view returns (uint256);
    function getOrganization(uint256 orgId) external view returns (Organization memory);
    function rolesOf(uint256 orgId, address account) external view returns (uint8);
    /// @notice True when `account` is the owner or holds every bit in `role`.
    function hasRole(uint256 orgId, address account, uint8 role) external view returns (bool);
    function exists(uint256 orgId) external view returns (bool);
}
