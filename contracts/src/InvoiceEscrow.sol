// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice EIP-3009 (USDC-style) signed transfers. tUSD8 on Aevum implements this.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title InvoiceEscrow
/// @notice Stablecoin invoices with milestone escrow, built on the Aevum Starter Kit's
///         Checkout pattern. A freelancer creates an invoice, the client funds it into
///         escrow (standard approve+pay, or gasless via EIP-3009), and the money is
///         released to the freelancer when the client approves the milestone — or
///         automatically once the auto-release time passes without a dispute.
///         A dispute freezes the funds until the arbiter (or the client, when no arbiter
///         was named) resolves it one way or the other.
/// @dev Safety rules, learned from the kit's docs:
///      - The contract never decides the price: `fund*` requires the exact invoice
///        amount. A payment of 0.000001 tUSD8 must never mark an invoice as funded.
///      - The EIP-3009 nonce is bound to this invoice (`authorizationNonce(invoiceId)`),
///        so a signature cannot be replayed for a different invoice.
///      - Funds move only after the status has changed (checks-effects-interactions).
///      - No owner, no admin, no upgradeability. The arbiter is chosen per invoice.
///      - Invoice descriptions live off-chain (URL / app); only their keccak256 hash
///        is stored on-chain, so a receipt can prove what was agreed.
contract InvoiceEscrow {
    using SafeERC20 for IERC20;

    enum Status {
        Created,
        Funded,
        Released,
        Refunded,
        Cancelled,
        Expired
    }

    struct Invoice {
        address freelancer;
        address client;
        address arbiter;
        uint256 amount;
        uint64 dueAt;
        uint64 autoReleaseAt;
        uint64 fundedAt;
        uint64 intervalSeconds;
        uint8 renewalsLeft;
        uint8 cycle;
        bytes32 rootId;
        bytes32 descriptionHash;
        Status status;
        bool disputed;
    }

    IERC20 public immutable token;

    mapping(bytes32 invoiceId => Invoice) private _invoices;

    event InvoiceCreated(
        bytes32 indexed invoiceId,
        address indexed freelancer,
        address indexed client,
        uint256 amount,
        uint64 dueAt,
        uint64 autoReleaseAt,
        uint64 intervalSeconds,
        uint8 renewalsLeft
    );
    event InvoiceFunded(bytes32 indexed invoiceId, address indexed payer, uint256 amount);
    event InvoiceReleased(bytes32 indexed invoiceId, address indexed freelancer, uint256 amount);
    event InvoiceRefunded(bytes32 indexed invoiceId, address indexed client, uint256 amount);
    event DisputeRaised(bytes32 indexed invoiceId, address indexed by);
    event DisputeResolved(bytes32 indexed invoiceId, address indexed by, bool released);
    event InvoiceCancelled(bytes32 indexed invoiceId);
    event InvoiceExpired(bytes32 indexed invoiceId);
    event InvoiceRenewed(bytes32 indexed invoiceId, bytes32 indexed newInvoiceId);

    error ZeroAmount();
    error ZeroAddress();
    error AlreadyExists(bytes32 invoiceId);
    error NotFound(bytes32 invoiceId);
    error NotFreelancer();
    error NotClient();
    error NotArbiter();
    error NotParty();
    error SelfInvoice();
    error NotFunded(bytes32 invoiceId);
    error AlreadyFunded(bytes32 invoiceId);
    error WrongAmount(uint256 expected, uint256 got);
    error WrongStatus(bytes32 invoiceId, Status status);
    error AlreadyDisputed(bytes32 invoiceId);
    error NotDisputed(bytes32 invoiceId);
    error TooEarly(uint64 now_, uint64 availableAt);
    error BadDeadline();
    error NotRecurring(bytes32 invoiceId);
    error NoRenewalsLeft(bytes32 invoiceId);

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Create an invoice. The caller is the freelancer.
    /// @param invoiceId Unpredictable id (e.g. keccak256 of random bytes). Never reused.
    /// @param client Who pays. Must differ from the freelancer.
    /// @param arbiter Who resolves disputes. address(0) means the client resolves.
    /// @param amount Exact tUSD8 amount (6 decimals). Funding must match it exactly.
    /// @param dueAt Deadline for the work (unix seconds). Unfunded invoices expire after it.
    /// @param autoReleaseAt If funded and undisputed, anyone may release after this time.
    /// @param intervalSeconds 0 = one-off. Otherwise the seconds between recurring cycles.
    /// @param renewalsLeft How many further cycles may be renewed after this one.
    /// @param descriptionHash keccak256 of the human-readable invoice (lines, terms).
    function createInvoice(
        bytes32 invoiceId,
        address client,
        address arbiter,
        uint256 amount,
        uint64 dueAt,
        uint64 autoReleaseAt,
        uint64 intervalSeconds,
        uint8 renewalsLeft,
        bytes32 descriptionHash
    ) external {
        if (_invoices[invoiceId].freelancer != address(0)) revert AlreadyExists(invoiceId);
        if (client == address(0)) revert ZeroAddress();
        if (client == msg.sender) revert SelfInvoice();
        if (amount == 0) revert ZeroAmount();
        if (dueAt <= block.timestamp || autoReleaseAt < dueAt) revert BadDeadline();

        _invoices[invoiceId] = Invoice({
            freelancer: msg.sender,
            client: client,
            arbiter: arbiter,
            amount: amount,
            dueAt: dueAt,
            autoReleaseAt: autoReleaseAt,
            fundedAt: 0,
            intervalSeconds: intervalSeconds,
            renewalsLeft: renewalsLeft,
            cycle: 0,
            rootId: invoiceId,
            descriptionHash: descriptionHash,
            status: Status.Created,
            disputed: false
        });

        emit InvoiceCreated(
            invoiceId, msg.sender, client, amount, dueAt, autoReleaseAt, intervalSeconds, renewalsLeft
        );
    }

    /// @notice Fund an invoice with tokens you approved to this contract. Caller must be the client.
    function fundInvoice(bytes32 invoiceId, uint256 amount) external {
        Invoice storage inv = _get(invoiceId);
        _requireClient(inv);
        _fund(inv, invoiceId, msg.sender, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Fund an invoice gaslessly: the client signs EIP-3009 off-chain, anyone submits.
    /// @dev The signed nonce must be `authorizationNonce(invoiceId)`. `to` must be this contract.
    function fundInvoiceWithAuthorization(
        bytes32 invoiceId,
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Invoice storage inv = _get(invoiceId);
        if (from != inv.client) revert NotClient();
        _fund(inv, invoiceId, from, amount);
        _pullWithAuthorization(invoiceId, from, amount, validAfter, validBefore, v, r, s);
    }

    /// @dev Separate frame: keeps `fundInvoiceWithAuthorization` clear of "stack too deep".
    function _pullWithAuthorization(
        bytes32 invoiceId,
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        IERC3009(address(token)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, authorizationNonce(invoiceId), v, r, s
        );
    }

    /// @notice The client approves the milestone: the escrowed amount goes to the freelancer.
    function approveMilestone(bytes32 invoiceId) external {
        Invoice storage inv = _get(invoiceId);
        _requireClient(inv);
        _requireFundedUndisputed(inv, invoiceId);
        _release(inv, invoiceId);
    }

    /// @notice Anyone may release an undisputed funded invoice after its auto-release time.
    function releaseAfterDeadline(bytes32 invoiceId) external {
        Invoice storage inv = _get(invoiceId);
        _requireFundedUndisputed(inv, invoiceId);
        if (block.timestamp < inv.autoReleaseAt) {
            revert TooEarly(uint64(block.timestamp), inv.autoReleaseAt);
        }
        _release(inv, invoiceId);
    }

    /// @notice Freeze a funded invoice. Only the client or the freelancer, before release.
    function raiseDispute(bytes32 invoiceId) external {
        Invoice storage inv = _get(invoiceId);
        if (msg.sender != inv.client && msg.sender != inv.freelancer) revert NotParty();
        _requireFunded(inv, invoiceId);
        if (inv.disputed) revert AlreadyDisputed(invoiceId);
        inv.disputed = true;
        emit DisputeRaised(invoiceId, msg.sender);
    }

    /// @notice Resolve a dispute: release to the freelancer or refund the client.
    /// @dev The arbiter resolves when one was named at creation; otherwise the client does.
    function resolveDispute(bytes32 invoiceId, bool releaseToFreelancer) external {
        Invoice storage inv = _get(invoiceId);
        address resolver = inv.arbiter == address(0) ? inv.client : inv.arbiter;
        if (msg.sender != resolver) revert NotArbiter();
        _requireFunded(inv, invoiceId);
        if (!inv.disputed) revert NotDisputed(invoiceId);
        inv.disputed = false;
        if (releaseToFreelancer) {
            _release(inv, invoiceId);
        } else {
            inv.status = Status.Refunded;
            emit InvoiceRefunded(invoiceId, inv.client, inv.amount);
            token.safeTransfer(inv.client, inv.amount);
        }
        emit DisputeResolved(invoiceId, msg.sender, releaseToFreelancer);
    }

    /// @notice The freelancer cancels an invoice that was never funded.
    function cancelInvoice(bytes32 invoiceId) external {
        Invoice storage inv = _get(invoiceId);
        if (msg.sender != inv.freelancer) revert NotFreelancer();
        if (inv.status != Status.Created) revert WrongStatus(invoiceId, inv.status);
        inv.status = Status.Cancelled;
        emit InvoiceCancelled(invoiceId);
    }

    /// @notice Anyone may expire an invoice that was never funded and is past its due date.
    function expireInvoice(bytes32 invoiceId) external {
        Invoice storage inv = _get(invoiceId);
        if (inv.status != Status.Created) revert WrongStatus(invoiceId, inv.status);
        if (block.timestamp <= inv.dueAt) revert TooEarly(uint64(block.timestamp), inv.dueAt);
        inv.status = Status.Expired;
        emit InvoiceExpired(invoiceId);
    }

    /// @notice Create the next cycle of a recurring invoice after the current one was released.
    /// @dev The new id is derived from the root invoice and the next cycle number, so a
    ///      cycle can never be renewed twice.
    function renewInvoice(bytes32 invoiceId) external returns (bytes32 newInvoiceId) {
        Invoice storage inv = _get(invoiceId);
        if (msg.sender != inv.freelancer) revert NotFreelancer();
        if (inv.status != Status.Released) revert WrongStatus(invoiceId, inv.status);
        if (inv.intervalSeconds == 0) revert NotRecurring(invoiceId);
        if (inv.renewalsLeft == 0) revert NoRenewalsLeft(invoiceId);

        uint8 nextCycle = inv.cycle + 1;
        newInvoiceId = keccak256(abi.encode(inv.rootId, nextCycle));
        if (_invoices[newInvoiceId].freelancer != address(0)) revert AlreadyExists(newInvoiceId);
        inv.renewalsLeft -= 1;

        _invoices[newInvoiceId] = Invoice({
            freelancer: inv.freelancer,
            client: inv.client,
            arbiter: inv.arbiter,
            amount: inv.amount,
            dueAt: inv.dueAt + inv.intervalSeconds,
            autoReleaseAt: inv.autoReleaseAt + inv.intervalSeconds,
            fundedAt: 0,
            intervalSeconds: inv.intervalSeconds,
            renewalsLeft: inv.renewalsLeft,
            cycle: nextCycle,
            rootId: inv.rootId,
            descriptionHash: inv.descriptionHash,
            status: Status.Created,
            disputed: false
        });

        emit InvoiceRenewed(invoiceId, newInvoiceId);
        emit InvoiceCreated(
            newInvoiceId,
            inv.freelancer,
            inv.client,
            inv.amount,
            inv.dueAt + inv.intervalSeconds,
            inv.autoReleaseAt + inv.intervalSeconds,
            inv.intervalSeconds,
            inv.renewalsLeft
        );
    }

    /// @notice The EIP-3009 nonce a client must sign to fund `invoiceId` through this contract.
    function authorizationNonce(bytes32 invoiceId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), invoiceId));
    }

    function invoiceOf(bytes32 invoiceId) external view returns (Invoice memory) {
        return _get(invoiceId);
    }

    function _get(bytes32 invoiceId) private view returns (Invoice storage) {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.freelancer == address(0)) revert NotFound(invoiceId);
        return inv;
    }

    function _requireClient(Invoice storage inv) private view {
        if (msg.sender != inv.client) revert NotClient();
    }

    function _requireFunded(Invoice storage inv, bytes32 invoiceId) private view {
        if (inv.status != Status.Funded) revert NotFunded(invoiceId);
    }

    function _requireFundedUndisputed(Invoice storage inv, bytes32 invoiceId) private view {
        _requireFunded(inv, invoiceId);
        if (inv.disputed) revert AlreadyDisputed(invoiceId);
    }

    function _fund(Invoice storage inv, bytes32 invoiceId, address payer, uint256 amount) private {
        if (inv.status != Status.Created) revert WrongStatus(invoiceId, inv.status);
        if (amount != inv.amount) revert WrongAmount(inv.amount, amount);
        inv.status = Status.Funded;
        inv.fundedAt = uint64(block.timestamp);
        emit InvoiceFunded(invoiceId, payer, amount);
    }

    function _release(Invoice storage inv, bytes32 invoiceId) private {
        inv.status = Status.Released;
        emit InvoiceReleased(invoiceId, inv.freelancer, inv.amount);
        token.safeTransfer(inv.freelancer, inv.amount);
    }
}
