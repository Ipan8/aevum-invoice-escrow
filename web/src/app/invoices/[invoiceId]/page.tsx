"use client";

import {
  authorizationWindow,
  checkoutTypedData,
  erc20Abi,
  invoiceEscrowAbi,
  txUrl,
} from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  encodeAbiParameters,
  formatUnits,
  isHex,
  keccak256,
  parseAbiParameters,
  parseUnits,
  type Hash,
  type Hex,
} from "viem";
import { useAccount, useConfig } from "wagmi";
import { readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import {
  decodeInvoiceMeta,
  descriptionHash,
  formatDue,
  invoiceLabel,
  short,
  statusLabel,
  timeLeft,
} from "@/lib/invoice";
import { useInvoice } from "@/lib/useInvoice";

const ZERO = "0x0000000000000000000000000000000000000000";

export default function InvoiceDetailPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const escrowAddress = net.escrow;
  const hasExplorer = net.hasExplorer;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();

  const params = useParams<{ invoiceId: string }>();
  const search = useSearchParams();
  const invoiceId = params.invoiceId;
  const validId = isHex(invoiceId) && invoiceId.length === 66;
  const meta = decodeInvoiceMeta(search.get("meta"));
  const invoice = useInvoice(validId ? (invoiceId as Hex) : undefined);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Hash | null>(null);
  const [renewedId, setRenewedId] = useState<Hex | null>(null);
  const [copied, setCopied] = useState(false);

  const relay = useQuery({
    queryKey: ["relay-status", appChain.id],
    queryFn: async () =>
      (await fetch(`/api/relay?chainId=${appChain.id}`)).json() as Promise<{
        enabled: boolean;
        escrowEnabled: boolean;
        relayer: string | null;
      }>,
  });
  const gaslessAvailable = relay.data?.escrowEnabled ?? false;

  if (!validId) {
    return (
      <main className="shell">
        <h1>Invoice not found</h1>
        <p className="lede">That invoice id isn&apos;t valid. Invoice ids are 32-byte hex values (0x + 64 characters).</p>
      </main>
    );
  }

  const inv = invoice.data;
  const notFound = inv && inv.freelancer === ZERO;
  const status = inv ? inv.status : undefined;
  const disputed = inv ? inv.disputed : false;
  const isFreelancer = !!address && !!inv && address.toLowerCase() === inv.freelancer.toLowerCase();
  const isClient = !!address && !!inv && address.toLowerCase() === inv.client.toLowerCase();
  const isArbiter = !!address && !!inv && inv.arbiter !== ZERO && address.toLowerCase() === inv.arbiter.toLowerCase();
  const canResolve = !!disputed && (isArbiter || (!!inv && inv.arbiter === ZERO && isClient));
  const amount = inv ? inv.amount : 0n;
  const metaMatches = meta && inv ? descriptionHash(meta) === inv.descriptionHash : null;
  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/invoices/${invoiceId}${meta ? `?meta=${search.get("meta")}` : ""}`
      : "";

  async function run(action: string, fn: () => Promise<Hash | null>) {
    setError(null);
    setBusy(action);
    setLastTx(null);
    try {
      const hash = await fn();
      if (hash) {
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
        if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing was charged.");
        setLastTx(hash);
      }
      invoice.refetch();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  type EscrowWriteMethod =
    | "createInvoice"
    | "fundInvoice"
    | "fundInvoiceWithAuthorization"
    | "approveMilestone"
    | "releaseAfterDeadline"
    | "raiseDispute"
    | "resolveDispute"
    | "cancelInvoice"
    | "expireInvoice"
    | "renewInvoice";

  async function write(method: EscrowWriteMethod, args: unknown[]) {
    if (!escrowAddress || !address) throw new Error("Connect your wallet first.");
    const { request } = await simulateContract(config, {
      account: address,
      address: escrowAddress,
      abi: invoiceEscrowAbi,
      functionName: method,
      args: args as never,
      chainId: appChain.id,
    });
    return writeContract(config, request);
  }

  async function fundStandard(): Promise<Hash | null> {
    if (!escrowAddress || !address || !inv) return null;
    const allowance = await readContract(config, {
      address: token.address!,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, escrowAddress],
      chainId: appChain.id,
    });
    if (allowance < amount) {
      const approveHash = await writeContract(config, {
        address: token.address!,
        abi: erc20Abi,
        functionName: "approve",
        args: [escrowAddress, amount],
        chainId: appChain.id,
        account: address,
      });
      await waitForTransactionReceipt(config, { hash: approveHash, chainId: appChain.id });
    }
    return write("fundInvoice", [invoiceId, amount]);
  }

  async function fundGasless(): Promise<Hash | null> {
    if (!escrowAddress || !address || !token.address) return null;
    const nonce = await readContract(config, {
      address: escrowAddress,
      abi: invoiceEscrowAbi,
      functionName: "authorizationNonce",
      args: [invoiceId as Hex],
      chainId: appChain.id,
    });
    const { validAfter, validBefore } = authorizationWindow(600);
    const signature = await signTypedData(config, {
      account: address,
      ...checkoutTypedData(appChain.id, token.address, {
        from: address,
        to: escrowAddress,
        value: amount,
        validAfter,
        validBefore,
        nonce,
      }),
    });
    const res = await fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: appChain.id,
        invoiceId,
        from: address,
        amount: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        signature,
      }),
    });
    const data = (await res.json()) as { hash?: Hash; error?: string };
    if (!res.ok || !data.hash) throw new Error(data.error ?? "The relayer didn't accept the payment.");
    return data.hash;
  }

  async function renew(): Promise<Hash | null> {
    if (!inv) return null;
    const hash = await write("renewInvoice", [invoiceId]);
    const nextCycle = inv.cycle + 1;
    const nextId = keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32, uint8"), [inv.rootId, nextCycle]),
    );
    setRenewedId(nextId);
    return hash;
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const canAct = onChain && Boolean(escrowAddress) && Boolean(inv) && !notFound;
  const autoReleasePassed = !!inv && Date.now() / 1000 >= Number(inv.autoReleaseAt);
  const duePassed = !!inv && Date.now() / 1000 > Number(inv.dueAt);

  return (
    <main className="shell" style={{ maxWidth: 860 }}>
      <div>
        <p className="eyebrow">Invoice · read from {appChain.name}</p>
        <h1>Invoice {invoiceLabel(invoiceId as Hex)}</h1>
      </div>

      {!escrowAddress ? (
        <section className="card stack">
          <span className="status-pill warn">Can&apos;t check</span>
          <p style={{ color: "var(--text-muted)" }}>
            No InvoiceEscrow is configured for {appChain.name} in this app. Set{" "}
            <code>NEXT_PUBLIC_ESCROW_{net.key.toUpperCase()}</code> in <code>web/.env.local</code>.
          </p>
        </section>
      ) : invoice.isLoading ? (
        <p className="empty">Reading InvoiceEscrow.invoiceOf…</p>
      ) : invoice.isError ? (
        <section className="card stack">
          <span className="status-pill warn">Can&apos;t check</span>
          <p style={{ color: "var(--text-muted)" }}>
            Couldn&apos;t read the invoice from {appChain.name}. The RPC may be busy.{" "}
            <button type="button" className="btn small" onClick={() => invoice.refetch()}>
              Try again
            </button>
          </p>
        </section>
      ) : notFound ? (
        <section className="card stack">
          <span className="status-pill warn">Not found</span>
          <p style={{ color: "var(--text-muted)" }}>No invoice with this id exists on {appChain.name}.</p>
        </section>
      ) : (
        inv && (
          <>
            <section className="card stack">
              <div className="check-top" style={{ alignItems: "center" }}>
                <span className={`status-pill ${status === 2 ? "good" : status === 3 || status === 4 || status === 5 ? "warn" : ""}`}>
                  {statusLabel(status ?? 0)}
                  {disputed ? " · disputed" : ""}
                </span>
                {inv.fundedAt > 0n && <span className="fine">Funded {new Date(Number(inv.fundedAt) * 1000).toLocaleString()}</span>}
              </div>
              <div className="receipt-amount">
                {formatUnits(amount, token.decimals)} <small style={{ fontSize: "0.4em", color: "var(--text-muted)" }}>{token.symbol}</small>
              </div>
              {meta ? (
                <div>
                  <h2 style={{ fontSize: 18, margin: "4px 0" }}>{meta.title}</h2>
                  <p style={{ whiteSpace: "pre-line", color: "var(--text-muted)" }}>{meta.description}</p>
                  <p className="fine">
                    {metaMatches === true
                      ? "This text matches the description hash stored on-chain."
                      : metaMatches === false
                        ? "Warning: this text does NOT match the description hash stored on-chain."
                        : ""}
                  </p>
                </div>
              ) : (
                <p className="fine">No description was shared in this link. The on-chain description hash is {short(inv.descriptionHash)}.</p>
              )}
              <dl className="kv">
                <dt>Freelancer</dt>
                <dd>
                  {inv.freelancer} {isFreelancer ? "(you)" : ""}
                </dd>
                <dt>Client</dt>
                <dd>
                  {inv.client} {isClient ? "(you)" : ""}
                </dd>
                <dt>Arbiter</dt>
                <dd>{inv.arbiter === ZERO ? "none — the client resolves disputes" : `${inv.arbiter}${isArbiter ? " (you)" : ""}`}</dd>
                <dt>Due</dt>
                <dd>
                  {formatDue(inv.dueAt)} · {timeLeft(inv.dueAt)}
                </dd>
                <dt>Auto-release</dt>
                <dd>
                  {formatDue(inv.autoReleaseAt)} · {timeLeft(inv.autoReleaseAt)}
                </dd>
                {inv.intervalSeconds > 0n && (
                  <>
                    <dt>Recurring</dt>
                    <dd>
                      every {Number(inv.intervalSeconds) / 86_400} days · cycle {inv.cycle} · {inv.renewalsLeft} renewal{inv.renewalsLeft === 1 ? "" : "s"} left
                    </dd>
                  </>
                )}
                <dt>Escrow</dt>
                <dd>{escrowAddress}</dd>
              </dl>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="btn small secondary" onClick={copyLink}>
                  {copied ? "Copied!" : "Copy share link"}
                </button>
                <Link className="btn small secondary" href="/invoices">
                  All invoices
                </Link>
              </div>
            </section>

            <section className="card stack" aria-label="Actions">
              <h2>Actions</h2>
              {!isConnected || !onChain ? (
                <p className="empty">Connect your wallet on {appChain.name} to act on this invoice.</p>
              ) : (
                <>
                  {status === 0 && isClient && (
                    <div className="stack">
                      <p className="fine">
                        Fund the escrow with exactly {formatUnits(amount, token.decimals)} {token.symbol}. Gasless signs once and a
                        relayer submits it — you need no tQDAY.
                      </p>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn"
                          disabled={!canAct || busy !== null || !gaslessAvailable}
                          onClick={() => run("fund-gasless", fundGasless)}
                        >
                          {busy === "fund-gasless" ? "Waiting for relayer…" : "Fund gasless"}
                        </button>
                        <button
                          type="button"
                          className="btn secondary"
                          disabled={!canAct || busy !== null}
                          onClick={() => run("fund-standard", fundStandard)}
                        >
                          {busy === "fund-standard" ? "Check your wallet…" : "Fund (approve + pay)"}
                        </button>
                      </div>
                      {!gaslessAvailable && (
                        <p className="fine">Gasless is off: set RELAYER_PRIVATE_KEY in web/.env.local to enable it.</p>
                      )}
                    </div>
                  )}
                  {status === 1 && !disputed && isClient && (
                    <button
                      type="button"
                      className="btn"
                      disabled={!canAct || busy !== null}
                      onClick={() => run("approve", () => write("approveMilestone", [invoiceId]))}
                    >
                      {busy === "approve" ? "Check your wallet…" : "Approve milestone — release to freelancer"}
                    </button>
                  )}
                  {status === 1 && !disputed && autoReleasePassed && (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={!canAct || busy !== null}
                      onClick={() => run("release", () => write("releaseAfterDeadline", [invoiceId]))}
                    >
                      {busy === "release" ? "Working…" : "Release now — auto-release date passed, no dispute"}
                    </button>
                  )}
                  {status === 1 && !disputed && (isClient || isFreelancer) && (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={!canAct || busy !== null}
                      onClick={() => run("dispute", () => write("raiseDispute", [invoiceId]))}
                    >
                      {busy === "dispute" ? "Working…" : "Raise a dispute — freeze the funds"}
                    </button>
                  )}
                  {status === 1 && disputed && canResolve && (
                    <div className="stack">
                      <p className="fine">
                        {inv.arbiter === ZERO
                          ? "No arbiter was named, so you (the client) resolve this dispute."
                          : "You are the arbiter for this invoice."}{" "}
                        Releasing pays the freelancer; refunding returns the money to the client.
                      </p>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn"
                          disabled={!canAct || busy !== null}
                          onClick={() => run("resolve-release", () => write("resolveDispute", [invoiceId, true]))}
                        >
                          {busy === "resolve-release" ? "Working…" : "Resolve: release to freelancer"}
                        </button>
                        <button
                          type="button"
                          className="btn secondary"
                          disabled={!canAct || busy !== null}
                          onClick={() => run("resolve-refund", () => write("resolveDispute", [invoiceId, false]))}
                        >
                          {busy === "resolve-refund" ? "Working…" : "Resolve: refund the client"}
                        </button>
                      </div>
                    </div>
                  )}
                  {status === 1 && disputed && !canResolve && (
                    <p className="empty">This invoice is disputed. Only the arbiter can resolve it.</p>
                  )}
                  {status === 0 && isFreelancer && (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={!canAct || busy !== null}
                      onClick={() => run("cancel", () => write("cancelInvoice", [invoiceId]))}
                    >
                      {busy === "cancel" ? "Working…" : "Cancel invoice (not funded yet)"}
                    </button>
                  )}
                  {status === 0 && duePassed && (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={!canAct || busy !== null}
                      onClick={() => run("expire", () => write("expireInvoice", [invoiceId]))}
                    >
                      {busy === "expire" ? "Working…" : "Mark expired — past due, never funded"}
                    </button>
                  )}
                  {status === 2 && inv.intervalSeconds > 0n && inv.renewalsLeft > 0 && isFreelancer && (
                    <div className="stack">
                      <p className="fine">Recurring invoice: create the next cycle with the same terms.</p>
                      <button
                        type="button"
                        className="btn"
                        disabled={!canAct || busy !== null}
                        onClick={() => run("renew", renew)}
                      >
                        {busy === "renew" ? "Working…" : "Renew — create next cycle"}
                      </button>
                      {renewedId && (
                        <p className="fine">
                          Next cycle: <Link href={`/invoices/${renewedId}`}>{invoiceLabel(renewedId)}</Link>
                        </p>
                      )}
                    </div>
                  )}
                  {status !== 0 && status !== 1 && status !== 2 && (
                    <p className="empty">This invoice is closed — no actions left.</p>
                  )}
                  {error && (
                    <div className="notice bad" role="alert">
                      <strong>That didn&apos;t go through</strong>
                      <span>{error}</span>
                    </div>
                  )}
                  {lastTx && (
                    <div className="notice good" role="status">
                      <strong>Confirmed on {appChain.name}</strong>
                      {hasExplorer && (
                        <a href={txUrl(lastTx)} target="_blank" rel="noreferrer">
                          View transaction
                        </a>
                      )}
                    </div>
                  )}
                </>
              )}
              <p className="fine">
                This page trusts nothing but the chain: it calls <code>InvoiceEscrow.invoiceOf</code> and checks the funded amount
                against the invoice amount before treating anything as settled.
              </p>
            </section>
          </>
        )
      )}
    </main>
  );
}
