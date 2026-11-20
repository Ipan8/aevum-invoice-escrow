// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceEscrow} from "../src/InvoiceEscrow.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract InvoiceEscrowTest is Test {
    MockUSD8 token;
    InvoiceEscrow escrow;

    address freelancer = makeAddr("freelancer");
    address client = makeAddr("client");
    address arbiter = makeAddr("arbiter");
    address relayer = makeAddr("relayer");
    address stranger = makeAddr("stranger");
    address gaslessClient;
    uint256 gaslessKey;

    bytes32 constant INV = keccak256("invoice-1");
    uint256 constant AMOUNT = 250e6; // 250 tUSD8
    bytes32 constant DESC = keccak256("Website redesign, milestone 1");

    uint64 dueAt;
    uint64 autoReleaseAt;

    function setUp() public {
        (gaslessClient, gaslessKey) = makeAddrAndKey("gaslessClient");
        token = new MockUSD8();
        escrow = new InvoiceEscrow(IERC20(address(token)));
        token.mint(client, 10_000e6);
        token.mint(gaslessClient, 10_000e6);
        dueAt = uint64(block.timestamp + 7 days);
        autoReleaseAt = uint64(block.timestamp + 14 days);
    }

    function _create() internal returns (bytes32) {
        vm.prank(freelancer);
        escrow.createInvoice(INV, client, arbiter, AMOUNT, dueAt, autoReleaseAt, 0, 0, DESC);
        return INV;
    }

    function _createRecurring() internal returns (bytes32) {
        vm.prank(freelancer);
        escrow.createInvoice(INV, client, arbiter, AMOUNT, dueAt, autoReleaseAt, 7 days, 2, DESC);
        return INV;
    }

    function _fund(bytes32 id) internal {
        vm.startPrank(client);
        token.approve(address(escrow), AMOUNT);
        escrow.fundInvoice(id, AMOUNT);
        vm.stopPrank();
    }

    // ---------- create ----------

    function test_create_storesInvoice() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit InvoiceEscrow.InvoiceCreated(INV, freelancer, client, AMOUNT, dueAt, autoReleaseAt, 0, 0);
        vm.prank(freelancer);
        escrow.createInvoice(INV, client, arbiter, AMOUNT, dueAt, autoReleaseAt, 0, 0, DESC);

        InvoiceEscrow.Invoice memory inv = escrow.invoiceOf(INV);
        assertEq(inv.freelancer, freelancer);
        assertEq(inv.client, client);
        assertEq(inv.arbiter, arbiter);
        assertEq(inv.amount, AMOUNT);
        assertEq(inv.dueAt, dueAt);
        assertEq(inv.autoReleaseAt, autoReleaseAt);
        assertEq(inv.descriptionHash, DESC);
        assertEq(uint256(inv.status), uint256(InvoiceEscrow.Status.Created));
        assertFalse(inv.disputed);
        assertEq(inv.cycle, 0);
        assertEq(inv.rootId, INV);
    }

    function test_create_revertsOnDuplicate() public {
        _create();
        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.AlreadyExists.selector, INV));
        escrow.createInvoice(INV, client, arbiter, AMOUNT, dueAt, autoReleaseAt, 0, 0, DESC);
    }

    function test_create_revertsOnZeroAmount() public {
        vm.prank(freelancer);
        vm.expectRevert(InvoiceEscrow.ZeroAmount.selector);
        escrow.createInvoice(INV, client, arbiter, 0, dueAt, autoReleaseAt, 0, 0, DESC);
    }

    function test_create_revertsOnZeroClient() public {
        vm.prank(freelancer);
        vm.expectRevert(InvoiceEscrow.ZeroAddress.selector);
        escrow.createInvoice(INV, address(0), arbiter, AMOUNT, dueAt, autoReleaseAt, 0, 0, DESC);
    }

    function test_create_revertsOnSelfInvoice() public {
        vm.prank(freelancer);
        vm.expectRevert(InvoiceEscrow.SelfInvoice.selector);
        escrow.createInvoice(INV, freelancer, arbiter, AMOUNT, dueAt, autoReleaseAt, 0, 0, DESC);
    }

    function test_create_revertsOnBadDeadline() public {
        vm.prank(freelancer);
        vm.expectRevert(InvoiceEscrow.BadDeadline.selector);
        escrow.createInvoice(INV, client, arbiter, AMOUNT, uint64(block.timestamp), autoReleaseAt, 0, 0, DESC);
        vm.prank(freelancer);
        vm.expectRevert(InvoiceEscrow.BadDeadline.selector);
        escrow.createInvoice(INV, client, arbiter, AMOUNT, dueAt, dueAt - 1, 0, 0, DESC);
    }

    function test_invoiceOf_revertsWhenMissing() public {
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.NotFound.selector, INV));
        escrow.invoiceOf(INV);
    }

    // ---------- fund (standard) ----------

    function test_fund_movesToEscrow() public {
        _create();
        // Approve first: it emits its own Approval event, which would shadow the expectEmit below.
        vm.startPrank(client);
        token.approve(address(escrow), AMOUNT);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit InvoiceEscrow.InvoiceFunded(INV, client, AMOUNT);
        escrow.fundInvoice(INV, AMOUNT);
        vm.stopPrank();

        assertEq(token.balanceOf(address(escrow)), AMOUNT);
        assertEq(token.balanceOf(client), 10_000e6 - AMOUNT);
        InvoiceEscrow.Invoice memory inv = escrow.invoiceOf(INV);
        assertEq(uint256(inv.status), uint256(InvoiceEscrow.Status.Funded));
        assertEq(inv.fundedAt, block.timestamp);
    }

    function test_fund_revertsOnWrongAmount() public {
        _create();
        vm.startPrank(client);
        token.approve(address(escrow), AMOUNT);
        // Dust payment must never mark the invoice as funded (kit gotcha).
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.WrongAmount.selector, AMOUNT, 1));
        escrow.fundInvoice(INV, 1);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.WrongAmount.selector, AMOUNT, AMOUNT + 1));
        escrow.fundInvoice(INV, AMOUNT + 1);
        vm.stopPrank();
        assertEq(uint256(escrow.invoiceOf(INV).status), uint256(InvoiceEscrow.Status.Created));
    }

    function test_fund_revertsForNonClient() public {
        _create();
        vm.startPrank(stranger);
        token.approve(address(escrow), AMOUNT);
        vm.expectRevert(InvoiceEscrow.NotClient.selector);
        escrow.fundInvoice(INV, AMOUNT);
        vm.stopPrank();
    }

    function test_fund_revertsTwice() public {
        _create();
        _fund(INV);
        vm.startPrank(client);
        token.approve(address(escrow), AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceEscrow.WrongStatus.selector, INV, InvoiceEscrow.Status.Funded
            )
        );
        escrow.fundInvoice(INV, AMOUNT);
        vm.stopPrank();
    }

    function test_fund_revertsWithoutApproval() public {
        _create();
        vm.prank(client);
        vm.expectRevert();
        escrow.fundInvoice(INV, AMOUNT);
    }

    // ---------- fund (gasless, EIP-3009) ----------

    function _signGasless(bytes32 id, uint256 value, uint256 validBefore)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        Signing.Auth memory a = Signing.Auth({
            from: gaslessClient,
            to: address(escrow),
            value: value,
            validAfter: 0,
            validBefore: validBefore,
            nonce: escrow.authorizationNonce(id)
        });
        return Signing.signReceive(vm, gaslessKey, token.DOMAIN_SEPARATOR(), a);
    }

    function _createGasless() internal returns (bytes32) {
        vm.prank(freelancer);
        escrow.createInvoice(INV, gaslessClient, arbiter, AMOUNT, dueAt, autoReleaseAt, 0, 0, DESC);
        return INV;
    }

    function test_fundGasless_relayerSubmits() public {
        _createGasless();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signGasless(INV, AMOUNT, deadline);

        vm.prank(relayer); // the client never sends a transaction
        escrow.fundInvoiceWithAuthorization(INV, gaslessClient, AMOUNT, 0, deadline, v, r, s);

        assertEq(token.balanceOf(address(escrow)), AMOUNT);
        assertEq(token.balanceOf(gaslessClient), 10_000e6 - AMOUNT);
        assertEq(uint256(escrow.invoiceOf(INV).status), uint256(InvoiceEscrow.Status.Funded));
        assertTrue(token.authorizationState(gaslessClient, escrow.authorizationNonce(INV)));
    }

    function test_fundGasless_signatureBoundToInvoice() public {
        _createGasless();
        // A second invoice for the same client and amount, so only the signature can fail.
        bytes32 inv2 = keccak256("invoice-2");
        vm.prank(freelancer);
        escrow.createInvoice(inv2, gaslessClient, arbiter, AMOUNT, dueAt, autoReleaseAt, 0, 0, DESC);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signGasless(INV, AMOUNT, deadline);

        // Same signature, different invoice id: the nonce no longer matches, so it fails.
        vm.prank(relayer);
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        escrow.fundInvoiceWithAuthorization(inv2, gaslessClient, AMOUNT, 0, deadline, v, r, s);
    }

    function test_fundGasless_cannotChangeAmount() public {
        _createGasless();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signGasless(INV, AMOUNT, deadline);

        // The contract checks the amount against the invoice before the token call,
        // so a changed amount reverts here (the signature would fail too, as a second layer).
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.WrongAmount.selector, AMOUNT, AMOUNT + 1));
        escrow.fundInvoiceWithAuthorization(INV, gaslessClient, AMOUNT + 1, 0, deadline, v, r, s);
    }

    function test_fundGasless_revertsForWrongClient() public {
        _createGasless();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signGasless(INV, AMOUNT, deadline);

        vm.prank(relayer);
        vm.expectRevert(InvoiceEscrow.NotClient.selector);
        escrow.fundInvoiceWithAuthorization(INV, stranger, AMOUNT, 0, deadline, v, r, s);
    }

    // ---------- approve milestone ----------

    function test_approve_releasesToFreelancer() public {
        _create();
        _fund(INV);
        uint256 before = token.balanceOf(freelancer);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit InvoiceEscrow.InvoiceReleased(INV, freelancer, AMOUNT);
        vm.prank(client);
        escrow.approveMilestone(INV);

        assertEq(token.balanceOf(freelancer), before + AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint256(escrow.invoiceOf(INV).status), uint256(InvoiceEscrow.Status.Released));
    }

    function test_approve_revertsForNonClient() public {
        _create();
        _fund(INV);
        vm.prank(freelancer);
        vm.expectRevert(InvoiceEscrow.NotClient.selector);
        escrow.approveMilestone(INV);
    }

    function test_approve_revertsWhenUnfunded() public {
        _create();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.NotFunded.selector, INV));
        escrow.approveMilestone(INV);
    }

    // ---------- auto-release after deadline ----------

    function test_releaseAfterDeadline_anyoneCanCall() public {
        _create();
        _fund(INV);
        vm.warp(autoReleaseAt);
        vm.prank(stranger);
        escrow.releaseAfterDeadline(INV);
        assertEq(token.balanceOf(freelancer), AMOUNT);
        assertEq(uint256(escrow.invoiceOf(INV).status), uint256(InvoiceEscrow.Status.Released));
    }

    function test_releaseAfterDeadline_revertsTooEarly() public {
        _create();
        _fund(INV);
        vm.warp(autoReleaseAt - 1);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceEscrow.TooEarly.selector, autoReleaseAt - 1, autoReleaseAt)
        );
        escrow.releaseAfterDeadline(INV);
    }

    // ---------- dispute ----------

    function test_dispute_blocksReleaseAndRefundsViaArbiter() public {
        _create();
        _fund(INV);

        vm.prank(client);
        escrow.raiseDispute(INV);
        assertTrue(escrow.invoiceOf(INV).disputed);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.AlreadyDisputed.selector, INV));
        escrow.approveMilestone(INV);

        // Arbiter sides with the freelancer.
        vm.prank(arbiter);
        escrow.resolveDispute(INV, true);
        assertEq(token.balanceOf(freelancer), AMOUNT);
        assertEq(uint256(escrow.invoiceOf(INV).status), uint256(InvoiceEscrow.Status.Released));
        assertFalse(escrow.invoiceOf(INV).disputed);
    }

    function test_dispute_resolveRefund() public {
        _create();
        _fund(INV);
        vm.prank(freelancer);
        escrow.raiseDispute(INV);

        uint256 before = token.balanceOf(client);
        vm.prank(arbiter);
        escrow.resolveDispute(INV, false);
        assertEq(token.balanceOf(client), before + AMOUNT);
        assertEq(uint256(escrow.invoiceOf(INV).status), uint256(InvoiceEscrow.Status.Refunded));
    }

    function test_dispute_clientResolvesWhenNoArbiter() public {
        vm.prank(freelancer);
        escrow.createInvoice(INV, client, address(0), AMOUNT, dueAt, autoReleaseAt, 0, 0, DESC);
        _fund(INV);
        vm.prank(client);
        escrow.raiseDispute(INV);
        vm.prank(client);
        escrow.resolveDispute(INV, true);
        assertEq(token.balanceOf(freelancer), AMOUNT);
    }

    function test_dispute_revertsForStrangerAndNonArbiter() public {
        _create();
        _fund(INV);
        vm.prank(stranger);
        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        escrow.raiseDispute(INV);

        vm.prank(client);
        escrow.raiseDispute(INV);
        vm.prank(stranger);
        vm.expectRevert(InvoiceEscrow.NotArbiter.selector);
        escrow.resolveDispute(INV, true);
        vm.prank(client);
        vm.expectRevert(InvoiceEscrow.NotArbiter.selector);
        escrow.resolveDispute(INV, true);
    }

    function test_dispute_revertsWhenNotDisputed() public {
        _create();
        _fund(INV);
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.NotDisputed.selector, INV));
        escrow.resolveDispute(INV, true);
    }

    function test_dispute_revertsTwice() public {
        _create();
        _fund(INV);
        vm.prank(client);
        escrow.raiseDispute(INV);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.AlreadyDisputed.selector, INV));
        escrow.raiseDispute(INV);
    }

    // ---------- cancel / expire ----------

    function test_cancel_unfundedByFreelancer() public {
        _create();
        vm.prank(freelancer);
        escrow.cancelInvoice(INV);
        assertEq(uint256(escrow.invoiceOf(INV).status), uint256(InvoiceEscrow.Status.Cancelled));
    }

    function test_cancel_revertsForClientAndWhenFunded() public {
        _create();
        vm.prank(client);
        vm.expectRevert(InvoiceEscrow.NotFreelancer.selector);
        escrow.cancelInvoice(INV);

        _fund(INV);
        vm.prank(freelancer);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceEscrow.WrongStatus.selector, INV, InvoiceEscrow.Status.Funded
            )
        );
        escrow.cancelInvoice(INV);
    }

    function test_expire_unfundedAfterDue() public {
        _create();
        vm.warp(dueAt + 1);
        vm.prank(stranger);
        escrow.expireInvoice(INV);
        assertEq(uint256(escrow.invoiceOf(INV).status), uint256(InvoiceEscrow.Status.Expired));
    }

    function test_expire_revertsTooEarlyAndWhenFunded() public {
        _create();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceEscrow.TooEarly.selector, block.timestamp, dueAt)
        );
        escrow.expireInvoice(INV);

        _fund(INV);
        vm.warp(dueAt + 1);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceEscrow.WrongStatus.selector, INV, InvoiceEscrow.Status.Funded
            )
        );
        escrow.expireInvoice(INV);
    }

    // ---------- recurring ----------

    function test_renew_createsNextCycle() public {
        _createRecurring();
        _fund(INV);
        vm.prank(client);
        escrow.approveMilestone(INV);

        bytes32 nextId = keccak256(abi.encode(INV, uint8(1)));
        vm.prank(freelancer);
        bytes32 got = escrow.renewInvoice(INV);
        assertEq(got, nextId);

        InvoiceEscrow.Invoice memory next = escrow.invoiceOf(nextId);
        assertEq(next.freelancer, freelancer);
        assertEq(next.client, client);
        assertEq(next.amount, AMOUNT);
        assertEq(next.dueAt, dueAt + 7 days);
        assertEq(next.autoReleaseAt, autoReleaseAt + 7 days);
        assertEq(next.intervalSeconds, 7 days);
        assertEq(next.renewalsLeft, 1);
        assertEq(next.cycle, 1);
        assertEq(next.rootId, INV);
        assertEq(uint256(next.status), uint256(InvoiceEscrow.Status.Created));
        assertEq(escrow.invoiceOf(INV).renewalsLeft, 1);
    }

    function test_renew_chainsAndStopsAtZero() public {
        _createRecurring();
        _fund(INV);
        vm.prank(client);
        escrow.approveMilestone(INV);

        bytes32 id1 = keccak256(abi.encode(INV, uint8(1)));
        vm.prank(freelancer);
        escrow.renewInvoice(INV);

        _fund(id1);
        vm.prank(client);
        escrow.approveMilestone(id1);
        bytes32 id2 = keccak256(abi.encode(INV, uint8(2)));
        vm.prank(freelancer);
        assertEq(escrow.renewInvoice(id1), id2);
        assertEq(escrow.invoiceOf(id2).renewalsLeft, 0);

        _fund(id2);
        vm.prank(client);
        escrow.approveMilestone(id2);
        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.NoRenewalsLeft.selector, id2));
        escrow.renewInvoice(id2);
    }

    function test_renew_revertsWhenNotRecurringOrNotReleased() public {
        _create(); // one-off
        _fund(INV);
        vm.prank(client);
        escrow.approveMilestone(INV);
        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.NotRecurring.selector, INV));
        escrow.renewInvoice(INV);

        bytes32 inv2 = keccak256("invoice-2");
        vm.prank(freelancer);
        escrow.createInvoice(inv2, client, arbiter, AMOUNT, dueAt, autoReleaseAt, 7 days, 1, DESC);
        vm.prank(freelancer);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceEscrow.WrongStatus.selector, inv2, InvoiceEscrow.Status.Created
            )
        );
        escrow.renewInvoice(inv2);
    }

    function test_renew_revertsForNonFreelancer() public {
        _createRecurring();
        _fund(INV);
        vm.prank(client);
        escrow.approveMilestone(INV);
        vm.prank(client);
        vm.expectRevert(InvoiceEscrow.NotFreelancer.selector);
        escrow.renewInvoice(INV);
    }

    function test_renew_cannotDoubleRenewSameCycle() public {
        _createRecurring();
        _fund(INV);
        vm.prank(client);
        escrow.approveMilestone(INV);
        vm.prank(freelancer);
        escrow.renewInvoice(INV);
        vm.prank(freelancer);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvoiceEscrow.AlreadyExists.selector, keccak256(abi.encode(INV, uint8(1)))
            )
        );
        escrow.renewInvoice(INV);
    }

    // ---------- fuzz ----------

    function testFuzz_fullFlow(bytes32 invoiceId, uint256 amount) public {
        vm.assume(invoiceId != bytes32(0));
        amount = bound(amount, 1, 1_000e6);
        token.mint(client, amount);
        vm.prank(freelancer);
        escrow.createInvoice(invoiceId, client, arbiter, amount, dueAt, autoReleaseAt, 0, 0, DESC);
        vm.startPrank(client);
        token.approve(address(escrow), amount);
        escrow.fundInvoice(invoiceId, amount);
        escrow.approveMilestone(invoiceId);
        vm.stopPrank();
        assertEq(token.balanceOf(freelancer), amount);
    }
}
