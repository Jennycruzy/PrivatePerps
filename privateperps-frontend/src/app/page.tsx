"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  encryptPosition,
  submitOpenPosition,
  submitClosePosition,
  ArciumEncryptedPosition,
} from "@/utils/arciumClient";
import IDL from "@/idl/private_perps.json";

const BASE_PRICES: Record<string, number> = {
  "BTC/USD": 67420,
  "ETH/USD": 3481,
  "SOL/USD": 175.4,
};

const open24h: Record<string, number> = {
  "BTC/USD": 66594,
  "ETH/USD": 3451,
  "SOL/USD": 175.96,
};

interface Position {
  id: string;
  pair: string;
  side: "long" | "short";
  size: number;
  leverage: number;
  entry: number;
  encrypted: ArciumEncryptedPosition;
  txSig: string;
  ghost: boolean;
  ts: number;
}

export default function TradingPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const programRef = useRef<anchor.Program<any> | null>(null);
  const providerRef = useRef<anchor.AnchorProvider | null>(null);

  const [market, setMarket] = useState("BTC/USD");
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState(500);
  const [leverage, setLeverage] = useState(10);
  const [ghost, setGhost] = useState(false);
  const [prices, setPrices] = useState({ ...BASE_PRICES });
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [fundingTimer, setFundingTimer] = useState("08:00:00");
  const [mockBalance, setMockBalance] = useState<number | null>(null);
  const [airdropping, setAirdropping] = useState(false);

  // Initialize Anchor program when wallet connects
  useEffect(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return;

    const provider = new anchor.AnchorProvider(
      connection,
      wallet as any,
      { commitment: "confirmed" }
    );
    providerRef.current = provider;
    anchor.setProvider(provider);

   try {
  // Anchor 0.32 IDL has address field — pass only IDL and provider
  programRef.current = new anchor.Program(IDL as any, provider);
  console.log("✅ Program loaded:", PROGRAM_ID.toString());
} catch (e) {
  console.error("Program load error:", e);
}

    // Give user 10,000 mock USDC on connect for testing
    if (mockBalance === null) {
      setMockBalance(10000);
      showToast("🎉 Welcome! 10,000 mock USDC added to your account for testing.", "ok");
    }
  }, [wallet.publicKey, connection]);

  // Clear state on disconnect
  useEffect(() => {
    if (!wallet.publicKey) {
      programRef.current = null;
      providerRef.current = null;
      setMockBalance(null);
      setPositions([]);
    }
  }, [wallet.publicKey]);

  // Price ticker
  useEffect(() => {
    const interval = setInterval(() => {
      setPrices((prev) => {
        const next = { ...prev };
        for (const pair of Object.keys(next)) {
          const v = pair === "BTC/USD" ? 0.0007 : pair === "ETH/USD" ? 0.0009 : 0.0012;
          next[pair] *= 1 + (Math.random() - 0.499) * v;
        }
        return next;
      });
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  // Funding timer
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      const next = new Date(now);
      next.setUTCHours(Math.ceil(now.getUTCHours() / 8) * 8, 0, 0, 0);
      if (next <= now) next.setUTCHours(next.getUTCHours() + 8);
      const d = next.getTime() - now.getTime();
      const h = String(Math.floor(d / 3600000)).padStart(2, "0");
      const m = String(Math.floor((d % 3600000) / 60000)).padStart(2, "0");
      const s = String(Math.floor((d % 60000) / 1000)).padStart(2, "0");
      setFundingTimer(`${h}:${m}:${s}`);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const showToast = (msg: string, type: string) => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 5000);
  };

  // Airdrop devnet SOL for gas fees
  const handleAirdrop = async () => {
    if (!wallet.publicKey) return;
    setAirdropping(true);
    try {
      const sig = await connection.requestAirdrop(
        wallet.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);
      showToast("✅ 2 devnet SOL airdropped for gas fees!", "ok");
    } catch {
      showToast("Airdrop failed — try faucet.solana.com", "err");
    } finally {
      setAirdropping(false);
    }
  };

  const handleOpenPosition = useCallback(async () => {
    if (!wallet.publicKey) {
      setVisible(true);
      return;
    }

    if (!providerRef.current || !programRef.current) {
      showToast("Program not loaded yet — please wait a moment and try again.", "err");
      return;
    }

    if (mockBalance !== null && size > mockBalance) {
      showToast(`Insufficient balance. You have $${mockBalance.toLocaleString()} USDC.`, "err");
      return;
    }

    setLoading(true);
    try {
      const currentPrice = prices[market];
      setStatus("🔐 Encrypting position via Arcium X25519 ECDH...");

      // Encrypt position data using Arcium SDK
      const encrypted = await encryptPosition(
        providerRef.current,
        currentPrice,
        size,
        leverage,
        side
      );

      setStatus("📡 Submitting encrypted position to Solana devnet...");

      // Submit to chain using real IDL accounts
      const sig = await submitOpenPosition(
        programRef.current,
        encrypted,
        wallet.publicKey
      );

      // Deduct from mock balance
      setMockBalance((prev) => (prev ?? 0) - size);

      const newPos: Position = {
        id: Math.random().toString(36).slice(2),
        pair: market,
        side,
        size,
        leverage,
        entry: currentPrice,
        encrypted,
        txSig: sig,
        ghost,
        ts: Date.now(),
      };

      setPositions((prev) => [...prev, newPos]);
      setStatus("");

      const msg = ghost
        ? `👻 Ghost position opened — encrypted in Arcium MXE\nTx: ${sig.slice(0, 20)}...`
        : `✅ Position opened — encrypted by Arcium MPC\nTx: ${sig.slice(0, 20)}...`;
      showToast(msg, ghost ? "arcium" : "ok");
    } catch (err: any) {
      console.error(err);
      setStatus("");
      showToast(`Error: ${err.message || "Transaction failed"}`, "err");
    } finally {
      setLoading(false);
    }
  }, [wallet, prices, market, side, size, leverage, ghost, mockBalance, setVisible]);

  const handleClosePosition = useCallback(
    async (pos: Position) => {
      if (!wallet.publicKey || !providerRef.current || !programRef.current) return;

      setLoading(true);
      try {
        const currentPrice = prices[pos.pair];
        setStatus("🔐 Closing position on Solana devnet...");

        const { signature } = await submitClosePosition(
          programRef.current,
          wallet.publicKey,
          currentPrice
        );

        const pnlUsd = estimatePnL(pos, currentPrice);
        const returnAmount = pos.size + pnlUsd;

        setPositions((prev) => prev.filter((p) => p.id !== pos.id));
        setMockBalance((prev) => (prev ?? 0) + returnAmount);
        setStatus("");

        const sign = pnlUsd >= 0 ? "+" : "";
        showToast(
          `Position closed ✓\nRealized PnL: ${sign}$${pnlUsd.toFixed(2)}\nBalance updated\nTx: ${signature.slice(0, 20)}...`,
          pnlUsd >= 0 ? "ok" : "err"
        );
      } catch (err: any) {
        console.error(err);
        setStatus("");
        showToast(`Close error: ${err.message}`, "err");
      } finally {
        setLoading(false);
      }
    },
    [wallet, prices]
  );

  function estimatePnL(pos: Position, currentPrice: number) {
    const delta =
      pos.side === "long" ? currentPrice - pos.entry : pos.entry - currentPrice;
    return (delta / pos.entry) * pos.size * pos.leverage;
  }

  function calcPnL(pos: Position) {
    const cur = prices[pos.pair];
    const pnl = estimatePnL(pos, cur);
    const pct = (pnl / pos.size) * 100;
    return { pnl, pct, cur };
  }

  function fmt(n: number) {
    if (n >= 1000) return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (n >= 10) return n.toFixed(2);
    return n.toFixed(3);
  }

  const price = prices[market];
  const change = ((price - open24h[market]) / open24h[market]) * 100;
  const isUp = change >= 0;
  const notional = size * leverage;

  return (
    <div className="flex flex-col h-screen bg-[#04060a] text-[#c8daea] font-mono text-xs overflow-hidden">

      {/* ── NAV ── */}
      <nav className="h-[52px] bg-[#080c12] border-b border-[#1a2535] flex items-center px-5 gap-0 flex-shrink-0 relative">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#7b61ff] to-transparent opacity-60" />

        <div className="flex flex-col gap-[1px] mr-7">
          <div className="text-xl font-bold tracking-tight bg-gradient-to-r from-white to-[#7b61ff] bg-clip-text text-transparent">
            PrivatePerps
          </div>
          <div className="text-[9px] text-[#3a5470] tracking-[2.5px] uppercase">
            Perps without predators
          </div>
        </div>

        <div className="w-px h-6 bg-[#1a2535] mx-4" />

        {/* Market tabs */}
        <div className="flex">
          {Object.keys(BASE_PRICES).map((pair) => {
            const p = prices[pair];
            const chg = ((p - open24h[pair]) / open24h[pair]) * 100;
            const up = chg >= 0;
            return (
              <button
                key={pair}
                onClick={() => setMarket(pair)}
                className={`flex items-center gap-2.5 px-4 h-[52px] cursor-pointer border-b-2 transition-all ${
                  market === pair
                    ? "text-[#c8daea] border-[#7b61ff]"
                    : "text-[#3a5470] border-transparent hover:text-[#6e8faa]"
                }`}
              >
                <span className="font-semibold text-xs tracking-wide">{pair}</span>
                <span className="text-xs font-semibold">${fmt(p)}</span>
                <span className={`text-[10px] ${up ? "text-[#00e896]" : "text-[#ff2d55]"}`}>
                  {up ? "+" : ""}{chg.toFixed(2)}%
                </span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Arcium badge */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[rgba(123,97,255,0.1)] border border-[rgba(123,97,255,0.25)] rounded text-[10px] tracking-widest text-[#a89fff] uppercase">
            <div className="w-1.5 h-1.5 rounded-full bg-[#7b61ff] shadow-[0_0_6px_#7b61ff] animate-pulse" />
            Arcium MPC · Devnet
          </div>

          {/* Mock USDC balance */}
          {mockBalance !== null && (
            <div className="px-3 py-1.5 bg-[rgba(0,232,150,0.08)] border border-[rgba(0,232,150,0.2)] rounded text-[10px] text-[#00e896]">
              💰 ${mockBalance.toLocaleString(undefined, {maximumFractionDigits: 2})} USDC
            </div>
          )}

          {/* Airdrop SOL button */}
          {wallet.publicKey && (
            <button
              onClick={handleAirdrop}
              disabled={airdropping}
              className="px-3 py-1.5 border border-[#1a2535] rounded text-[10px] text-[#f0c060] hover:border-[#f0c060] hover:bg-[rgba(240,192,96,0.08)] transition-all disabled:opacity-30"
            >
              {airdropping ? "Airdropping..." : "🪙 Get SOL"}
            </button>
          )}

          <div className="flex items-center gap-1 px-2.5 py-1.5 bg-[rgba(0,255,209,0.08)] border border-[rgba(0,255,209,0.15)] rounded text-[9px] tracking-[1.5px] text-[#00c4a0] uppercase">
            🔒 Encrypted
          </div>

          <button
            onClick={() => wallet.publicKey ? wallet.disconnect() : setVisible(true)}
            className={`px-4 py-2 border rounded text-[11px] font-medium tracking-wide transition-all ${
              wallet.publicKey
                ? "border-[#00e896] text-[#00e896] bg-[rgba(0,232,150,0.1)]"
                : "border-[#1f2e42] text-[#6e8faa] hover:border-[#7b61ff] hover:text-[#7b61ff] hover:bg-[rgba(123,97,255,0.08)]"
            }`}
          >
            {wallet.publicKey
              ? `${wallet.publicKey.toString().slice(0, 4)}...${wallet.publicKey.toString().slice(-4)}`
              : "Connect Wallet"}
          </button>
        </div>
      </nav>

      {/* ── STATS BAR ── */}
      <div className="h-[34px] bg-[#080c12] border-b border-[#1a2535] flex items-center px-5 gap-7 flex-shrink-0 overflow-x-auto">
        {[
          ["Mark Price", `$${fmt(price)}`],
          ["24h Change", `${isUp ? "+" : ""}${change.toFixed(2)}%`, isUp ? "text-[#00e896]" : "text-[#ff2d55]"],
          ["24h Vol", "$2.48B"],
          ["Open Int", "$890M"],
          ["Funding", "+0.0082%", "text-[#00e896]"],
          ["Next Funding", fundingTimer, "text-[#f0c060]"],
        ].map(([label, val, cls]) => (
          <div key={label as string} className="flex flex-col gap-[1px] min-w-max">
            <span className="text-[9px] uppercase tracking-[1.5px] text-[#3a5470]">{label}</span>
            <span className={`text-[11px] font-medium ${cls || "text-[#c8daea]"}`}>{val}</span>
          </div>
        ))}
        <div className="ml-auto flex flex-col gap-[1px] min-w-max">
          <span className="text-[9px] uppercase tracking-[1.5px] text-[#3a5470]">Liq. Threshold</span>
          <span className="text-[10px] text-[#7b61ff]">🔒 Arcium Encrypted</span>
        </div>
      </div>

      {/* ── MAIN ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── CHART / PRICE AREA ── */}
        <div className="flex-1 border-r border-[#1a2535] flex flex-col overflow-hidden">
          <div className="h-9 bg-[#080c12] border-b border-[#1a2535] flex items-center px-3.5 gap-0.5 flex-shrink-0">
            {["1m","5m","15m","1H","4H","1D"].map((tf, i) => (
              <button key={tf} className={`px-2.5 py-1 rounded border-none text-[11px] cursor-pointer transition-all ${i === 3 ? "text-[#7b61ff] bg-[rgba(123,97,255,0.1)]" : "text-[#3a5470] bg-none hover:text-[#6e8faa]"}`}>
                {tf}
              </button>
            ))}
            <div className="w-px h-3.5 bg-[#1a2535] mx-2" />
            <span className="ml-auto text-[9px] text-[#3a5470] tracking-wide flex items-center gap-1.5">
              <span className="text-[#7b61ff]">⚡ Arcium MPC</span> — positions encrypted · only PnL revealed on close
            </span>
          </div>

          {/* Price display */}
          <div className="flex-1 flex flex-col items-start justify-center p-6 relative bg-[#04060a]">
            <div className="absolute inset-0 bg-gradient-to-br from-[rgba(123,97,255,0.03)] to-transparent pointer-events-none" />
            <div className={`text-6xl font-bold tracking-tight ${isUp ? "text-[#00e896]" : "text-[#ff2d55]"}`} style={{textShadow: isUp ? "0 0 40px rgba(0,232,150,0.3)" : "0 0 40px rgba(255,45,85,0.3)"}}>
              ${fmt(price)}
            </div>
            <div className={`text-sm mt-1.5 tracking-wide ${isUp ? "text-[#00e896]" : "text-[#ff2d55]"}`}>
              {isUp ? "▲" : "▼"} {isUp ? "+" : ""}{(price - open24h[market]).toFixed(2)} ({isUp ? "+" : ""}{change.toFixed(2)}%) 24H
            </div>
            <div className="mt-6 text-[10px] text-[#3a5470] space-y-1">
              <div>Program: <span className="text-[#7b61ff]">{PROGRAM_ID.toString()}</span></div>
              <div>MXE Cluster: <span className="text-[#7b61ff]">offset 456 · devnet</span></div>
              <div>Circuits: <span className="text-[#00ffd1]">open_position · check_liquidation · compute_pnl</span></div>
              <div>SDK: <span className="text-[#00ffd1]">@arcium-hq/client · X25519 ECDH + RescueCipher</span></div>
            </div>
            {status && (
              <div className="mt-4 px-4 py-2 bg-[rgba(123,97,255,0.1)] border border-[rgba(123,97,255,0.3)] rounded text-[11px] text-[#c4b5fd] max-w-lg">
                {status}
              </div>
            )}
            {!wallet.publicKey && (
              <div className="mt-4 px-4 py-3 bg-[rgba(123,97,255,0.08)] border border-[rgba(123,97,255,0.2)] rounded text-[11px] text-[#a89fff] max-w-lg">
                👋 Connect your wallet to start trading. You'll receive <span className="text-[#00e896] font-semibold">10,000 mock USDC</span> to test with.
              </div>
            )}
            <div className="absolute bottom-5 right-5 text-[80px] font-bold text-white opacity-[0.02] tracking-widest pointer-events-none">
              PrivatePerps
            </div>
          </div>

          {/* ── POSITIONS TABLE ── */}
          <div className="border-t border-[#1a2535] bg-[#080c12] flex flex-col" style={{height: "190px"}}>
            <div className="h-9 border-b border-[#1a2535] flex items-center px-4 gap-5 flex-shrink-0">
              <span className="text-[11px] font-medium text-[#c8daea] border-b border-[#00ffd1] pb-0.5">
                Positions
                <span className="ml-1.5 text-[9px] px-1.5 py-0.5 bg-[rgba(0,255,209,0.08)] text-[#00ffd1] border border-[rgba(0,255,209,0.2)] rounded-full">
                  {positions.length}
                </span>
              </span>
              <span className="ml-auto text-[9px] text-[#3a5470] uppercase tracking-wide flex items-center gap-1.5">
                <span className="text-[#7b61ff]">Arcium MPC</span> — private positions · only PnL revealed
              </span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {positions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-[#3a5470]">
                  <span className="text-3xl opacity-40">🔐</span>
                  <span className="text-[11px] tracking-wide">No open positions</span>
                  <span className="text-[9px] opacity-60">
                    {wallet.publicKey ? "Open a position using the panel on the right" : "Connect wallet to start trading"}
                  </span>
                </div>
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      {["Market","Side","Margin","Leverage","Notional","Entry","Mark","Liq. Price","PnL","Action"].map(h => (
                        <th key={h} className="text-left px-3.5 py-1.5 text-[9px] uppercase tracking-[1.5px] text-[#3a5470] font-medium border-b border-[#1a2535] bg-[#080c12] whitespace-nowrap sticky top-0">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((pos) => {
                      const { pnl, pct, cur } = calcPnL(pos);
                      const isPos = pnl >= 0;
                      return (
                        <tr key={pos.id} className="hover:bg-[rgba(255,255,255,0.015)] transition-colors">
                          <td className="px-3.5 py-2.5 font-bold text-xs whitespace-nowrap">
                            {pos.pair}
                            {pos.ghost && <span className="ml-1.5 text-[9px] px-1.5 py-0.5 bg-[rgba(123,97,255,0.1)] text-[#c4b5fd] border border-[rgba(123,97,255,0.2)] rounded">👻</span>}
                          </td>
                          <td className={`px-3.5 py-2.5 font-bold text-[10px] tracking-wide ${pos.side === "long" ? "text-[#00e896]" : "text-[#ff2d55]"}`}>
                            {pos.side.toUpperCase()}
                          </td>
                          <td className="px-3.5 py-2.5 text-[#6e8faa]">${pos.size.toLocaleString()}</td>
                          <td className="px-3.5 py-2.5 text-[#6e8faa]">{pos.leverage}×</td>
                          <td className="px-3.5 py-2.5 text-[#6e8faa]">${(pos.size * pos.leverage).toLocaleString()}</td>
                          <td className="px-3.5 py-2.5 text-[#6e8faa]">${fmt(pos.entry)}</td>
                          <td className="px-3.5 py-2.5">${fmt(cur)}</td>
                          <td className="px-3.5 py-2.5">
                            <span className="text-[9px] px-1.5 py-0.5 bg-[rgba(123,97,255,0.1)] text-[#a89fff] border border-[rgba(123,97,255,0.2)] rounded">
                              🔒 Arcium
                            </span>
                          </td>
                          <td className={`px-3.5 py-2.5 font-bold whitespace-nowrap ${isPos ? "text-[#00e896]" : "text-[#ff2d55]"}`}>
                            {isPos ? "+" : ""}${pnl.toFixed(2)}
                            <span className="ml-1 text-[10px] font-normal opacity-70">({isPos ? "+" : ""}{pct.toFixed(2)}%)</span>
                          </td>
                          <td className="px-3.5 py-2.5">
                            <button
                              onClick={() => handleClosePosition(pos)}
                              disabled={loading}
                              className="px-2.5 py-1 border border-[#1f2e42] bg-transparent text-[#6e8faa] text-[9px] tracking-wide uppercase rounded transition-all hover:border-[#ff2d55] hover:text-[#ff2d55] hover:bg-[rgba(255,45,85,0.1)] disabled:opacity-30"
                            >
                              Close
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* ── TRADE PANEL ── */}
        <div className="w-72 bg-[#080c12] border-l border-[#1a2535] overflow-y-auto flex flex-col flex-shrink-0">

          {/* Long / Short */}
          <div className="flex border-b border-[#1a2535] flex-shrink-0">
            {(["long","short"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={`flex-1 py-3 text-[11px] font-semibold tracking-[1.5px] uppercase cursor-pointer border-b-2 transition-all ${
                  side === s && s === "long" ? "text-[#00e896] border-[#00e896] bg-[rgba(0,232,150,0.08)]"
                  : side === s && s === "short" ? "text-[#ff2d55] border-[#ff2d55] bg-[rgba(255,45,85,0.08)]"
                  : "text-[#3a5470] border-transparent"
                }`}
              >
                {s === "long" ? "▲ Long" : "▼ Short"}
              </button>
            ))}
          </div>

          <div className="p-3.5 flex flex-col gap-3">

            {/* Mock balance display in panel */}
            {mockBalance !== null && (
              <div className="flex items-center justify-between px-3 py-2 bg-[#0d1219] border border-[#1a2535] rounded">
                <span className="text-[9px] uppercase tracking-[1.5px] text-[#3a5470]">Available</span>
                <span className="text-[11px] text-[#00e896] font-semibold">
                  ${mockBalance.toLocaleString(undefined, {maximumFractionDigits: 2})} USDC
                </span>
              </div>
            )}

            {/* Size */}
            <div>
              <div className="text-[9px] uppercase tracking-[2px] text-[#3a5470] mb-1.5">Size (USD)</div>
              <div className="relative">
                <input
                  type="number"
                  value={size}
                  min={10}
                  onChange={(e) => setSize(Number(e.target.value))}
                  className="w-full bg-[#111820] border border-[#1a2535] text-[#c8daea] font-mono text-[13px] px-3.5 py-2.5 rounded outline-none focus:border-[#7b61ff] transition-colors pr-12"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[#3a5470] tracking-wide pointer-events-none">USD</span>
              </div>
              <div className="grid grid-cols-4 gap-[3px] mt-1">
                {[25,50,75,100].map((pct) => (
                  <button
                    key={pct}
                    onClick={() => setSize(Math.floor((mockBalance ?? 10000) * pct / 100))}
                    className="py-1.5 border border-[#1a2535] bg-[#111820] text-[#3a5470] text-[10px] rounded cursor-pointer hover:border-[#1f2e42] hover:text-[#6e8faa] transition-all"
                  >
                    {pct === 100 ? "Max" : `${pct}%`}
                  </button>
                ))}
              </div>
            </div>

            {/* Leverage */}
            <div>
              <div className="text-[9px] uppercase tracking-[2px] text-[#3a5470] mb-1.5">
                Leverage — <span className="text-[#7b61ff]">{leverage}×</span>
              </div>
              <input type="range" min={1} max={50} value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                className="w-full accent-[#7b61ff] cursor-pointer" />
              <div className="grid grid-cols-5 gap-[3px] mt-1.5">
                {[2,5,10,20,50].map((l) => (
                  <button key={l} onClick={() => setLeverage(l)}
                    className={`py-1.5 border rounded text-[10px] font-semibold cursor-pointer transition-all ${
                      leverage === l
                        ? "bg-[rgba(123,97,255,0.1)] border-[rgba(123,97,255,0.3)] text-[#7b61ff]"
                        : "border-[#1a2535] bg-[#111820] text-[#3a5470]"
                    }`}>
                    {l}×
                  </button>
                ))}
              </div>
            </div>

            {/* Arcium Privacy section */}
            <div className="bg-[#0d1219] border border-[#1a2535] rounded p-3 flex flex-col gap-1.5">
              <div className="text-[9px] uppercase tracking-[2px] text-[#7b61ff] flex items-center gap-1.5 mb-1">
                <div className="w-1.5 h-1.5 rounded-full bg-[#7b61ff] animate-pulse" />
                Arcium MPC Privacy
              </div>
              {[
                ["Position Size", "🔒 Encrypted"],
                ["Entry Price", "🔒 Encrypted"],
                ["Leverage", "🔒 Encrypted"],
                ["Liq. Threshold", "🔒 Computed Privately"],
                ["Final PnL", "✓ Revealed on close"],
              ].map(([label, val]) => (
                <div key={label} className="flex items-center justify-between text-[10px]">
                  <span className="text-[#3a5470]">{label}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 border rounded ${
                    val.includes("Revealed")
                      ? "bg-transparent border-[#00e896] text-[#00e896]"
                      : "bg-[rgba(123,97,255,0.1)] border-[rgba(123,97,255,0.2)] text-[#a89fff]"
                  }`}>{val}</span>
                </div>
              ))}
            </div>

            {/* Ghost mode */}
            <button
              onClick={() => setGhost(!ghost)}
              className={`flex items-center justify-between px-3 py-2.5 border rounded cursor-pointer transition-all ${
                ghost
                  ? "bg-[rgba(123,97,255,0.1)] border-[rgba(123,97,255,0.35)] shadow-[0_0_20px_rgba(123,97,255,0.1)]"
                  : "bg-[#0d1219] border-[#1a2535] hover:border-[#7b61ff]"
              }`}
            >
              <div className="flex flex-col gap-[3px] text-left">
                <div className={`text-[11px] font-medium flex items-center gap-1.5 ${ghost ? "text-[#c4b5fd]" : ""}`}>
                  👻 Ghost Mode
                </div>
                <div className="text-[9px] text-[#3a5470] tracking-wide">Full Arcium MPC encryption</div>
              </div>
              <div className={`w-8 h-[17px] rounded-full relative transition-colors flex-shrink-0 ${ghost ? "bg-[#7b61ff]" : "bg-[#1f2e42]"}`}>
                <div className={`absolute w-[11px] h-[11px] bg-white rounded-full top-[3px] transition-transform ${ghost ? "translate-x-[17px]" : "translate-x-[3px]"}`} />
              </div>
            </button>

            {/* Order summary */}
            <div className="bg-[#0d1219] border border-[#1a2535] rounded p-3 flex flex-col gap-1.5">
              {[
                ["Entry", "Market"],
                ["Notional", `$${notional.toLocaleString()}`],
                ["Margin", `$${size.toLocaleString()}`],
                ["Fees (0.01%)", `$${(notional * 0.0001).toFixed(2)}`],
              ].map(([label, val]) => (
                <div key={label} className="flex justify-between text-[10px] text-[#3a5470]">
                  <span>{label}</span>
                  <span className="text-[#6e8faa]">{val}</span>
                </div>
              ))}
              <div className="flex justify-between text-[10px] text-[#3a5470]">
                <span>Liq. Price</span>
                <span className="text-[9px] text-[#a89fff]">🔒 Arcium Encrypted</span>
              </div>
            </div>

            {/* Submit */}
            <button
              onClick={handleOpenPosition}
              disabled={loading}
              className={`w-full py-3.5 border-none rounded font-mono text-xs font-bold tracking-[2px] uppercase cursor-pointer transition-all disabled:opacity-30 disabled:cursor-not-allowed relative overflow-hidden ${
                side === "long"
                  ? "bg-gradient-to-r from-[#006644] to-[#00e896] text-white hover:shadow-[0_0_24px_rgba(0,232,150,0.35)] hover:-translate-y-px"
                  : "bg-gradient-to-r from-[#660020] to-[#ff2d55] text-white hover:shadow-[0_0_24px_rgba(255,45,85,0.35)] hover:-translate-y-px"
              }`}
            >
              {loading
                ? (status.slice(0, 28) + "...")
                : wallet.publicKey
                  ? `${side === "long" ? "▲ Long" : "▼ Short"} ${market}`
                  : "Connect Wallet to Trade"
              }
            </button>

            <div className="text-center text-[9px] text-[#3a5470] tracking-wide flex items-center justify-center gap-1">
              Secured by <span className="text-[#a89fff]">Arcium</span> on Solana Devnet
            </div>
          </div>
        </div>
      </div>

      {/* ── TOAST ── */}
      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded text-[11px] z-50 max-w-sm border backdrop-blur-xl whitespace-pre-line leading-relaxed transition-all ${
          toast.type === "ok" ? "bg-[rgba(0,232,150,0.08)] border-[#00e896] text-[#00e896]"
          : toast.type === "err" ? "bg-[rgba(255,45,85,0.08)] border-[#ff2d55] text-[#ff2d55]"
          : "bg-[rgba(123,97,255,0.1)] border-[rgba(123,97,255,0.4)] text-[#c4b5fd]"
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
