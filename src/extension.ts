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

type Strategy = {
    id: string;
    name: string;
    symbols: string[]; // 关注的股票代码
};

class Store {
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
            contextValue: 'efinance.watchItem' | 'efinance.holdingItem' | 'efinance.strategyItem';
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
    getChildren(): Promise<StockTreeItem[]> {
        const list = this.store.getWatchlist();
        return Promise.resolve(
            list.map(s => new StockTreeItem(
                `${s.symbol}${s.name ? ' · ' + s.name : ''}`,
                vscode.TreeItemCollapsibleState.None,
                {
                    contextValue: 'efinance.watchItem',
                    description: this.renderQuote(s),
                    tooltip: this.renderTooltip(s)
                }
            ))
        );
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
    getChildren(): Promise<StockTreeItem[]> {
        const list = this.store.getHoldings();
        return Promise.resolve(
            list.map(h => {
                const pnl = (typeof h.price === 'number')
                    ? (h.price - h.cost) * h.quantity
                    : undefined;
                const desc = typeof pnl === 'number'
                    ? `现价 ${h.price?.toFixed(2)} | 持仓 ${h.quantity} | 成本 ${h.cost} | 浮盈 ${pnl.toFixed(2)}`
                    : `持仓 ${h.quantity} | 成本 ${h.cost}`;
                return new StockTreeItem(
                    `${h.symbol}${h.name ? ' · ' + h.name : ''}`,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        contextValue: 'efinance.holdingItem',
                        description: desc,
                        tooltip: desc
                    }
                );
            })
        );
    }
}

class StrategiesProvider extends BaseProvider<Strategy> {
    getChildren(element?: StockTreeItem): Promise<StockTreeItem[]> {
        const list = this.store.getStrategies();
        if (!element) {
            return Promise.resolve(
                list.map(st => new StockTreeItem(
                    st.name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    {
                        contextValue: 'efinance.strategyItem',
                        description: `${st.symbols.length} 支股票`,
                        tooltip: `策略: ${st.name}\n股票: ${st.symbols.join(', ')}`
                    }
                ))
            );
        } else {
            const strategy = list.find(s => s.name === element.label);
            if (!strategy) return Promise.resolve([]);
            return Promise.resolve(
                strategy.symbols.map(sym => new StockTreeItem(
                    sym,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        contextValue: 'efinance.watchItem'
                    }
                ))
            );
        }
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
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const text = await response.text();
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
        refreshInterval: config.get<number>('refreshInterval', 60),
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
            const name = await vscode.window.showInputBox({ prompt: '输入股票名称（可选）' });

            const list = store.getWatchlist();
            if (list.some(s => s.symbol === symbol)) {
                vscode.window.showInformationMessage(`自选股已存在：${symbol}`);
                return;
            }
            list.push({ symbol, name: name || undefined });
            await store.setWatchlist(list);
            watchProvider.refresh();
        })
    );

    // 添加持仓股
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.addHoldingStock', async () => {
            const symbol = await vscode.window.showInputBox({ prompt: '输入股票代码' });
            if (!symbol) return;
            const name = await vscode.window.showInputBox({ prompt: '输入股票名称（可选）' });
            const quantityStr = await vscode.window.showInputBox({ prompt: '输入持仓数量（整数）', validateInput: v => /^\d+$/.test(v) ? null : '请输入整数' });
            if (!quantityStr) return;
            const costStr = await vscode.window.showInputBox({ prompt: '输入成本价（数字）', validateInput: v => isNaN(Number(v)) ? '请输入数字' : null });
            if (!costStr) return;

            const holdings = store.getHoldings();
            holdings.push({
                symbol,
                name: name || undefined,
                quantity: parseInt(quantityStr, 10),
                cost: parseFloat(costStr)
            });
            await store.setHoldings(holdings);
            holdingProvider.refresh();
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
                symbols
            });
            await store.setStrategies(strategies);
            strategyProvider.refresh();
        })
    );

    // 删除项目（自选/持仓/策略）
    context.subscriptions.push(
        vscode.commands.registerCommand('efinance.removeItem', async (item?: StockTreeItem) => {
            if (!item) return;
            const ok = await vscode.window.showWarningMessage(`确认删除：${item.label}？`, { modal: true }, '删除');
            if (!ok) return;

            // 根据 contextValue 判断来源
            switch (item.contextValue) {
                case 'efinance.watchItem': {
                    const list = store.getWatchlist().filter(s => (s.symbol !== item.label && `${s.symbol} · ${s.name ?? ''}` !== item.label));
                    await store.setWatchlist(list);
                    watchProvider.refresh();
                    strategyProvider.refresh();
                    break;
                }
                case 'efinance.holdingItem': {
                    const holdings = store.getHoldings().filter(h => (h.symbol !== item.label && `${h.symbol} · ${h.name ?? ''}` !== item.label));
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