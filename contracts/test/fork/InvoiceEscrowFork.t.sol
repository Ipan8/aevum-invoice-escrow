// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceEscrow} from "../../src/InvoiceEscrow.sol";
import {Signing} from "../Signing.sol";

interface ITUSD8 is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

/// @notice Runs InvoiceEscrow against the REAL tUSD8 on a local fork of Aevum testnet.
///         No funds needed: `deal` writes balances into the fork only.
///         Run with: make test-fork (or: forge test --match-path 'test/fork/*' --fork-url aevum)
contract InvoiceEscrowForkTest is Test {
    ITUSD8 constant TUSD8 = ITUSD8(0x456569838f1d43009A91ebA4263147Afd7233483);

    InvoiceEscrow escrow;
    address freelancer = makeAddr("freelancer");
    address client = makeAddr("client");
    address arbiter = makeAddr("arbiter");

    bytes32 constant INV = keccak256("fork-invoice-1");
    uint256 constant AMOUNT = 25e6; // 25 tUSD8

    function setUp() public {
        escrow = new InvoiceEscrow(TUSD8);
        deal(address(TUSD8), client, 1_000e6);
    }

    function _create() internal {
        vm.prank(freelancer);
        escrow.createInvoice(
            INV, client, arbiter, AMOUNT, uint64(block.timestamp + 7 days), uint64(block.timestamp + 14 days), 0, 0, keccak256("fork work")
        );
    }

    function test_realTusd8_fullFlow_standard() public {
        _create();

        vm.startPrank(client);
        TUSD8.approve(address(escrow), AMOUNT);
        escrow.fundInvoice(INV, AMOUNT);
        escrow.approveMilestone(INV);
        vm.stopPrank();

        assertEq(TUSD8.balanceOf(freelancer), AMOUNT);
        assertEq(TUSD8.balanceOf(address(escrow)), 0);
        assertEq(uint256(escrow.invoiceOf(INV).status), uint256(InvoiceEscrow.Status.Released));
    }

    function test_realTusd8_fundGasless() public {
        (address gaslessClient, uint256 key) = makeAddrAndKey("forkGasless");
        deal(address(TUSD8), gaslessClient, 1_000e6);
        vm.prank(freelancer);
        escrow.createInvoice(
            INV, gaslessClient, arbiter, AMOUNT, uint64(block.timestamp + 7 days), uint64(block.timestamp + 14 days), 0, 0, keccak256("fork work")
        );

        uint256 deadline = block.timestamp + 1 hours;
        Signing.Auth memory a = Signing.Auth({
            from: gaslessClient,
            to: address(escrow),
            value: AMOUNT,
            validAfter: 0,
            validBefore: deadline,
            nonce: escrow.authorizationNonce(INV)
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, key, TUSD8.DOMAIN_SEPARATOR(), a);

        vm.prank(makeAddr("relayer"));
        escrow.fundInvoiceWithAuthorization(INV, gaslessClient, AMOUNT, 0, deadline, v, r, s);

        assertEq(TUSD8.balanceOf(address(escrow)), AMOUNT);
        assertTrue(TUSD8.authorizationState(gaslessClient, escrow.authorizationNonce(INV)));
    }

    function test_realTusd8_disputeRefund() public {
        _create();
        vm.startPrank(client);
        TUSD8.approve(address(escrow), AMOUNT);
        escrow.fundInvoice(INV, AMOUNT);
        escrow.raiseDispute(INV);
        vm.stopPrank();

        uint256 before = TUSD8.balanceOf(client);
        vm.prank(arbiter);
        escrow.resolveDispute(INV, false);
        assertEq(TUSD8.balanceOf(client), before + AMOUNT);
        assertEq(uint256(escrow.invoiceOf(INV).status), uint256(InvoiceEscrow.Status.Refunded));
    }
}
