import {
  BN,
  DriftClient,
  PerpMarketAccount,
  SlotSubscriber,
  PositionDirection,
  OrderType,
  BASE_PRECISION,
  Order,
  PerpPosition,
  calculateBidAskPrice,
  PRICE_PRECISION,
  isVariant,
} from '@drift-labs/sdk';
import { Mutex, tryAcquire, E_ALREADY_LOCKED } from 'async-mutex';
import { logger } from '../logger';
import { Bot } from '../types';
import { RuntimeSpec } from '../metrics';
import { BaseBotConfig } from '../config';

export interface FloatingMakerConfig extends BaseBotConfig {
  bidSpreadBps: number;
  askSpreadBps: number;
  minSpreadBps: number;
  dynamicSpreadFactor: number;
  orderRefreshMs: number;
  orderRefreshToleranceBps: number;
  maxPositionSizeQuote: number;
  maxLeverage: number;
  targetLeverage: number;
  inventorySkewEnabled: boolean;
  inventoryTargetPct: number;
  hangingOrdersEnabled: boolean;
  hangingOrdersCancelPct: number;
  filledOrderDelayMs: number;
  filledOrderDelayPct: number;
  debugLogs: boolean;
}

export class FloatingPerpMakerBot implements Bot {
  public readonly name: string;
  public readonly dryRun: boolean;
  public readonly defaultIntervalMs: number = 5000;

  private driftClient: DriftClient;
  private slotSubscriber: SlotSubscriber;
  private periodicTaskMutex = new Mutex();
  private lastSlotMarketUpdated: Map<number, number> = new Map();

  private intervalIds: Array<NodeJS.Timer> = [];

  private agentState?: {
    marketPosition: Map<number, PerpPosition>;
    openOrders: Map<number, Array<Order>>;
    lastFilledTime: Map<number, number>;
  };

  private config: FloatingMakerConfig;

  constructor(
    clearingHouse: DriftClient,
    slotSubscriber: SlotSubscriber,
    runtimeSpec: RuntimeSpec,
    config: FloatingMakerConfig
  ) {
    this.name = config.botId;
    this.dryRun = config.dryRun;
    this.driftClient = clearingHouse;
    this.slotSubscriber = slotSubscriber;
    this.config = config;
  }

  public async init() {
    logger.info(`${this.name} initing`);
    this.agentState = {
      marketPosition: new Map<number, PerpPosition>(),
      openOrders: new Map<number, Array<Order>>(),
      lastFilledTime: new Map<number, number>(),
    };
    this.updateAgentState();
  }

  public async reset() {
    for (const intervalId of this.intervalIds) {
      clearInterval(intervalId as NodeJS.Timeout);
    }
    this.intervalIds = [];
  }

  public async startIntervalLoop(intervalMs?: number) {
    await this.updateOpenOrders();
    const intervalId = setInterval(
      this.updateOpenOrders.bind(this),
      intervalMs || this.defaultIntervalMs
    );
    this.intervalIds.push(intervalId);

    logger.info(`${this.name} Bot started!`);
  }

  public async healthCheck(): Promise<boolean> {
    // Implement health check logic
    return true;
  }

  private updateAgentState(): void {
    const userAccount = this.driftClient.getUserAccount();
    if (userAccount) {
      userAccount.orders.forEach((o) => {
        if (!isVariant(o.status, 'init')) {
          const marketIndex = o.marketIndex;
          const currentOrders = this.agentState?.openOrders.get(marketIndex) ?? [];
          this.agentState?.openOrders.set(marketIndex, [...currentOrders, o]);
        }
      });
    }

    // zero out the open orders
    this.driftClient.getPerpMarketAccounts().forEach((market) => {
      this.agentState?.openOrders.set(market.marketIndex, []);
    });
  }

  private async updateOpenOrdersForMarket(marketAccount: PerpMarketAccount) {
    const currSlot = this.slotSubscriber.currentSlot;
    const marketIndex = marketAccount.marketIndex;
    const nextUpdateSlot = (this.lastSlotMarketUpdated.get(marketIndex) || 0) + Math.floor(this.config.orderRefreshMs / 1000);

    if (nextUpdateSlot > currSlot) {
      return;
    }

    const openOrders = this.agentState?.openOrders.get(marketIndex) ?? [];
    const oracle = this.driftClient.getOracleDataForPerpMarket(marketIndex);
    const [vBid, vAsk] = calculateBidAskPrice(marketAccount.amm, oracle);

    const position = this.agentState?.marketPosition.get(marketIndex);
    const inventorySkew = this.calculateInventorySkew(position);

    const bidSpread = new BN(this.config.bidSpreadBps).mul(PRICE_PRECISION).div(new BN(10000));
    const askSpread = new BN(this.config.askSpreadBps).mul(PRICE_PRECISION).div(new BN(10000));

    const dynamicBidSpread = this.applyDynamicSpread(bidSpread, vBid, vAsk);
    const dynamicAskSpread = this.applyDynamicSpread(askSpread, vBid, vAsk);

    const adjustedBidPrice = vBid.sub(dynamicBidSpread.mul(inventorySkew.bidMultiplier));
    const adjustedAskPrice = vAsk.add(dynamicAskSpread.mul(inventorySkew.askMultiplier));

    // Cancel existing orders
    for (const order of openOrders) {
      await this.driftClient.cancelOrder(order.orderId);
    }

    // Place new orders
    if (this.canPlaceNewOrders(marketIndex)) {
      await this.placeBidAskOrders(marketIndex, adjustedBidPrice, adjustedAskPrice);
    }

    this.lastSlotMarketUpdated.set(marketIndex, currSlot);
  }

  private calculateInventorySkew(position?: PerpPosition): { bidMultiplier: BN; askMultiplier: BN } {
    if (!position || !this.config.inventorySkewEnabled) {
      return { bidMultiplier: new BN(1), askMultiplier: new BN(1) };
    }

    const targetInventory = new BN(this.config.inventoryTargetPct).mul(BASE_PRECISION).div(new BN(100));
    const currentInventory = position.baseAssetAmount.abs();
    const skew = currentInventory.sub(targetInventory).div(targetInventory);

    const bidMultiplier = new BN(1).sub(skew);
    const askMultiplier = new BN(1).add(skew);

    return { bidMultiplier, askMultiplier };
  }

  private applyDynamicSpread(baseSpread: BN, vBid: BN, vAsk: BN): BN {
    const midPrice = vBid.add(vAsk).div(new BN(2));
    if (midPrice.isZero()) {
      // Handle the case where midPrice is zero
      console.warn('Mid price is zero, returning base spread');
      return baseSpread;
    }
    const volatility = vAsk.sub(vBid).mul(new BN(10000)).div(midPrice);
    const dynamicFactor = new BN(Math.floor(this.config.dynamicSpreadFactor * 1000));
    return baseSpread.add(volatility.mul(dynamicFactor).div(new BN(1000)));
  }

  private canPlaceNewOrders(marketIndex: number): boolean {
    const lastFillTime = this.agentState?.lastFilledTime.get(marketIndex) || 0;
    const currentTime = Date.now();
    return currentTime - lastFillTime > this.config.filledOrderDelayMs;
  }

  private async placeBidAskOrders(marketIndex: number, bidPrice: BN, askPrice: BN) {
    const baseAssetAmount = BASE_PRECISION.mul(new BN(1)); // Adjust order size as needed
try {
    await this.driftClient.placePerpOrder({
      marketIndex: marketIndex,
      orderType: OrderType.LIMIT,
      direction: PositionDirection.LONG,
      baseAssetAmount: baseAssetAmount,
      price: bidPrice,
      });
    } catch (e) {
      console.error(`Error placing bid order: ${e}`);
    }

    try {
      await this.driftClient.placePerpOrder({
      marketIndex: marketIndex,
      orderType: OrderType.LIMIT,
      direction: PositionDirection.SHORT,
      baseAssetAmount: baseAssetAmount,
      price: askPrice,
      });
    } catch (e) {
      console.error(`Error placing ask order: ${e}`);
    }
  }

  private async updateOpenOrders() {
    const start = Date.now();
    let ran = false;
    try {
      await tryAcquire(this.periodicTaskMutex).runExclusive(async () => {
        this.updateAgentState();
        await Promise.all(
          this.driftClient.getPerpMarketAccounts().map((marketAccount) => {
            console.log(
              `${this.name} updating open orders for market ${marketAccount.marketIndex}`
            );
            return this.updateOpenOrdersForMarket(marketAccount);
          })
        );

        ran = true;
      });
    } catch (e) {
      if (e === E_ALREADY_LOCKED) {
        const _user = this.driftClient.getUser();
        // Handle mutex busy counter if needed
      } else {
        throw e;
      }
    } finally {
      if (ran) {
        const duration = Date.now() - start;
        logger.debug(`${this.name} Bot took ${duration}ms to run`);
      }
    }
  }
}
