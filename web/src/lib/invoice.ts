import { keccak256, toHex, type Hex } from "viem";

/**
 * What an invoice is, off-chain. The contract only sees `invoiceId` and `amount`;
 * the human-readable part travels in the invoice link (base64url JSON) and its
 * keccak256 hash is stored on-chain at creation, so a receipt can prove what was agreed.
 */
export interface InvoiceMeta {
  /** Short title, e.g. "Website redesign — milestone 1". */
  title: string;
  /** Free-form description / line items, one per line. */
  description: string;
  /** Optional arbiter display name (the address itself is on-chain). */
  arbiterLabel?: string;
}

export function newInvoiceId(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return keccak256(toHex(bytes));
}

/** Short, human-friendly label for a bytes32 invoice id. */
export function invoiceLabel(invoiceId: Hex): string {
  return `#${invoiceId.slice(2, 6).toUpperCase()}-${invoiceId.slice(-4).toUpperCase()}`;
}

/** keccak256 of the canonical invoice text. Stored on-chain as descriptionHash. */
export function descriptionHash(meta: InvoiceMeta): Hex {
  return keccak256(toHex(`${meta.title}\n${meta.description}`));
}

export function encodeInvoiceMeta(meta: InvoiceMeta): string {
  const json = JSON.stringify(meta);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeInvoiceMeta(encoded: string | null | undefined): InvoiceMeta | null {
  if (!encoded) return null;
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(json) as InvoiceMeta;
    if (typeof parsed.title !== "string" || typeof parsed.description !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The InvoiceEscrow.Invoice struct, as viem returns it from invoiceOf. */
export interface InvoiceStruct {
  freelancer: Hex;
  client: Hex;
  arbiter: Hex;
  amount: bigint;
  dueAt: bigint;
  autoReleaseAt: bigint;
  fundedAt: bigint;
  intervalSeconds: bigint;
  renewalsLeft: number;
  cycle: number;
  rootId: Hex;
  descriptionHash: Hex;
  status: number;
  disputed: boolean;
}

/** InvoiceEscrow.Status: 0 Created, 1 Funded, 2 Released, 3 Refunded, 4 Cancelled, 5 Expired. */
export const INVOICE_STATUS_LABELS = [
  "Created",
  "Funded",
  "Released",
  "Refunded",
  "Cancelled",
  "Expired",
] as const;

export function statusLabel(status: number): string {
  return INVOICE_STATUS_LABELS[status] ?? `Status ${status}`;
}

/** "2026-11-20 13:00" in the user's locale, from a unix-seconds timestamp. */
export function formatDue(unixSeconds: bigint | number): string {
  const d = new Date(Number(unixSeconds) * 1000);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Whole days/hours left until a unix-seconds timestamp, for countdowns. */
export function timeLeft(unixSeconds: bigint | number): string {
  const diff = Number(unixSeconds) * 1000 - Date.now();
  if (diff <= 0) return "passed";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h left`;
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${mins}m left` : `${mins}m left`;
}

export function short(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}
