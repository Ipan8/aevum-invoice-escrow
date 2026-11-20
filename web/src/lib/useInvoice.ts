import { invoiceEscrowAbi } from "@aevum-kit/aevum";
import type { Hex } from "viem";
import { useReadContract } from "wagmi";
import { useNetwork } from "@/lib/network";

/** One invoice, read straight from InvoiceEscrow.invoiceOf. Returns the struct tuple. */
export function useInvoice(invoiceId: Hex | undefined) {
  const { net } = useNetwork();
  const appChain = net.chain;
  return useReadContract({
    address: net.escrow,
    abi: invoiceEscrowAbi,
    functionName: "invoiceOf",
    args: invoiceId ? [invoiceId] : undefined,
    chainId: appChain.id,
    query: { enabled: Boolean(invoiceId) && Boolean(net.escrow) },
  });
}
