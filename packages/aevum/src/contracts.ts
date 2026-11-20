import { parseAbi, type Address } from "viem";

/** tUSD8 on Aevum testnet: a USDC-style token (FiatTokenV2) with 6 decimals, EIP-2612 and EIP-3009. */
export const TUSD8_ADDRESS: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
export const TUSD8_DECIMALS = 6;

/** EIP-712 domain of tUSD8. MockUSD8 (local) uses the same name and version. */
export function tusd8Domain(chainId: number, verifyingContract: Address) {
  return { name: "tUSD8", version: "2", chainId, verifyingContract } as const;
}

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const eip3009Abi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

/** ABI of contracts/src/InvoiceEscrow.sol. Status: 0 Created, 1 Funded, 2 Released, 3 Refunded, 4 Cancelled, 5 Expired. */
export const invoiceEscrowAbi = parseAbi([
  "function token() view returns (address)",
  "function createInvoice(bytes32 invoiceId, address client, address arbiter, uint256 amount, uint64 dueAt, uint64 autoReleaseAt, uint64 intervalSeconds, uint8 renewalsLeft, bytes32 descriptionHash)",
  "function fundInvoice(bytes32 invoiceId, uint256 amount)",
  "function fundInvoiceWithAuthorization(bytes32 invoiceId, address from, uint256 amount, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function approveMilestone(bytes32 invoiceId)",
  "function releaseAfterDeadline(bytes32 invoiceId)",
  "function raiseDispute(bytes32 invoiceId)",
  "function resolveDispute(bytes32 invoiceId, bool releaseToFreelancer)",
  "function cancelInvoice(bytes32 invoiceId)",
  "function expireInvoice(bytes32 invoiceId)",
  "function renewInvoice(bytes32 invoiceId) returns (bytes32 newInvoiceId)",
  "function authorizationNonce(bytes32 invoiceId) view returns (bytes32)",
  "function invoiceOf(bytes32 invoiceId) view returns ((address freelancer, address client, address arbiter, uint256 amount, uint64 dueAt, uint64 autoReleaseAt, uint64 fundedAt, uint64 intervalSeconds, uint8 renewalsLeft, uint8 cycle, bytes32 rootId, bytes32 descriptionHash, uint8 status, bool disputed))",
  "event InvoiceCreated(bytes32 indexed invoiceId, address indexed freelancer, address indexed client, uint256 amount, uint64 dueAt, uint64 autoReleaseAt, uint64 intervalSeconds, uint8 renewalsLeft)",
  "event InvoiceFunded(bytes32 indexed invoiceId, address indexed payer, uint256 amount)",
  "event InvoiceReleased(bytes32 indexed invoiceId, address indexed freelancer, uint256 amount)",
  "event InvoiceRefunded(bytes32 indexed invoiceId, address indexed client, uint256 amount)",
  "event DisputeRaised(bytes32 indexed invoiceId, address indexed by)",
  "event DisputeResolved(bytes32 indexed invoiceId, address indexed by, bool released)",
  "event InvoiceCancelled(bytes32 indexed invoiceId)",
  "event InvoiceExpired(bytes32 indexed invoiceId)",
  "event InvoiceRenewed(bytes32 indexed invoiceId, bytes32 indexed newInvoiceId)",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error AlreadyExists(bytes32 invoiceId)",
  "error NotFound(bytes32 invoiceId)",
  "error NotFreelancer()",
  "error NotClient()",
  "error NotArbiter()",
  "error NotParty()",
  "error SelfInvoice()",
  "error NotFunded(bytes32 invoiceId)",
  "error AlreadyFunded(bytes32 invoiceId)",
  "error WrongAmount(uint256 expected, uint256 got)",
  "error WrongStatus(bytes32 invoiceId, uint8 status)",
  "error AlreadyDisputed(bytes32 invoiceId)",
  "error NotDisputed(bytes32 invoiceId)",
  "error TooEarly(uint64 now_, uint64 availableAt)",
  "error BadDeadline()",
  "error NotRecurring(bytes32 invoiceId)",
  "error NoRenewalsLeft(bytes32 invoiceId)",
]);
export const checkoutAbi = parseAbi([
  "function token() view returns (address)",
  "function merchant() view returns (address)",
  "function pay(bytes32 orderId, uint256 amount)",
  "function payWithAuthorization(bytes32 orderId, address from, uint256 amount, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationNonce(bytes32 orderId) view returns (bytes32)",
  "function isPaid(bytes32 orderId) view returns (bool)",
  "function paymentOf(bytes32 orderId) view returns ((address payer, uint64 paidAt, uint256 amount))",
  "event Paid(bytes32 indexed orderId, address indexed payer, uint256 amount)",
  "error AlreadyPaid(bytes32 orderId)",
  "error ZeroAmount()",
  "error ZeroAddress()",
]);
