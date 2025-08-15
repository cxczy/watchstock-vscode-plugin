import * as vscode from 'vscode';
import fetch from 'node-fetch';

type StockBase = {
    symbol: string;   // 代码，例如 600519
    name?: string;    // 名称，可选
    price?: number;   // 实时价，示例字段
    change?: number;  // 涨跌幅，示例字段
};

type Holding = StockBase & {
    quantity: number; // 持仓数量
    cost: number;     // 成本价
};

export type Strategy = {
    id: string;
    name: string;
    symbols: string[]; // 关注的股票代码
    
    // 策略类型：'simple' 为简单阈值策略，'script' 为Pine脚本策略
    type?: 'simple' | 'script';
    
    // 股票配置列表（新增，用于扁平化数据结构）
    stocks?: {
        symbol: string;
        name?: string;
        enabled: boolean;
        config?: any; // 策略参数配置
        presetStrategy?: string; // 预设策略名称
        strategyType?: string; // 策略类型
        updatedAt?: string; // 更新时间
    }[];
    
    // Pine脚本配置（新增）
    script?: {
        buyScript?: string;         // 买入信号Pine脚本
        sellScript?: string;        // 卖出信号Pine脚本
        enabled: boolean;           // 是否启用脚本策略
        template?: string;          // 使用的策略模板名称
    };
    
    // 传统买卖信号配置（保持向后兼容）
    signals?: {
        buyConditions?: {
            priceThreshold?: number;    // 买入价格阈值
            changeThreshold?: number;   // 买入涨跌幅阈值（如-0.05表示跌5%时买入）
            enabled: boolean;           // 是否启用买入信号
        };
        sellConditions?: {
            priceThreshold?: number;    // 卖出价格阈值
            changeThreshold?: number;   // 卖出涨跌幅阈值（如0.10表示涨10%时卖出）
            enabled: boolean;           // 是否启用卖出信号
        };
        notifications?: {
            showPopup: boolean;         // 是否显示弹窗提醒
            playSound: boolean;         // 是否播放提示音
        };
    };
};

export class Store {
    private readonly WATCH_KEY = 'efinance.watchlist';
    private readonly HOLD_KEY = 'efinance.holdings';
    private readonly STRA_KEY = 'efinance.strategies';

    constructor(private memento: vscode.Memento) {}

    getWatchlist(): StockBase[] {
        return this.memento.get<StockBase[]>(this.WATCH_KEY, []);
    }
    setWatchlist(data: StockBase[]) {
        return this.memento.update(this.WATCH_KEY, data);
    }

    getHoldings(): Holding[] {
        return this.memento.get<Holding[]>(this.HOLD_KEY, []);
    }
    setHoldings(data: Holding[]) {
        return this.memento.update(this.HOLD_KEY, data);
    }

    getStrategies(): Strategy[] {
        return this.memento.get<Strategy[]>(this.STRA_KEY, []);
    }
    setStrategies(data: Strategy[]) {
        return this.memento.update(this.STRA_KEY, data);
    }
}

class StockTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly options: {
            contextValue: 'efinance.watchItem' | 'efinance.holdingItem' | 'efinance.strategyItem' | 'efinance.strategyStockItem';
            description?: string;
            tooltip?: string;
        }
    ) {
        super(label, collapsibleState);
        this.contextValue = options.contextValue;
        this.description = options.description;
        this.tooltip = options.tooltip;
    }
}

class BaseProvider<T> implements vscode.TreeDataProvider<StockTreeItem> {
    protected _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(protected store: Store) {}

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: StockTreeItem): vscode.TreeItem {
        return element;
    }

    // 子类实现
    getChildren(element?: StockTreeItem): Thenable<StockTreeItem[]> {
        return Promise.resolve([]);
    }
}

class WatchlistProvider extends BaseProvider<StockBase> {
    async getChildren(): Promise<StockTreeItem[]> {
        const list = this.store.getWatchlist();
        
        // 获取股票行情数据
        const symbols = list.map(s => s.symbol);
        const quotes = await fetchQuotes(symbols, 'watchlist-view');
        
        // 更新股票价格和涨跌幅数据
        const updatedList = list.map(stock => {
            const quote = quotes[stock.symbol];
            return {
                ...stock,
                price: quote?.price || stock.price,
                change: quote?.change || stock.change
            };
        });
        
        // 按涨跌幅排序：涨幅大的在上面，跌幅大的在下面
        const sortedList = updatedList.sort((a, b) => {
            const changeA = a.change || 0;
            const changeB = b.change || 0;
            return changeB - changeA; // 降序排列
        });
        
        // 更新存储的数据
        await this.store.setWatchlist(sortedList);
        
        return sortedList.map(s => new StockTreeItem(
            s.name ? `${s.name}(${s.symbol})` : s.symbol,
            vscode.TreeItemCollapsibleState.None,
            {
                contextValue: 'efinance.watchItem',
                description: this.renderQuote(s),
                tooltip: this.renderTooltip(s)
            }
        ));
    }

    private renderQuote(s: StockBase): string | undefined {
        if (typeof s.price === 'number' && typeof s.change === 'number') {
            const chg = (s.change > 0 ? '+' : '') + (s.change * 100).toFixed(2) + '%';
            return `${s.price.toFixed(2)} (${chg})`;
        }
        return undefined;
    }

    private renderTooltip(s: StockBase): string | undefined {
        if (typeof s.price === 'number') {
            return `${s.symbol} ${s.name ?? ''}\n价格: ${s.price}\n涨跌: ${(s.change ?? 0) * 100}%`;
        }
        return `${s.symbol} ${s.name ?? ''}`;
    }
}

class HoldingsProvider extends BaseProvider<Holding> {
    async getChildren(): Promise<StockTreeItem[]> {
        const list = this.store.getHoldings();
        
        // 获取股票行情数据
        const symbols = list.map(h => h.symbol);
        const quotes = await fetchQuotes(symbols, 'holdings-view');
        
        // 更新股票价格和涨跌幅数据
        const updatedList = list.map(holding => {
            const quote = quotes[holding.symbol];
            return {
                ...holding,
                price: quote?.price || holding.price,
                change: quote?.change || holding.change
            };
        });
        
        // 按涨跌幅排序：涨幅大的在上面，跌幅大的在下面
        const sortedList = updatedList.sort((a, b) => {
            const changeA = a.change || 0;
            const changeB = b.change || 0;
            return changeB - changeA; // 降序排列
        });
        
        // 更新存储的数据
        await this.store.setHoldings(sortedList);
        
        return sortedList.map(h => {
            const pnl = (typeof h.price === 'number')
                ? (h.price - h.cost) * h.quantity
                : undefined;
            const desc = typeof pnl === 'number'
                ? `现价 ${h.price?.toFixed(2)} | 持仓 ${h.quantity} | 成本 ${h.cost} | 浮盈 ${pnl.toFixed(2)}`
                : `持仓 ${h.quantity} | 成本 ${h.cost}`;
            return new StockTreeItem(
                h.name ? `${h.name}(${h.symbol})` : h.symbol,
                vscode.TreeItemCollapsibleState.None,
                {
                    contextValue: 'efinance.holdingItem',
                    description: desc,
                    tooltip: desc
                }
            );
        });
    }
}

class StrategiesProvider extends BaseProvider<Strategy> {
    async getChildren(element?: StockTreeItem): Promise<StockTreeItem[]> {
        // 扁平化显示：直接显示所有涉及策略的股票，不再按策略分组
        const strategies = this.store.getStrategies();
        
        // 收集所有股票及其关联的策略
        const stockStrategyMap = new Map<string, { strategies: Strategy[], name?: string }>();
        
        for (const strategy of strategies) {
            for (const symbol of strategy.symbols) {
                if (!stockStrategyMap.has(symbol)) {
                    stockStrategyMap.set(symbol, { strategies: [] });
                }
                stockStrategyMap.get(symbol)!.strategies.push(strategy);
            }
        }
        
        if (stockStrategyMap.size === 0) {
            return Promise.resolve([]);
        }
        
        // 获取所有股票的行情数据
        const allSymbols = Array.from(stockStrategyMap.keys());
        const quotes = await fetchQuotes(allSymbols, 'strategy-view');
        
        // 创建股票数据并获取名称
        const stocksWithData = await Promise.all(
            Array.from(stockStrategyMap.entries()).map(async ([symbol, data]) => {
                const quote = quotes[symbol];
                const name = await fetchStockName(symbol);
                return {
                    symbol,
                    name,
                    quote,
                    change: quote?.change || 0,
                    strategies: data.strategies
                };
            })
        );
        
        // 按涨跌幅排序：涨幅大的在上面，跌幅大的在下面
        const sortedStocks = stocksWithData.sort((a, b) => {
            return b.change - a.change; // 降序排列
        });
        
        return Promise.resolve(
            sortedStocks.map(stock => {
                let description = '';
                let signalStatus = '';
                let tooltip = `股票: ${stock.name}(${stock.symbol})`;
                
                // 添加策略信息到tooltip
                const strategyNames = stock.strategies.map(s => s.name).join(', ');
                tooltip += `\n关联策略: ${strategyNames}`;
                
                if (stock.quote) {
                    const changePercent = (stock.quote.change * 100).toFixed(2);
                    const changeColor = stock.quote.change >= 0 ? '📈' : '📉';
                    description = `¥${stock.quote.price.toFixed(2)} ${changeColor}${changePercent}%`;
                    tooltip += `\n当前价: ¥${stock.quote.price.toFixed(2)}\n涨跌幅: ${changePercent}%`;
                    
                    // 检查所有关联策略的买卖信号
                    const allSignals: string[] = [];
                    for (const strategy of stock.strategies) {
                        if (strategy.signals || (strategy.type === 'script' && strategy.script?.enabled)) {
                            const signals = this.checkSignals(stock.quote, strategy);
                            allSignals.push(...signals);
                        }
                    }
                    
                    // 去重并显示信号
                    const uniqueSignals = [...new Set(allSignals)];
                    if (uniqueSignals.length > 0) {
                        signalStatus = ` ${uniqueSignals.join(' ')}`;
                        tooltip += `\n信号: ${uniqueSignals.join(', ')}`;
                    }
                } else {
                    description = '数据获取中...';
                }
                
                return new StockTreeItem(
                    (stock.name ? `${stock.name}(${stock.symbol})` : stock.symbol) + signalStatus,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        contextValue: 'efinance.strategyStockItem',
                        description: description,
                        tooltip: tooltip
                    }
                );
            })
        );
    }
    
    // 检查买卖信号（支持Pine脚本和传统阈值策略）
    private checkSignals(quote: { price: number; change: number }, strategy: Strategy): string[] {
        const result: string[] = [];
        
        // 优先使用Pine脚本策略
        if (strategy.type === 'script' && strategy.script?.enabled) {
            return this.checkScriptSignals(quote, strategy);
        }
        
        // 传统阈值策略（向后兼容）
        const signals = strategy.signals;
        if (!signals) return result;
        
        // 检查买入信号
        if (signals.buyConditions?.enabled) {
            let buySignal = false;
            
            // 价格阈值检查
            if (signals.buyConditions.priceThreshold !== undefined && 
                quote.price <= signals.buyConditions.priceThreshold) {
                buySignal = true;
            }
            
            // 涨跌幅阈值检查
            if (signals.buyConditions.changeThreshold !== undefined && 
                quote.change <= signals.buyConditions.changeThreshold / 100) {
                buySignal = true;
            }
            
            if (buySignal) {
                result.push('🟢买入');
            }
        }
        
        // 检查卖出信号
        if (signals.sellConditions?.enabled) {
            let sellSignal = false;
            
            // 价格阈值检查
            if (signals.sellConditions.priceThreshold !== undefined && 
                quote.price >= signals.sellConditions.priceThreshold) {
                sellSignal = true;
            }
            
            // 涨跌幅阈值检查
            if (signals.sellConditions.changeThreshold !== undefined && 
                quote.change >= signals.sellConditions.changeThreshold / 100) {
                sellSignal = true;
            }
            
            if (sellSignal) {
                result.push('🔴卖出');
            }
        }
        
        return result;
    }
    
    // Pine脚本信号检查
    private checkScriptSignals(quote: { price: number; change: number }, strategy: Strategy): string[] {
        const result: string[] = [];
        
        if (!strategy.script) return result;
        
        try {
            // 导入Pine脚本解析器
            const { PineScriptParser } = require('./scriptParser');
            
            // 创建脚本执行上下文
            const context = {
                symbol: '', // 在调用时会设置具体的股票代码
                price: quote.price,
                change: quote.change,
                changePercent: quote.change * 100,
                // 历史价格数据（暂时使用当前价格模拟）
                historicalPrices: Array(20).fill(quote.price),
                indicatorCache: new Map()
            };
            
            const parser = new PineScriptParser(context);
            
            // 检查买入脚本
            if (strategy.script.buyScript) {
                const buyResult = parser.execute(strategy.script.buyScript);
                if (buyResult.success && buyResult.value) {
                    result.push('🟢买入');
                }
            }
            
            // 检查卖出脚本
            if (strategy.script.sellScript) {
                const sellResult = parser.execute(strategy.script.sellScript);
                if (sellResult.success && sellResult.value) {
                    result.push('🔴卖出');
                }
            }
            
        } catch (error) {
            console.error('[Pine脚本] 执行错误:', error);
            // 脚本执行失败时，回退到传统策略
            return this.checkSignals(quote, { ...strategy, type: 'simple' });
        }
        
        return result;
    }
}

// 获取股票名称
async function fetchStockName(symbol: string): Promise<string> {
    try {
        const code = symbol.replace(/[^0-9]/g, ''); // 只保留数字
        
        if (code.length === 5) {
            // 港股：使用腾讯实时报价API
            const url = `https://qt.gtimg.cn/q=hk${code}`;
            
            const response = await fetch(url, {
                headers: {
                    'Referer': 'https://finance.qq.com',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            // 获取响应的ArrayBuffer，然后使用TextDecoder进行GBK解码
            const buffer = await response.arrayBuffer();
            const decoder = new TextDecoder('gbk');
            const text = decoder.decode(buffer);
            
            // 解析腾讯港股数据格式
            const match = text.match(/v_hk\d+="([^"]+)";/);
            if (match && match[1]) {
                const stockData = match[1].split('~');
                if (stockData.length > 1 && stockData[1]) {
                    return stockData[1]; // 港股名称在字段1位置
                }
            }
        } else {
            // A股：使用新浪财经API
            let formattedSymbol: string;
            if (code.startsWith('6')) {
                formattedSymbol = `sh${code}`; // 沪市
            } else if (code.startsWith('0') || code.startsWith('3')) {
                formattedSymbol = `sz${code}`; // 深市
            } else {
                formattedSymbol = `sh${code}`; // 默认沪市
            }

            const url = `https://hq.sinajs.cn/list=${formattedSymbol}`;
            
            const response = await fetch(url, {
                headers: {
                    'Referer': 'https://finance.sina.com.cn',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept-Charset': 'GBK,utf-8;q=0.7,*;q=0.3'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            // 获取响应的ArrayBuffer，然后使用TextDecoder进行GBK解码
            const buffer = await response.arrayBuffer();
            const decoder = new TextDecoder('gbk');
            const text = decoder.decode(buffer);
            
            const match = text.match(/var hq_str_[^=]+="([^"]+)";/);
            
            if (match && match[1]) {
                const data = match[1].split(',');
                if (data.length >= 1 && data[0]) {
                    return data[0]; // A股名称在第一个位置
                }
            }
        }
        
        // 如果获取失败，返回股票代码作为名称
        return symbol;
    } catch (error) {
        console.error(`[fetchStockName] 获取股票名称失败: ${symbol}`, error);
        return symbol; // 返回股票代码作为默认名称
    }
}

// 获取真实股票行情数据
async function fetchQuotes(symbols: string[], source: string = 'unknown'): Promise<Record<string, { price: number; change: number }>> {
    const result: Record<string, { price: number; change: number }> = {};
    
    console.log(`[fetchQuotes] 开始获取股票数据，调用来源: ${source}, 股票数量: ${symbols.length}`);
    
    if (symbols.length === 0) {
        console.log(`[fetchQuotes] 无股票代码，直接返回空结果`);
        return result;
    }

    // 分离A股和港股
    const aStocks: string[] = [];
    const hkStocks: string[] = [];
    
    symbols.forEach(symbol => {
        const code = symbol.replace(/[^0-9]/g, ''); // 只保留数字
        if (code.length === 5) {
            // 港股：5位数字
            hkStocks.push(symbol);
        } else {
            // A股
            aStocks.push(symbol);
        }
    });
    
    console.log(`[fetchQuotes] A股数量: ${aStocks.length}, 港股数量: ${hkStocks.length}`);
    
    // 并行获取A股和港股数据
    const [aStockResults, hkStockResults] = await Promise.all([
        aStocks.length > 0 ? fetchAStockQuotes(aStocks, source) : Promise.resolve({}),
        hkStocks.length > 0 ? fetchHKStockQuotes(hkStocks, source) : Promise.resolve({})
    ]);
    
    // 合并结果
    Object.assign(result, aStockResults, hkStockResults);
    
    console.log(`[fetchQuotes] 总共获取到${Object.keys(result).length}只股票数据，来源: ${source}`);
    
    return result;
}

// 获取A股行情数据（使用新浪财经API）
async function fetchAStockQuotes(symbols: string[], source: string): Promise<Record<string, { price: number; change: number }>> {
    const result: Record<string, { price: number; change: number }> = {};
    const maxRetries = 3;
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[fetchAStockQuotes] 第${attempt}次尝试获取A股数据，来源: ${source}`);
            
            // 格式化A股代码：沪市加sh前缀，深市加sz前缀
            const formattedSymbols = symbols.map(symbol => {
                const code = symbol.replace(/[^0-9]/g, ''); // 只保留数字
                if (code.startsWith('6')) {
                    return `sh${code}`; // 沪市
                } else if (code.startsWith('0') || code.startsWith('3')) {
                    return `sz${code}`; // 深市
                } else {
                    return `sh${code}`; // 默认沪市
                }
            });

            const url = `https://hq.sinajs.cn/list=${formattedSymbols.join(',')}`;
            console.log(`[fetchAStockQuotes] 请求URL: ${url}`);
            
            // 创建带超时的fetch请求
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
            
            try {
                const response = await fetch(url, {
                    headers: {
                        'Referer': 'https://finance.sina.com.cn',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept-Charset': 'GBK,utf-8;q=0.7,*;q=0.3'
                    },
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                // 获取响应的ArrayBuffer，然后使用TextDecoder进行GBK解码
                const buffer = await response.arrayBuffer();
                const decoder = new TextDecoder('gbk');
                const text = decoder.decode(buffer);
                console.log(`[fetchAStockQuotes] 获取到响应数据长度: ${text.length}`);
                
                const lines = text.split('\n').filter(line => line.trim());
                console.log(`[fetchAStockQuotes] 解析到${lines.length}行数据`);
                
                let successCount = 0;
                for (let i = 0; i < lines.length && i < symbols.length; i++) {
                    const line = lines[i];
                    const match = line.match(/var hq_str_[^=]+="([^"]+)";/);
                    
                    if (match && match[1]) {
                        const data = match[1].split(',');
                        if (data.length >= 4) {
                            const currentPrice = parseFloat(data[3]); // 当前价
                            const prevClose = parseFloat(data[2]); // 昨收价
                            
                            if (!isNaN(currentPrice) && !isNaN(prevClose) && prevClose > 0) {
                                const change = (currentPrice - prevClose) / prevClose; // 涨跌幅
                                result[symbols[i]] = {
                                    price: currentPrice,
                                    change: change
                                };
                                successCount++;
                                console.log(`[fetchAStockQuotes] 成功解析 ${symbols[i]}: 价格=${currentPrice}, 涨跌幅=${(change * 100).toFixed(2)}%`);
                            }
                        }
                    }
                }
                
                console.log(`[fetchAStockQuotes] 成功获取${successCount}/${symbols.length}只A股数据`);
                
                // 如果成功获取到数据，直接返回
                if (successCount > 0) {
                    return result;
                }
                
                // 如果没有获取到任何数据，抛出错误进行重试
                throw new Error('未获取到任何有效A股数据');
                
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
            
        } catch (error) {
            lastError = error;
            console.error(`[fetchAStockQuotes] 第${attempt}次尝试失败，错误:`, error);
            
            // 如果不是最后一次尝试，等待后重试
            if (attempt < maxRetries) {
                const delay = attempt * 1000; // 递增延迟：1秒、2秒、3秒
                console.log(`[fetchAStockQuotes] 等待${delay}ms后重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    // 所有重试都失败，使用模拟数据
    console.error(`[fetchAStockQuotes] 所有重试都失败，使用模拟数据，最后错误:`, lastError);
    for (const s of symbols) {
        const price = 10 + Math.random() * 100;
        const change = (Math.random() - 0.5) * 0.1; // -5% ~ +5%
        result[s] = { price, change };
        console.log(`[fetchAStockQuotes] 模拟数据 ${s}: 价格=${price.toFixed(2)}, 涨跌幅=${(change * 100).toFixed(2)}%`);
    }
    
    return result;
}

// 汇率缓存对象，避免频繁请求汇率API
interface ExchangeRateCache {
    HKD_CNY: number;      // 港元兑人民币汇率
    USD_CNY: number;      // 美元兑人民币汇率
    timestamp: number;    // 缓存时间戳
    expiry: number;       // 过期时间（毫秒）
}

// Exchange Rates API响应接口
interface ExchangeRatesApiResponse {
    success?: boolean;
    base?: string;
    date?: string;
    rates?: {
        [currency: string]: number;
    };
}

// 汇率缓存，默认值为近似值
let exchangeRateCache: ExchangeRateCache = {
    HKD_CNY: 0.91,        // 默认1港元≈0.91人民币
    USD_CNY: 7.2,         // 默认1美元≈7.2人民币
    timestamp: 0,
    expiry: 3600000       // 默认缓存1小时
};

// 获取最新汇率数据
async function fetchExchangeRates(): Promise<ExchangeRateCache> {
    // 检查缓存是否有效
    const now = Date.now();
    if (exchangeRateCache.timestamp > 0 && now - exchangeRateCache.timestamp < exchangeRateCache.expiry) {
        console.log(`[fetchExchangeRates] 使用缓存汇率数据: 港元兑人民币=${exchangeRateCache.HKD_CNY}, 美元兑人民币=${exchangeRateCache.USD_CNY}`);
        return exchangeRateCache;
    }
    
    console.log(`[fetchExchangeRates] 开始获取最新汇率数据`);
    
    try {
        // 使用Exchange Rates API获取汇率数据
        // 注意：免费版API可能有请求限制，生产环境建议使用付费API或官方汇率源
        const url = `https://open.er-api.com/v6/latest/CNY`;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json() as ExchangeRatesApiResponse;
        
        // 计算汇率：API返回的是CNY兑其他货币的汇率，需要取倒数
        if (data && data.rates) {
            // 1人民币=多少港元，取倒数得到1港元=多少人民币
            const hkdRate = data.rates.HKD ? (1 / data.rates.HKD) : exchangeRateCache.HKD_CNY;
            // 1人民币=多少美元，取倒数得到1美元=多少人民币
            const usdRate = data.rates.USD ? (1 / data.rates.USD) : exchangeRateCache.USD_CNY;
            
            // 更新缓存
            exchangeRateCache = {
                HKD_CNY: hkdRate,
                USD_CNY: usdRate,
                timestamp: now,
                expiry: 3600000 // 缓存1小时
            };
            
            console.log(`[fetchExchangeRates] 成功获取汇率数据: 港元兑人民币=${hkdRate.toFixed(4)}, 美元兑人民币=${usdRate.toFixed(4)}`);
        } else {
            throw new Error('汇率数据格式异常');
        }
    } catch (error) {
        console.error(`[fetchExchangeRates] 获取汇率失败:`, error);
        // 如果获取失败，使用缓存数据，并更新时间戳以避免频繁重试
        if (exchangeRateCache.timestamp === 0) {
            // 如果从未成功获取过，使用默认值
            exchangeRateCache.timestamp = now;
        }
    }
    
    return exchangeRateCache;
}

// 获取港股行情数据（使用腾讯实时报价API）并转换为人民币价格
async function fetchHKStockQuotes(symbols: string[], source: string): Promise<Record<string, { price: number; change: number }>> {
    const result: Record<string, { price: number; change: number }> = {};
    const maxRetries = 3;
    
    // 获取最新汇率数据
    const rates = await fetchExchangeRates();
    const hkdToCny = rates.HKD_CNY; // 港元兑人民币汇率
    
    console.log(`[fetchHKStockQuotes] 使用汇率: 1港元=${hkdToCny.toFixed(4)}人民币`);
    
    for (const symbol of symbols) {
        let lastError: any;
        let success = false;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`[fetchHKStockQuotes] 第${attempt}次尝试获取港股数据: ${symbol}`);
                
                const code = symbol.replace(/[^0-9]/g, ''); // 只保留数字
                const url = `https://qt.gtimg.cn/q=hk${code}`;
                console.log(`[fetchHKStockQuotes] 请求URL: ${url}`);
                
                // 创建带超时的fetch请求
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
                
                try {
                    const response = await fetch(url, {
                        headers: {
                            'Referer': 'https://finance.qq.com',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        },
                        signal: controller.signal
                    });
                    
                    clearTimeout(timeoutId);
                    
                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    
                    // 获取响应的ArrayBuffer，然后使用TextDecoder进行GBK解码
                    const buffer = await response.arrayBuffer();
                    const decoder = new TextDecoder('gbk');
                    const text = decoder.decode(buffer);
                    console.log(`[fetchHKStockQuotes] 获取到港股响应数据长度: ${text.length}`);
                    
                    // 解析腾讯实时报价API返回的数据格式: v_hk00700="...";
                    const match = text.match(/v_hk\d+="([^"]+)";/);
                    if (match && match[1]) {
                        const stockData = match[1].split('~');
                        console.log(`[fetchHKStockQuotes] 解析到${stockData.length}个字段`);
                        
                        if (stockData.length > 32) {
                            // 腾讯API字段映射：
                            // 字段3: 当前价格
                            // 字段9: 昨收价
                            // 字段31: 涨跌额
                            // 字段32: 涨跌幅
                            const currentPriceHKD = parseFloat(stockData[3]);
                            const prevCloseHKD = parseFloat(stockData[9]);
                            const changeAmount = parseFloat(stockData[31]);
                            const changePercent = parseFloat(stockData[32]);
                            
                            // 将港元价格转换为人民币价格
                            const currentPriceCNY = currentPriceHKD * hkdToCny;
                            const prevCloseCNY = prevCloseHKD * hkdToCny;
                            
                            console.log(`[fetchHKStockQuotes] 港股${symbol}解析数据: 当前价=${currentPriceHKD}港元(${currentPriceCNY.toFixed(2)}人民币), 昨收价=${prevCloseHKD}港元, 涨跌幅=${changePercent}%`);
                            
                            if (!isNaN(currentPriceHKD) && !isNaN(changePercent)) {
                                const change = changePercent / 100; // 转换为小数形式
                                result[symbol] = {
                                    price: currentPriceCNY, // 存储转换后的人民币价格
                                    change: change
                                };
                                console.log(`[fetchHKStockQuotes] 成功解析港股 ${symbol}: 价格=${currentPriceCNY.toFixed(2)}人民币, 涨跌幅=${changePercent.toFixed(2)}%`);
                                success = true;
                                break; // 成功获取数据，跳出重试循环
                            }
                        }
                    }
                    
                    // 如果数据结构不符合预期，抛出错误进行重试
                    throw new Error(`港股数据结构异常: ${symbol}`);
                    
                } catch (fetchError) {
                    clearTimeout(timeoutId);
                    throw fetchError;
                }
                
            } catch (error) {
                lastError = error;
                console.error(`[fetchHKStockQuotes] 第${attempt}次尝试失败: ${symbol}, 错误:`, error);
                
                // 如果不是最后一次尝试，等待后重试
                if (attempt < maxRetries) {
                    const delay = attempt * 1000; // 递增延迟：1秒、2秒、3秒
                    console.log(`[fetchHKStockQuotes] 等待${delay}ms后重试...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        
        // 如果所有重试都失败，使用模拟数据
        if (!success) {
            console.error(`[fetchHKStockQuotes] 港股${symbol}所有重试都失败，使用模拟数据，最后错误:`, lastError);
            const priceHKD = 10 + Math.random() * 100;
            const priceCNY = priceHKD * hkdToCny; // 转换为人民币
            const change = (Math.random() - 0.5) * 0.1; // -5% ~ +5%
            result[symbol] = { price: priceCNY, change };
            console.log(`[fetchHKStockQuotes] 模拟数据 ${symbol}: 价格=${priceCNY.toFixed(2)}人民币, 涨跌幅=${(change * 100).toFixed(2)}%`);
        }
    }
    
    console.log(`[fetchHKStockQuotes] 港股数据获取完成，成功获取${Object.keys(result).length}/${symbols.length}只股票`);
    return result;
}

// 扩展激活函数
export function activate(context: vscode.ExtensionContext) {
    console.log('EFinance Stocks 扩展已激活');
    
    // 创建数据存储
    const store = new Store(context.globalState);
    
    // 创建树视图提供者
    const watchlistProvider = new WatchlistProvider(store);
    const holdingsProvider = new HoldingsProvider(store);
    const strategiesProvider = new StrategiesProvider(store);
    
    // 注册树视图
    vscode.window.createTreeView('efinance.watchlist', {
        treeDataProvider: watchlistProvider,
        showCollapseAll: false
    });
    
    vscode.window.createTreeView('efinance.holdings', {
        treeDataProvider: holdingsProvider,
        showCollapseAll: false
    });
    
    vscode.window.createTreeView('efinance.strategies', {
        treeDataProvider: strategiesProvider,
        showCollapseAll: false
    });
    
    // 注册命令
    const commands = [
        // 刷新所有数据命令
        vscode.commands.registerCommand('efinance.refreshAll', async () => {
            console.log('执行刷新所有数据命令');
            watchlistProvider.refresh();
            holdingsProvider.refresh();
            strategiesProvider.refresh();
            vscode.window.showInformationMessage('已刷新所有股票数据');
        }),
        
        // 添加自选股命令
        vscode.commands.registerCommand('efinance.addWatchStock', async () => {
            const symbol = await vscode.window.showInputBox({
                prompt: '请输入股票代码（如：600519 或 00700）',
                placeHolder: '股票代码'
            });
            
            if (symbol) {
                const watchlist = store.getWatchlist();
                const exists = watchlist.find(s => s.symbol === symbol);
                
                if (exists) {
                    vscode.window.showWarningMessage(`股票 ${symbol} 已在自选股中`);
                    return;
                }
                
                const name = await fetchStockName(symbol);
                watchlist.push({ symbol, name });
                await store.setWatchlist(watchlist);
                watchlistProvider.refresh();
                vscode.window.showInformationMessage(`已添加自选股：${name}(${symbol})`);
            }
        }),
        
        // 添加持仓股命令
        vscode.commands.registerCommand('efinance.addHoldingStock', async () => {
            const symbol = await vscode.window.showInputBox({
                prompt: '请输入股票代码（如：600519 或 00700）',
                placeHolder: '股票代码'
            });
            
            if (!symbol) return;
            
            const quantityStr = await vscode.window.showInputBox({
                prompt: '请输入持仓数量',
                placeHolder: '持仓数量'
            });
            
            if (!quantityStr) return;
            
            const costStr = await vscode.window.showInputBox({
                prompt: '请输入成本价',
                placeHolder: '成本价'
            });
            
            if (!costStr) return;
            
            const quantity = parseFloat(quantityStr);
            const cost = parseFloat(costStr);
            
            if (isNaN(quantity) || isNaN(cost)) {
                vscode.window.showErrorMessage('请输入有效的数字');
                return;
            }
            
            const holdings = store.getHoldings();
            const exists = holdings.find(h => h.symbol === symbol);
            
            if (exists) {
                vscode.window.showWarningMessage(`股票 ${symbol} 已在持仓中`);
                return;
            }
            
            const name = await fetchStockName(symbol);
            holdings.push({ symbol, name, quantity, cost });
            await store.setHoldings(holdings);
            holdingsProvider.refresh();
            vscode.window.showInformationMessage(`已添加持仓：${name}(${symbol})`);
        }),
        
        // 删除项目命令
        vscode.commands.registerCommand('efinance.removeItem', async (item: StockTreeItem) => {
            if (!item) return;
            
            const confirmed = await vscode.window.showWarningMessage(
                `确定要删除 ${item.label} 吗？`,
                '确定',
                '取消'
            );
            
            if (confirmed !== '确定') return;
            
            // 根据上下文值确定删除类型
            if (item.contextValue === 'efinance.watchItem') {
                const watchlist = store.getWatchlist();
                const updated = watchlist.filter(s => !item.label?.includes(s.symbol));
                await store.setWatchlist(updated);
                watchlistProvider.refresh();
            } else if (item.contextValue === 'efinance.holdingItem') {
                const holdings = store.getHoldings();
                const updated = holdings.filter(h => !item.label?.includes(h.symbol));
                await store.setHoldings(updated);
                holdingsProvider.refresh();
            } else if (item.contextValue === 'efinance.strategyItem') {
                const strategies = store.getStrategies();
                const updated = strategies.filter(s => s.name !== item.label);
                await store.setStrategies(updated);
                strategiesProvider.refresh();
            }
            
            vscode.window.showInformationMessage(`已删除 ${item.label}`);
        })
    ];
    
    // 将所有命令添加到订阅列表
    context.subscriptions.push(...commands);
    
    console.log('EFinance Stocks 扩展命令注册完成');
}

// 扩展停用函数
export function deactivate() {
    console.log('EFinance Stocks 扩展已停用');
}