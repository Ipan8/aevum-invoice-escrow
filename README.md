# Aevum Invoice Escrow

**Invoice + milestone escrow in tUSD8 on QDay Aevum testnet (chain `44005`).**

A freelancer creates an invoice, the client pays into escrow — standard or gasless — and the money is released when the client approves the milestone, or automatically when the deadline passes with no dispute. If something goes wrong, either side can raise a dispute and a named arbiter (or the client, when no arbiter was named) resolves it: release or refund. Invoices can also recur — each renewal is a new invoice with the same terms.

**Why this exists:** freelancers in Indonesia (and anywhere without easy access to international banking) can get paid in stablecoin with no bank account — and the client needs no gas, no tQDAY, just one signature. The escrow is the trust layer: the freelancer knows the money is already locked, the client knows it only moves when the work is approved or the deadline passes.

> **Forked from the [Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) (MIT, PQA Labs).** The checkout, relayer, chunked log reader, chain config and setup checker come from the kit; `InvoiceEscrow.sol` and the invoice UI + dashboard are new. See [Licenses and credit](#licenses-and-credit).

> **Judging counts activity on Aevum.** Contracts, payments and transfers must happen on Aevum testnet. Settling only on another chain (for example x402 on Base) doesn't count.

---

## Contents

- [How an invoice works](#how-an-invoice-works)
- [Quickstart (5 minutes, no funds needed)](#quickstart-5-minutes-no-funds-needed)
- [Network details](#network-details)
- [Get test tokens](#get-test-tokens)
- [Deploy to Aevum testnet](#deploy-to-aevum-testnet)
- [Deploy the web app to Vercel](#deploy-the-web-app-to-vercel)
- [How the escrow works](#how-the-escrow-works)
- [Things that differ from Ethereum](#things-that-differ-from-ethereum)
- [Project layout](#project-layout)
- [Commands](#commands)
- [Submitting your project](#submitting-your-project)
- [FAQ](#faq)

---

## How an invoice works

```
freelancer ── createInvoice(id, client, amount, due, autoRelease, …) ──▶ InvoiceEscrow
client     ── fundInvoice / fundInvoiceWithAuthorization (gasless) ────▶ escrow holds amount
client     ── approveMilestone ────────────────────────────────────────▶ freelancer paid
        OR ── (no dispute) auto-release date passes ── releaseAfterDeadline ──▶ freelancer paid
        OR ── either side raises a dispute ── arbiter resolves ──▶ freelancer paid / client refunded
```

- **Invoice id** is a random 32 bytes, so nobody can claim an invoice number in advance. The human-readable title and description are hashed on-chain (`descriptionHash`); the full text travels in the share link, and the detail page checks it against the hash.
- **Funded amount is always checked against the invoice amount** — never trust `isPaid`-style flags alone. The relayer reads the invoice from the chain and refuses anything that doesn't match exactly.
- **Gasless funding** reuses the kit's EIP-3009 relayer: the client signs once, the relayer submits `fundInvoiceWithAuthorization` and pays the gas. The signature's nonce is `keccak256(escrow, invoiceId)`, so it can only fund that one invoice.
- **Recurring invoices:** `renewInvoice` creates the next cycle with the same terms. The next id is deterministic — `keccak256(rootId, cycle + 1)` — and renewals can't be doubled or chained past the limit.
- **No owner, no admin.** Nobody can move escrowed funds except through the rules above.

---

## Quickstart (5 minutes, no funds needed)

You need [Node 22+](https://nodejs.org), [pnpm](https://pnpm.io/installation) and [Foundry](https://book.getfoundry.sh/getting-started/installation) (`foundryup`).

```bash
git clone --recursive https://github.com/Ipan8/aevum-invoice-escrow.git
cd aevum-invoice-escrow
make install          # Solidity libs + JS packages
make check            # build, Shanghai opcode check, unit tests, fork tests
```

> The first snapshot of this repo was pushed without git submodule pointers, so a fresh clone may not bring `forge-std` / `openzeppelin-contracts` with it. If `make install` doesn't fetch them, get the pinned versions once:
>
> ```bash
> cd contracts && forge install foundry-rs/forge-std@3b20d60d14b343ee4f908cb8079495c07f5e8981 OpenZeppelin/openzeppelin-contracts@69c8def5f222ff96f2b5beff05dfba996368aa79
> ```

Run the whole app against a **local copy of Aevum**, with the real tUSD8 and free test balances:

```bash
# terminal 1: local copy of Aevum testnet on 127.0.0.1:8555 (chain 440050)
make fork

# terminal 2: deploy Checkout + InvoiceEscrow and give yourself test money
make deploy-fork                      # prints both contract addresses
make deal TO=<your wallet address>    # 100 tUSD8 + 10 tQDAY, on the fork only

cp web/.env.example web/.env.local
#   NEXT_PUBLIC_NETWORKS=fork,aevum
#   NEXT_PUBLIC_CHECKOUT_FORK=<address from deploy-fork>
#   NEXT_PUBLIC_ESCROW_FORK=<address from deploy-fork>
#   RELAYER_PRIVATE_KEY=<a test key, see below>   (optional: enables gasless mode)
make dev                              # http://localhost:3000
```

Use the **Local fork / Aevum testnet** switcher in the app's header. The first time you pick the fork, your wallet offers to add "Aevum fork (local)" as a new network; after that, switching is one click and your real testnet network stays untouched.

**Why the fork has its own chain ID (440050):** it copies Aevum's state (accounts, balances, tUSD8) but anything you sign there, such as an EIP-3009 authorization or a permit, can't be replayed on the real testnet, and wallets never mix the two up. `make deploy-fork` also deploys from a random address nobody has the key to, so its contract addresses can't be claimed on the real testnet.

For a local relayer, any of anvil's [default test accounts](https://book.getfoundry.sh/anvil/#getting-started) works. Those keys are public, so the relayer refuses them on any chain but `make fork` and `make anvil`. When you add `aevum`, put a fresh test wallet's key in `RELAYER_PRIVATE_KEY` instead.

Want an empty chain instead of a fork? `make anvil` + `make deploy-local` deploys a `MockUSD8` (same decimals, EIP-712 domain and EIP-3009 functions as tUSD8) that anyone can mint with `make mint`.

---

## Network details

| | |
|---|---|
| Network | QDay Aevum Testnet |
| Chain ID | `44005` |
| RPC | `https://rpc-test.qday.info` (HTTPS only, no WebSocket) |
| Explorer | https://explorer-test.qday.info |
| Gas token | tQDAY (18 decimals) |
| Gas price | about 1 gwei. 1 tQDAY covers hundreds of contract calls. |
| EVM version | **Shanghai** |
| tUSD8 | [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483), 6 decimals, USDC-style (EIP-2612 `permit`, EIP-3009 signed transfers), EIP-712 domain `name: "tUSD8"`, `version: "2"` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

All of this is in [`packages/aevum/src/chain.ts`](packages/aevum/src/chain.ts) and [`contracts.ts`](packages/aevum/src/contracts.ts).

---

## Get test tokens

- **Discord faucet (for Builder Challenge participants):** join the [QDay Discord](https://discord.gg/bYPhjmrSfK), react ✅ in `#verify`, then run `/faucet <your address>`. You get **1 tQDAY + 5 tUSD8**, once per Discord account and once per address. No Ethereum mainnet balance needed.
- **Web faucet:** https://faucet.qday.info. Check the page for its rules.
- **Local fork:** `make deal TO=<address>` for unlimited test balances. Nothing leaves your machine.

1 tQDAY is plenty for development: deploying `InvoiceEscrow` costs well under 0.01 tQDAY.

---

## Deploy to Aevum testnet

Keep your deployer key out of files and shell history. Foundry's encrypted keystore asks for the key once and a password each time:

```bash
cast wallet import aevum-deployer --interactive   # paste the key of a TEST wallet
cast wallet address --account aevum-deployer      # fund this address from the faucet

make deploy-aevum ACCOUNT=aevum-deployer          # deploys Checkout + InvoiceEscrow, uses real tUSD8
```

Then set `NEXT_PUBLIC_CHECKOUT_AEVUM` and `NEXT_PUBLIC_ESCROW_AEVUM` in `web/.env.local` and add `aevum` to `NEXT_PUBLIC_NETWORKS`.

**Putting the web app online:** see [Deploy the web app to Vercel](#deploy-the-web-app-to-vercel). The same settings apply to any other host.

> Use a wallet made only for testing. Never paste a private key into chat, an issue, or a committed file.

**Contract verification:** the explorer's verifier isn't working yet, so `forge verify-contract` will fail for now. Put your contract addresses and a link to the source (the exact commit) in your README and submission instead. The command, for when it's back:

```bash
forge verify-contract <address> src/InvoiceEscrow.sol:InvoiceEscrow --chain-id 44005 \
  --verifier blockscout --verifier-url https://explorer-test.qday.info/api/
```

---

## Deploy the web app to Vercel

Deploy your contracts first ([above](#deploy-to-aevum-testnet)), then:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIpan8%2Faevum-invoice-escrow&root-directory=web&project-name=aevum-invoice-escrow&repository-name=aevum-invoice-escrow&env=NEXT_PUBLIC_NETWORKS%2CNEXT_PUBLIC_CHECKOUT_AEVUM%2CNEXT_PUBLIC_ESCROW_AEVUM%2CTRUSTED_IP_HEADER&envDefaults=%7B%22NEXT_PUBLIC_NETWORKS%22%3A%22aevum%22%2C%22TRUSTED_IP_HEADER%22%3A%22x-vercel-forwarded-for%22%7D&envDescription=Your%20contract%20addresses%20from%20%60make%20deploy-aevum%60.%20Add%20RELAYER_PRIVATE_KEY%20later%20in%20Project%20Settings%20to%20turn%20on%20gasless%20payments.&envLink=https%3A%2F%2Fgithub.com%2FIpan8%2Faevum-invoice-escrow%23deploy-the-web-app-to-vercel)

The button copies this repo into your GitHub account and creates a Vercel project with **Root Directory** `web`. It asks for:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_NETWORKS` | `aevum` (prefilled). Keep it to `aevum` online: with `fork` or `local`, visitors get a "Local fork" option that points at *their own* 127.0.0.1. |
| `NEXT_PUBLIC_CHECKOUT_AEVUM` | Your Checkout address from `make deploy-aevum`. |
| `NEXT_PUBLIC_ESCROW_AEVUM` | Your InvoiceEscrow address from `make deploy-aevum`. |
| `TRUSTED_IP_HEADER` | `x-vercel-forwarded-for` (prefilled). The relayer rate-limits on this header, which Vercel sets and visitors can't fake. |

Optional, in **Project Settings → Environment Variables** (then redeploy):

| Variable | Value |
|---|---|
| `RELAYER_PRIVATE_KEY` | Turns on gasless checkout and gasless invoice funding. A **fresh** wallet with a little tQDAY, never one that holds anything else, and never an anvil key (the relayer refuses those on Aevum). Mark it Sensitive. |
| `NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM` | Your deploy block. The Activity and Dashboard pages start scanning there. |
| `NEXT_PUBLIC_WC_PROJECT_ID` | Enables WalletConnect (mobile wallets). Free at [cloud.reown.com](https://cloud.reown.com). |
| `NEXT_PUBLIC_REPO_URL` | Your repo, for the Docs page's Source link. |

Doing it by hand instead: **Add New → Project**, import your repo, set **Root Directory** to `web`, add the variables above, and deploy. Keep the whole repo connected (not just `web/`): the app imports `packages/aevum` through the pnpm workspace, and Vercel reads `pnpm-lock.yaml` at the repo root.

> **The relayer's limits live in memory.** On Vercel each function instance has its own copy, so they slow down an attacker but don't stop one. Keep only a little tQDAY in the relayer, and move the limits to a shared store (for example Upstash Redis) if your app gets real traffic.

---

## How the escrow works

`InvoiceEscrow` holds tUSD8 for one invoice at a time. Each invoice has a freelancer, a client, an optional arbiter, an amount, a due date, an auto-release date, and an optional recurring schedule.

**States:** `Created → Funded → Released | Refunded | Cancelled | Expired`. A `disputed` flag freezes a funded invoice until it is resolved.

| Function | Who | What it does |
|---|---|---|
| `createInvoice` | freelancer | Creates the invoice (exact amount, due + auto-release dates, optional arbiter and recurring schedule). Stores only the description hash on-chain. |
| `fundInvoice` | client | Approves + pays the exact amount into escrow. |
| `fundInvoiceWithAuthorization` | relayer (client signed) | Gasless funding via EIP-3009. Nonce is `keccak256(escrow, invoiceId)` — bound to this invoice only. |
| `approveMilestone` | client | Releases the funds to the freelancer. |
| `releaseAfterDeadline` | anyone | Releases the funds once the auto-release date passed with no dispute. |
| `raiseDispute` | client or freelancer | Freezes the funds. |
| `resolveDispute(release)` | arbiter, or the client when no arbiter was named | Releases to the freelancer or refunds the client. |
| `cancelInvoice` | freelancer, unfunded only | Cancels a never-funded invoice. |
| `expireInvoice` | anyone | Marks an unfunded invoice expired after its due date. |
| `renewInvoice` | freelancer, released + recurring | Creates the next cycle. Next id = `keccak256(rootId, cycle + 1)`; renewals can't be doubled. |

Design choices worth reusing:

- **Checks-effects-interactions throughout**, no owner/admin, no upgradeability. Escrowed funds can only move through the functions above.
- **The relayer never trusts the client.** For gasless funding it reads the invoice from the chain and checks status (`Created`), client (`from` must match), and amount (must match exactly) before simulating and submitting. A signature for a different amount or invoice fails simulation and costs nothing.
- **The description hash** lets the detail page prove the text in a share link is what was agreed at creation — without storing the text on-chain.
- **The dashboard** reads escrow events with the kit's chunked log reader (1,000 blocks per call) and shows what's locked, what's due soon, and the latest activity.

The original checkout (`Checkout.sol`) is still in the repo, unchanged, with its own page — it shows the simple pay-per-order flow the escrow builds on.

Code to read, in order:

1. [`contracts/src/InvoiceEscrow.sol`](contracts/src/InvoiceEscrow.sol)
2. [`contracts/test/InvoiceEscrow.t.sol`](contracts/test/InvoiceEscrow.t.sol): 37 unit tests (create/fund/gasless/dispute/approve/auto-release/cancel/expire/renew + fuzz)
3. [`contracts/test/fork/InvoiceEscrowFork.t.sol`](contracts/test/fork/InvoiceEscrowFork.t.sol): the same flows against the real tUSD8 on a fork
4. [`web/src/app/invoices/page.tsx`](web/src/app/invoices/page.tsx): create form + my-invoices list
5. [`web/src/app/invoices/[invoiceId]/page.tsx`](web/src/app/invoices/[invoiceId]/page.tsx): detail + role-based actions
6. [`web/src/app/dashboard/page.tsx`](web/src/app/dashboard/page.tsx): escrow stats + activity feed
7. [`web/src/app/api/relay/route.ts`](web/src/app/api/relay/route.ts): gasless relayer, checkout + escrow branches

---

## Things that differ from Ethereum

| | What happens | What to do |
|---|---|---|
| **Shanghai EVM** | Cancun opcodes (`MCOPY`, `TSTORE`/`TLOAD`, blob ops) don't exist. Code compiled for Cancun deploys fine, then reverts with `invalid opcode`. | Keep `evm_version = "shanghai"` in `foundry.toml` (already set). `make build` runs [`tools/check-shanghai.mjs`](tools/check-shanghai.mjs) to catch it. Don't use OpenZeppelin's `*Transient` contracts. |
| **anvil hides it** | A plain `anvil --fork-url` runs Cancun, so bad bytecode passes local tests. | Always add `--hardfork shanghai` (the Makefile does). |
| **1,000-block log limit** | `eth_getLogs` over more than 1,000 blocks fails. | Use `getLogsChunked` from `@aevum-kit/aevum`. Store your deploy block and start from there. |
| **No WebSocket RPC** | `watchContractEvent` over WS won't connect. | Poll over HTTPS (viem's default for `http()` transports). |
| **Explorer verification** | Not working yet. | See [Deploy](#deploy-to-aevum-testnet). |
| **Legacy transactions** | The kit's scripts and relayer send legacy (type 0) transactions, the same as QDay's own faucet. | `--legacy` in `forge script`, `type: "legacy"` in viem. |

---

## Project layout

```
contracts/            Foundry project
  src/InvoiceEscrow.sol  invoice + milestone escrow (the new contract)
  src/Checkout.sol       the kit's pay-per-order contract (kept as-is)
  src/mocks/MockUSD8.sol  local tUSD8 stand-in (anyone can mint)
  test/                 unit tests + test/fork (real tUSD8 on a fork)
  script/Deploy.s.sol   deploys Checkout + InvoiceEscrow to anvil, a fork or Aevum
packages/aevum/       chain config, ABIs (incl. invoiceEscrowAbi), EIP-3009 typed data, getLogsChunked
web/                  Next.js app (wagmi + RainbowKit)
  src/app/page.tsx        Setup check (incl. InvoiceEscrow)
  src/app/invoices/       create invoices + invoice detail (fund/approve/dispute/resolve/renew)
  src/app/dashboard/      escrow stats + activity feed
  src/app/checkout/       standard + gasless checkout (kit)
  src/app/receipts/       receipt read from the chain (kit)
  src/app/activity/       Paid events, read in 1,000-block chunks (kit)
  src/app/api/relay/      gasless relayer: checkout + escrow branches
  src/app/globals.css     every color and font; edit to rebrand
examples/             runnable TypeScript scripts (kit)
tools/check-shanghai.mjs  fails the build on Cancun-only opcodes
LICENSE, NOTICE.md     MIT license and third-party licenses
```

---

## Commands

```
make install        Fetch Solidity libs and JS packages
make build          Compile contracts and check they are Shanghai-safe
make test           Unit tests (local, no network)
make test-fork      Tests against the real tUSD8 on a local fork of Aevum
make check          Build, tests and typecheck (CI also runs pnpm build)
make anvil          Empty local chain (31337) with Aevum's EVM rules
make fork           Local copy of Aevum testnet on 127.0.0.1:8555 (chain 440050)
make deploy-local   Deploy MockUSD8 + Checkout + InvoiceEscrow to `make anvil`
make deploy-fork    Deploy Checkout + InvoiceEscrow (real tUSD8) to `make fork`
make deploy-aevum   Deploy Checkout + InvoiceEscrow to Aevum testnet (ACCOUNT=<keystore>)
make mint           `make anvil` only: mint MockUSD8 (TO=, CHECKOUT=, AMOUNT=)
make deal           `make fork` only: give TO tUSD8 and tQDAY
make dev            Start the web app on http://localhost:3000
```

Examples (copy `examples/.env.example` to `examples/.env` first):

```bash
pnpm example check-setup      # chain, block, gas price and balances of ADDRESS
pnpm example pay-gasless      # BUYER_KEY signs, RELAYER_KEY submits
pnpm example read-payments    # every Paid event, 1,000 blocks at a time
```

---

## Submitting your project

### The problem

Freelancers in Indonesia (and anywhere without easy access to international banking) struggle to get paid across borders without a bank account — and clients who pay upfront have no guarantee the work will be delivered. This project is an **invoice + milestone escrow in tUSD8 on QDay Aevum testnet**: the client locks payment in escrow, the freelancer sees the money is already there, and funds move only when the client approves the milestone — or automatically when the deadline passes with no dispute. If something goes wrong, either side raises a dispute and a named arbiter (or the client, when no arbiter was named) resolves it: release or refund. The client needs no gas and no tQDAY: funding can be gasless with a single EIP-3009 signature.

### Architecture

- `contracts/src/InvoiceEscrow.sol` — the escrow core (**new code written for this entry**): create / fund / approve / release / dispute / renew. No owner, no admin, no upgradeability. Funding must match the invoice amount exactly; the EIP-3009 nonce is bound to the invoice (`keccak256(escrow, invoiceId)`), so a signature cannot be replayed for another invoice. Recurring invoices renew into a new invoice with the same terms.
- `contracts/src/Checkout.sol` — the kit's example pay-per-order flow, kept as the simple checkout path.
- `web/` (Next.js + TypeScript) — invoice UI, dashboard, activity feed, receipts. Every chain read and write goes through `@aevum-kit/aevum` (see below).
- `web/src/app/api/relay/route.ts` — gasless relayer: it reads the invoice from the chain, checks status (`Created`), client and amount, simulates, then submits `fundInvoiceWithAuthorization` and pays the gas. A signature for a different amount or invoice fails simulation and costs nothing.
- `packages/aevum/` (`@aevum-kit/aevum`) — the Aevum integration library shipped with the official starter kit (see [Aevum integration](#aevum-integration)).

### Workflow (what a judge can click through)

1. Freelancer creates an invoice (amount, due date, auto-release date, optional arbiter).
2. Client funds it — directly, or gasless by signing once (the relayer submits and pays gas).
3. Freelancer delivers the work.
4. Client approves the milestone → funds released to the freelancer. Or: the auto-release date passes with no dispute → anyone can release. Or: either side disputes → the arbiter resolves (release or refund).

### Tech stack

Solidity (Shanghai EVM, no Cancun opcodes), Foundry, Next.js + TypeScript, wagmi / viem / RainbowKit, tUSD8 (EIP-2612 + EIP-3009, 6 decimals), Vercel hosting.

### Live demo + video

- **Live demo:** https://aevum-invoice-escrow-ipan12.vercel.app
- **Demo video:** `demo-video-aevum.mp4` in the repo root (2:41, narrated walkthrough of the live demo + on-chain evidence).

### Contracts on Aevum testnet (chain `44005`)

Explorer: https://explorer-test.qday.info

| Contract | Address | Deploy tx | Block |
|---|---|---|---|
| `InvoiceEscrow` | `0x0a8401Acdf5c13c5255763D38472Fb9F9303E2d8` | `0x060f93de02cb62d9d53f5048b203947b45387aaafba0cd095b78586cf24f1a7a` | 3643492 |
| `Checkout` | `0x80B416d32fD4A70161eeE887ac9bDAD43D93849b` | `0x769cf98b08a102272215140fe8c6b76ba0de5a1aa8d7945ed24be686c2dc7cc8` | 3643491 |

### Verified end-to-end run (20 Nov 2026, live testnet)

Invoice `0xf16726821b2f51134b3788e7caf9585d63fc14dd9cd3c381356c621de8048d4b`, freelancer `0x550BC7715640cB36fB5E3F1A81f294399d025595`, amount **1 tUSD8**. All receipts `status 0x1` (verified against the Aevum RPC):

| Step | Transaction | Block |
|---|---|---|
| Create invoice | `0x744e8fee7325f9a00ef98d5b33ff4c00987b328de80327482857f6191e43a239` | 3649313 |
| Gasless fund (via live `/api/relay`) | `0x133382c2739e20918c08fa1fb48bb1d656b9b964f928a120332d2aaaea2a2ef4` | 3649502 |
| Approve milestone → Released, freelancer received 1 tUSD8 | `0xd5da9e8db215a06b0523be1ea5462f70c1f2805860527b0063e95a4d76dcd577` | 3649517 |
| Checkout order `0xa0daef835f7816d4f9d5cb0fa4f279c4ea9a04cf837cc0b6448feee6aa8b2d37`, gasless pay → `isPaid = true` | `0x02fe7019117705ff5ef60ab82a2e3ce4b089557975f8055387f06b73c103aa19` | 3649534 |

Machine-readable evidence: [`docs/e2e-2026-11-20.json`](docs/e2e-2026-11-20.json).

The deployed bytecode was verified against this repo: a fresh `forge build` produces identical runtime code for both contracts (same length, same metadata hash; the only differing bytes are the immutable constructor addresses — tUSD8 and the relayer wallet). The deployed code **is** the code in this repo.

### Aevum integration

The app integrates the Aevum integration library shipped with the **official Aevum Starter Kit**: [`@aevum-kit/aevum`](packages/aevum) (workspace package, MIT). It is the kit's own Aevum layer, and every on-chain interaction in this app goes through it:

- **Chain config** (`src/chain.ts`): `aevumTestnet` (chain `44005`, RPC `https://rpc-test.qday.info`, explorer `https://explorer-test.qday.info`, multicall3), plus the local anvil/fork chains and `MAX_LOG_RANGE = 1000` (Aevum's `eth_getLogs` limit).
- **Contract ABIs** (`src/contracts.ts`): tUSD8 address + ERC-20 ABI, EIP-3009 ABI, `checkoutAbi`, `invoiceEscrowAbi` — used by the invoice pages, dashboard, activity feed, receipts, checkout, and the relayer (12 files under `web/src` import from the package).
- **EIP-3009 helpers** (`src/eip3009.ts`): `checkoutTypedData` builds the EIP-712 message the client signs for gasless payment.
- **Chunked log reader** (`src/logs.ts`): `getLogsChunked` splits `eth_getLogs` into ≤1,000-block requests — required on Aevum, where a wider range fails.

**Honest note for judges:** the package is not branded "SDK" anywhere in the kit — it is the starter kit's official shared Aevum library, and it is the integration surface QDay ships for this challenge; no separately published "Aevum SDK" package exists in the kit. The other named path, a QDay agent via the ERC-8004 registry, is **not open for this challenge** (the registry is still in internal testing — see the in-app Docs page). No integration was faked: everything listed above is imported and executed by the running app, and the on-chain evidence above proves it. If the judges want a different integration surface, please ask in the QDay Discord Q/A — the team can add it before the deadline.

### Before you submit

- **Commit first.** At the time of writing, the working tree has uncommitted changes (including `contracts/src/InvoiceEscrow.sol` and the invoice UI, which are new files). The deployed contracts match this exact tree, so commit it and push to `https://github.com/Ipan8/aevum-invoice-escrow` — the resulting commit is the "exact commit deployed". Do not submit with a dirty tree.
- Pushing to `main` redeploys the Vercel demo automatically, so the live demo will then show the new "Aevum Invoice Escrow" title.
- Submit on DoraHacks before **11 Dec 2026, 15:00 WIB** with the repo link, the live demo URL, and the demo video.

Read the official rules on the DoraHacks challenge page. They win over anything here.

### Licenses and credit

The organizers confirmed that boilerplate, scaffolding and templates are allowed, as long as their license permits the use. The starter kit is MIT licensed, so building on it is allowed.

- This repo is MIT licensed (see [LICENSE](LICENSE)).
- **Based on [Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) (MIT, © 2026 PQA Labs).** Its `LICENSE` file is kept in this repo, and the kit's own `NOTICE.md` lists its third-party licenses.
- Keep the original copyright and license headers in any file copied from another project.
- Put a short comment above any code snippet you borrow, naming the source repo, author and license.
- List your third-party dependencies and their licenses in your README or a `NOTICE` file. [NOTICE.md](NOTICE.md) shows one way to do it.
- If you copy a whole directory or library, keep its original `LICENSE` file in that folder.

---

## FAQ

**Do I have to use `Checkout`?** No. It's the kit's example, kept here as the simple pay-per-order flow. The invoice escrow is the actual entry.

**Can I use account abstraction?** It isn't required for this challenge, and there's no officially supported bundler or paymaster. A normal wallet plus tUSD8 payments is enough. To spare users gas, use the gasless flows in this app (EIP-3009 with a relayer). You can deploy your own ERC-4337 setup if you want to, but the team won't support or debug it.

**Can I use Hardhat?** Yes. Set `evmVersion: "shanghai"` in the Solidity settings, and `hardfork: "shanghai"` for the Hardhat network.

**My transaction fails with `invalid opcode`.** You compiled for Cancun. See [Things that differ from Ethereum](#things-that-differ-from-ethereum).

**`eth_getLogs` errors on a big range.** Split it into 1,000-block chunks with `getLogsChunked`.

**What if the client never approves?** The auto-release date releases the funds automatically (anyone can call `releaseAfterDeadline` once it passes) — unless a dispute was raised, which freezes the funds until resolved.

**What if the freelancer never delivers?** The client (or freelancer) raises a dispute before the auto-release date. The arbiter — or the client, when no arbiter was named — then releases or refunds.

**Where do I ask for help?** In the [QDay Discord](https://discord.gg/bYPhjmrSfK)'s Builder Challenge channels (verify first to see them), Monday to Friday, 10:00 to 18:00 HKT.

**`pnpm audit` reports high advisories in `zod` and `decode-uri-component`.** Both come in through WalletConnect (`@reown/appkit-wallet` pins `zod` 3.22.4; `@walletconnect/utils` 2.21 uses `query-string`). They run only in the browser, are only reached when you set `NEXT_PUBLIC_WC_PROJECT_ID`, and at worst slow down the user's own tab. The relay route doesn't load them. The fix is upstream: RainbowKit moving to wagmi 3 brings WalletConnect 2.26, which drops `query-string`. Forcing newer versions with `pnpm.overrides` swaps in major versions WalletConnect wasn't tested with, so the kit doesn't.

---

MIT licensed. See [LICENSE](LICENSE). Based on Aevum Starter Kit (MIT, © 2026 PQA Labs). Third-party licenses are listed in [NOTICE.md](NOTICE.md).
