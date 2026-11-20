"use client";

import { getLogsChunked, invoiceEscrowAbi } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo } from "react";
import { formatUnits, getAbiItem, type Hex, type PublicClient } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { formatDue, invoiceLabel, statusLabel, type InvoiceStruct } from "@/lib/invoice";

type EscrowEvent = {
  invoiceId: Hex;
  block: bigint;
  kind: "Created" | "Funded" | "Released" | "Refunded" | "Dispute" | "Resolved" | "Cancelled" | "Expired" | "Renewed";
};

export default function DashboardPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const escrowAddress = net.escrow;
  const { address, isConnected } = useAccount();
  const token = useToken();
  const client = usePublicClient({ chainId: appChain.id }) as PublicClient | undefined;

  const activity = useQuery({
    queryKey: ["escrow-activity", appChain.id, escrowAddress],
    enabled: Boolean(client && escrowAddress),
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const from = net.deployBlock !== undefined ? net.deployBlock : head > 20_000n ? head - 20_000n : 0n;
      // One literal getAbiItem call per event: a union of names won't narrow.
      const events = {
        Created: getAbiItem({ abi: invoiceEscrowAbi, name: "InvoiceCreated" }),
        Funded: getAbiItem({ abi: invoiceEscrowAbi, name: "InvoiceFunded" }),
        Released: getAbiItem({ abi: invoiceEscrowAbi, name: "InvoiceReleased" }),
        Refunded: getAbiItem({ abi: invoiceEscrowAbi, name: "InvoiceRefunded" }),
        Dispute: getAbiItem({ abi: invoiceEscrowAbi, name: "DisputeRaised" }),
        Resolved: getAbiItem({ abi: invoiceEscrowAbi, name: "DisputeResolved" }),
        Cancelled: getAbiItem({ abi: invoiceEscrowAbi, name: "InvoiceCancelled" }),
        Expired: getAbiItem({ abi: invoiceEscrowAbi, name: "InvoiceExpired" }),
        Renewed: getAbiItem({ abi: invoiceEscrowAbi, name: "InvoiceRenewed" }),
      } as const;
      const out: EscrowEvent[] = [];
      for (const [kind, event] of Object.entries(events) as [EscrowEvent["kind"], (typeof events)[keyof typeof events]][]) {
        const logs = await getLogsChunked(client!, {
          address: escrowAddress!,
          event,
          fromBlock: from,
          toBlock: head,
        });
        for (const l of logs) {
          out.push({ invoiceId: l.args.invoiceId as Hex, block: l.blockNumber, kind });
        }
      }
      return out.sort((a, b) => (a.block > b.block ? -1 : a.block < b.block ? 1 : 0)).slice(0, 30);
    },
  });

  // Open exposure: my invoices that are Funded (money locked in escrow right now).
  const open = useQuery({
    queryKey: ["escrow-open", appChain.id, escrowAddress, address],
    enabled: Boolean(client && escrowAddress && isConnected),
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const from = net.deployBlock !== undefined ? net.deployBlock : head > 20_000n ? head - 20_000n : 0n;
      const logs = await getLogsChunked(client!, {
        address: escrowAddress!,
        event: getAbiItem({ abi: invoiceEscrowAbi, name: "InvoiceCreated" }),
        fromBlock: from,
        toBlock: head,
      });
      return [...logs]
        .reverse()
        .filter((l) => l.args.freelancer === address || l.args.client === address)
        .map((l) => l.args.invoiceId as Hex)
        .slice(0, 20);
    },
  });

  const openIds = useMemo(() => open.data ?? [], [open.data]);
  // useReadContracts degrades the struct type for a dynamic list, so read each invoice
  // directly with the public client instead.
  const openInvoices = useQuery({
    queryKey: ["escrow-open-states", appChain.id, escrowAddress, address, openIds.join(",")],
    enabled: Boolean(client && escrowAddress && openIds.length > 0),
    queryFn: async () => {
      const rows: { id: Hex; inv: InvoiceStruct }[] = [];
      for (const id of openIds) {
        const inv = await client!.readContract({
          address: escrowAddress!,
          abi: invoiceEscrowAbi,
          functionName: "invoiceOf",
          args: [id],
        });
        rows.push({ id, inv });
      }
      return rows;
    },
  });

  const funded = useMemo(() => {
    const rows = (openInvoices.data ?? []).filter(({ inv }) => inv.status === 1);
    return { count: rows.length, total: rows.reduce((acc, { inv }) => acc + inv.amount, 0n) };
  }, [openInvoices.data]);

  const dueSoon = useMemo(() => {
    const now = Date.now() / 1000;
    return (openInvoices.data ?? [])
      .filter(({ inv }) => (inv.status === 0 || inv.status === 1) && Number(inv.dueAt) > now && Number(inv.dueAt) - now < 7 * 86_400)
      .sort((a, b) => Number(a.inv.dueAt) - Number(b.inv.dueAt));
  }, [openInvoices.data]);

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Dashboard · escrow on {appChain.name}</p>
          <h1>Your escrow at a glance</h1>
          <p className="lede">
            Money locked in InvoiceEscrow right now, invoices that need your attention, and the latest escrow activity on
            this network.
          </p>
        </div>
      </div>

      {!escrowAddress ? (
        <section className="card stack">
          <span className="status-pill warn">No escrow configured</span>
          <p style={{ color: "var(--text-muted)" }}>
            Set <code>NEXT_PUBLIC_ESCROW_{net.key.toUpperCase()}</code> in <code>web/.env.local</code> (deploy with{" "}
            <code>make deploy-fork</code> or <code>make deploy-aevum</code> first).
          </p>
        </section>
      ) : (
        <>
          <div className="row">
            <section className="card stack" style={{ flex: "1 1 240px" }}>
              <h2>In escrow (funded)</h2>
              <p style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>
                {formatUnits(funded.total, token.decimals)} {token.symbol}
              </p>
              <p className="fine">
                {funded.count} invoice{funded.count === 1 ? "" : "s"} funded, waiting for approval or the auto-release date.
              </p>
            </section>
            <section className="card stack" style={{ flex: "1 1 240px" }}>
              <h2>Due in the next 7 days</h2>
              {dueSoon.length === 0 ? (
                <p className="empty">Nothing due soon.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {dueSoon.map(({ id, inv }) => (
                    <li key={id}>
                      <Link href={`/invoices/${id}`}>{invoiceLabel(id)}</Link> — {formatDue(inv.dueAt)} (
                      {formatUnits(inv.amount, token.decimals)} {token.symbol})
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="card stack">
            <h2>Latest escrow activity</h2>
            {activity.isPending ? (
              <p className="empty">Reading escrow events…</p>
            ) : activity.error ? (
              <p className="empty">Couldn&apos;t read activity: {(activity.error as Error).message}</p>
            ) : (activity.data ?? []).length === 0 ? (
              <p className="empty">
                No escrow activity on {appChain.name} yet. Create an invoice on the{" "}
                <Link href="/invoices">Invoices</Link> page.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Invoice</th>
                      <th className="right">Block</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(activity.data ?? []).map((e, i) => (
                      <tr key={`${e.invoiceId}-${e.kind}-${e.block}-${i}`}>
                        <td>{e.kind}</td>
                        <td className="mono">
                          <Link href={`/invoices/${e.invoiceId}`}>{invoiceLabel(e.invoiceId)}</Link>
                        </td>
                        <td className="right num">{e.block.toString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="fine">
              Read with the kit&apos;s chunked log reader (max 1,000 blocks per call) from the deploy block, or the last 20,000
              blocks. Disputes freeze funds until the arbiter — or the client, when no arbiter was named — resolves them.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
