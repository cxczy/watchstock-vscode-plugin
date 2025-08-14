/**
 * Pine脚本解析器模块
 * 支持类似TradingView Pine脚本的条件表达式解析和执行
 */

import * as indicators from './indicators';

// 脚本执行上下文
export interface ScriptContext {
    // 当前股票数据
    symbol: string;
    price: number;
    change: number;
    changePercent: number;
    
    // 历史价格数据（用于技术指标计算）
    historicalPrices: number[];
    historicalHighs?: number[];
    historicalLows?: number[];
    
    // 技术指标缓存
    indicatorCache: Map<string, any>;
}

// 脚本执行结果
export interface ScriptResult {
    buySignal: boolean;
    sellSignal: boolean;
    value?: number;
    error?: string;
}

// 支持的操作符
const OPERATORS = {
    // 比较操作符
    '>': (a: number, b: number) => a > b,
    '<': (a: number, b: number) => a < b,
    '>=': (a: number, b: number) => a >= b,
    '<=': (a: number, b: number) => a <= b,
    '==': (a: number, b: number) => Math.abs(a - b) < 0.0001,
    '!=': (a: number, b: number) => Math.abs(a - b) >= 0.0001,
    
    // 逻辑操作符
    'and': (a: boolean, b: boolean) => a && b,
    'or': (a: boolean, b: boolean) => a || b,
    'not': (a: boolean) => !a,
    
    // 数学操作符
    '+': (a: number, b: number) => a + b,
    '-': (a: number, b: number) => a - b,
    '*': (a: number, b: number) => a * b,
    '/': (a: number, b: number) => b !== 0 ? a / b : 0,
};

// 内置函数
const BUILTIN_FUNCTIONS = {
    // 技术指标函数
    sma: (prices: number[], period: number) => indicators.latest(indicators.sma(prices, period)),
    ema: (prices: number[], period: number) => indicators.latest(indicators.ema(prices, period)),
    rsi: (prices: number[], period: number = 14) => indicators.latest(indicators.rsi(prices, period)),
    
    // MACD相关函数
    macd: (prices: number[], fast: number = 12, slow: number = 26, signal: number = 9) => {
        const macdData = indicators.latest(indicators.macd(prices, fast, slow, signal));
        return macdData ? macdData.macd : undefined;
    },
    macd_signal: (prices: number[], fast: number = 12, slow: number = 26, signal: number = 9) => {
        const macdData = indicators.latest(indicators.macd(prices, fast, slow, signal));
        return macdData ? macdData.signal : undefined;
    },
    macd_histogram: (prices: number[], fast: number = 12, slow: number = 26, signal: number = 9) => {
        const macdData = indicators.latest(indicators.macd(prices, fast, slow, signal));
        return macdData ? macdData.histogram : undefined;
    },
    
    // 布林带函数
    bb_upper: (prices: number[], period: number = 20, stdDev: number = 2) => {
        const bbData = indicators.latest(indicators.bollingerBands(prices, period, stdDev));
        return bbData ? bbData.upper : undefined;
    },
    bb_middle: (prices: number[], period: number = 20, stdDev: number = 2) => {
        const bbData = indicators.latest(indicators.bollingerBands(prices, period, stdDev));
        return bbData ? bbData.middle : undefined;
    },
    bb_lower: (prices: number[], period: number = 20, stdDev: number = 2) => {
        const bbData = indicators.latest(indicators.bollingerBands(prices, period, stdDev));
        return bbData ? bbData.lower : undefined;
    },
    
    // KDJ函数
    kdj_k: (highs: number[], lows: number[], closes: number[], period: number = 9) => {
        const kdjData = indicators.latest(indicators.kdj(highs, lows, closes, period));
        return kdjData ? kdjData.k : undefined;
    },
    kdj_d: (highs: number[], lows: number[], closes: number[], period: number = 9) => {
        const kdjData = indicators.latest(indicators.kdj(highs, lows, closes, period));
        return kdjData ? kdjData.d : undefined;
    },
    kdj_j: (highs: number[], lows: number[], closes: number[], period: number = 9) => {
        const kdjData = indicators.latest(indicators.kdj(highs, lows, closes, period));
        return kdjData ? kdjData.j : undefined;
    },
    
    // 威廉指标
    wr: (highs: number[], lows: number[], closes: number[], period: number = 14) => {
        return indicators.latest(indicators.williamsR(highs, lows, closes, period));
    },
    
    // 交叉函数
    crossover: (series1: number[], series2: number[]) => {
        return indicators.crossover(series1, series2).bullishCross;
    },
    crossunder: (series1: number[], series2: number[]) => {
        return indicators.crossover(series1, series2).bearishCross;
    },
    
    // 数学函数
    abs: Math.abs,
    max: Math.max,
    min: Math.min,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
};

// 内置变量
const BUILTIN_VARIABLES = {
    // 当前价格相关
    'close': (context: ScriptContext) => context.price,
    'price': (context: ScriptContext) => context.price,
    'change': (context: ScriptContext) => context.change,
    'change_percent': (context: ScriptContext) => context.changePercent,
    
    // 历史数据
    'prices': (context: ScriptContext) => context.historicalPrices,
    'highs': (context: ScriptContext) => context.historicalHighs || [],
    'lows': (context: ScriptContext) => context.historicalLows || [],
};

/**
 * Pine脚本解析器类
 */
export class PineScriptParser {
    private context: ScriptContext;
    
    constructor(context: ScriptContext) {
        this.context = context;
    }
    
    /**
     * 执行Pine脚本
     * @param script 脚本内容
     * @returns 执行结果
     */
    execute(script: string): ScriptResult {
        try {
            // 预处理脚本
            const processedScript = this.preprocessScript(script);
            
            // 解析并执行脚本
            const result = this.evaluateScript(processedScript);
            
            return {
                buySignal: result.buy || false,
                sellSignal: result.sell || false,
                value: result.value,
            };
        } catch (error) {
            return {
                buySignal: false,
                sellSignal: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    
    /**
     * 预处理脚本
     * @param script 原始脚本
     * @returns 处理后的脚本
     */
    private preprocessScript(script: string): string {
        // 移除注释
        let processed = script.replace(/\/\/.*$/gm, '');
        
        // 替换逻辑操作符
        processed = processed.replace(/\band\b/g, '&&');
        processed = processed.replace(/\bor\b/g, '||');
        processed = processed.replace(/\bnot\b/g, '!');
        
        return processed.trim();
    }
    
    /**
     * 评估脚本表达式
     * @param script 脚本内容
     * @returns 评估结果
     */
    private evaluateScript(script: string): any {
        // 简化的脚本解析实现
        // 支持基本的条件表达式和函数调用
        
        const lines = script.split('\n').filter(line => line.trim());
        const result: any = {};
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            
            // 处理买入信号
            if (trimmedLine.startsWith('buy = ') || trimmedLine.startsWith('buy=')) {
                const expression = trimmedLine.split('=')[1].trim();
                result.buy = this.evaluateExpression(expression);
            }
            // 处理卖出信号
            else if (trimmedLine.startsWith('sell = ') || trimmedLine.startsWith('sell=')) {
                const expression = trimmedLine.split('=')[1].trim();
                result.sell = this.evaluateExpression(expression);
            }
            // 处理其他变量赋值
            else if (trimmedLine.includes('=')) {
                const [varName, expression] = trimmedLine.split('=').map(s => s.trim());
                result[varName] = this.evaluateExpression(expression);
            }
        }
        
        return result;
    }
    
    /**
     * 评估单个表达式
     * @param expression 表达式字符串
     * @returns 评估结果
     */
    private evaluateExpression(expression: string): any {
        try {
            // 替换内置变量
            let processedExpr = expression;
            
            for (const [varName, varFunc] of Object.entries(BUILTIN_VARIABLES)) {
                const regex = new RegExp(`\\b${varName}\\b`, 'g');
                if (processedExpr.match(regex)) {
                    const value = varFunc(this.context);
                    processedExpr = processedExpr.replace(regex, JSON.stringify(value));
                }
            }
            
            // 处理函数调用
            processedExpr = this.processFunctionCalls(processedExpr);
            
            // 使用安全的表达式评估
            return this.safeEval(processedExpr);
        } catch (error) {
            console.error('Expression evaluation error:', error);
            return false;
        }
    }
    
    /**
     * 处理函数调用
     * @param expression 表达式
     * @returns 处理后的表达式
     */
    private processFunctionCalls(expression: string): string {
        let processed = expression;
        
        // 匹配函数调用模式：functionName(args)
        const functionPattern = /(\w+)\s*\(([^)]*)\)/g;
        
        processed = processed.replace(functionPattern, (match, funcName, argsStr) => {
            if (BUILTIN_FUNCTIONS.hasOwnProperty(funcName)) {
                try {
                    // 解析参数
                    const args = this.parseArguments(argsStr);
                    
                    // 调用函数
                    const func = BUILTIN_FUNCTIONS[funcName as keyof typeof BUILTIN_FUNCTIONS];
                    const result = (func as any)(...args);
                    
                    return String(result);
                } catch (error) {
                    console.error(`Function call error for ${funcName}:`, error);
                    return '0';
                }
            }
            return match;
        });
        
        return processed;
    }
    
    /**
     * 解析函数参数
     * @param argsStr 参数字符串
     * @returns 参数数组
     */
    private parseArguments(argsStr: string): any[] {
        if (!argsStr.trim()) return [];
        
        const args: any[] = [];
        const argStrings = argsStr.split(',').map(s => s.trim());
        
        for (const argStr of argStrings) {
            // 处理数字
            if (/^\d+(\.\d+)?$/.test(argStr)) {
                args.push(parseFloat(argStr));
            }
            // 处理内置变量
            else if (BUILTIN_VARIABLES.hasOwnProperty(argStr)) {
                const varFunc = BUILTIN_VARIABLES[argStr as keyof typeof BUILTIN_VARIABLES];
                args.push(varFunc(this.context));
            }
            // 处理字符串
            else if (argStr.startsWith('"') && argStr.endsWith('"')) {
                args.push(argStr.slice(1, -1));
            }
            // 处理其他表达式
            else {
                args.push(this.evaluateExpression(argStr));
            }
        }
        
        return args;
    }
    
    /**
     * 安全的表达式评估
     * @param expression 表达式
     * @returns 评估结果
     */
    private safeEval(expression: string): any {
        // 简化的安全评估实现
        // 在实际应用中，应该使用更安全的表达式解析器
        
        try {
            // 移除危险的函数调用
            const safeExpr = expression.replace(/[^0-9+\-*/.()\s<>=!&|\[\],"]/g, '');
            
            // 使用Function构造器进行安全评估
            const func = new Function('return ' + safeExpr);
            return func();
        } catch (error) {
            console.error('Safe eval error:', error);
            return false;
        }
    }
}

/**
 * 创建脚本执行上下文
 * @param symbol 股票代码
 * @param price 当前价格
 * @param change 涨跌额
 * @param changePercent 涨跌幅百分比
 * @param historicalPrices 历史价格数据
 * @returns 脚本上下文
 */
export function createScriptContext(
    symbol: string,
    price: number,
    change: number,
    changePercent: number,
    historicalPrices: number[] = [],
    historicalHighs?: number[],
    historicalLows?: number[]
): ScriptContext {
    return {
        symbol,
        price,
        change,
        changePercent,
        historicalPrices,
        historicalHighs,
        historicalLows,
        indicatorCache: new Map(),
    };
}

/**
 * 获取预设策略模板
 * @returns 预设策略对象
 */
export function getPresetStrategies() {
    return {
        rsi_oversold_overbought: {
            name: 'RSI超买超卖策略',
            description: 'RSI < 30买入，RSI > 70卖出',
            buyScript: 'rsi(14) < 30',
            sellScript: 'rsi(14) > 70'
        },
        macd_golden_cross: {
            name: 'MACD金叉死叉策略',
            description: 'MACD金叉买入，死叉卖出',
            buyScript: 'macd(12, 26, 9) > macd_signal(12, 26, 9) and macd(12, 26, 9)[1] <= macd_signal(12, 26, 9)[1]',
            sellScript: 'macd(12, 26, 9) < macd_signal(12, 26, 9) and macd(12, 26, 9)[1] >= macd_signal(12, 26, 9)[1]'
        },
        double_ma_cross: {
            name: '双均线策略',
            description: '短期均线上穿长期均线买入，下穿卖出',
            buyScript: 'sma(5) > sma(20) and sma(5)[1] <= sma(20)[1]',
            sellScript: 'sma(5) < sma(20) and sma(5)[1] >= sma(20)[1]'
        },
        bollinger_bands: {
            name: '布林带策略',
            description: '价格触及下轨买入，触及上轨卖出',
            buyScript: 'close <= bb_lower(20, 2)',
            sellScript: 'close >= bb_upper(20, 2)'
        },
        kdj_oversold_overbought: {
            name: 'KDJ超买超卖策略',
            description: 'KDJ < 20买入，KDJ > 80卖出',
            buyScript: 'kdj_k(9, 3, 3) < 20 and kdj_d(9, 3, 3) < 20',
            sellScript: 'kdj_k(9, 3, 3) > 80 and kdj_d(9, 3, 3) > 80'
        },
        price_volume_breakout: {
            name: '价量突破策略',
            description: '价格突破前高且成交量放大时买入',
            buyScript: 'close > highest(high, 20)[1] and volume > sma(volume, 10) * 1.5',
            sellScript: 'close < lowest(low, 20)[1]'
        },
        mean_reversion: {
            name: '均值回归策略',
            description: '价格偏离均线过多时反向操作',
            buyScript: '(close - sma(20)) / sma(20) < -0.05',
            sellScript: '(close - sma(20)) / sma(20) > 0.05'
        },
        momentum_strategy: {
            name: '动量策略',
            description: '基于价格动量的趋势跟踪策略',
            buyScript: 'roc(10) > 5 and rsi(14) > 50',
            sellScript: 'roc(10) < -5 and rsi(14) < 50'
        }
    };
}

/**
 * 预设的策略模板（保持向后兼容）
 */
export const STRATEGY_TEMPLATES = {
    // RSI超买超卖策略
    rsi_oversold_overbought: `
// RSI超买超卖策略
rsi_value = rsi(prices, 14)
buy = rsi_value < 30
sell = rsi_value > 70
    `,
    
    // MACD金叉死叉策略
    macd_crossover: `
// MACD金叉死叉策略
macd_line = macd(prices, 12, 26, 9)
signal_line = macd_signal(prices, 12, 26, 9)
buy = crossover([macd_line], [signal_line])
sell = crossunder([macd_line], [signal_line])
    `,
    
    // 双均线策略
    dual_ma: `
// 双均线策略
ma5 = sma(prices, 5)
ma20 = sma(prices, 20)
buy = crossover([ma5], [ma20])
sell = crossunder([ma5], [ma20])
    `,
    
    // 布林带策略
    bollinger_bands: `
// 布林带策略
bb_up = bb_upper(prices, 20, 2)
bb_low = bb_lower(prices, 20, 2)
buy = price < bb_low
sell = price > bb_up
    `,
    
    // KDJ策略
    kdj_strategy: `
// KDJ策略
k_value = kdj_k(highs, lows, prices, 9)
d_value = kdj_d(highs, lows, prices, 9)
buy = k_value < 20 && d_value < 20 && k_value > d_value
sell = k_value > 80 && d_value > 80 && k_value < d_value
    `,
};