// app/types/index.ts
// PrivatePerps — Shared TypeScript Types

export type WalletAddress = string;

export type TradingPair = "BTC/USD" | "ETH/USD" | "SOL/USD";

export type TradeSide = "long" | "short";

export type PositionStatus = "open" | "closed" | "liquidated";

/** Input the trader fills in on the trade form */
export interface TradeInput {
  pair: TradingPair;
  side: TradeSide;
  leverage: number;
  size: number;
  walletAddress: WalletAddress;
}

/** Returned after Arcium openPosition computation completes */
export interface TradeResult {
  positionId: string;
  success: boolean;
  entryPrice: number;
  timestamp: number;
}

/** A position as stored — all sensitive fields are encrypted on-chain */
export interface Position {
  id: string;
  pair: TradingPair;
  side: TradeSide;
  size: number;
  leverage: number;
  entryPrice: number;
  currentPrice: number;
  status: PositionStatus;
  walletAddress: WalletAddress;
  timestamp: number;
}

/** PnL result — the ONLY value Arcium reveals on position close */
export interface PnLResult {
  pnlValue: number;
  pnlPercentage: number;
  isProfit: boolean;
}

/** Oracle price feed entry */
export interface OraclePrice {
  pair: TradingPair;
  price: number;
  updatedAt: number;
}
