// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOrganizationRegistry} from "./interfaces/IOrganizationRegistry.sol";

/// @title OrganizationRegistry
/// @notice Organization identity, two-step ownership and per-member role bitmasks.
///         Holds no funds. PayrollEscrow reads `hasRole` for every privileged action.
contract OrganizationRegistry is IOrganizationRegistry {
    uint8 public constant ROLE_ADMIN = 1;
    uint8 public constant ROLE_APPROVER = 2;
    uint8 public constant ROLE_OPERATOR = 4;
    uint8 internal constant ALL_ROLES = 7;
    uint8 internal constant MAX_APPROVALS = 10;

    uint256 private _count;
    mapping(uint256 => Organization) private _orgs;
    mapping(uint256 => mapping(address => uint8)) private _roles;

    modifier onlyExisting(uint256 orgId) {
        if (_orgs[orgId].owner == address(0)) revert OrgNotFound(orgId);
        _;
    }

    modifier onlyOwner(uint256 orgId) {
        address owner = _orgs[orgId].owner;
        if (owner == address(0)) revert OrgNotFound(orgId);
        if (msg.sender != owner) revert NotOwner(orgId, msg.sender);
        _;
    }

    function createOrganization(bytes32 metadataHash) external returns (uint256 orgId) {
        orgId = ++_count;
        _orgs[orgId] = Organization({
            owner: msg.sender,
            pendingOwner: address(0),
            approvalsRequired: 1,
            createdAt: uint64(block.timestamp),
            metadataHash: metadataHash
        });
        emit OrganizationCreated(orgId, msg.sender, metadataHash);
    }

    function setMetadata(uint256 orgId, bytes32 metadataHash) external onlyExisting(orgId) {
        if (!hasRole(orgId, msg.sender, ROLE_ADMIN)) revert NotAuthorized(orgId, msg.sender, ROLE_ADMIN);
        _orgs[orgId].metadataHash = metadataHash;
        emit MetadataUpdated(orgId, metadataHash);
    }

    function setMemberRoles(uint256 orgId, address member, uint8 roles) external onlyExisting(orgId) {
        if (roles & ~ALL_ROLES != 0) revert InvalidRoles(roles);
        Organization storage org = _orgs[orgId];
        if (member == address(0) || member == org.owner) revert InvalidMember(member);

        if (msg.sender != org.owner) {
            // Admins may only grant or remove OPERATOR on members holding no other role.
            // ADMIN and APPROVER are owner-only, so an admin can never mint the approvals
            // that gate their own runs (or strip the approvers who would block them).
            if (_roles[orgId][msg.sender] & ROLE_ADMIN == 0) revert NotAuthorized(orgId, msg.sender, ROLE_ADMIN);
            if (roles & ~ROLE_OPERATOR != 0 || _roles[orgId][member] & ~ROLE_OPERATOR != 0) {
                revert NotOwner(orgId, msg.sender);
            }
        }
        _roles[orgId][member] = roles;
        emit MemberRolesSet(orgId, member, roles, msg.sender);
    }

    function setApprovalsRequired(uint256 orgId, uint8 approvalsRequired) external onlyOwner(orgId) {
        if (approvalsRequired == 0 || approvalsRequired > MAX_APPROVALS) revert InvalidApprovals(approvalsRequired);
        _orgs[orgId].approvalsRequired = approvalsRequired;
        emit ApprovalsRequiredSet(orgId, approvalsRequired);
    }

    /// @notice Pass address(0) to cancel a pending transfer.
    function transferOwnership(uint256 orgId, address newOwner) external onlyOwner(orgId) {
        if (newOwner == msg.sender) revert InvalidMember(newOwner);
        _orgs[orgId].pendingOwner = newOwner;
        emit OwnershipTransferStarted(orgId, msg.sender, newOwner);
    }

    function acceptOwnership(uint256 orgId) external onlyExisting(orgId) {
        Organization storage org = _orgs[orgId];
        if (msg.sender != org.pendingOwner) revert NotPendingOwner(orgId, msg.sender);
        address previous = org.owner;
        org.owner = msg.sender;
        org.pendingOwner = address(0);
        // The new owner's explicit role bits are redundant; clear them so removal is clean later.
        delete _roles[orgId][msg.sender];
        emit OwnershipTransferred(orgId, previous, msg.sender);
    }

    function organizationCount() external view returns (uint256) {
        return _count;
    }

    function getOrganization(uint256 orgId) external view onlyExisting(orgId) returns (Organization memory) {
        return _orgs[orgId];
    }

    function rolesOf(uint256 orgId, address account) external view returns (uint8) {
        if (account != address(0) && _orgs[orgId].owner == account) return ALL_ROLES;
        return _roles[orgId][account];
    }

    function hasRole(uint256 orgId, address account, uint8 role) public view returns (bool) {
        address owner = _orgs[orgId].owner;
        if (owner == address(0)) return false;
        if (account == owner) return true;
        return role != 0 && _roles[orgId][account] & role == role;
    }

    function exists(uint256 orgId) external view returns (bool) {
        return _orgs[orgId].owner != address(0);
    }
}
