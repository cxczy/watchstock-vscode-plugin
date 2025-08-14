import * as vscode from 'vscode';
import { Strategy, Store } from './extension';

/**
 * 策略监控面板数据接口
 */
export interface StrategyDashboardData {
    strategies: StrategyWithStats[];
    lastUpdate: string;
    totalSignals: number;
    activeStrategies: number;
}

/**
 * 带统计信息的策略接口
 */
export interface StrategyWithStats {
    id: string;
    name: string;
    type: string;
    stats: {
        totalSignals: number;       // 总信号数
        buySignals: number;         // 买入信号数
        sellSignals: number;        // 卖出信号数
        lastSignalTime?: number;    // 最后信号时间
        isActive: boolean;          // 是否活跃
    };
    stocks: StrategyStock[];        // 策略下的股票详情
    performance: StrategyPerformance;
}

/**
 * 策略股票详情接口
 */
export interface StrategyStock {
    symbol: string;
    name?: string;
    price?: number;
    change?: number;
    changePercent?: number;
    signals: string[];              // 当前信号状态
    lastUpdate?: string;
}

/**
 * 信号历史记录接口
 */
export interface SignalHistory {
    id: string;
    strategyId: string;
    strategyName: string;
    symbol: string;
    signalType: 'buy' | 'sell';
    price: number;
    timestamp: number;
    conditions: string;             // 触发条件描述
}

interface StrategyPerformance {
    strategyName: string;
    totalSignals: number;
    buySignals: number;
    sellSignals: number;
    avgSignalInterval: number; // 平均信号间隔（分钟）
    lastSignalTime: number;
    recentActivity: 'high' | 'medium' | 'low'; // 最近活跃度
}

/**
 * 策略监控面板类
 */
export class StrategyDashboardPanel {
    public static currentPanel: StrategyDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _store: Store;
    private _disposables: vscode.Disposable[] = [];
    private _signalHistory: SignalHistory[] = [];
    private _updateTimer: NodeJS.Timeout | undefined;
    private _lastUpdateTime: Date = new Date();

    public static createOrShow(store: Store) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // 如果面板已存在，则显示它
        if (StrategyDashboardPanel.currentPanel) {
            StrategyDashboardPanel.currentPanel._panel.reveal(column);
            return;
        }

        // 创建新面板
        const panel = vscode.window.createWebviewPanel(
            'strategyDashboard',
            '策略监控面板',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        StrategyDashboardPanel.currentPanel = new StrategyDashboardPanel(panel, store);
    }

    private constructor(panel: vscode.WebviewPanel, store: Store) {
        this._panel = panel;
        this._store = store;

        // 设置初始HTML内容
        this._update();

        // 监听面板关闭事件
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // 处理来自webview的消息
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'refresh':
                        await this._updateContent();
                        vscode.window.showInformationMessage('策略数据已刷新');
                        break;
                    case 'toggleStrategy':
                        await this._toggleStrategy(message.strategyId);
                        break;
                    case 'clearHistory':
                        this._clearSignalHistory();
                        await this._updateContent();
                        vscode.window.showInformationMessage('信号历史已清空');
                        break;
                }
            },
            null,
            this._disposables
        );

        // 启动自动更新定时器（每30秒更新一次）
        this._startAutoUpdate();
    }



    /**
     * 切换策略启用状态
     */
    private async _toggleStrategy(strategyId: string) {
        const strategies = this._store.getStrategies();
        const strategy = strategies.find((s: any) => s.name === strategyId);
        
        if (!strategy) {
            vscode.window.showErrorMessage(`未找到策略: ${strategyId}`);
            return;
        }
        
        // 切换策略状态
        if (strategy.type === 'script' && strategy.script) {
            strategy.script.enabled = !strategy.script.enabled;
            const status = strategy.script.enabled ? '启用' : '禁用';
            vscode.window.showInformationMessage(`Pine脚本策略 "${strategy.name}" 已${status}`);
        } else if (strategy.signals) {
            // 对于传统策略，切换买入和卖出条件的启用状态
            const currentlyEnabled = strategy.signals.buyConditions?.enabled || strategy.signals.sellConditions?.enabled;
            
            if (strategy.signals.buyConditions) {
                strategy.signals.buyConditions.enabled = !currentlyEnabled;
            }
            if (strategy.signals.sellConditions) {
                strategy.signals.sellConditions.enabled = !currentlyEnabled;
            }
            
            const status = !currentlyEnabled ? '启用' : '禁用';
            vscode.window.showInformationMessage(`传统策略 "${strategy.name}" 已${status}`);
        }
        
        // 保存更新后的策略
        await this._store.setStrategies(strategies);
        await this._updateContent();
        
        console.log(`策略 ${strategyId} 状态已切换`);
    }

    /**
     * 清空信号历史
     */
    private _clearSignalHistory() {
        this._signalHistory = [];
        this._update();
        vscode.window.showInformationMessage('信号历史已清空');
    }

    /**
     * 添加信号到历史记录
     */
    public addSignalToHistory(signal: SignalHistory): void {
        this._signalHistory.unshift(signal);
        
        // 保持最多100条记录
        if (this._signalHistory.length > 100) {
            this._signalHistory = this._signalHistory.slice(0, 100);
        }
        
        console.log(`[策略监控] 添加信号记录: ${signal.strategyName} - ${signal.symbol} - ${signal.signalType}`);
        
        // 如果面板打开，更新内容
        if (StrategyDashboardPanel.currentPanel) {
            this._updateContent();
        }
        
        // 启动自动更新机制
        this._startAutoUpdate();
    }
    
    /**
     * 启动自动更新机制
     */
    private _startAutoUpdate(): void {
        // 清理现有定时器
        if (this._updateTimer) {
            clearInterval(this._updateTimer);
        }
        
        // 每30秒更新一次数据
        this._updateTimer = setInterval(() => {
            this._updateContent();
            console.log('[策略监控] 自动更新面板数据');
        }, 30000);
        
        console.log('[策略监控] 启动自动更新机制，间隔30秒');
    }
    
    /**
     * 停止自动更新机制
     */
    private _stopAutoUpdate(): void {
        if (this._updateTimer) {
             clearInterval(this._updateTimer);
             this._updateTimer = undefined;
             console.log('[策略监控] 停止自动更新机制');
         }
     }
    
    /**
     * 静态方法：添加信号记录（供extension.ts调用）
     */
    public static addSignal(strategyName: string, symbol: string, signalType: 'buy' | 'sell', price: number, conditions: string): void {
        if (StrategyDashboardPanel.currentPanel) {
            const signal: SignalHistory = {
                id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                strategyId: strategyName,
                timestamp: Date.now(),
                strategyName,
                symbol,
                signalType,
                price,
                conditions
            };
            StrategyDashboardPanel.currentPanel.addSignalToHistory(signal);
        }
    }
    
    /**
     * 计算策略性能统计
     */
    private _calculateStrategyPerformance(): StrategyPerformance[] {
        const strategies = this._store.getStrategies();
        const performances: StrategyPerformance[] = [];
        
        for (const strategy of strategies) {
            const strategySignals = this._signalHistory.filter(s => s.strategyName === strategy.name);
            
            const totalSignals = strategySignals.length;
            const buySignals = strategySignals.filter(s => s.signalType === 'buy').length;
            const sellSignals = strategySignals.filter(s => s.signalType === 'sell').length;
            
            // 计算平均信号间隔（分钟）
            let avgSignalInterval = 0;
            if (strategySignals.length > 1) {
                const sortedSignals = strategySignals.sort((a, b) => a.timestamp - b.timestamp);
                let totalInterval = 0;
                for (let i = 1; i < sortedSignals.length; i++) {
                    totalInterval += sortedSignals[i].timestamp - sortedSignals[i - 1].timestamp;
                }
                avgSignalInterval = Math.round(totalInterval / (sortedSignals.length - 1) / 60000); // 转换为分钟
            }
            
            // 获取最后信号时间
            const lastSignalTime = strategySignals.length > 0 
                ? Math.max(...strategySignals.map(s => s.timestamp))
                : 0;
            
            // 计算最近活跃度（基于最近24小时的信号数量）
            const last24Hours = Date.now() - 24 * 60 * 60 * 1000;
            const recentSignals = strategySignals.filter(s => s.timestamp > last24Hours).length;
            let recentActivity: 'high' | 'medium' | 'low';
            if (recentSignals >= 10) {
                recentActivity = 'high';
            } else if (recentSignals >= 3) {
                recentActivity = 'medium';
            } else {
                recentActivity = 'low';
            }
            
            performances.push({
                strategyName: strategy.name,
                totalSignals,
                buySignals,
                sellSignals,
                avgSignalInterval,
                lastSignalTime,
                recentActivity
            });
        }
        
        return performances;
    }

    /**
     * 添加信号历史记录（保持向后兼容）
     */
    public addSignalHistory(signal: SignalHistory) {
        this.addSignalToHistory(signal);
    }

    /**
     * 更新内容（异步版本）
     */
    private async _updateContent(): Promise<void> {
        await this._update();
    }

    /**
     * 更新面板内容
     */
    private async _update() {
        const webview = this._panel.webview;
        this._panel.title = '策略监控面板';
        this._panel.webview.html = await this._getHtmlForWebview(webview);
    }

    /**
     * 获取WebView的HTML内容
     */
    private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        // 获取策略数据
        const dashboardData = await this._getDashboardData();
        
        // 生成HTML
        return this._generateHtml(webview, dashboardData);
    }

    /**
     * 获取面板数据
     */
    private async _getDashboardData(): Promise<StrategyDashboardData> {
        const rawStrategies = this._store.getStrategies();
        const watchlist = this._store.getWatchlist();
        const holdings = this._store.getHoldings();
        
        // 构建股票价格映射
        const stockPrices: Record<string, { price: number; change: number }> = {};
        [...watchlist, ...holdings].forEach(stock => {
            stockPrices[stock.symbol] = {
                price: stock.price || 0,
                change: stock.change || 0
            };
        });
        
        // 获取性能统计数据
        const performanceStats = this._calculateStrategyPerformance();
        
        // 转换策略数据
        const strategies: StrategyWithStats[] = rawStrategies.map((strategy: any) => {
            const strategySignals = this._signalHistory.filter(s => s.strategyName === strategy.name);
            const buySignals = strategySignals.filter(s => s.signalType === 'buy').length;
            const sellSignals = strategySignals.filter(s => s.signalType === 'sell').length;
            
            // 获取该策略的性能统计
            const performance = performanceStats.find(p => p.strategyName === strategy.name);
            
            // 判断策略是否活跃
            const isActive = strategy.type === 'script' 
                ? (strategy.script?.enabled || false)
                : (strategy.signals?.buyConditions?.enabled || strategy.signals?.sellConditions?.enabled || false);
            
            return {
                id: strategy.name, // 使用策略名称作为ID
                name: strategy.name,
                type: strategy.type,
                stocks: strategy.symbols.map((symbol: string) => {
                    const stockData = stockPrices[symbol];
                    const stockSignals = strategySignals
                        .filter(s => s.symbol === symbol)
                        .slice(0, 3) // 最近3个信号
                        .map(s => s.signalType === 'buy' ? '🟢' : '🔴');
                    
                    return {
                        symbol,
                        price: stockData?.price,
                        change: stockData?.change,
                        changePercent: stockData ? stockData.change * 100 : undefined,
                        signals: stockSignals
                    };
                }),
                stats: {
                    isActive,
                    totalSignals: strategySignals.length,
                    buySignals,
                    sellSignals,
                    lastSignalTime: strategySignals.length > 0 
                        ? Math.max(...strategySignals.map(s => s.timestamp))
                        : undefined
                },
                performance: performance || {
                    strategyName: strategy.name,
                    totalSignals: 0,
                    buySignals: 0,
                    sellSignals: 0,
                    avgSignalInterval: 0,
                    lastSignalTime: 0,
                    recentActivity: 'low' as const
                }
            };
        });
        
        return {
            strategies,
            lastUpdate: new Date().toLocaleString('zh-CN'),
            totalSignals: this._signalHistory.length,
            activeStrategies: strategies.filter(s => s.stats.isActive).length
        };
    }

    /**
     * 生成HTML内容
     */
    private _generateHtml(webview: vscode.Webview, data: StrategyDashboardData): string {
        const nonce = this._getNonce();
        
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>策略监控面板</title>
    <style>
        ${this._getStyles()}
    </style>
</head>
<body>
    <div class="dashboard-container">
        <header class="dashboard-header">
            <h1>📊 策略监控面板</h1>
            <div class="header-stats">
                <div class="stat-item">
                    <span class="stat-label">活跃策略</span>
                    <span class="stat-value">${data.activeStrategies}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">总信号数</span>
                    <span class="stat-value">${data.totalSignals}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">最后更新</span>
                    <span class="stat-value">${data.lastUpdate}</span>
                </div>
            </div>
            <div class="header-actions">
                <button class="btn btn-primary" onclick="refreshData()">🔄 刷新</button>
                <button class="btn btn-secondary" onclick="clearHistory()">🗑️ 清空历史</button>
            </div>
        </header>

        <main class="dashboard-main">
            <div class="strategies-section">
                <h2>策略列表</h2>
                <div class="strategies-grid" id="strategiesGrid">
                    ${this._generateStrategiesHtml(data.strategies)}
                </div>
            </div>

            <div class="signals-section">
                <h2>信号历史</h2>
                <div class="signals-list" id="signalsList">
                    ${this._generateSignalsHtml()}
                </div>
            </div>
        </main>
    </div>

    <script nonce="${nonce}">
        ${this._getScript()}
    </script>
</body>
</html>`;
    }

    /**
     * 生成策略HTML
     */
    private _generateStrategiesHtml(strategies: StrategyWithStats[]): string {
        if (strategies.length === 0) {
            return '<div class="empty-state">暂无策略数据</div>';
        }

        return strategies.map(strategy => `
            <div class="strategy-card ${strategy.stats.isActive ? 'active' : 'inactive'}">
                <div class="strategy-header">
                    <h3>${strategy.name}</h3>
                    <div class="strategy-toggle">
                        <label class="switch">
                            <input type="checkbox" ${strategy.stats.isActive ? 'checked' : ''} 
                                   onchange="toggleStrategy('${strategy.id}')">
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>
                <div class="strategy-stats">
                    <div class="stat">总信号: ${strategy.stats.totalSignals}</div>
                    <div class="stat">买入: ${strategy.stats.buySignals}</div>
                    <div class="stat">卖出: ${strategy.stats.sellSignals}</div>
                </div>
                <div class="strategy-performance">
                    <span class="perf-item activity-${strategy.performance.recentActivity}">
                        活跃度: ${strategy.performance.recentActivity === 'high' ? '高' : strategy.performance.recentActivity === 'medium' ? '中' : '低'}
                    </span>
                    ${strategy.performance.avgSignalInterval > 0 ? 
                        `<span class="perf-item">平均间隔: ${strategy.performance.avgSignalInterval}分钟</span>` : 
                        '<span class="perf-item">平均间隔: 暂无数据</span>'
                    }
                </div>
                <div class="strategy-stocks">
                    ${strategy.stocks.map(stock => `
                        <div class="stock-item">
                            <span class="stock-symbol">${stock.symbol}</span>
                            <span class="stock-price">¥${stock.price?.toFixed(2) || '--'}</span>
                            <span class="stock-change ${(stock.change || 0) >= 0 ? 'positive' : 'negative'}">
                                ${stock.changePercent?.toFixed(2) || '--'}%
                            </span>
                            <span class="stock-signals">${stock.signals.join(' ')}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');
    }

    /**
     * 生成信号历史HTML
     */
    private _generateSignalsHtml(): string {
        if (this._signalHistory.length === 0) {
            return '<div class="empty-state">暂无信号历史</div>';
        }

        return this._signalHistory.slice(0, 20).map(signal => `
            <div class="signal-item ${signal.signalType}">
                <div class="signal-time">${new Date(signal.timestamp).toLocaleString('zh-CN')}</div>
                <div class="signal-strategy">${signal.strategyName}</div>
                <div class="signal-stock">${signal.symbol}</div>
                <div class="signal-type">${signal.signalType === 'buy' ? '🟢 买入' : '🔴 卖出'}</div>
                <div class="signal-price">¥${signal.price.toFixed(2)}</div>
                <div class="signal-conditions">${signal.conditions}</div>
            </div>
        `).join('');
    }

    /**
     * 获取CSS样式
     */
    private _getStyles(): string {
        return `
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                line-height: 1.6;
            }

            .dashboard-container {
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px;
            }

            .dashboard-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 30px;
                padding: 20px;
                background-color: var(--vscode-panel-background);
                border-radius: 8px;
                border: 1px solid var(--vscode-panel-border);
            }

            .dashboard-header h1 {
                font-size: 24px;
                font-weight: 600;
            }

            .header-stats {
                display: flex;
                gap: 20px;
            }

            .stat-item {
                text-align: center;
            }

            .stat-label {
                display: block;
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                margin-bottom: 4px;
            }

            .stat-value {
                display: block;
                font-size: 18px;
                font-weight: 600;
                color: var(--vscode-textLink-foreground);
            }

            .header-actions {
                display: flex;
                gap: 10px;
            }

            .btn {
                padding: 8px 16px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                transition: all 0.2s;
            }

            .btn-primary {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
            }

            .btn-primary:hover {
                background-color: var(--vscode-button-hoverBackground);
            }

            .btn-secondary {
                background-color: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
            }

            .btn-secondary:hover {
                background-color: var(--vscode-button-secondaryHoverBackground);
            }

            .dashboard-main {
                display: grid;
                grid-template-columns: 2fr 1fr;
                gap: 30px;
            }

            .strategies-section h2,
            .signals-section h2 {
                font-size: 18px;
                margin-bottom: 15px;
                color: var(--vscode-editor-foreground);
            }

            .strategies-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
                gap: 20px;
            }

            .strategy-card {
                background-color: var(--vscode-panel-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 8px;
                padding: 20px;
                transition: all 0.2s;
            }

            .strategy-card.active {
                border-color: var(--vscode-textLink-foreground);
            }

            .strategy-card.inactive {
                opacity: 0.6;
            }

            .strategy-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 15px;
            }

            .strategy-header h3 {
                font-size: 16px;
                font-weight: 600;
            }

            .switch {
                position: relative;
                display: inline-block;
                width: 40px;
                height: 20px;
            }

            .switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }

            .slider {
                position: absolute;
                cursor: pointer;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: var(--vscode-input-background);
                transition: .4s;
                border-radius: 20px;
            }

            .slider:before {
                position: absolute;
                content: "";
                height: 16px;
                width: 16px;
                left: 2px;
                bottom: 2px;
                background-color: var(--vscode-editor-foreground);
                transition: .4s;
                border-radius: 50%;
            }

            input:checked + .slider {
                background-color: var(--vscode-textLink-foreground);
            }

            input:checked + .slider:before {
                transform: translateX(20px);
            }

            .strategy-stats {
                display: flex;
                gap: 15px;
                margin-bottom: 15px;
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
            }
            
            .strategy-performance {
                display: flex;
                gap: 8px;
                margin: 4px 0;
                font-size: 11px;
            }
            
            .perf-item {
                padding: 1px 4px;
                border-radius: 2px;
                background: var(--vscode-textBlockQuote-background);
                color: var(--vscode-textBlockQuote-foreground);
            }
            
            .activity-high {
                background: var(--vscode-testing-iconPassed) !important;
                color: white !important;
            }
            
            .activity-medium {
                background: var(--vscode-testing-iconQueued) !important;
                color: white !important;
            }
            
            .activity-low {
                background: var(--vscode-testing-iconFailed) !important;
                color: white !important;
            }

            .strategy-stocks {
                border-top: 1px solid var(--vscode-panel-border);
                padding-top: 15px;
            }

            .stock-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 0;
                border-bottom: 1px solid var(--vscode-panel-border);
                font-size: 14px;
            }

            .stock-item:last-child {
                border-bottom: none;
            }

            .stock-symbol {
                font-weight: 600;
                min-width: 80px;
            }

            .stock-price {
                min-width: 80px;
                text-align: right;
            }

            .stock-change {
                min-width: 60px;
                text-align: right;
                font-weight: 600;
            }

            .stock-change.positive {
                color: #f14c4c;
            }

            .stock-change.negative {
                color: #73c991;
            }

            .stock-signals {
                min-width: 80px;
                text-align: right;
            }

            .signals-list {
                max-height: 600px;
                overflow-y: auto;
                background-color: var(--vscode-panel-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 8px;
            }

            .signal-item {
                display: grid;
                grid-template-columns: 120px 1fr 80px 60px 80px 1fr;
                gap: 10px;
                padding: 12px;
                border-bottom: 1px solid var(--vscode-panel-border);
                font-size: 12px;
                align-items: center;
            }

            .signal-item:last-child {
                border-bottom: none;
            }

            .signal-item.buy {
                border-left: 3px solid #73c991;
            }

            .signal-item.sell {
                border-left: 3px solid #f14c4c;
            }

            .signal-time {
                color: var(--vscode-descriptionForeground);
            }

            .signal-strategy {
                font-weight: 600;
            }

            .signal-stock {
                font-weight: 600;
                color: var(--vscode-textLink-foreground);
            }

            .signal-type {
                font-weight: 600;
            }

            .signal-price {
                text-align: right;
                font-weight: 600;
            }

            .signal-conditions {
                color: var(--vscode-descriptionForeground);
                font-size: 11px;
            }

            .empty-state {
                text-align: center;
                padding: 40px;
                color: var(--vscode-descriptionForeground);
                font-style: italic;
            }

            @media (max-width: 768px) {
                .dashboard-main {
                    grid-template-columns: 1fr;
                }
                
                .dashboard-header {
                    flex-direction: column;
                    gap: 15px;
                }
                
                .strategies-grid {
                    grid-template-columns: 1fr;
                }
            }
        `;
    }

    /**
     * 获取JavaScript脚本
     */
    private _getScript(): string {
        return `
            const vscode = acquireVsCodeApi();

            function refreshData() {
                vscode.postMessage({ command: 'refresh' });
            }

            function toggleStrategy(strategyId) {
                vscode.postMessage({ 
                    command: 'toggleStrategy', 
                    strategyId: strategyId 
                });
            }

            function clearHistory() {
                if (confirm('确定要清空所有信号历史记录吗？')) {
                    vscode.postMessage({ command: 'clearHistory' });
                }
            }

            // 自动刷新提示
            let lastUpdate = new Date();
            setInterval(() => {
                const now = new Date();
                const diff = Math.floor((now - lastUpdate) / 1000);
                if (diff > 30) {
                    console.log('数据可能已过期，建议手动刷新');
                }
            }, 5000);
        `;
    }

    /**
     * 生成随机nonce
     */
    private _getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /**
     * 清理资源
     */
    public dispose() {
        StrategyDashboardPanel.currentPanel = undefined;
        
        // 清理定时器
        if (this._updateTimer) {
            clearInterval(this._updateTimer);
            this._updateTimer = undefined;
        }
        
        this._panel.dispose();
        
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}