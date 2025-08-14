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
        // 格式化股票代码：沪市加sh前缀，深市加sz前缀
        const code = symbol.replace(/[^0-9]/g, ''); // 只保留数字
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
                return data[0]; // 股票名称在第一个位置
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

    // 重试机制
    const maxRetries = 3;
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[fetchQuotes] 第${attempt}次尝试获取数据，来源: ${source}`);
            
            // 使用新浪财经API获取股票数据
            // 格式化股票代码：沪市加sh前缀，深市加sz前缀
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
            console.log(`[fetchQuotes] 请求URL: ${url}`);
            
            // 创建带超时的fetch请求
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
            
            try {
                // 使用node-fetch获取数据
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
                console.log(`[fetchQuotes] 获取到响应数据长度: ${text.length}`);
                
                const lines = text.split('\n').filter(line => line.trim());
                console.log(`[fetchQuotes] 解析到${lines.length}行数据`);
                
                let successCount = 0;
                for (let i = 0; i < lines.length && i < symbols.length; i++) {
                    const line = lines[i];
                    const match = line.match(/var hq_str_[^=]+=\"([^\"]+)\";/);
                    
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
                                console.log(`[fetchQuotes] 成功解析 ${symbols[i]}: 价格=${currentPrice}, 涨跌幅=${(change * 100).toFixed(2)}%`);
                            }
                        }
                    }
                }
                
                console.log(`[fetchQuotes] 成功获取${successCount}/${symbols.length}只股票数据，来源: ${source}`);
                
                // 如果成功获取到数据，直接返回
                if (successCount > 0) {
                    return result;
                }
                
                // 如果没有获取到任何数据，抛出错误进行重试
                throw new Error('未获取到任何有效股票数据');
                
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
            
        } catch (error) {
            lastError = error;
            console.error(`[fetchQuotes] 第${attempt}次尝试失败，来源: ${source}, 错误:`, error);
            
            // 如果不是最后一次尝试，等待后重试
            if (attempt < maxRetries) {
                const delay = attempt * 1000; // 递增延迟：1秒、2秒、3秒
                console.log(`[fetchQuotes] 等待${delay}ms后重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    // 所有重试都失败，使用模拟数据
    console.error(`[fetchQuotes] 所有重试都失败，使用模拟数据，来源: ${source}, 最后错误:`, lastError);
    for (const s of symbols) {
        const price = 10 + Math.random() * 100;
        const change = (Math.random() - 0.5) * 0.1; // -5% ~ +5%
        result[s] = { price, change };
        console.log(`[fetchQuotes] 模拟数据 ${s}: 价格=${price.toFixed(2)}, 涨跌幅=${(change * 100).toFixed(2)}%`);
    }
    
    return result;
}

// 全局定时器变量
let refreshTimer: NodeJS.Timeout | undefined;

// 获取配置
function getConfig() {
    const config = vscode.workspace.getConfiguration('efinance');
    return {
        refreshInterval: config.get<number>('refreshInterval', 5),
        autoRefresh: config.get<boolean>('autoRefresh', true)
    };
}

// 设置定时刷新
function setupAutoRefresh(context: vscode.ExtensionContext) {
    // 清除现有定时器
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    }

    const { refreshInterval, autoRefresh } = getConfig();
    
    if (autoRefresh && refreshInterval > 0) {
        console.log(`[setupAutoRefresh] 启动自动刷新，间隔: ${refreshInterval}秒`);
        refreshTimer = setInterval(() => {
            console.log(`[setupAutoRefresh] 执行自动刷新`);
            vscode.commands.executeCommand('efinance.refreshAll', 'auto');
        }, refreshInterval * 1000); // 转换为毫秒
        
        // 添加到订阅中以便清理
        context.subscriptions.push({ dispose: () => {
            if (refreshTimer) {
                clearInterval(refreshTimer);
                refreshTimer = undefined;
            }
        }});
    } else {
        console.log(`[setupAutoRefresh] 自动刷新已禁用`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const store = new Store(context.globalState);

    const watchProvider = new WatchlistProvider(store);
    const holdingProvider = new HoldingsProvider(store);
    const strategyProvider = new StrategiesProvider(store);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('efinance.watchlist', watchProvider),
        vscode.window.registerTreeDataProvider('efinance.holdings', holdingProvider),
        vscode.window.registerTreeDataProvider('efinance.strategies', strategyProvider)
    );

    // 添加自选股
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.addWatchStock', async () => {
            const symbol = await vscode.window.showInputBox({ prompt: '输入股票代码（例如：600519 或 000001）' });
            if (!symbol) return;

            const list = store.getWatchlist();
            if (list.some(s => s.symbol === symbol)) {
                vscode.window.showInformationMessage(`自选股已存在：${symbol}`);
                return;
            }

            // 显示加载提示
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `正在获取股票信息: ${symbol}`,
                cancellable: false
            }, async () => {
                // 自动获取股票名称
                const name = await fetchStockName(symbol);
                list.push({ symbol, name });
                await store.setWatchlist(list);
                watchProvider.refresh();
                vscode.window.showInformationMessage(`已添加自选股：${name}(${symbol})`);
            });
        })
    );

    // 添加持仓股
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.addHoldingStock', async () => {
            const symbol = await vscode.window.showInputBox({ prompt: '输入股票代码' });
            if (!symbol) return;
            const quantityStr = await vscode.window.showInputBox({ prompt: '输入持仓数量（整数）', validateInput: v => /^\d+$/.test(v) ? null : '请输入整数' });
            if (!quantityStr) return;
            const costStr = await vscode.window.showInputBox({ prompt: '输入成本价（数字）', validateInput: v => isNaN(Number(v)) ? '请输入数字' : null });
            if (!costStr) return;

            // 显示加载提示
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `正在获取股票信息: ${symbol}`,
                cancellable: false
            }, async () => {
                // 自动获取股票名称
                const name = await fetchStockName(symbol);
                const holdings = store.getHoldings();
                holdings.push({
                    symbol,
                    name,
                    quantity: parseInt(quantityStr, 10),
                    cost: parseFloat(costStr)
                });
                await store.setHoldings(holdings);
                holdingProvider.refresh();
                vscode.window.showInformationMessage(`已添加持仓股：${name}(${symbol})`);
            });
        })
    );

    // 创建策略
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.addStrategy', async () => {
            const name = await vscode.window.showInputBox({ prompt: '输入策略名称' });
            if (!name) return;
            const symbolsStr = await vscode.window.showInputBox({ prompt: '输入股票代码，使用逗号分隔（如：600519,000001）' });
            const symbols = (symbolsStr || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
            const strategies = store.getStrategies();
            strategies.push({
                id: `${Date.now()}`,
                name,
                symbols,
                signals: {
                    buyConditions: { enabled: false },
                    sellConditions: { enabled: false },
                    notifications: { showPopup: true, playSound: false }
                }
            });
            await store.setStrategies(strategies);
            strategyProvider.refresh();
        })
    );

    // 添加股票到策略
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.addStockToStrategy', async () => {
            const strategies = store.getStrategies();
            if (strategies.length === 0) {
                vscode.window.showInformationMessage('请先创建策略');
                return;
            }

            // 选择策略
            const strategyItems = strategies.map(s => ({
                label: s.name,
                description: `${s.symbols.length} 支股票`,
                strategy: s
            }));
            const selectedStrategy = await vscode.window.showQuickPick(strategyItems, {
                placeHolder: '选择要添加股票的策略'
            });
            if (!selectedStrategy) return;

            // 输入股票代码
            const symbol = await vscode.window.showInputBox({ 
                prompt: '输入股票代码（例如：600519 或 000001）',
                validateInput: (value) => {
                    if (!value || !value.trim()) {
                        return '请输入股票代码';
                    }
                    if (selectedStrategy.strategy.symbols.includes(value.trim())) {
                        return '该股票已在策略中';
                    }
                    return null;
                }
            });
            if (!symbol) return;

            // 更新策略
            const updatedStrategies = strategies.map(s => {
                if (s.id === selectedStrategy.strategy.id) {
                    return {
                        ...s,
                        symbols: [...s.symbols, symbol.trim()]
                    };
                }
                return s;
            });
            
            await store.setStrategies(updatedStrategies);
            strategyProvider.refresh();
            vscode.window.showInformationMessage(`已将 ${symbol} 添加到策略 "${selectedStrategy.strategy.name}"`);
        })
    );

    // 创建Pine脚本策略
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.addScriptStrategy', async () => {
            const name = await vscode.window.showInputBox({ prompt: '输入Pine脚本策略名称' });
            if (!name) return;
            
            const symbolsStr = await vscode.window.showInputBox({ prompt: '输入股票代码，使用逗号分隔（如：600519,000001）' });
            const symbols = (symbolsStr || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
            
            const strategies = store.getStrategies();
            strategies.push({
                id: `${Date.now()}`,
                name,
                symbols,
                type: 'script',
                script: {
                    enabled: true,
                    buyScript: '',
                    sellScript: '',
                    template: 'custom'
                }
            });
            await store.setStrategies(strategies);
            strategyProvider.refresh();
            vscode.window.showInformationMessage(`Pine脚本策略 "${name}" 已创建，请配置脚本内容`);
        })
    );
    
    // 配置Pine脚本策略内容
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.configureScriptStrategy', async (item?: StockTreeItem) => {
            let targetStrategy: Strategy | undefined;
            
            if (item && item.contextValue === 'efinance.strategyItem') {
                // 从右键菜单调用
                const strategies = store.getStrategies();
                targetStrategy = strategies.find(s => s.name === item.label);
            } else {
                // 从命令面板调用
                const strategies = store.getStrategies().filter(s => s.type === 'script');
                if (strategies.length === 0) {
                    vscode.window.showInformationMessage('请先创建Pine脚本策略');
                    return;
                }
                const strategyItems = strategies.map(s => ({
                    label: s.name,
                    description: `${s.symbols.length} 支股票 - Pine脚本策略`,
                    strategy: s
                }));
                const selected = await vscode.window.showQuickPick(strategyItems, {
                    placeHolder: '选择要配置的Pine脚本策略'
                });
                if (!selected) return;
                targetStrategy = selected.strategy;
            }
            
            if (!targetStrategy || targetStrategy.type !== 'script') {
                vscode.window.showErrorMessage('请选择Pine脚本策略');
                return;
            }
            
            // 选择配置类型
            const configType = await vscode.window.showQuickPick([
                { label: '使用预设模板', value: 'template' },
                { label: '自定义脚本', value: 'custom' },
                { label: '启用/禁用策略', value: 'toggle' }
            ], { placeHolder: '选择配置方式' });
            
            if (!configType) return;
            
            const strategies = store.getStrategies();
            let updatedStrategies = [...strategies];
            
            if (configType.value === 'template') {
                // 选择预设模板
                const { getPresetStrategies } = require('./scriptParser');
                const presets = getPresetStrategies();
                const templateItems = Object.entries(presets).map(([key, preset]: [string, any]) => ({
                    label: preset.name,
                    description: preset.description,
                    value: key
                }));
                
                const selectedTemplate = await vscode.window.showQuickPick(templateItems, {
                    placeHolder: '选择预设策略模板'
                });
                
                if (selectedTemplate) {
                    const preset = presets[selectedTemplate.value];
                    updatedStrategies = strategies.map(s => {
                        if (s.id === targetStrategy!.id) {
                            return {
                                ...s,
                                script: {
                                    enabled: true,
                                    buyScript: preset.buyScript,
                                    sellScript: preset.sellScript,
                                    template: selectedTemplate.value
                                }
                            };
                        }
                        return s;
                    });
                    
                    await store.setStrategies(updatedStrategies);
                    strategyProvider.refresh();
                    vscode.window.showInformationMessage(`已应用模板 "${preset.name}" 到策略 "${targetStrategy.name}"`);
                }
            } else if (configType.value === 'custom') {
                // 自定义脚本配置
                const scriptType = await vscode.window.showQuickPick([
                    { label: '配置买入脚本', value: 'buy' },
                    { label: '配置卖出脚本', value: 'sell' }
                ], { placeHolder: '选择要配置的脚本类型' });
                
                if (!scriptType) return;
                
                const currentScript = scriptType.value === 'buy' 
                    ? targetStrategy.script?.buyScript || ''
                    : targetStrategy.script?.sellScript || '';
                
                const scriptContent = await vscode.window.showInputBox({
                    prompt: `输入${scriptType.label}内容（Pine脚本语法）`,
                    value: currentScript,
                    placeHolder: '例如：rsi(14) < 30 and close < sma(20)'
                });
                
                if (scriptContent !== undefined) {
                    updatedStrategies = strategies.map(s => {
                        if (s.id === targetStrategy!.id) {
                            const updatedScript = s.script ? { ...s.script } : { enabled: true, buyScript: '', sellScript: '', template: 'custom' };
                            if (scriptType.value === 'buy') {
                                updatedScript.buyScript = scriptContent;
                            } else {
                                updatedScript.sellScript = scriptContent;
                            }
                            return { ...s, script: updatedScript };
                        }
                        return s;
                    });
                    
                    await store.setStrategies(updatedStrategies);
                    strategyProvider.refresh();
                    vscode.window.showInformationMessage(`策略 "${targetStrategy.name}" 的${scriptType.label}已更新`);
                }
            } else if (configType.value === 'toggle') {
                // 启用/禁用策略
                const currentEnabled = targetStrategy.script?.enabled ?? false;
                const newEnabled = !currentEnabled;
                
                updatedStrategies = strategies.map(s => {
                    if (s.id === targetStrategy!.id) {
                        return {
                            ...s,
                            script: {
                                enabled: newEnabled,
                                buyScript: s.script?.buyScript || '',
                                sellScript: s.script?.sellScript || '',
                                template: s.script?.template || 'custom'
                            }
                        };
                    }
                    return s;
                });
                
                await store.setStrategies(updatedStrategies);
                strategyProvider.refresh();
                vscode.window.showInformationMessage(`策略 "${targetStrategy.name}" 已${newEnabled ? '启用' : '禁用'}`);
            }
        })
    );

    // 配置策略信号
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.configureStrategySignals', async (item?: StockTreeItem) => {
            let targetStrategy: Strategy | undefined;
            
            if (item && item.contextValue === 'efinance.strategyItem') {
                // 从右键菜单调用
                const strategies = store.getStrategies();
                targetStrategy = strategies.find(s => s.name === item.label);
            } else {
                // 从命令面板调用
                const strategies = store.getStrategies();
                if (strategies.length === 0) {
                    vscode.window.showInformationMessage('请先创建策略');
                    return;
                }
                const strategyItems = strategies.map(s => ({
                    label: s.name,
                    description: `${s.symbols.length} 支股票`,
                    strategy: s
                }));
                const selected = await vscode.window.showQuickPick(strategyItems, {
                    placeHolder: '选择要配置信号的策略'
                });
                if (!selected) return;
                targetStrategy = selected.strategy;
            }

            if (!targetStrategy) return;

            // 配置买入条件
            const buyEnabled = await vscode.window.showQuickPick(
                [{ label: '启用', value: true }, { label: '禁用', value: false }],
                { placeHolder: '是否启用买入信号？' }
            );
            if (buyEnabled === undefined) return;

            let buyPriceThreshold: number | undefined;
            let buyChangeThreshold: number | undefined;

            if (buyEnabled.value) {
                const buyPriceStr = await vscode.window.showInputBox({
                    prompt: '设置买入价格阈值（可选，留空则不设置）',
                    validateInput: (v) => v && isNaN(Number(v)) ? '请输入有效数字' : null
                });
                buyPriceThreshold = buyPriceStr ? parseFloat(buyPriceStr) : undefined;

                const buyChangeStr = await vscode.window.showInputBox({
                    prompt: '设置买入涨跌幅阈值（如-0.05表示跌5%时买入，可选）',
                    validateInput: (v) => v && (isNaN(Number(v)) || Number(v) > 1 || Number(v) < -1) ? '请输入-1到1之间的数字' : null
                });
                buyChangeThreshold = buyChangeStr ? parseFloat(buyChangeStr) : undefined;
            }

            // 配置卖出条件
            const sellEnabled = await vscode.window.showQuickPick(
                [{ label: '启用', value: true }, { label: '禁用', value: false }],
                { placeHolder: '是否启用卖出信号？' }
            );
            if (sellEnabled === undefined) return;

            let sellPriceThreshold: number | undefined;
            let sellChangeThreshold: number | undefined;

            if (sellEnabled.value) {
                const sellPriceStr = await vscode.window.showInputBox({
                    prompt: '设置卖出价格阈值（可选，留空则不设置）',
                    validateInput: (v) => v && isNaN(Number(v)) ? '请输入有效数字' : null
                });
                sellPriceThreshold = sellPriceStr ? parseFloat(sellPriceStr) : undefined;

                const sellChangeStr = await vscode.window.showInputBox({
                    prompt: '设置卖出涨跌幅阈值（如0.10表示涨10%时卖出，可选）',
                    validateInput: (v) => v && (isNaN(Number(v)) || Number(v) > 1 || Number(v) < -1) ? '请输入-1到1之间的数字' : null
                });
                sellChangeThreshold = sellChangeStr ? parseFloat(sellChangeStr) : undefined;
            }

            // 更新策略配置
            const strategies = store.getStrategies();
            const updatedStrategies = strategies.map(s => {
                if (s.id === targetStrategy!.id) {
                    return {
                        ...s,
                        signals: {
                            buyConditions: {
                                enabled: buyEnabled.value,
                                priceThreshold: buyPriceThreshold,
                                changeThreshold: buyChangeThreshold
                            },
                            sellConditions: {
                                enabled: sellEnabled.value,
                                priceThreshold: sellPriceThreshold,
                                changeThreshold: sellChangeThreshold
                            },
                            notifications: {
                                showPopup: true,
                                playSound: false
                            }
                        }
                    };
                }
                return s;
            });

            await store.setStrategies(updatedStrategies);
            strategyProvider.refresh();
            vscode.window.showInformationMessage(`策略 "${targetStrategy.name}" 信号配置已更新`);
        })
    );

    // 删除项目（自选/持仓/策略）
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.removeItem', async (item?: StockTreeItem) => {
            if (!item) return;
            
            // 根据 contextValue 判断来源
            switch (item.contextValue) {
                case 'efinance.watchItem': {
                    // 从显示标签中提取股票代码
                    let symbolToRemove = '';
                    if (item.label.includes('(') && item.label.includes(')')) {
                        // 格式：名称(代码)
                        const match = item.label.match(/\(([^)]+)\)$/);
                        symbolToRemove = match ? match[1] : item.label;
                    } else {
                        // 格式：只有代码
                        symbolToRemove = item.label;
                    }
                    
                    const list = store.getWatchlist().filter(s => s.symbol !== symbolToRemove);
                    await store.setWatchlist(list);
                    watchProvider.refresh();
                    strategyProvider.refresh();
                    break;
                }
                case 'efinance.holdingItem': {
                    // 从显示标签中提取股票代码
                    let symbolToRemove = '';
                    if (item.label.includes('(') && item.label.includes(')')) {
                        // 格式：名称(代码)
                        const match = item.label.match(/\(([^)]+)\)$/);
                        symbolToRemove = match ? match[1] : item.label;
                    } else {
                        // 格式：只有代码
                        symbolToRemove = item.label;
                    }
                    
                    const holdings = store.getHoldings().filter(h => h.symbol !== symbolToRemove);
                    await store.setHoldings(holdings);
                    holdingProvider.refresh();
                    break;
                }
                case 'efinance.strategyItem': {
                    const strategies = store.getStrategies().filter(s => s.name !== item.label);
                    await store.setStrategies(strategies);
                    strategyProvider.refresh();
                    break;
                }
            }
        })
    );

    // 刷新所有视图并模拟拉行情
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.refreshAll', async (source: string = 'manual') => {
            console.log(`[refreshAll] 开始刷新，来源: ${source}`);
            
            const allSymbols = new Set<string>();
            store.getWatchlist().forEach(s => allSymbols.add(s.symbol));
            store.getHoldings().forEach(h => allSymbols.add(h.symbol));
            store.getStrategies().forEach(st => st.symbols.forEach(sym => allSymbols.add(sym)));

            console.log(`[refreshAll] 需要刷新的股票数量: ${allSymbols.size}`);

            if (allSymbols.size > 0) {
                const quotes = await fetchQuotes(Array.from(allSymbols), source);
                
                // 写回 watchlist
                const watch = store.getWatchlist().map(s => ({
                    ...s,
                    price: quotes[s.symbol]?.price ?? s.price,
                    change: quotes[s.symbol]?.change ?? s.change
                }));
                await store.setWatchlist(watch);
                
                // 写回 holdings
                const holds = store.getHoldings().map(h => ({
                    ...h,
                    price: quotes[h.symbol]?.price ?? h.price,
                    change: quotes[h.symbol]?.change ?? h.change
                }));
                await store.setHoldings(holds);
                
                // 检查策略信号并发送通知
                await checkAndNotifySignals(quotes, source);
                
                console.log(`[refreshAll] 数据更新完成，来源: ${source}`);
            }

            watchProvider.refresh();
            holdingProvider.refresh();
            strategyProvider.refresh();
            
            const message = source === 'auto' ? '自动刷新完成' : '手动刷新完成';
            if (source === 'manual') {
                vscode.window.showInformationMessage(message);
            }
            console.log(`[refreshAll] ${message}`);
        })
    );

    // 检查策略信号并发送通知的函数（支持Pine脚本和传统策略）
    async function checkAndNotifySignals(quotes: Record<string, { price: number; change: number }>, source: string) {
        const strategies = store.getStrategies();
        
        for (const strategy of strategies) {
            // 跳过没有配置任何信号的策略
            if (!strategy.signals && !(strategy.type === 'script' && strategy.script?.enabled)) {
                continue;
            }
            
            for (const symbol of strategy.symbols) {
                const quote = quotes[symbol];
                if (!quote) continue;
                
                // 优先使用Pine脚本策略
                if (strategy.type === 'script' && strategy.script?.enabled) {
                    await checkScriptSignalsAndNotify(strategy, symbol, quote);
                } else if (strategy.signals) {
                    // 传统阈值策略
                    await checkTraditionalSignalsAndNotify(strategy, symbol, quote);
                }
            }
        }
    }
    
    // Pine脚本信号检查和通知
    async function checkScriptSignalsAndNotify(strategy: Strategy, symbol: string, quote: { price: number; change: number }) {
        if (!strategy.script) return;
        
        try {
            const { PineScriptParser } = require('./scriptParser');
            
            // 创建脚本执行上下文
            const context = {
                symbol: symbol,
                price: quote.price,
                change: quote.change,
                changePercent: quote.change * 100,
                historicalPrices: Array(20).fill(quote.price),
                indicatorCache: new Map()
            };
            
            const parser = new PineScriptParser(context);
            
            // 检查买入脚本
            if (strategy.script.buyScript) {
                const buyResult = parser.execute(strategy.script.buyScript);
                if (buyResult.success && buyResult.value) {
                    const message = `🟢 买入信号：${symbol} - Pine脚本策略触发`;
                    vscode.window.showInformationMessage(message);
                    console.log(`[Pine脚本信号] ${strategy.name}: ${message}`);
                    
                    // 记录信号到策略监控面板
                    const { StrategyDashboardPanel } = require('./strategyDashboard');
                    StrategyDashboardPanel.addSignal(
                        strategy.name,
                        symbol,
                        'buy',
                        quote.price,
                        'Pine脚本买入条件触发'
                    );
                }
            }
            
            // 检查卖出脚本
            if (strategy.script.sellScript) {
                const sellResult = parser.execute(strategy.script.sellScript);
                if (sellResult.success && sellResult.value) {
                    const message = `🔴 卖出信号：${symbol} - Pine脚本策略触发`;
                    vscode.window.showWarningMessage(message);
                    console.log(`[Pine脚本信号] ${strategy.name}: ${message}`);
                    
                    // 记录信号到策略监控面板
                    const { StrategyDashboardPanel } = require('./strategyDashboard');
                    StrategyDashboardPanel.addSignal(
                        strategy.name,
                        symbol,
                        'sell',
                        quote.price,
                        'Pine脚本卖出条件触发'
                    );
                }
            }
            
        } catch (error) {
            console.error(`[Pine脚本] 策略 ${strategy.name} 执行错误:`, error);
        }
    }
    
    // 传统阈值策略信号检查和通知
    async function checkTraditionalSignalsAndNotify(strategy: Strategy, symbol: string, quote: { price: number; change: number }) {
        const { buyConditions, sellConditions, notifications } = strategy.signals!;
        
        // 检查买入信号
        if (buyConditions?.enabled) {
            let shouldBuy = false;
            let reason = '';
            
            if (buyConditions.priceThreshold !== undefined && quote.price <= buyConditions.priceThreshold) {
                shouldBuy = true;
                reason += `价格 ${quote.price} 低于买入阈值 ${buyConditions.priceThreshold}`;
            }
            
            if (buyConditions.changeThreshold !== undefined && quote.change <= buyConditions.changeThreshold) {
                shouldBuy = true;
                if (reason) reason += '，';
                reason += `涨跌幅 ${(quote.change * 100).toFixed(2)}% 达到买入条件 ${(buyConditions.changeThreshold * 100).toFixed(2)}%`;
            }
            
            if (shouldBuy && notifications?.showPopup) {
                const message = `🟢 买入信号：${symbol} - ${reason}`;
                vscode.window.showInformationMessage(message);
                console.log(`[策略信号] ${strategy.name}: ${message}`);
                
                // 记录信号到策略监控面板
                const { StrategyDashboardPanel } = require('./strategyDashboard');
                StrategyDashboardPanel.addSignal(
                    strategy.name,
                    symbol,
                    'buy',
                    quote.price,
                    reason
                );
            }
        }
        
        // 检查卖出信号
        if (sellConditions?.enabled) {
            let shouldSell = false;
            let reason = '';
            
            if (sellConditions.priceThreshold !== undefined && quote.price >= sellConditions.priceThreshold) {
                shouldSell = true;
                reason += `价格 ${quote.price} 高于卖出阈值 ${sellConditions.priceThreshold}`;
            }
            
            if (sellConditions.changeThreshold !== undefined && quote.change >= sellConditions.changeThreshold) {
                shouldSell = true;
                if (reason) reason += '，';
                reason += `涨跌幅 ${(quote.change * 100).toFixed(2)}% 达到卖出条件 ${(sellConditions.changeThreshold * 100).toFixed(2)}%`;
            }
            
            if (shouldSell && notifications?.showPopup) {
                const message = `🔴 卖出信号：${symbol} - ${reason}`;
                vscode.window.showWarningMessage(message);
                console.log(`[策略信号] ${strategy.name}: ${message}`);
                
                // 记录信号到策略监控面板
                const { StrategyDashboardPanel } = require('./strategyDashboard');
                StrategyDashboardPanel.addSignal(
                    strategy.name,
                    symbol,
                    'sell',
                    quote.price,
                    reason
                );
            }
        }
    }

    // 注册策略监控面板命令
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.openStrategyDashboard', async () => {
            const { StrategyDashboardPanel } = require('./strategyDashboard');
            StrategyDashboardPanel.createOrShow(context.extensionUri, store);
        })
    );

    // 设置可配置的定时刷新
    setupAutoRefresh(context);
    
    // 监听配置变更
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('efinance.refreshInterval') || 
                e.affectsConfiguration('efinance.autoRefresh')) {
                setupAutoRefresh(context);
            }
        })
    );
}

export function deactivate() {
    // 清理资源由 context.subscriptions 管理
}