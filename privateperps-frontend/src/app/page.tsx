"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import * as anchor from "@coral-xyz/anchor";
import {
  PROGRAM_ID,
  encryptPosition,
  submitOpenPosition,
  submitOpenGhostPosition,
  submitClosePosition,
  ArciumEncryptedPosition,
} from "@/utils/arciumClient";
import IDL from "@/idl/private_perps.json";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Candle { t: number; o: number; h: number; l: number; c: number; }

interface Position {
  id: string;
  pair: string;
  side: "long" | "short";
  size: number;
  leverage: number;
  entry: number;
  encrypted: ArciumEncryptedPosition;
  txSig: string;
  ghost: boolean;   // ghost = hide ALL details in UI + never store PnL on-chain
  ts: number;
}

const MARKETS: Record<string, { id: string; label: string; color: string }> = {
  "BTC/USD": { id: "bitcoin",  label: "BTC", color: "#f7931a" },
  "ETH/USD": { id: "ethereum", label: "ETH", color: "#627eea" },
  "SOL/USD": { id: "solana",   label: "SOL", color: "#9945ff" },
};

// ─── Candlestick Chart ────────────────────────────────────────────────────────

function CandleChart({ candles, loading }: { candles: Candle[]; loading: boolean }) {
  if (loading || !candles.length) return (
    <div className="w-full h-full flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-5 h-5 border-2 border-[#7b61ff] border-t-transparent rounded-full animate-spin" />
        <span className="text-[10px] text-[#2a3a50]">Loading chart data...</span>
      </div>
    </div>
  );

  const W = 1000, H = 300;
  const pad = { t: 16, b: 24, l: 64, r: 16 };
  const cw  = (W - pad.l - pad.r) / candles.length;
  const bw  = Math.max(cw * 0.55, 1.5);

  const allH = candles.map(c => c.h), allL = candles.map(c => c.l);
  const maxP = Math.max(...allH), minP = Math.min(...allL);
  const rng  = maxP - minP || 1;

  const py = (p: number) => pad.t + ((maxP - p) / rng) * (H - pad.t - pad.b);
  const px = (i: number) => pad.l + i * cw + cw / 2;

  const nTicks = 5;
  const ticks  = Array.from({ length: nTicks }, (_, i) => {
    const v = minP + (rng * i) / (nTicks - 1);
    return { y: py(v), v };
  });

  const last = candles[candles.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="bullGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00e896" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#00e896" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="bearGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff2d55" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#ff2d55" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Grid */}
      {ticks.map(({ y, v }) => (
        <g key={v}>
          <line x1={pad.l} y1={y} x2={W - pad.r} y2={y} stroke="#0d1825" strokeWidth="1" />
          <text x={pad.l - 6} y={y + 4} fill="#2a3a50" fontSize="9" textAnchor="end" fontFamily="monospace">
            {v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(2)}`}
          </text>
        </g>
      ))}

      {/* Candles */}
      {candles.map((c, i) => {
        const isUp  = c.c >= c.o;
        const col   = isUp ? "#00e896" : "#ff2d55";
        const top   = py(Math.max(c.o, c.c));
        const bot   = py(Math.min(c.o, c.c));
        const bodyH = Math.max(bot - top, 1);
        const x     = px(i);
        return (
          <g key={i}>
            <line x1={x} y1={py(c.h)} x2={x} y2={py(c.l)} stroke={col} strokeWidth="1" opacity="0.5" />
            <rect x={x - bw / 2} y={top} width={bw} height={bodyH} fill={col} opacity="0.85" rx="0.5" />
          </g>
        );
      })}

      {/* Current price dashed line */}
      {last && (() => {
        const y   = py(last.c);
        const col = last.c >= last.o ? "#00e896" : "#ff2d55";
        return (
          <line x1={pad.l} y1={y} x2={W - pad.r} y2={y}
            stroke={col} strokeWidth="0.8" strokeDasharray="4,4" opacity="0.4" />
        );
      })()}
    </svg>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TradingPage() {
  const { connection } = useConnection();
  const wallet         = useWallet();
  const { setVisible } = useWalletModal();
  const programRef     = useRef<anchor.Program<any> | null>(null);
  const providerRef    = useRef<anchor.AnchorProvider | null>(null);
  const initRef        = useRef(false);

  const [market,       setMarket]       = useState("BTC/USD");
  const [side,         setSide]         = useState<"long" | "short">("long");
  const [size,         setSize]         = useState(500);
  const [leverage,     setLeverage]     = useState(10);
  const [ghost,        setGhost]        = useState(false);
  const [positions,    setPositions]    = useState<Position[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [status,       setStatus]       = useState("");
  const [toast,        setToast]        = useState<{ msg: string; type: string } | null>(null);
  const [mockBalance,  setMockBalance]  = useState<number | null>(null);
  const [airdropping,  setAirdropping]  = useState(false);
  const [prices,       setPrices]       = useState<Record<string, number>>({});
  const [changes,      setChanges]      = useState<Record<string, number>>({});
  const [candles,      setCandles]      = useState<Candle[]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [fundingTimer, setFundingTimer] = useState("08:00:00");
  const [activeTab,    setActiveTab]    = useState<"positions" | "orders">("positions");
  const [tf,           setTf]           = useState("1H");

  // ── Fetch live prices from CoinGecko ────────────────────────────────────────
  const fetchPrices = useCallback(async () => {
    try {
      const ids = Object.values(MARKETS).map(m => m.id).join(",");
      const r   = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
        { headers: { Accept: "application/json" } }
      );
      if (!r.ok) return;
      const data = await r.json();
      const p: Record<string, number> = {};
      const c: Record<string, number> = {};
      for (const [pair, conf] of Object.entries(MARKETS)) {
        if (data[conf.id]) {
          p[pair] = data[conf.id].usd;
          c[pair] = data[conf.id].usd_24h_change ?? 0;
        }
      }
      setPrices(prev => ({ ...prev, ...p }));
      setChanges(prev => ({ ...prev, ...c }));
    } catch {}
  }, []);

  // ── Fetch OHLC candles ───────────────────────────────────────────────────────
  const fetchCandles = useCallback(async (mkt: string, timeframe: string) => {
    setChartLoading(true);
    try {
      const days = timeframe === "15m" ? 1 : timeframe === "1H" ? 1 : timeframe === "4H" ? 7 : timeframe === "1D" ? 14 : 30;
      const r    = await fetch(
        `https://api.coingecko.com/api/v3/coins/${MARKETS[mkt].id}/ohlc?vs_currency=usd&days=${days}`,
        { headers: { Accept: "application/json" } }
      );
      if (!r.ok) return;
      const raw: [number,number,number,number,number][] = await r.json();
      setCandles(raw.map(([t,o,h,l,c]) => ({ t,o,h,l,c })));
    } catch {}
    finally { setChartLoading(false); }
  }, []);

  useEffect(() => { fetchPrices(); }, []);
  useEffect(() => { const iv = setInterval(fetchPrices, 15000); return () => clearInterval(iv); }, [fetchPrices]);
  useEffect(() => {
    fetchCandles(market, tf);
    const iv = setInterval(() => fetchCandles(market, tf), 60000);
    return () => clearInterval(iv);
  }, [market, tf]);

  // ── Funding countdown ────────────────────────────────────────────────────────
  useEffect(() => {
    const iv = setInterval(() => {
      const now  = new Date();
      const next = new Date(now);
      next.setUTCHours(Math.ceil(now.getUTCHours() / 8) * 8, 0, 0, 0);
      if (next <= now) next.setUTCHours(next.getUTCHours() + 8);
      const d = next.getTime() - now.getTime();
      setFundingTimer(
        `${String(Math.floor(d/3600000)).padStart(2,"0")}:${String(Math.floor((d%3600000)/60000)).padStart(2,"0")}:${String(Math.floor((d%60000)/1000)).padStart(2,"0")}`
      );
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // ── Initialize Anchor program ────────────────────────────────────────────────
  useEffect(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return;
    if (initRef.current && programRef.current) return;

    const provider = new anchor.AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
    providerRef.current = provider;
    anchor.setProvider(provider);

    try {
      // Anchor 0.32: IDL has address field, pass IDL + provider only
      programRef.current = new anchor.Program(IDL as any, provider);
      initRef.current    = true;
      console.log("✅ Program initialized:", PROGRAM_ID.toString());
    } catch (e) {
      console.error("Program init error:", e);
      try {
        // Fallback for older Anchor versions
        programRef.current = new anchor.Program(IDL as any, PROGRAM_ID, provider);
        initRef.current    = true;
        console.log("✅ Program initialized (fallback)");
      } catch (e2) { console.error("Program init fallback failed:", e2); }
    }

    if (mockBalance === null) {
      setMockBalance(10000);
      showToast("🎉 10,000 mock USDC added for testing", "ok");
    }
  }, [wallet.publicKey, connection]);

  useEffect(() => {
    if (!wallet.publicKey) {
      programRef.current = null;
      providerRef.current = null;
      initRef.current = false;
      setMockBalance(null);
      setPositions([]);
    }
  }, [wallet.publicKey]);

  const showToast = (msg: string, type: string) => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 6000);
  };

  const handleAirdrop = async () => {
    if (!wallet.publicKey) return;
    setAirdropping(true);
    try {
      const sig = await connection.requestAirdrop(wallet.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
      showToast("✅ 2 devnet SOL airdropped!", "ok");
    } catch { showToast("Airdrop failed — try faucet.solana.com", "err"); }
    finally  { setAirdropping(false); }
  };

  // ── Open position — standard OR ghost ───────────────────────────────────────
  const handleOpenPosition = useCallback(async () => {
    if (!wallet.publicKey) { setVisible(true); return; }
    if (!providerRef.current || !programRef.current) {
      showToast("Program initializing — please try again.", "err");
      return;
    }
    const currentPrice = prices[market];
    if (!currentPrice) { showToast("Price not loaded yet — please wait.", "err"); return; }
    if (mockBalance !== null && size > mockBalance) {
      showToast(`Insufficient balance. You have $${mockBalance.toLocaleString()} USDC.`, "err");
      return;
    }

    setLoading(true);
    try {
      setStatus(ghost ? "👻 Encrypting ghost position via Arcium..." : "🔐 Encrypting via Arcium X25519 ECDH...");
      const encrypted = await encryptPosition(providerRef.current, currentPrice, size, leverage, side);

      setStatus(ghost ? "👻 Submitting ghost position on-chain..." : "📡 Submitting to Solana devnet...");

      // ghost = separate on-chain instruction, is_ghost flag set, PnL never stored
      const sig = ghost
        ? await submitOpenGhostPosition(programRef.current, encrypted, wallet.publicKey)
        : await submitOpenPosition(programRef.current, encrypted, wallet.publicKey);

      setMockBalance(prev => (prev ?? 0) - size);
      setPositions(prev => [...prev, {
        id: encrypted.positionId.toString(),
        pair: market, side, size, leverage,
        entry: currentPrice, encrypted,
        txSig: sig, ghost, ts: Date.now(),
      }]);
      setStatus("");
      showToast(
        ghost
          ? `👻 Ghost position opened\nAll details hidden forever on-chain\nTx: ${sig.slice(0,20)}...`
          : `✅ Position opened — encrypted by Arcium MPC\nTx: ${sig.slice(0,20)}...`,
        ghost ? "arcium" : "ok"
      );
    } catch (err: any) {
      console.error(err);
      setStatus("");
      showToast(`Error: ${err.message || "Transaction failed"}`, "err");
    } finally { setLoading(false); }
  }, [wallet, prices, market, side, size, leverage, ghost, mockBalance, setVisible]);

  // ── Close position ───────────────────────────────────────────────────────────
  const handleClosePosition = useCallback(async (pos: Position) => {
    if (!wallet.publicKey || !providerRef.current || !programRef.current) return;
    setLoading(true);
    try {
      const currentPrice = prices[pos.pair];
      setStatus("Closing position on-chain...");
      const { signature } = await submitClosePosition(
        programRef.current, wallet.publicKey,
        pos.encrypted.positionId, currentPrice, pos.ghost
      );
      const pnl = pos.ghost ? null : estimatePnL(pos, currentPrice);
      const ret = pos.ghost ? pos.size : pos.size + (pnl ?? 0);
      setPositions(prev => prev.filter(p => p.id !== pos.id));
      setMockBalance(prev => (prev ?? 0) + ret);
      setStatus("");
      showToast(
        pos.ghost
          ? `👻 Ghost closed\nMargin returned: $${pos.size.toLocaleString()}\nPnL: 🔒 Hidden forever\nTx: ${signature.slice(0,20)}...`
          : `Closed ✓  PnL: ${(pnl ?? 0) >= 0 ? "+" : ""}$${(pnl ?? 0).toFixed(2)}\nTx: ${signature.slice(0,20)}...`,
        pos.ghost ? "arcium" : (pnl ?? 0) >= 0 ? "ok" : "err"
      );
    } catch (err: any) {
      setStatus("");
      showToast(`Close error: ${err.message}`, "err");
    } finally { setLoading(false); }
  }, [wallet, prices]);

  function estimatePnL(pos: Position, cur: number) {
    const delta = pos.side === "long" ? cur - pos.entry : pos.entry - cur;
    return (delta / pos.entry) * pos.size * pos.leverage;
  }

  function calcPnL(pos: Position) {
    if (pos.ghost) return { pnl: null, pct: null, cur: null };
    const cur = prices[pos.pair];
    const pnl = estimatePnL(pos, cur);
    return { pnl, pct: (pnl / pos.size) * 100, cur };
  }

  function fmtPrice(n: number | null | undefined) {
    if (!n) return "—";
    return n >= 1000
      ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : `$${n.toFixed(2)}`;
  }

  const price      = prices[market] ?? 0;
  const change     = changes[market] ?? 0;
  const isUp       = change >= 0;
  const mktConf    = MARKETS[market];
  const notional   = size * leverage;
  const ghostCount  = positions.filter(p => p.ghost).length;
  const normalCount = positions.filter(p => !p.ghost).length;

  return (
    <div className="flex flex-col h-screen bg-[#020508] text-[#c8daea] font-mono text-xs overflow-hidden select-none">

      {/* ── NAV ── */}
      <nav className="h-[48px] bg-[#06090f] border-b border-[#0f1923] flex items-center px-4 gap-0 flex-shrink-0 relative z-10">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#7b61ff] to-transparent opacity-40" />

        {/* Logo */}
        <div className="flex items-center gap-2 mr-5">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-[#7b61ff] to-[#00ffd1] flex items-center justify-center font-black text-[11px] text-black">P</div>
          <div>
            <div className="text-[13px] font-bold text-white leading-none">PrivatePerps</div>
            <div className="text-[8px] text-[#2a3a50] tracking-[2px] uppercase">Perps without predators</div>
          </div>
        </div>

        <div className="w-px h-5 bg-[#0f1923] mx-3" />

        {/* Market tabs */}
        {Object.entries(MARKETS).map(([pair, conf]) => {
          const p   = prices[pair];
          const chg = changes[pair] ?? 0;
          const up  = chg >= 0;
          return (
            <button key={pair} onClick={() => setMarket(pair)}
              className={`flex items-center gap-2 px-3.5 h-[48px] cursor-pointer border-b-2 transition-all ${
                market === pair ? "border-[#7b61ff] text-white" : "border-transparent text-[#2a3a50] hover:text-[#6e8faa]"
              }`}>
              <span className="font-bold text-[10px]" style={{ color: market === pair ? conf.color : undefined }}>{conf.label}</span>
              <span className={`text-[11px] font-semibold tabular-nums ${up ? "text-[#00e896]" : "text-[#ff2d55]"}`}>
                {p ? fmtPrice(p) : "—"}
              </span>
              <span className={`text-[9px] ${up ? "text-[#00e896]" : "text-[#ff2d55]"}`}>
                {up ? "+" : ""}{chg.toFixed(2)}%
              </span>
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-[rgba(123,97,255,0.08)] border border-[rgba(123,97,255,0.2)] rounded text-[9px] tracking-widest text-[#7b61ff] uppercase">
            <div className="w-1.5 h-1.5 rounded-full bg-[#7b61ff] animate-pulse" />
            Arcium MPC
          </div>

          {mockBalance !== null && (
            <div className="px-2.5 py-1 bg-[rgba(0,232,150,0.06)] border border-[rgba(0,232,150,0.15)] rounded text-[10px] text-[#00e896] tabular-nums">
              💰 ${mockBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
          )}

          {wallet.publicKey && (
            <button onClick={handleAirdrop} disabled={airdropping}
              className="px-2.5 py-1 border border-[#1a2535] rounded text-[9px] text-[#f0c060] hover:border-[#f0c060] transition-all disabled:opacity-30">
              {airdropping ? "..." : "🪙 Get SOL"}
            </button>
          )}

          <button onClick={() => wallet.publicKey ? wallet.disconnect() : setVisible(true)}
            className={`px-3 py-1.5 border rounded text-[10px] font-medium transition-all ${
              wallet.publicKey
                ? "border-[#00e896] text-[#00e896] bg-[rgba(0,232,150,0.06)]"
                : "border-[#1f2e42] text-[#6e8faa] hover:border-[#7b61ff] hover:text-[#7b61ff]"
            }`}>
            {wallet.publicKey
              ? `${wallet.publicKey.toString().slice(0,4)}...${wallet.publicKey.toString().slice(-4)}`
              : "Connect Wallet"}
          </button>
        </div>
      </nav>

      {/* ── STATS BAR ── */}
      <div className="h-[30px] bg-[#06090f] border-b border-[#0f1923] flex items-center px-4 gap-5 flex-shrink-0 overflow-x-auto">
        <div className="flex items-baseline gap-2 min-w-max">
          <span className={`text-[13px] font-bold tabular-nums ${isUp ? "text-[#00e896]" : "text-[#ff2d55]"}`}>
            {fmtPrice(price)}
          </span>
          <span className={`text-[10px] ${isUp ? "text-[#00e896]" : "text-[#ff2d55]"}`}>
            {isUp ? "▲ +" : "▼ "}{Math.abs(change).toFixed(2)}%
          </span>
        </div>
        {[
          ["24h Vol",     "$2.48B",    ""],
          ["Open Int",    "$890M",     ""],
          ["Funding",     "+0.0082%",  "text-[#00e896]"],
          ["Next Funding",fundingTimer,"text-[#f0c060]"],
          ["Mark",        fmtPrice(price), ""],
          ["Index",       fmtPrice(price ? price * 0.9998 : 0), ""],
        ].map(([l, v, cls]) => (
          <div key={l as string} className="flex items-center gap-1.5 min-w-max">
            <span className="text-[8px] text-[#1a2535] uppercase tracking-wide">{l}</span>
            <span className={`text-[10px] text-[#3a5470] ${cls}`}>{v}</span>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-1.5 min-w-max">
          <span className="text-[8px] text-[#1a2535] uppercase">Liq.</span>
          <span className="text-[9px] text-[#7b61ff]">🔒 MPC Computed</span>
        </div>
      </div>

      {/* ── MAIN ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── CHART + POSITIONS ── */}
        <div className="flex-1 flex flex-col overflow-hidden border-r border-[#0f1923]">

          {/* Timeframe bar */}
          <div className="h-8 bg-[#06090f] border-b border-[#0f1923] flex items-center px-3 gap-1 flex-shrink-0">
            {["15m","1H","4H","1D","1W"].map(t => (
              <button key={t} onClick={() => setTf(t)}
                className={`px-2.5 py-1 rounded text-[10px] transition-all border-none cursor-pointer ${
                  tf === t ? "text-[#7b61ff] bg-[rgba(123,97,255,0.1)]" : "text-[#2a3a50] hover:text-[#6e8faa]"
                }`}>{t}</button>
            ))}
            <div className="w-px h-3 bg-[#0f1923] mx-1" />
            {["Candles","Line"].map((t, i) => (
              <button key={t} className={`px-2 py-1 text-[9px] transition-all border-none cursor-pointer rounded ${i === 0 ? "text-[#6e8faa]" : "text-[#1a2535] hover:text-[#2a3a50]"}`}>{t}</button>
            ))}
            <div className="ml-auto text-[8px] text-[#1a2535] flex items-center gap-1">
              <span className="text-[#7b61ff] opacity-50">⚡</span>
              <span>Arcium MPC · encrypted liquidations · ghost positions fully dark</span>
            </div>
          </div>

          {/* Chart area */}
          <div className="flex-1 relative bg-[#020508] overflow-hidden">
            <div className="absolute inset-0 p-2">
              <CandleChart candles={candles} loading={chartLoading} />
            </div>

            {/* Price overlay — top left */}
            <div className="absolute top-3 left-4 pointer-events-none">
              <div className={`text-[38px] font-bold tabular-nums leading-none ${isUp ? "text-[#00e896]" : "text-[#ff2d55]"}`}
                style={{ textShadow: isUp ? "0 0 50px rgba(0,232,150,0.15)" : "0 0 50px rgba(255,45,85,0.15)" }}>
                {fmtPrice(price)}
              </div>
              <div className={`text-[11px] mt-0.5 font-medium ${isUp ? "text-[#00e896]" : "text-[#ff2d55]"}`}>
                {isUp ? "▲" : "▼"} {Math.abs(change).toFixed(2)}% (24H)  ·  {mktConf.label}/USD
              </div>
            </div>

            {/* Status overlay */}
            {status && (
              <div className="absolute bottom-3 left-0 right-0 flex justify-center pointer-events-none">
                <div className="px-4 py-2 bg-[rgba(6,9,15,0.95)] border border-[rgba(123,97,255,0.3)] rounded text-[11px] text-[#c4b5fd] backdrop-blur-sm">
                  {status}
                </div>
              </div>
            )}

            {/* Connect prompt */}
            {!wallet.publicKey && (
              <div className="absolute bottom-10 left-0 right-0 flex justify-center pointer-events-none">
                <div className="px-4 py-2.5 bg-[rgba(6,9,15,0.8)] border border-[rgba(123,97,255,0.2)] rounded text-[11px] text-[#a89fff] backdrop-blur-sm">
                  👋 Connect wallet · get 10,000 mock USDC · trade with Arcium MPC privacy
                </div>
              </div>
            )}
          </div>

          {/* ── POSITIONS TABLE ── */}
          <div className="border-t border-[#0f1923] bg-[#06090f]" style={{ height: "200px" }}>
            <div className="h-8 border-b border-[#0f1923] flex items-center px-3 gap-3 flex-shrink-0">
              {(["positions","orders"] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`text-[10px] font-medium uppercase tracking-wide border-b pb-0.5 transition-all ${
                    activeTab === tab ? "text-[#c8daea] border-[#7b61ff]" : "text-[#1a2535] border-transparent hover:text-[#3a5470]"
                  }`}>
                  {tab === "positions"
                    ? `Positions${positions.length > 0 ? ` (${positions.length})` : ""}`
                    : "Open Orders (0)"}
                </button>
              ))}
              {ghostCount > 0 && (
                <span className="text-[8px] px-1.5 py-0.5 bg-[rgba(123,97,255,0.08)] text-[#7b61ff] border border-[rgba(123,97,255,0.2)] rounded-full">
                  👻 {ghostCount} ghost
                </span>
              )}
              {normalCount > 0 && (
                <span className="text-[8px] px-1.5 py-0.5 bg-[rgba(0,255,209,0.06)] text-[#00c4a0] border border-[rgba(0,255,209,0.15)] rounded-full">
                  {normalCount} open
                </span>
              )}
              <div className="ml-auto text-[8px] text-[#1a2535]">
                Arcium MPC · unique encrypted PDA per position
              </div>
            </div>

            <div className="overflow-y-auto" style={{ height: "160px" }}>
              {positions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-1.5 text-[#1a2535]">
                  <span className="text-2xl opacity-20">🔐</span>
                  <span className="text-[10px]">No open positions</span>
                  <span className="text-[9px] opacity-60">
                    {wallet.publicKey ? "Each position gets a unique encrypted PDA on Solana" : "Connect wallet to start trading"}
                  </span>
                </div>
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-[#080e15]">
                      {["Market","Side","Size","Lev","Notional","Entry","Mark","Liq. Price","Unrealized PnL",""].map(h => (
                        <th key={h} className="text-left px-3 py-1.5 text-[8px] uppercase tracking-[1.5px] text-[#1a2535] font-medium whitespace-nowrap sticky top-0 bg-[#06090f]">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map(pos => {
                      const { pnl, pct, cur } = calcPnL(pos);
                      const isPos = (pnl ?? 0) >= 0;
                      // Ghost helper — renders dash for hidden fields
                      const GH = ({ v }: { v: React.ReactNode }) =>
                        pos.ghost ? <span className="text-[#1a2535]">—</span> : <>{v}</>;

                      return (
                        <tr key={pos.id}
                          className={`border-b border-[#070c13] transition-colors ${
                            pos.ghost
                              ? "bg-[rgba(123,97,255,0.02)] hover:bg-[rgba(123,97,255,0.04)]"
                              : "hover:bg-[rgba(255,255,255,0.01)]"
                          }`}>
                          <td className="px-3 py-2 font-bold text-[10px]">
                            {pos.ghost ? (
                              <span className="text-[8px] px-1.5 py-0.5 bg-[rgba(123,97,255,0.1)] text-[#7b61ff] border border-[rgba(123,97,255,0.2)] rounded">👻 GHOST</span>
                            ) : (
                              <span style={{ color: MARKETS[pos.pair]?.color }}>{pos.pair.split("/")[0]}</span>
                            )}
                          </td>
                          <td className={`px-3 py-2 font-bold text-[10px] ${pos.ghost ? "text-[#1a2535]" : pos.side === "long" ? "text-[#00e896]" : "text-[#ff2d55]"}`}>
                            <GH v={pos.side.toUpperCase()} />
                          </td>
                          <td className="px-3 py-2 text-[10px] text-[#6e8faa]"><GH v={`$${pos.size.toLocaleString()}`} /></td>
                          <td className="px-3 py-2 text-[10px] text-[#6e8faa]"><GH v={`${pos.leverage}×`} /></td>
                          <td className="px-3 py-2 text-[10px] text-[#6e8faa]"><GH v={`$${(pos.size * pos.leverage).toLocaleString()}`} /></td>
                          <td className="px-3 py-2 text-[10px] text-[#6e8faa]"><GH v={fmtPrice(pos.entry)} /></td>
                          <td className="px-3 py-2 text-[10px]"><GH v={fmtPrice(cur ?? 0)} /></td>
                          <td className="px-3 py-2">
                            <span className="text-[8px] px-1.5 py-0.5 bg-[rgba(123,97,255,0.06)] text-[#7b61ff] border border-[rgba(123,97,255,0.15)] rounded">
                              🔒 MPC
                            </span>
                          </td>
                          <td className="px-3 py-2 font-bold text-[10px]">
                            {pos.ghost ? (
                              <span className="text-[8px] px-1.5 py-0.5 bg-[rgba(123,97,255,0.06)] text-[#5b45cc] border border-[rgba(123,97,255,0.15)] rounded">
                                👻 Hidden forever
                              </span>
                            ) : (
                              <span className={isPos ? "text-[#00e896]" : "text-[#ff2d55]"}>
                                {isPos ? "+" : ""}${(pnl ?? 0).toFixed(2)}
                                <span className="ml-1 text-[9px] opacity-60">({isPos ? "+" : ""}{(pct ?? 0).toFixed(2)}%)</span>
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <button onClick={() => handleClosePosition(pos)} disabled={loading}
                              className="px-2 py-0.5 border border-[#1a2535] text-[#3a5470] text-[9px] rounded hover:border-[#ff2d55] hover:text-[#ff2d55] hover:bg-[rgba(255,45,85,0.06)] transition-all disabled:opacity-30">
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
        <div className="w-[260px] bg-[#06090f] flex flex-col flex-shrink-0 overflow-y-auto">

          {/* Long / Short tabs */}
          <div className="flex flex-shrink-0 border-b border-[#0f1923]">
            {(["long","short"] as const).map(s => (
              <button key={s} onClick={() => setSide(s)}
                className={`flex-1 py-2.5 text-[11px] font-bold tracking-[2px] uppercase transition-all border-b-2 ${
                  side === s && s === "long"  ? "text-[#00e896] border-[#00e896] bg-[rgba(0,232,150,0.05)]"
                  : side === s && s === "short" ? "text-[#ff2d55] border-[#ff2d55] bg-[rgba(255,45,85,0.05)]"
                  : "text-[#2a3a50] border-transparent hover:text-[#6e8faa]"
                }`}>
                {s === "long" ? "▲ Long" : "▼ Short"}
              </button>
            ))}
          </div>

          <div className="p-3 flex flex-col gap-2.5">

            {/* Balance */}
            {mockBalance !== null && (
              <div className="flex items-center justify-between px-2.5 py-1.5 bg-[#0a1018] border border-[#0f1923] rounded">
                <span className="text-[8px] uppercase tracking-[1.5px] text-[#2a3a50]">Available</span>
                <span className="text-[11px] text-[#00e896] font-bold tabular-nums">
                  ${mockBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC
                </span>
              </div>
            )}

            {/* Order type */}
            <div className="flex bg-[#0a1018] rounded border border-[#0f1923] overflow-hidden">
              {["Market","Limit","Stop"].map((t, i) => (
                <button key={t} className={`flex-1 py-1.5 text-[9px] font-medium transition-all border-none ${
                  i === 0 ? "bg-[#111820] text-[#c8daea]" : "text-[#2a3a50] hover:text-[#6e8faa]"
                }`}>{t}</button>
              ))}
            </div>

            {/* Size */}
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-[8px] uppercase tracking-[2px] text-[#2a3a50]">Size</span>
                <span className="text-[8px] text-[#2a3a50]">Max: ${mockBalance?.toLocaleString() ?? "—"}</span>
              </div>
              <div className="relative">
                <input type="number" value={size} min={10}
                  onChange={e => setSize(Number(e.target.value))}
                  className="w-full bg-[#0a1018] border border-[#0f1923] text-[#c8daea] font-mono text-[12px] px-3 py-2 rounded outline-none focus:border-[#7b61ff] transition-colors pr-12" />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-[#2a3a50]">USD</span>
              </div>
              <div className="grid grid-cols-4 gap-1 mt-1.5">
                {[25,50,75,100].map(p => (
                  <button key={p} onClick={() => setSize(Math.floor((mockBalance ?? 10000) * p / 100))}
                    className="py-1 border border-[#0f1923] bg-[#0a1018] text-[#2a3a50] text-[9px] rounded hover:border-[#1a2535] hover:text-[#6e8faa] transition-all">
                    {p === 100 ? "Max" : `${p}%`}
                  </button>
                ))}
              </div>
            </div>

            {/* Leverage */}
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-[8px] uppercase tracking-[2px] text-[#2a3a50]">Leverage</span>
                <span className="text-[10px] text-[#7b61ff] font-bold">{leverage}×</span>
              </div>
              <input type="range" min={1} max={50} value={leverage}
                onChange={e => setLeverage(Number(e.target.value))}
                className="w-full accent-[#7b61ff]" />
              <div className="grid grid-cols-5 gap-1 mt-1.5">
                {[2,5,10,20,50].map(l => (
                  <button key={l} onClick={() => setLeverage(l)}
                    className={`py-1 border rounded text-[9px] font-semibold transition-all ${
                      leverage === l
                        ? "bg-[rgba(123,97,255,0.1)] border-[rgba(123,97,255,0.3)] text-[#7b61ff]"
                        : "border-[#0f1923] bg-[#0a1018] text-[#2a3a50] hover:text-[#6e8faa]"
                    }`}>{l}×</button>
                ))}
              </div>
            </div>

            {/* Arcium Privacy panel — updates live based on ghost state */}
            <div className="bg-[#080d15] border border-[#0f1923] rounded p-2.5">
              <div className="flex items-center gap-1.5 mb-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[#7b61ff] animate-pulse" />
                <span className="text-[8px] uppercase tracking-[2px] text-[#7b61ff]">Arcium MPC · Privacy</span>
              </div>
              {[
                ["Entry Price",    "🔒 Encrypted"],
                ["Position Size",  "🔒 Encrypted"],
                ["Leverage",       "🔒 Encrypted"],
                ["Direction",      ghost ? "👻 Hidden Forever" : "🔒 Encrypted"],
                ["Liq. Threshold", "🔒 MPC Computed"],
                ["PnL",            ghost ? "👻 Hidden Forever" : "✓ Revealed on close"],
              ].map(([label, val]) => (
                <div key={label} className="flex items-center justify-between py-[3px]">
                  <span className="text-[9px] text-[#2a3a50]">{label}</span>
                  <span className={`text-[8px] px-1.5 py-0.5 rounded border ${
                    (val as string).includes("Hidden") ? "bg-[rgba(123,97,255,0.08)] border-[rgba(123,97,255,0.2)] text-[#9b7dff]"
                    : (val as string).includes("✓")    ? "bg-transparent border-[rgba(0,232,150,0.25)] text-[#00e896]"
                    : "bg-[rgba(123,97,255,0.04)] border-[rgba(123,97,255,0.12)] text-[#4a5a7a]"
                  }`}>{val}</span>
                </div>
              ))}
            </div>

            {/* Ghost mode toggle — enables fully dark position */}
            <button onClick={() => setGhost(!ghost)}
              className={`flex items-center justify-between px-2.5 py-2 border rounded transition-all ${
                ghost
                  ? "bg-[rgba(123,97,255,0.07)] border-[rgba(123,97,255,0.3)] shadow-[0_0_12px_rgba(123,97,255,0.08)]"
                  : "bg-[#080d15] border-[#0f1923] hover:border-[#1a2535]"
              }`}>
              <div>
                <div className={`text-[10px] font-medium ${ghost ? "text-[#c4b5fd]" : "text-[#6e8faa]"}`}>
                  👻 Ghost Mode
                </div>
                <div className="text-[8px] text-[#2a3a50] mt-0.5">
                  {ghost ? "PnL hidden forever · position fully dark" : "Hide all position details on-chain"}
                </div>
              </div>
              <div className={`w-7 h-[14px] rounded-full relative transition-colors flex-shrink-0 ml-2 ${ghost ? "bg-[#7b61ff]" : "bg-[#1a2535]"}`}>
                <div className={`absolute w-[10px] h-[10px] bg-white rounded-full top-[2px] transition-transform ${ghost ? "translate-x-[15px]" : "translate-x-[2px]"}`} />
              </div>
            </button>

            {/* Order summary */}
            <div className="bg-[#080d15] border border-[#0f1923] rounded p-2.5 space-y-1.5">
              {[
                ["Entry",      "Market"],
                ["Notional",   `$${notional.toLocaleString()}`],
                ["Margin",     `$${size.toLocaleString()}`],
                ["Fee (0.01%)",`$${(notional * 0.0001).toFixed(2)}`],
              ].map(([l, v]) => (
                <div key={l as string} className="flex justify-between">
                  <span className="text-[9px] text-[#2a3a50]">{l}</span>
                  <span className="text-[9px] text-[#6e8faa]">{v}</span>
                </div>
              ))}
              <div className="flex justify-between">
                <span className="text-[9px] text-[#2a3a50]">Liq. Price</span>
                <span className="text-[8px] text-[#7b61ff]">🔒 Arcium MPC</span>
              </div>
            </div>

            {/* Submit button */}
            <button onClick={handleOpenPosition} disabled={loading}
              className={`w-full py-3 border-none rounded font-mono text-[11px] font-bold tracking-[2px] uppercase transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                ghost
                  ? "bg-gradient-to-r from-[#1e0054] to-[#7b61ff] text-white hover:shadow-[0_0_20px_rgba(123,97,255,0.35)] hover:-translate-y-px"
                  : side === "long"
                    ? "bg-gradient-to-r from-[#004433] to-[#00e896] text-black font-black hover:shadow-[0_0_20px_rgba(0,232,150,0.25)] hover:-translate-y-px"
                    : "bg-gradient-to-r from-[#4d0015] to-[#ff2d55] text-white hover:shadow-[0_0_20px_rgba(255,45,85,0.25)] hover:-translate-y-px"
              }`}>
              {loading
                ? status.slice(0, 28) + "..."
                : !wallet.publicKey ? "Connect Wallet to Trade"
                : ghost ? `👻 Ghost ${side === "long" ? "Long" : "Short"} ${mktConf.label}`
                : `${side === "long" ? "▲ Long" : "▼ Short"} ${mktConf.label}/USD`}
            </button>

            <div className="text-center text-[8px] text-[#1a2535] flex items-center justify-center gap-1.5">
              <span className="text-[#7b61ff] opacity-40">Arcium MPC</span>
              <span>· Solana Devnet</span>
              {positions.length > 0 && <span>· {positions.length} position{positions.length !== 1 ? "s" : ""}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* ── TOAST ── */}
      {toast && (
        <div className={`fixed bottom-5 right-5 px-4 py-3 rounded-lg text-[11px] z-50 max-w-xs border backdrop-blur-xl whitespace-pre-line leading-relaxed shadow-2xl ${
          toast.type === "ok"     ? "bg-[rgba(0,232,150,0.06)] border-[rgba(0,232,150,0.2)] text-[#00e896]"
          : toast.type === "err"   ? "bg-[rgba(255,45,85,0.06)] border-[rgba(255,45,85,0.2)] text-[#ff2d55]"
          : "bg-[rgba(123,97,255,0.08)] border-[rgba(123,97,255,0.25)] text-[#c4b5fd]"
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
