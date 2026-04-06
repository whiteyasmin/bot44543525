import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { Config } from "./config";
import { logger } from "./logger";

const PAPER_TAKER_FEE = 0.02;

export interface TraderInitOptions {
  mode?: "live" | "paper";
  paperBalance?: number;
}

interface PaperOrder {
  orderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  orderType: "FAK" | "FOK" | "GTC";
  size: number;
  filled: number;
  avgPrice: number;
  price?: number;
  canceled?: boolean;
}

export class Trader {
  private client!: ClobClient;
  private mode: "live" | "paper" = "live";
  private paperBalance = 0;
  private paperOrders = new Map<string, PaperOrder>();
  private paperOrderSeq = 0;

  async init(options: TraderInitOptions = {}): Promise<void> {
    this.mode = options.mode || "live";
    const wallet = Config.PRIVATE_KEY ? new Wallet(Config.PRIVATE_KEY) : Wallet.createRandom();

    if (this.mode === "paper") {
      this.client = new ClobClient(Config.CLOB_HOST, Config.CHAIN_ID, wallet);
      this.paperBalance = options.paperBalance && options.paperBalance > 0 ? options.paperBalance : 100;
      this.paperOrders.clear();
      this.paperOrderSeq = 0;
      logger.info(`交易客户端连接成功 (paper mode, initialBalance=$${this.paperBalance.toFixed(2)})`);
      return;
    }

    const tempClient = new ClobClient(Config.CLOB_HOST, Config.CHAIN_ID, wallet);
    const creds = await tempClient.createOrDeriveApiKey();
    let sigType = Config.SIGNATURE_TYPE;
    if (Config.FUNDER_ADDRESS && Config.FUNDER_ADDRESS.toLowerCase() !== wallet.address.toLowerCase() && sigType === 0) {
      sigType = 1;
      logger.info(`Auto-detected SIGNATURE_TYPE=1 (POLY_PROXY) for funder ${Config.FUNDER_ADDRESS.slice(0, 10)}...`);
    }
    this.client = new ClobClient(
      Config.CLOB_HOST,
      Config.CHAIN_ID,
      wallet,
      creds,
      sigType,
      Config.FUNDER_ADDRESS,
    );
    logger.info(`交易客户端连接成功 (sigType=${sigType}, funder=${Config.FUNDER_ADDRESS.slice(0, 10)}...)`);
  }

  isPaperMode(): boolean {
    return this.mode === "paper";
  }

  private nextPaperOrderId(prefix: string): string {
    this.paperOrderSeq += 1;
    return `paper-${prefix}-${Date.now()}-${this.paperOrderSeq}`;
  }

  private async fillPaperGtcOrder(orderId: string): Promise<PaperOrder | null> {
    const order = this.paperOrders.get(orderId);
    if (!order || order.canceled || order.orderType !== "GTC" || order.side !== "SELL") return order || null;
    if (order.filled >= order.size) return order;
    const book = await this.getBestPrices(order.tokenId);
    if (book.bid == null || book.bidDepth <= 0) return order;
    if (order.price != null && book.bid + 1e-9 < order.price) return order;
    const fillable = Math.min(order.size - order.filled, book.bidDepth);
    if (fillable <= 0) return order;
    const fillPrice = Math.max(order.price || book.bid, book.bid);
    order.filled += fillable;
    order.avgPrice = fillPrice;
    this.paperBalance += fillable * fillPrice * (1 - PAPER_TAKER_FEE);
    return order;
  }

  async getBestPrices(tokenId: string): Promise<{ bid: number | null; ask: number | null; spread: number; askDepth: number; bidDepth: number }> {
    try {
      const book = await this.client.getOrderBook(tokenId);
      // Polymarket CLOB returns bids ascending (worst first) and asks descending (worst first)
      // Use Math.max/min to get best bid/ask regardless of sort order
      const bestBid = book.bids?.length ? Math.max(...book.bids.map(b => parseFloat(b.price))) : null;
      const bestAsk = book.asks?.length ? Math.min(...book.asks.map(a => parseFloat(a.price))) : null;
      const spread = (bestAsk != null && bestBid != null) ? bestAsk - bestBid : 1;
      let askDepth = 0;
      if (book.asks) {
        // asks are descending (worst first), so last 3 are the cheapest (best) asks
        const sorted = book.asks.slice().sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        for (let i = 0; i < Math.min(3, sorted.length); i++) {
          askDepth += parseFloat(sorted[i].size || "0");
        }
      }
      let bidDepth = 0;
      if (book.bids) {
        // bids are ascending (worst first), so last 3 are the highest (best) bids
        const sorted = book.bids.slice().sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        for (let i = 0; i < Math.min(3, sorted.length); i++) {
          bidDepth += parseFloat(sorted[i].size || "0");
        }
      }
      return { bid: bestBid, ask: bestAsk, spread, askDepth, bidDepth };
    } catch (e: any) {
      logger.error(`获取盘口失败: ${e.message}`);
      return { bid: null, ask: null, spread: 1, askDepth: 0, bidDepth: 0 };
    }
  }

  async placeFakBuy(tokenId: string, amount: number, negRisk = false): Promise<any> {
    if (this.mode === "paper") {
      const book = await this.getBestPrices(tokenId);
      if (book.ask == null || book.ask <= 0 || book.askDepth <= 0) {
        logger.warn(`PAPER FAK买入失败: 无可用ask token=${tokenId.slice(0, 20)}...`);
        return null;
      }
      const requestedShares = amount / book.ask;
      const affordableShares = this.paperBalance / (book.ask * (1 + PAPER_TAKER_FEE));
      const filled = Math.min(requestedShares, book.askDepth, affordableShares);
      if (filled < 1e-6) {
        logger.warn(`PAPER FAK买入失败: 余额不足或深度不足 token=${tokenId.slice(0, 20)}...`);
        return null;
      }
      const orderId = this.nextPaperOrderId("buy");
      this.paperOrders.set(orderId, {
        orderId,
        tokenId,
        side: "BUY",
        orderType: "FAK",
        size: requestedShares,
        filled,
        avgPrice: book.ask,
      });
      this.paperBalance -= filled * book.ask * (1 + PAPER_TAKER_FEE);
      logger.info(`PAPER FAK买入: ${filled.toFixed(2)}份 @$${book.ask.toFixed(2)} token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return { orderID: orderId };
    }
    try {
      const resp = await this.client.createAndPostMarketOrder(
        { tokenID: tokenId, amount, side: Side.BUY },
        { tickSize: "0.01", negRisk },
        OrderType.FAK,
      );
      logger.info(`FAK买入: $${amount.toFixed(2)} token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return resp;
    } catch (e: any) {
      logger.error(`FAK买入失败: ${e.message}`);
      return null;
    }
  }

  async placeFakSell(tokenId: string, shares: number, negRisk = false): Promise<any> {
    if (this.mode === "paper") {
      const book = await this.getBestPrices(tokenId);
      if (book.bid == null || book.bid <= 0 || book.bidDepth <= 0) {
        logger.warn(`PAPER FAK卖出失败: 无可用bid token=${tokenId.slice(0, 20)}...`);
        return null;
      }
      const filled = Math.min(shares, book.bidDepth);
      if (filled < 1e-6) {
        logger.warn(`PAPER FAK卖出失败: 深度不足 token=${tokenId.slice(0, 20)}...`);
        return null;
      }
      const orderId = this.nextPaperOrderId("sell");
      this.paperOrders.set(orderId, {
        orderId,
        tokenId,
        side: "SELL",
        orderType: "FAK",
        size: shares,
        filled,
        avgPrice: book.bid,
      });
      this.paperBalance += filled * book.bid * (1 - PAPER_TAKER_FEE);
      logger.info(`PAPER FAK卖出: ${filled.toFixed(2)}份 @$${book.bid.toFixed(2)} token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return { orderID: orderId };
    }
    try {
      const resp = await this.client.createAndPostMarketOrder(
        { tokenID: tokenId, amount: shares, side: Side.SELL },
        { tickSize: "0.01", negRisk },
        OrderType.FAK,
      );
      logger.info(`FAK卖出: ${shares}份 token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return resp;
    } catch (e: any) {
      logger.error(`FAK卖出失败: ${e.message}`);
      try {
        logger.info(`FAK卖出重试: FOK市价 ${shares}份`);
        const retry = await this.client.createAndPostMarketOrder(
          { tokenID: tokenId, amount: shares, side: Side.SELL },
          { tickSize: "0.01", negRisk },
          OrderType.FOK,
        );
        return retry;
      } catch (e2: any) {
        logger.error(`卖出重试也失败: ${e2.message}`);
        return null;
      }
    }
  }

  /** 挂 GTC 限价卖单，不等成交，返回 orderID 供调用方追踪 */
  async placeGtcSell(tokenId: string, shares: number, price: number, negRisk = false): Promise<string | null> {
    if (this.mode === "paper") {
      const orderId = this.nextPaperOrderId("gtc");
      this.paperOrders.set(orderId, {
        orderId,
        tokenId,
        side: "SELL",
        orderType: "GTC",
        size: shares,
        filled: 0,
        avgPrice: 0,
        price,
      });
      logger.info(`PAPER GTC限价卖单: ${shares.toFixed(2)}份 @${price.toFixed(2)} token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return orderId;
    }
    try {
      const resp = await this.client.createAndPostOrder(
        { tokenID: tokenId, price, size: shares, side: Side.SELL },
        { tickSize: "0.01", negRisk },
        OrderType.GTC,
      );
      const orderId: string = resp?.orderID || resp?.order_id || "";
      logger.info(`GTC限价卖单: ${shares}份 @${price.toFixed(2)} token=${tokenId.slice(0, 20)}... orderId=${orderId}`);
      return orderId || null;
    } catch (e: any) {
      logger.error(`GTC卖单失败: ${e.message}`);
      return null;
    }
  }

  async cancelAll(): Promise<void> {
    if (this.mode === "paper") {
      for (const order of this.paperOrders.values()) {
        if (order.orderType === "GTC") order.canceled = true;
      }
      logger.info("已取消所有挂单 (paper)");
      return;
    }
    try {
      await this.client.cancelAll();
      logger.info("已取消所有挂单");
    } catch (e: any) {
      logger.error(`取消失败: ${e.message}`);
    }
  }

  async getOrderFilled(orderId: string): Promise<number> {
    if (this.mode === "paper") {
      const order = await this.fillPaperGtcOrder(orderId);
      return order?.filled || 0;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const o = await this.client.getOrder(orderId);
        return parseFloat(o.size_matched || "0");
      } catch (e: any) {
        if (attempt < 2) await new Promise(r => setTimeout(r, 500));
        else logger.warn(`getOrderFilled failed after 3 attempts (${orderId.slice(0,12)}): ${e.message}`);
      }
    }
    return 0;
  }

  /** 查询订单真实成交: 返回 { filled: 成交份数, avgPrice: 平均成交价 } */
  async getOrderFillDetails(orderId: string): Promise<{ filled: number; avgPrice: number }> {
    if (this.mode === "paper") {
      const order = await this.fillPaperGtcOrder(orderId);
      return order ? { filled: order.filled, avgPrice: order.avgPrice } : { filled: 0, avgPrice: 0 };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const o: any = await this.client.getOrder(orderId);
        const sizeMatched = parseFloat(o.size_matched || "0");
        if (sizeMatched <= 0) return { filled: 0, avgPrice: 0 };
        // CLOB 订单返回的 associate_trades 包含每笔成交明细
        const trades: any[] = o.associate_trades || o.trades || [];
        if (trades.length > 0) {
          let totalQty = 0, totalVal = 0;
          for (const t of trades) {
            const qty = parseFloat(t.size || t.amount || "0");
            const px = parseFloat(t.price || "0");
            if (qty > 0 && px > 0) { totalQty += qty; totalVal += qty * px; }
          }
          if (totalQty > 0) {
            // 以 trades 明细的实际总量为准, 与 size_matched 取较小值防止超算
            const filled = Math.min(sizeMatched, totalQty);
            if (Math.abs(sizeMatched - totalQty) > 0.5) {
              logger.warn(`getOrderFillDetails: size_matched=${sizeMatched.toFixed(1)} vs trades_total=${totalQty.toFixed(1)}, using min=${filled.toFixed(1)}`);
            }
            return { filled, avgPrice: totalVal / totalQty };
          }
        }
        // 无明细时用 size_matched 和订单价格(限价单)
        const orderPrice = parseFloat(o.price || "0");
        return { filled: sizeMatched, avgPrice: orderPrice > 0 ? orderPrice : 0 };
      } catch (e: any) {
        if (attempt < 2) await new Promise(r => setTimeout(r, 500));
        else logger.warn(`getOrderFillDetails failed after 3 attempts (${orderId.slice(0,12)}): ${e.message}`);
      }
    }
    return { filled: 0, avgPrice: 0 };
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (this.mode === "paper") {
      const order = this.paperOrders.get(orderId);
      if (order) order.canceled = true;
      return;
    }
    try {
      await this.client.cancelOrder({ orderID: orderId });
    } catch (e: any) {
      logger.warn(`cancelOrder失败 (${orderId.slice(0, 12)}): ${e.message}`);
    }
  }

  /** 仿真盘结算：将赢得的份额回款加到paperBalance */
  creditSettlement(amount: number): void {
    if (this.mode === "paper" && amount > 0) {
      this.paperBalance += amount;
    }
  }

  async getBalance(): Promise<number> {
    if (this.mode === "paper") {
      return this.paperBalance;
    }
    // Method 1: Polymarket CLOB API
    try {
      const resp = await this.client.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
      logger.info(`CLOB balance response: ${JSON.stringify(resp)}`);
      let raw = 0;
      if (resp && typeof resp === "object") {
        for (const key of ["balance", "available", "amount", "collateral"]) {
          const val = (resp as any)[key];
          if (val != null && val !== "" && val !== "0") {
            raw = parseFloat(String(val));
            if (raw > 0) { logger.info(`CLOB balance: found in field '${key}' raw=${raw}`); break; }
          }
        }
        if (raw === 0 && typeof resp === "string") {
          raw = parseFloat(resp);
        }
      }
      const bal = raw >= 10000 ? raw / 1e6 : raw;
      logger.info(`CLOB balance parsed=$${bal.toFixed(4)}`);
      if (bal > 0) return bal;
    } catch (e: any) {
      logger.warn(`CLOB balance query failed: ${e.message}`);
    }

    // Method 2: Direct Polymarket REST API
    try {
      const resp = await fetch(`${Config.CLOB_HOST}/balance`, {
        headers: { Authorization: `Bearer ${(this.client as any).creds?.apiKey || ""}` },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        logger.info(`REST balance response: ${JSON.stringify(data)}`);
        const raw = parseFloat(data?.balance || data?.available || data?.collateral || "0");
        const bal = raw >= 10000 ? raw / 1e6 : raw;
        if (bal > 0) return bal;
      }
    } catch (e: any) {
      logger.warn(`REST balance query failed: ${e.message}`);
    }

    // Method 3: On-chain RPC query
    const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
    const RPCS = [Config.CHAINLINK_RPC, "https://1rpc.io/matic", "https://polygon-bor-rpc.publicnode.com"].filter(Boolean);
    const wallet = new Wallet(Config.PRIVATE_KEY);
    const addresses = [Config.FUNDER_ADDRESS, wallet.address].filter(a => a.length > 0);

    const query = async (token: string, address: string): Promise<number> => {
      const addr = address.toLowerCase().replace("0x", "").padStart(64, "0");
      for (const rpc of RPCS) {
        try {
          const resp = await fetch(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "eth_call",
              params: [{ to: token, data: "0x70a08231" + addr }, "latest"],
              id: 1,
            }),
            signal: AbortSignal.timeout(5000),
          });
          const json = await resp.json();
          if (json.error) continue;
          const result = json.result as string | undefined;
          if (!result || result === "0x" || result === "0x0000000000000000000000000000000000000000000000000000000000000000") return 0;
          const val = parseInt(result, 16) / 1e6;
          if (val > 0) logger.info(`RPC balance: ${token.slice(0,10)}... @ ${address.slice(0,10)}... = $${val.toFixed(2)} (via ${rpc.slice(0,30)})`);
          return val;
        } catch {}
      }
      return 0;
    };

    let totalBal = 0;
    for (const address of addresses) {
      const [b1, b2] = await Promise.all([query(USDC_E, address), query(USDC_NATIVE, address)]);
      totalBal += b1 + b2;
    }
    if (totalBal > 0) logger.info(`RPC total balance: $${totalBal.toFixed(2)}`);
    else logger.warn(`RPC balance fallback: all queries returned 0 for ${addresses.join(",")}`);
    return totalBal;
  }
}
