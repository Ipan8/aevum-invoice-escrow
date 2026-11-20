"use client";

import { erc20Abi, getLogsChunked, invoiceEscrowAbi, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { formatUnits, getAbiItem, isAddress, parseUnits, type Hex, type PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import {
  descriptionHash,
  encodeInvoiceMeta,
  formatDue,
  invoiceLabel,
  newInvoiceId,
  short,
  statusLabel,
  type InvoiceMeta,
  type InvoiceStruct,
} from "@/lib/invoice";

type Phase = "idle" | "working" | "done" | "error";

function toUnixSeconds(local: string): number {
  return Math.floor(new Date(local).getTime() / 1000);
}

function defaultDue(): string {
  const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 16);
}

function defaultAutoRelease(): string {
  const d = new Date(Date.now() + 14 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 16);
}

export default function InvoicesPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const escrowAddress = net.escrow;
  const hasExplorer = net.hasExplorer;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();
  const client = usePublicClient({ chainId: appChain.id }) as PublicClient | undefined;

  const [clientAddr, setClientAddr] = useState("");
  const [amount, setAmount] = useState("250");
  const [due, setDue] = useState(defaultDue());
  const [autoRelease, setAutoRelease] = useState(defaultAutoRelease());
  const [title, setTitle] = useState("Website redesign — milestone 1");
  const [description, setDescription] = useState("Homepage + booking flow, responsive.\n2 revision rounds included.");
  const [arbiter, setArbiter] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [intervalDays, setIntervalDays] = useState("30");
  const [cycles, setCycles] = useState("3");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: Hex; meta: InvoiceMeta; tx: Hex } | null>(null);

  // ---- my invoices: InvoiceCreated events, filtered to me ----
  const createdLogs = useQuery({
    queryKey: ["invoice-created", appChain.id, escrowAddress, address],
    enabled: Boolean(client && escrowAddress),
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const from = net.deployBlock !== undefined ? net.deployBlock : head > 20_000n ? head - 20_000n : 0n;
      const result = await getLogsChunked(client!, {
        address: escrowAddress!,
        event: getAbiItem({ abi: invoiceEscrowAbi, name: "InvoiceCreated" }),
        fromBlock: from,
        toBlock: head,
      });
      const mine = [...result]
        .reverse()
        .filter((l) => l.args.freelancer === address || l.args.client === address)
        .slice(0, 20);
      return mine;
    },
  });

  const ids = useMemo(() => (createdLogs.data ?? []).map((l) => l.args.invoiceId as Hex), [createdLogs.data]);
  // useReadContracts degrades the struct type for a dynamic list, so read each invoice
  // directly with the public client instead.
  const states = useQuery({
    queryKey: ["invoice-states", appChain.id, escrowAddress, ids.join(",")],
    enabled: Boolean(client && escrowAddress && ids.length > 0),
    queryFn: async () => {
      const rows: InvoiceStruct[] = [];
      for (const id of ids) {
        rows.push(
          await client!.readContract({
            address: escrowAddress!,
            abi: invoiceEscrowAbi,
            functionName: "invoiceOf",
            args: [id],
          }),
        );
      }
      return rows;
    },
  });

  const amountUnits = (() => {
    try {
      return parseUnits(amount || "0", token.decimals);
    } catch {
      return 0n;
    }
  })();

  const formError = (() => {
    if (!onChain) return "Connect your wallet on this network to create an invoice.";
    if (!escrowAddress) return "Deploy InvoiceEscrow first (make deploy-fork / deploy-aevum).";
    if (!isAddress(clientAddr)) return "Enter the client's wallet address.";
    if (clientAddr.toLowerCase() === address?.toLowerCase()) return "You can't invoice yourself.";
    if (amountUnits <= 0n) return "Enter an amount above 0.";
    if (!due || Number.isNaN(toUnixSeconds(due)) || toUnixSeconds(due) * 1000 <= Date.now())
      return "Pick a due date in the future.";
    if (!autoRelease || toUnixSeconds(autoRelease) < toUnixSeconds(due))
      return "Auto-release must be on or after the due date.";
    if (!title.trim()) return "Give the invoice a title.";
    if (arbiter && !isAddress(arbiter)) return "Arbiter must be a wallet address (or leave it empty).";
    if (recurring && (Number(intervalDays) < 1 || Number(cycles) < 1))
      return "Recurring needs an interval of at least 1 day and at least 1 renewal.";
    return null;
  })();

  async function onCreate() {
    if (formError || !escrowAddress || !address) return;
    setError(null);
    setPhase("working");
    setCreated(null);
    try {
      const meta: InvoiceMeta = { title: title.trim(), description: description.trim() };
      const invoiceId = newInvoiceId();
      const dueAt = BigInt(toUnixSeconds(due));
      const autoReleaseAt = BigInt(toUnixSeconds(autoRelease));
      const interval = recurring ? BigInt(Number(intervalDays) * 24 * 3600) : 0n;
      const renewals = recurring ? Number(cycles) : 0;
      const hash = descriptionHash(meta);
      const arbiterAddr = (arbiter.trim() || "0x0000000000000000000000000000000000000000") as Hex;
      const { request } = await simulateContract(config, {
        account: address,
        address: escrowAddress,
        abi: invoiceEscrowAbi,
        functionName: "createInvoice",
        args: [invoiceId, clientAddr as Hex, arbiterAddr, amountUnits, dueAt, autoReleaseAt, interval, renewals, hash],
        chainId: appChain.id,
      });
      const tx = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash: tx, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
      setCreated({ id: invoiceId, meta, tx });
      setPhase("done");
      createdLogs.refetch();
    } catch (e) {
      setError(explain(e));
      setPhase("error");
    }
  }

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Invoice Payments · InvoiceEscrow.sol</p>
          <h1>Invoices with milestone escrow</h1>
          <p className="lede">
            Create an invoice in tUSD8. The client pays into escrow — gasless if they want — and the money is released when
            they approve the milestone, or automatically after the date you set, unless someone raises a dispute.
          </p>
        </div>
      </div>

      <div className="row">
        <section className="card stack" aria-label="Create invoice" style={{ flex: "1 1 420px" }}>
          <h2>Create invoice</h2>
          <label className="field">
            <span>Client wallet address</span>
            <input value={clientAddr} onChange={(e) => setClientAddr(e.target.value)} placeholder="0x…" spellCheck={false} />
          </label>
          <div className="row" style={{ gap: 12 }}>
            <label className="field" style={{ flex: 1 }}>
              <span>Amount ({token.symbol})</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="250" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Arbiter (optional)</span>
              <input value={arbiter} onChange={(e) => setArbiter(e.target.value)} placeholder="0x… (empty = client resolves)" spellCheck={false} />
            </label>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <label className="field" style={{ flex: 1 }}>
              <span>Due date</span>
              <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Auto-release</span>
              <input type="datetime-local" value={autoRelease} onChange={(e) => setAutoRelease(e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Website redesign — milestone 1" />
          </label>
          <label className="field">
            <span>Description / line items</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
            <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
            Recurring invoice
          </label>
          {recurring && (
            <div className="row" style={{ gap: 12 }}>
              <label className="field" style={{ flex: 1 }}>
                <span>Every (days)</span>
                <input value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} inputMode="numeric" />
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span>Renewals after this one</span>
                <input value={cycles} onChange={(e) => setCycles(e.target.value)} inputMode="numeric" />
              </label>
            </div>
          )}

          {formError && phase !== "done" && (
            <div className="notice warn" role="status">
              <span>{formError}</span>
            </div>
          )}
          {error && (
            <div className="notice bad" role="alert">
              <strong>Couldn&apos;t create the invoice</strong>
              <span>{error}</span>
            </div>
          )}
          {phase === "done" && created && (
            <div className="notice good" role="status">
              <strong>Invoice {invoiceLabel(created.id)} created</strong>
              <span style={{ display: "flex", gap: 16 }}>
                <Link href={`/invoices/${created.id}?meta=${encodeInvoiceMeta(created.meta)}`}>Open invoice</Link>
                {hasExplorer && (
                  <a href={txUrl(created.tx)} target="_blank" rel="noreferrer">
                    Explorer
                  </a>
                )}
              </span>
            </div>
          )}
          <button type="button" className="btn big block" disabled={Boolean(formError) || phase === "working"} onClick={onCreate}>
            {phase === "working" ? "Check your wallet…" : `Create invoice — ${amount || "0"} ${token.symbol}`}
          </button>
          <p className="fine">
            The invoice id is random and unpredictable. Only its description hash is stored on-chain; the full text travels in
            the share link.
          </p>
        </section>

        <section className="card stack" aria-label="My invoices" style={{ flex: "1 1 420px" }}>
          <h2>My invoices</h2>
          {!escrowAddress ? (
            <p className="empty">
              No InvoiceEscrow configured for {net.label}. Set <code>NEXT_PUBLIC_ESCROW_{net.key.toUpperCase()}</code> in{" "}
              <code>web/.env.local</code>.
            </p>
          ) : !isConnected ? (
            <p className="empty">Connect your wallet to see invoices where you are the freelancer or the client.</p>
          ) : createdLogs.isPending ? (
            <p className="empty">Reading invoices…</p>
          ) : createdLogs.error ? (
            <p className="empty">Couldn&apos;t read invoices: {(createdLogs.error as Error).message}</p>
          ) : ids.length === 0 ? (
            <p className="empty">No invoices yet. Create your first one on the left.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th className="right">Amount</th>
                    <th>Due</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {createdLogs.data!.map((l, i) => {
                    const id = l.args.invoiceId as Hex;
                    const status = states.data?.[i]?.status;
                    return (
                      <tr key={id}>
                        <td className="mono">
                          <Link href={`/invoices/${id}`}>{invoiceLabel(id)}</Link>
                          <br />
                          <span className="fine">
                            {l.args.freelancer === address ? "you bill " : "you pay "}
                            {short((l.args.freelancer === address ? (l.args.client as string) : (l.args.freelancer as string)) ?? "")}
                          </span>
                        </td>
                        <td className="right num">
                          {formatUnits(l.args.amount ?? 0n, token.decimals)} {token.symbol}
                        </td>
                        <td>{formatDue(l.args.dueAt ?? 0n)}</td>
                        <td>{status === undefined ? "…" : statusLabel(status)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="fine">
            Read from <code>InvoiceCreated</code> events with the kit&apos;s chunked log reader (max 1,000 blocks per call).
          </p>
        </section>
      </div>
    </main>
  );
}
