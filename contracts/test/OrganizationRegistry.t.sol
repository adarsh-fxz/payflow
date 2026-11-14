// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrganizationRegistry} from "../src/OrganizationRegistry.sol";
import {IOrganizationRegistry} from "../src/interfaces/IOrganizationRegistry.sol";

contract OrganizationRegistryTest is Test {
    OrganizationRegistry reg;
    address owner = makeAddr("owner");
    address admin = makeAddr("admin");
    address op = makeAddr("op");
    address other = makeAddr("other");
    uint256 orgId;

    function setUp() public {
        reg = new OrganizationRegistry();
        vm.prank(owner);
        orgId = reg.createOrganization(keccak256("meta"));
    }

    function test_create() public view {
        IOrganizationRegistry.Organization memory o = reg.getOrganization(orgId);
        assertEq(o.owner, owner);
        assertEq(o.approvalsRequired, 1);
        assertEq(o.metadataHash, keccak256("meta"));
        assertEq(reg.organizationCount(), 1);
        assertEq(reg.rolesOf(orgId, owner), 7);
        assertTrue(reg.hasRole(orgId, owner, 1));
        assertTrue(reg.exists(orgId));
        assertFalse(reg.exists(2));
    }

    function test_ownerSetsRoles() public {
        vm.prank(owner);
        reg.setMemberRoles(orgId, admin, 1);
        assertTrue(reg.hasRole(orgId, admin, 1));
        assertFalse(reg.hasRole(orgId, admin, 2));
        assertFalse(reg.hasRole(orgId, admin, 0));
    }

    function test_adminManagesNonAdmins() public {
        vm.prank(owner);
        reg.setMemberRoles(orgId, admin, 1);
        vm.prank(admin);
        reg.setMemberRoles(orgId, op, 4);
        assertEq(reg.rolesOf(orgId, op), 4);
        vm.prank(admin); // admins can't grant APPROVER (it gates their own runs)
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotOwner.selector, orgId, admin));
        reg.setMemberRoles(orgId, op, 4 | 2);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotOwner.selector, orgId, admin));
        reg.setMemberRoles(orgId, op, 1);
        vm.prank(admin);
        reg.setMemberRoles(orgId, op, 0);
        assertEq(reg.rolesOf(orgId, op), 0);
        vm.prank(owner);
        reg.setMemberRoles(orgId, other, 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotOwner.selector, orgId, admin));
        reg.setMemberRoles(orgId, other, 0);
    }

    function test_nonMemberCannotSetRoles() public {
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotAuthorized.selector, orgId, op, uint8(1)));
        reg.setMemberRoles(orgId, other, 4);
    }

    function test_invalidRolesAndMembers() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.InvalidRoles.selector, uint8(8)));
        reg.setMemberRoles(orgId, op, 8);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.InvalidMember.selector, address(0)));
        reg.setMemberRoles(orgId, address(0), 4);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.InvalidMember.selector, owner));
        reg.setMemberRoles(orgId, owner, 0);
        vm.stopPrank();
    }

    function test_approvalsRequired() public {
        vm.prank(owner);
        reg.setApprovalsRequired(orgId, 3);
        assertEq(reg.getOrganization(orgId).approvalsRequired, 3);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.InvalidApprovals.selector, uint8(0)));
        reg.setApprovalsRequired(orgId, 0);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.InvalidApprovals.selector, uint8(11)));
        reg.setApprovalsRequired(orgId, 11);
        vm.stopPrank();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotOwner.selector, orgId, admin));
        reg.setApprovalsRequired(orgId, 2);
    }

    function test_twoStepOwnership() public {
        vm.prank(owner);
        reg.setMemberRoles(orgId, admin, 1);
        vm.prank(owner);
        reg.transferOwnership(orgId, admin);
        assertEq(reg.getOrganization(orgId).owner, owner);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotPendingOwner.selector, orgId, other));
        reg.acceptOwnership(orgId);
        vm.prank(admin);
        reg.acceptOwnership(orgId);
        assertEq(reg.getOrganization(orgId).owner, admin);
        assertEq(reg.rolesOf(orgId, admin), 7);
        assertFalse(reg.hasRole(orgId, owner, 1));
    }

    function test_metadataUpdate() public {
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.NotAuthorized.selector, orgId, op, uint8(1)));
        reg.setMetadata(orgId, bytes32("x"));
        vm.prank(owner);
        reg.setMetadata(orgId, bytes32("x"));
        assertEq(reg.getOrganization(orgId).metadataHash, bytes32("x"));
    }

    function test_unknownOrg() public {
        vm.expectRevert(abi.encodeWithSelector(IOrganizationRegistry.OrgNotFound.selector, 5));
        reg.getOrganization(5);
        assertFalse(reg.hasRole(5, owner, 1));
        assertEq(reg.rolesOf(5, address(0)), 0);
    }
}
