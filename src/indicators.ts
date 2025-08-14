/**
 * 技术指标计算模块
 * 提供类似TradingView Pine脚本的技术指标计算功能
 */

// 价格数据接口
export interface PriceData {
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    timestamp?: number;
}

// 简化的价格数据（仅收盘价）
export interface SimplePriceData {
    price: number;
    timestamp?: number;
}

/**
 * 移动平均线（MA）
 * @param prices 价格数组
 * @param period 周期
 * @returns 移动平均值数组
 */
export function sma(prices: number[], period: number): number[] {
    if (prices.length < period) return [];
    
    const result: number[] = [];
    for (let i = period - 1; i < prices.length; i++) {
        const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
        result.push(sum / period);
    }
    return result;
}

/**
 * 指数移动平均线（EMA）
 * @param prices 价格数组
 * @param period 周期
 * @returns EMA值数组
 */
export function ema(prices: number[], period: number): number[] {
    if (prices.length === 0) return [];
    
    const result: number[] = [];
    const multiplier = 2 / (period + 1);
    
    // 第一个EMA值使用SMA
    if (prices.length >= period) {
        const firstSMA = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
        result.push(firstSMA);
        
        // 后续EMA值
        for (let i = period; i < prices.length; i++) {
            const emaValue = (prices[i] - result[result.length - 1]) * multiplier + result[result.length - 1];
            result.push(emaValue);
        }
    }
    
    return result;
}

/**
 * 相对强弱指数（RSI）
 * @param prices 价格数组
 * @param period 周期，默认14
 * @returns RSI值数组
 */
export function rsi(prices: number[], period: number = 14): number[] {
    if (prices.length < period + 1) return [];
    
    const gains: number[] = [];
    const losses: number[] = [];
    
    // 计算涨跌幅
    for (let i = 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? Math.abs(change) : 0);
    }
    
    const result: number[] = [];
    
    // 计算RSI
    for (let i = period - 1; i < gains.length; i++) {
        const avgGain = gains.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
        const avgLoss = losses.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
        
        if (avgLoss === 0) {
            result.push(100);
        } else {
            const rs = avgGain / avgLoss;
            const rsiValue = 100 - (100 / (1 + rs));
            result.push(rsiValue);
        }
    }
    
    return result;
}

/**
 * MACD指标
 * @param prices 价格数组
 * @param fastPeriod 快线周期，默认12
 * @param slowPeriod 慢线周期，默认26
 * @param signalPeriod 信号线周期，默认9
 * @returns MACD对象数组
 */
export function macd(prices: number[], fastPeriod: number = 12, slowPeriod: number = 26, signalPeriod: number = 9): Array<{macd: number, signal: number, histogram: number}> {
    const fastEMA = ema(prices, fastPeriod);
    const slowEMA = ema(prices, slowPeriod);
    
    if (fastEMA.length === 0 || slowEMA.length === 0) return [];
    
    // 计算MACD线
    const macdLine: number[] = [];
    const minLength = Math.min(fastEMA.length, slowEMA.length);
    
    for (let i = 0; i < minLength; i++) {
        macdLine.push(fastEMA[i] - slowEMA[i]);
    }
    
    // 计算信号线（MACD的EMA）
    const signalLine = ema(macdLine, signalPeriod);
    
    // 计算柱状图
    const result: Array<{macd: number, signal: number, histogram: number}> = [];
    
    for (let i = 0; i < signalLine.length; i++) {
        const macdValue = macdLine[i + (macdLine.length - signalLine.length)];
        const signalValue = signalLine[i];
        result.push({
            macd: macdValue,
            signal: signalValue,
            histogram: macdValue - signalValue
        });
    }
    
    return result;
}

/**
 * 布林带（Bollinger Bands）
 * @param prices 价格数组
 * @param period 周期，默认20
 * @param stdDev 标准差倍数，默认2
 * @returns 布林带对象数组
 */
export function bollingerBands(prices: number[], period: number = 20, stdDev: number = 2): Array<{upper: number, middle: number, lower: number}> {
    if (prices.length < period) return [];
    
    const result: Array<{upper: number, middle: number, lower: number}> = [];
    
    for (let i = period - 1; i < prices.length; i++) {
        const slice = prices.slice(i - period + 1, i + 1);
        const middle = slice.reduce((a, b) => a + b, 0) / period;
        
        // 计算标准差
        const variance = slice.reduce((sum, price) => sum + Math.pow(price - middle, 2), 0) / period;
        const standardDeviation = Math.sqrt(variance);
        
        const upper = middle + (standardDeviation * stdDev);
        const lower = middle - (standardDeviation * stdDev);
        
        result.push({ upper, middle, lower });
    }
    
    return result;
}

/**
 * KDJ指标
 * @param highs 最高价数组
 * @param lows 最低价数组
 * @param closes 收盘价数组
 * @param period K值周期，默认9
 * @param kSmooth K值平滑周期，默认3
 * @param dSmooth D值平滑周期，默认3
 * @returns KDJ对象数组
 */
export function kdj(highs: number[], lows: number[], closes: number[], period: number = 9, kSmooth: number = 3, dSmooth: number = 3): Array<{k: number, d: number, j: number}> {
    if (highs.length < period || lows.length < period || closes.length < period) return [];
    
    const rsvValues: number[] = [];
    
    // 计算RSV值
    for (let i = period - 1; i < closes.length; i++) {
        const highestHigh = Math.max(...highs.slice(i - period + 1, i + 1));
        const lowestLow = Math.min(...lows.slice(i - period + 1, i + 1));
        const close = closes[i];
        
        if (highestHigh === lowestLow) {
            rsvValues.push(50); // 避免除零
        } else {
            const rsv = ((close - lowestLow) / (highestHigh - lowestLow)) * 100;
            rsvValues.push(rsv);
        }
    }
    
    // 计算K值（RSV的移动平均）
    const kValues: number[] = [];
    let prevK = 50; // K值初始值
    
    for (const rsv of rsvValues) {
        const k = (rsv + (kSmooth - 1) * prevK) / kSmooth;
        kValues.push(k);
        prevK = k;
    }
    
    // 计算D值（K值的移动平均）
    const dValues: number[] = [];
    let prevD = 50; // D值初始值
    
    for (const k of kValues) {
        const d = (k + (dSmooth - 1) * prevD) / dSmooth;
        dValues.push(d);
        prevD = d;
    }
    
    // 计算J值
    const result: Array<{k: number, d: number, j: number}> = [];
    
    for (let i = 0; i < kValues.length; i++) {
        const k = kValues[i];
        const d = dValues[i];
        const j = 3 * k - 2 * d;
        
        result.push({ k, d, j });
    }
    
    return result;
}

/**
 * 威廉指标（Williams %R）
 * @param highs 最高价数组
 * @param lows 最低价数组
 * @param closes 收盘价数组
 * @param period 周期，默认14
 * @returns Williams %R值数组
 */
export function williamsR(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
    if (highs.length < period || lows.length < period || closes.length < period) return [];
    
    const result: number[] = [];
    
    for (let i = period - 1; i < closes.length; i++) {
        const highestHigh = Math.max(...highs.slice(i - period + 1, i + 1));
        const lowestLow = Math.min(...lows.slice(i - period + 1, i + 1));
        const close = closes[i];
        
        if (highestHigh === lowestLow) {
            result.push(-50); // 避免除零
        } else {
            const wr = ((highestHigh - close) / (highestHigh - lowestLow)) * -100;
            result.push(wr);
        }
    }
    
    return result;
}

/**
 * 获取最新的指标值
 * @param values 指标值数组
 * @returns 最新值，如果数组为空则返回undefined
 */
export function latest<T>(values: T[]): T | undefined {
    return values.length > 0 ? values[values.length - 1] : undefined;
}

/**
 * 交叉检测
 * @param series1 第一个数据系列
 * @param series2 第二个数据系列
 * @returns 交叉信息对象
 */
export function crossover(series1: number[], series2: number[]): {bullishCross: boolean, bearishCross: boolean} {
    if (series1.length < 2 || series2.length < 2) {
        return { bullishCross: false, bearishCross: false };
    }
    
    const len1 = series1.length;
    const len2 = series2.length;
    
    // 当前值和前一个值
    const curr1 = series1[len1 - 1];
    const prev1 = series1[len1 - 2];
    const curr2 = series2[len2 - 1];
    const prev2 = series2[len2 - 2];
    
    // 金叉：series1从下方穿越series2
    const bullishCross = prev1 <= prev2 && curr1 > curr2;
    
    // 死叉：series1从上方穿越series2
    const bearishCross = prev1 >= prev2 && curr1 < curr2;
    
    return { bullishCross, bearishCross };
}