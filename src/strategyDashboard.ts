import * as vscode from 'vscode';
import { Strategy, Store } from './extension';

/**
 * 策略监控面板数据接口 - 扁平化结构
 */
export interface StrategyDashboardData {
    stockStrategies: StockStrategyItem[];  // 扁平化的股票-策略组合列表
    lastUpdate: string;
    totalSignals: number;
    activeStrategies: number;
}

/**
 * 扁平化的股票-策略组合接口
 */
export interface StockStrategyItem {
    id: string;                     // 唯一标识：stockSymbol_strategyId
    stockSymbol: string;            // 股票代码
    stockName: string;              // 股票名称
    strategyId: string;             // 策略ID
    strategyName: string;           // 策略名称
    strategyType: string;           // 策略类型
    price?: number;                 // 股票价格
    change?: number;                // 涨跌幅
    changePercent?: number;         // 涨跌幅百分比
    signals: string[];              // 当前信号状态
    lastUpdate?: string;            // 最后更新时间
    isActive: boolean;              // 策略是否活跃
    stats: {
        totalSignals: number;       // 总信号数
        buySignals: number;         // 买入信号数
        sellSignals: number;        // 卖出信号数
        lastSignalTime?: number;    // 最后信号时间
    };
    performance: StrategyPerformance;
}

/**
 * 带统计信息的策略接口（保留用于兼容性）
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

    public static createOrShow(extensionUri: vscode.Uri, store: Store) {
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
                    case 'toggleStockStrategy':
                        await this._toggleStockStrategy(message.stockSymbol, message.strategyName);
                        break;
                    case 'clearHistory':
                        this._clearSignalHistory();
                        await this._updateContent();
                        vscode.window.showInformationMessage('信号历史已清空');
                        break;
                    case 'configureStockStrategy':
                        this._configureStockStrategy(message.stockSymbol, message.strategyName);
                        break;
                    case 'selectPresetStrategy':
                        this._selectPresetStrategy(message.stockSymbol, message.strategyName, message.presetStrategy);
                        break;
                    case 'createPineScript':
                        this._createPineScript();
                        break;
                    case 'managePineScripts':
                        this._managePineScripts();
                        break;
                    case 'configurePineScript':
                        this._configurePineScript(message.scriptName);
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
     * 切换股票-策略组合的启用状态
     */
    private async _toggleStockStrategy(stockSymbol: string, strategyName: string) {
        const strategies = this._store.getStrategies();
        const strategy = strategies.find((s: any) => s.name === strategyName);
        
        if (!strategy) {
            vscode.window.showErrorMessage(`未找到策略: ${strategyName}`);
            return;
        }
        
        // 确保策略有stocks数组
        if (!strategy.stocks) {
            strategy.stocks = [];
        }
        
        // 查找或创建股票配置
        let stockConfig = strategy.stocks.find((stock: any) => stock.symbol === stockSymbol);
        if (!stockConfig) {
            stockConfig = {
                symbol: stockSymbol,
                enabled: true
            };
            strategy.stocks.push(stockConfig);
        }
        
        // 切换股票在该策略中的启用状态
        stockConfig.enabled = !stockConfig.enabled;
        const status = stockConfig.enabled ? '启用' : '禁用';
        
        // 保存更新后的策略
        await this._store.setStrategies(strategies);
        await this._updateContent();
        
        vscode.window.showInformationMessage(`股票 ${stockSymbol} 在策略 "${strategyName}" 中已${status}`);
        console.log(`股票 ${stockSymbol} 在策略 ${strategyName} 中的状态已切换为: ${stockConfig.enabled}`);
    }

    /**
     * 清空信号历史
     */
    private _clearSignalHistory() {
        this._signalHistory = [];
        this._update();
        vscode.window.showInformationMessage('信号历史已清空');
    }

    private async _configureStrategy(strategyId: string) {
        // 获取策略信息
        const strategies = this._store.getStrategies();
        const strategy = strategies.find((s: any) => s.name === strategyId);
        if (!strategy) {
            vscode.window.showErrorMessage('未找到指定策略');
            return;
        }

        // 根据策略类型显示不同的配置选项
        const strategyType = this._getStrategyType(strategy.name);
        const config = await this._showStrategyConfigDialog(strategy, strategyType);
        
        if (config) {
            // 保存策略配置
            await this._saveStrategyConfig(strategyId, config);
            vscode.window.showInformationMessage(`策略 ${strategy.name} 配置已更新`);
            this._update();
        }
    }

    private async _configureStockStrategy(stockSymbol: string, strategyName: string) {
        // 获取策略信息
        const strategies = this._store.getStrategies();
        const strategy = strategies.find((s: any) => s.name === strategyName);
        if (!strategy) {
            vscode.window.showErrorMessage('未找到指定策略');
            return;
        }

        // 根据策略类型显示不同的配置选项
        const strategyType = this._getStrategyType(strategy.name);
        const config = await this._showStockStrategyConfigDialog(strategy, stockSymbol, strategyType);
        
        if (config) {
            // 保存股票策略配置
            await this._saveStockStrategyConfig(strategyName, stockSymbol, config);
            vscode.window.showInformationMessage(`股票 ${stockSymbol} 在策略 ${strategy.name} 中的配置已更新`);
            await this._updateContent();
        }
    }

    private async _selectPresetStrategy(stockSymbol: string, strategyName: string, presetStrategy: string) {
        try {
            // 获取当前策略信息
            const strategies = this._store.getStrategies();
            const strategy = strategies.find((s: any) => s.name === strategyName);
            if (!strategy) {
                vscode.window.showErrorMessage('未找到指定策略');
                return;
            }

            // 确保策略有stocks数组
            if (!strategy.stocks) {
                strategy.stocks = [];
            }
            
            // 查找或创建股票配置
            let stockConfig = strategy.stocks.find((stock: any) => stock.symbol === stockSymbol);
            if (!stockConfig) {
                stockConfig = {
                    symbol: stockSymbol,
                    enabled: true
                };
                strategy.stocks.push(stockConfig);
            }
            
            // 应用预设策略配置
            stockConfig.presetStrategy = presetStrategy;
            stockConfig.strategyType = presetStrategy;
            
            // 保存更新后的策略
            await this._store.setStrategies(strategies);
            await this._updateContent();
            
            vscode.window.showInformationMessage(`股票 ${stockSymbol} 已应用预设策略 ${presetStrategy}`);
        } catch (error) {
            console.error('选择预设策略失败:', error);
            vscode.window.showErrorMessage('选择预设策略失败');
        }
    }

    /**
     * 创建Pine脚本策略
     */
    private async _createPineScript() {
        try {
            // 调用extension.ts中的addScriptStrategy命令
            await vscode.commands.executeCommand('efinance.addScriptStrategy');
            
            // 刷新面板内容
            await this._updateContent();
        } catch (error) {
            console.error('创建Pine脚本失败:', error);
            vscode.window.showErrorMessage('创建Pine脚本失败');
        }
    }

    /**
     * 管理Pine脚本策略
     */
    private async _managePineScripts() {
        try {
            const strategies = this._store.getStrategies();
            const scriptStrategies = strategies.filter((s: any) => s.type === 'script');
            
            if (scriptStrategies.length === 0) {
                vscode.window.showInformationMessage('暂无Pine脚本策略，请先创建一个');
                return;
            }
            
            // 显示Pine脚本列表供用户选择
            const items = scriptStrategies.map((strategy: any) => ({
                label: strategy.name,
                description: strategy.script?.enabled ? '✅ 已启用' : '❌ 已禁用',
                detail: `符号: ${strategy.symbols?.join(', ') || '无'}`
            }));
            
            items.push({
                label: '$(add) 创建新的Pine脚本',
                description: '创建一个新的Pine脚本策略',
                detail: ''
            });
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: '选择要管理的Pine脚本策略'
            });
            
            if (selected) {
                if (selected.label.includes('创建新的Pine脚本')) {
                    await this._createPineScript();
                } else {
                    await this._configurePineScript(selected.label);
                }
            }
        } catch (error) {
            console.error('管理Pine脚本失败:', error);
            vscode.window.showErrorMessage('管理Pine脚本失败');
        }
    }

    /**
     * 配置Pine脚本策略
     */
    private async _configurePineScript(scriptName: string) {
        try {
            // 调用extension.ts中的configureScriptStrategy命令
            await vscode.commands.executeCommand('efinance.configureScriptStrategy', scriptName);
            
            // 刷新面板内容
            await this._updateContent();
        } catch (error) {
            console.error('配置Pine脚本失败:', error);
            vscode.window.showErrorMessage('配置Pine脚本失败');
        }
    }

    private _getStrategyType(strategyName: string): string {
        if (strategyName.includes('均线') || strategyName.includes('MA')) {
            return 'ma';
        } else if (strategyName.includes('KDJ')) {
            return 'kdj';
        } else if (strategyName.includes('RSI')) {
            return 'rsi';
        }
        return 'unknown';
    }

    private async _showStrategyConfigDialog(strategy: any, strategyType: string): Promise<any> {
        const items: vscode.QuickPickItem[] = [];
        
        switch (strategyType) {
            case 'ma':
                items.push(
                    { label: '配置均线周期', description: '设置跟踪的均线周期' },
                    { label: '配置时间周期', description: '设置K线时间周期' }
                );
                break;
            case 'kdj':
                items.push(
                    { label: '配置KDJ参数', description: '设置KDJ指标参数' },
                    { label: '配置时间周期', description: '设置K线时间周期' }
                );
                break;
            case 'rsi':
                items.push(
                    { label: '配置RSI参数', description: '设置RSI指标参数' },
                    { label: '配置时间周期', description: '设置K线时间周期' }
                );
                break;
            default:
                items.push(
                    { label: '配置时间周期', description: '设置K线时间周期' }
                );
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `配置策略: ${strategy.name}`
        });

        if (!selected) {
            return null;
        }

        if (selected.label === '配置均线周期') {
            return await this._configureMAPeriod();
        } else if (selected.label === '配置时间周期') {
            return await this._configureTimePeriod();
        } else if (selected.label === '配置KDJ参数') {
            return await this._configureKDJParams();
        } else if (selected.label === '配置RSI参数') {
            return await this._configureRSIParams();
        }

        return null;
    }

    private async _configureMAPeriod(): Promise<any> {
        const periods = [
            { label: '5日均线', value: 5 },
            { label: '10日均线', value: 10 },
            { label: '20日均线', value: 20 },
            { label: '30日均线', value: 30 },
            { label: '60日均线', value: 60 }
        ];

        const selected = await vscode.window.showQuickPick(
            periods.map(p => ({ label: p.label, description: `周期: ${p.value}` })),
            { placeHolder: '选择均线周期' }
        );

        if (selected) {
            const period = periods.find(p => p.label === selected.label);
            return { type: 'ma', period: period?.value };
        }
        return null;
    }

    private async _configureTimePeriod(): Promise<any> {
        const periods = [
            { label: '15分钟', value: '15m' },
            { label: '60分钟', value: '60m' },
            { label: '日线', value: '1d' },
            { label: '周线', value: '1w' }
        ];

        const selected = await vscode.window.showQuickPick(
            periods.map(p => ({ label: p.label })),
            { placeHolder: '选择时间周期' }
        );

        if (selected) {
            const period = periods.find(p => p.label === selected.label);
            return { type: 'timeframe', period: period?.value };
        }
        return null;
    }

    private async _configureKDJParams(): Promise<any> {
        const kPeriod = await vscode.window.showInputBox({
            prompt: '请输入K值周期',
            value: '9',
            validateInput: (value) => {
                const num = parseInt(value);
                if (isNaN(num) || num <= 0) {
                    return '请输入有效的正整数';
                }
                return null;
            }
        });

        if (kPeriod) {
            return { type: 'kdj', kPeriod: parseInt(kPeriod), dPeriod: 3, jPeriod: 3 };
        }
        return null;
    }

    private async _configureRSIParams(): Promise<any> {
        const period = await vscode.window.showInputBox({
            prompt: '请输入RSI周期',
            value: '14',
            validateInput: (value) => {
                const num = parseInt(value);
                if (isNaN(num) || num <= 0) {
                    return '请输入有效的正整数';
                }
                return null;
            }
        });

        if (period) {
            return { type: 'rsi', period: parseInt(period) };
        }
        return null;
    }

    private async _saveStrategyConfig(strategyId: string, config: any): Promise<void> {
        // 这里应该保存到配置文件或数据库
        // 暂时只是显示配置信息
        console.log(`保存策略配置: ${strategyId}`, config);
        
        // 可以通过vscode.workspace.getConfiguration()来保存配置
        const workspaceConfig = vscode.workspace.getConfiguration('watchstock');
        const strategies: { [key: string]: any } = workspaceConfig.get('strategies', {});
        strategies[strategyId] = { ...strategies[strategyId], ...config };
        await workspaceConfig.update('strategies', strategies, vscode.ConfigurationTarget.Workspace);
    }

    private async _showStockStrategyConfigDialog(strategy: any, stockSymbol: string, strategyType: string): Promise<any> {
        const title = `配置股票 ${stockSymbol} 的策略参数 - ${strategy.name}`;
        
        switch (strategyType) {
            case 'MA':
                return await this._configureStockMAPeriod(stockSymbol, strategy);
            case 'TIME':
                return await this._configureStockTimePeriod(stockSymbol, strategy);
            case 'KDJ':
                return await this._configureStockKDJParams(stockSymbol, strategy);
            case 'RSI':
                return await this._configureStockRSIParams(stockSymbol, strategy);
            default:
                vscode.window.showWarningMessage(`暂不支持配置 ${strategyType} 类型的策略参数`);
                return null;
        }
    }

    private async _saveStockStrategyConfig(strategyName: string, stockSymbol: string, config: any) {
        try {
            // 获取当前策略信息
            const strategies = this._store.getStrategies();
            const strategy = strategies.find((s: any) => s.name === strategyName);
            if (!strategy) {
                throw new Error(`未找到策略: ${strategyName}`);
            }

            // 确保策略有stocks数组
            if (!strategy.stocks) {
                strategy.stocks = [];
            }
            
            // 查找或创建股票配置
            let stockConfig = strategy.stocks.find((stock: any) => stock.symbol === stockSymbol);
            if (!stockConfig) {
                stockConfig = {
                    symbol: stockSymbol,
                    enabled: true
                };
                strategy.stocks.push(stockConfig);
            }
            
            // 保存配置参数
            stockConfig.config = { ...stockConfig.config, ...config };
            stockConfig.updatedAt = new Date().toISOString();
            
            // 保存更新后的策略
            await this._store.setStrategies(strategies);
            
            console.log(`保存股票策略配置: ${strategyName}, 股票: ${stockSymbol}`, config);
        } catch (error) {
            console.error('保存股票策略配置失败:', error);
            vscode.window.showErrorMessage('保存股票策略配置失败');
        }
    }

    private async _configureStockMAPeriod(stockSymbol: string, strategy: any): Promise<any> {
        const periods = [
            { label: '5日均线', value: 5 },
            { label: '10日均线', value: 10 },
            { label: '20日均线', value: 20 },
            { label: '30日均线', value: 30 },
            { label: '60日均线', value: 60 }
        ];

        const selected = await vscode.window.showQuickPick(
            periods.map(p => ({ label: p.label, description: `周期: ${p.value}` })),
            { placeHolder: `为股票 ${stockSymbol} 选择均线周期` }
        );

        if (selected) {
            const period = periods.find(p => p.label === selected.label);
            return { type: 'ma', period: period?.value, stockSymbol };
        }
        return null;
    }

    private async _configureStockTimePeriod(stockSymbol: string, strategy: any): Promise<any> {
        const periods = [
            { label: '15分钟', value: '15m' },
            { label: '60分钟', value: '60m' },
            { label: '日线', value: '1d' },
            { label: '周线', value: '1w' }
        ];

        const selected = await vscode.window.showQuickPick(
            periods.map(p => ({ label: p.label })),
            { placeHolder: `为股票 ${stockSymbol} 选择时间周期` }
        );

        if (selected) {
            const period = periods.find(p => p.label === selected.label);
            return { type: 'timeframe', period: period?.value, stockSymbol };
        }
        return null;
    }

    private async _configureStockKDJParams(stockSymbol: string, strategy: any): Promise<any> {
        const kPeriod = await vscode.window.showInputBox({
            prompt: `为股票 ${stockSymbol} 请输入K值周期`,
            value: '9',
            validateInput: (value) => {
                const num = parseInt(value);
                if (isNaN(num) || num <= 0) {
                    return '请输入有效的正整数';
                }
                return null;
            }
        });

        if (kPeriod) {
            return { type: 'kdj', kPeriod: parseInt(kPeriod), dPeriod: 3, jPeriod: 3, stockSymbol };
        }
        return null;
    }

    private async _configureStockRSIParams(stockSymbol: string, strategy: any): Promise<any> {
        const period = await vscode.window.showInputBox({
            prompt: `为股票 ${stockSymbol} 请输入RSI周期`,
            value: '14',
            validateInput: (value) => {
                const num = parseInt(value);
                if (isNaN(num) || num <= 0) {
                    return '请输入有效的正整数';
                }
                return null;
            }
        });

        if (period) {
            return { type: 'rsi', period: parseInt(period), stockSymbol };
        }
        return null;
    }

    private async _showPresetStrategyConfigDialog(presetStrategy: any, stockSymbol: string): Promise<any> {
        const strategyName = presetStrategy.name;
        const config: any = { strategyName, stockSymbol };

        // 根据不同的预设策略显示不同的参数配置
        switch (strategyName) {
            case 'RSI超买超卖':
                const rsiPeriod = await vscode.window.showInputBox({
                    prompt: `为股票 ${stockSymbol} 配置RSI周期`,
                    value: '14',
                    validateInput: (value) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num <= 0) {
                            return '请输入有效的正整数';
                        }
                        return null;
                    }
                });
                if (rsiPeriod) {
                    config.rsiPeriod = parseInt(rsiPeriod);
                    config.overbought = 70;
                    config.oversold = 30;
                }
                break;

            case 'MACD金叉死叉':
                const fastPeriod = await vscode.window.showInputBox({
                    prompt: `为股票 ${stockSymbol} 配置MACD快线周期`,
                    value: '12',
                    validateInput: (value) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num <= 0) {
                            return '请输入有效的正整数';
                        }
                        return null;
                    }
                });
                if (fastPeriod) {
                    config.fastPeriod = parseInt(fastPeriod);
                    config.slowPeriod = 26;
                    config.signalPeriod = 9;
                }
                break;

            case '双均线策略':
                const shortMA = await vscode.window.showInputBox({
                    prompt: `为股票 ${stockSymbol} 配置短期均线周期`,
                    value: '5',
                    validateInput: (value) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num <= 0) {
                            return '请输入有效的正整数';
                        }
                        return null;
                    }
                });
                if (shortMA) {
                    config.shortMA = parseInt(shortMA);
                    config.longMA = 20;
                }
                break;

            case '布林带策略':
                const bollPeriod = await vscode.window.showInputBox({
                    prompt: `为股票 ${stockSymbol} 配置布林带周期`,
                    value: '20',
                    validateInput: (value) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num <= 0) {
                            return '请输入有效的正整数';
                        }
                        return null;
                    }
                });
                if (bollPeriod) {
                    config.period = parseInt(bollPeriod);
                    config.stdDev = 2;
                }
                break;

            case 'KDJ超买超卖':
                const kdjPeriod = await vscode.window.showInputBox({
                    prompt: `为股票 ${stockSymbol} 配置KDJ周期`,
                    value: '9',
                    validateInput: (value) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num <= 0) {
                            return '请输入有效的正整数';
                        }
                        return null;
                    }
                });
                if (kdjPeriod) {
                    config.kPeriod = parseInt(kdjPeriod);
                    config.dPeriod = 3;
                    config.jPeriod = 3;
                }
                break;

            default:
                // 对于其他策略，使用通用配置
                config.period = 14;
                break;
        }

        return Object.keys(config).length > 2 ? config : null;
    }

    private async _savePresetStrategyConfig(strategyId: string, stockSymbol: string, presetStrategy: string, config: any): Promise<void> {
        try {
            console.log(`保存预设策略配置: 策略ID=${strategyId}, 股票=${stockSymbol}, 预设策略=${presetStrategy}`, config);
            
            // 获取当前策略配置
            const workspaceConfig = vscode.workspace.getConfiguration('watchstock');
            const stockStrategies: { [key: string]: any } = workspaceConfig.get('stockStrategies', {});
            
            // 为股票创建策略配置键
            const configKey = `${strategyId}_${stockSymbol}`;
            stockStrategies[configKey] = {
                strategyId,
                stockSymbol,
                presetStrategy,
                config,
                updatedAt: new Date().toISOString()
            };
            
            // 保存到工作区配置
            await workspaceConfig.update('stockStrategies', stockStrategies, vscode.ConfigurationTarget.Workspace);
            
            console.log(`预设策略配置已保存: ${configKey}`);
        } catch (error) {
            console.error('保存预设策略配置失败:', error);
            throw error;
        }
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
     * 获取面板数据 - 扁平化结构
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
        
        // 构建股票名称映射
        const stockNames: Record<string, string> = {};
        [...watchlist, ...holdings].forEach(stock => {
            if (stock.name) {
                stockNames[stock.symbol] = stock.name;
            }
        });
        
        // 获取性能统计数据
        const performanceStats = this._calculateStrategyPerformance();
        
        // 生成扁平化的股票-策略组合数据
        const stockStrategies: StockStrategyItem[] = [];
        
        rawStrategies.forEach((strategy: any) => {
            const strategySignals = this._signalHistory.filter(s => s.strategyName === strategy.name);
            const buySignals = strategySignals.filter(s => s.signalType === 'buy').length;
            const sellSignals = strategySignals.filter(s => s.signalType === 'sell').length;
            
            // 获取该策略的性能统计
            const performance = performanceStats.find(p => p.strategyName === strategy.name) || {
                strategyName: strategy.name,
                totalSignals: 0,
                buySignals: 0,
                sellSignals: 0,
                avgSignalInterval: 0,
                lastSignalTime: 0,
                recentActivity: 'low' as const
            };
            
            // 判断策略是否活跃
            const isActive = strategy.type === 'script' 
                ? (strategy.script?.enabled || false)
                : (strategy.signals?.buyConditions?.enabled || strategy.signals?.sellConditions?.enabled || false);
            
            // 为每个股票创建一个股票-策略组合条目
            strategy.symbols.forEach((symbol: string) => {
                const stockData = stockPrices[symbol];
                const stockSignals = strategySignals
                    .filter(s => s.symbol === symbol)
                    .slice(0, 3) // 最近3个信号
                    .map(s => s.signalType === 'buy' ? '🟢' : '🔴');
                
                const stockName = stockNames[symbol] || symbol; // 如果没有名称则使用代码
                
                stockStrategies.push({
                    id: `${symbol}_${strategy.name}`, // 唯一标识
                    stockSymbol: symbol,
                    stockName: stockName,
                    strategyId: strategy.name,
                    strategyName: strategy.name,
                    strategyType: strategy.type || 'simple',
                    price: stockData?.price,
                    change: stockData?.change,
                    changePercent: stockData ? stockData.change * 100 : undefined,
                    signals: stockSignals,
                    lastUpdate: new Date().toLocaleString('zh-CN'),
                    isActive: isActive,
                    stats: {
                        totalSignals: strategySignals.filter(s => s.symbol === symbol).length,
                        buySignals: strategySignals.filter(s => s.symbol === symbol && s.signalType === 'buy').length,
                        sellSignals: strategySignals.filter(s => s.symbol === symbol && s.signalType === 'sell').length,
                        lastSignalTime: strategySignals.filter(s => s.symbol === symbol).length > 0 
                            ? Math.max(...strategySignals.filter(s => s.symbol === symbol).map(s => s.timestamp))
                            : undefined
                    },
                    performance: performance
                });
            });
        });
        
        return {
            stockStrategies,
            lastUpdate: new Date().toLocaleString('zh-CN'),
            totalSignals: this._signalHistory.length,
            activeStrategies: stockStrategies.filter(s => s.isActive).length
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
                <button class="btn btn-success" onclick="createPineScript()">📝 创建Pine脚本</button>
                <button class="btn btn-info" onclick="managePineScripts()">⚙️ 管理Pine脚本</button>
            </div>
        </header>

        <main class="dashboard-main">
            <div class="strategies-section">
                <h2>股票策略监控</h2>
                <div class="stock-strategies-list" id="stockStrategiesList">
                    ${this._generateStockStrategiesHtml(data.stockStrategies)}
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
     * 生成扁平化股票策略HTML
     */
    private _generateStockStrategiesHtml(stockStrategies: StockStrategyItem[]): string {
        if (stockStrategies.length === 0) {
            return '<div class="empty-state">暂无股票策略数据</div>';
        }

        return stockStrategies.map(item => `
            <div class="stock-strategy-row ${item.isActive ? 'active' : 'inactive'}">
                <div class="stock-info-section">
                    <div class="stock-name-code">
                        <span class="stock-name">${item.stockName}</span>
                        <span class="stock-code">${item.stockSymbol}</span>
                    </div>
                    <div class="strategy-name">
                        <span class="strategy-label">${item.strategyName}</span>
                        <span class="strategy-type">(${this._getStrategyTypeLabel(item.strategyType)})</span>
                    </div>
                </div>
                
                <div class="price-info-section">
                    <div class="stock-price">¥${item.price?.toFixed(2) || '--'}</div>
                    <div class="stock-change ${(item.change || 0) >= 0 ? 'positive' : 'negative'}">
                        ${(item.change || 0) >= 0 ? '↗' : '↘'} ${Math.abs(item.changePercent || 0).toFixed(2)}%
                    </div>
                </div>
                
                <div class="signals-section">
                    <div class="recent-signals">${item.signals.join(' ')}</div>
                    <div class="signal-stats">
                        <span class="signal-count">信号: ${item.stats.totalSignals}</span>
                        <span class="buy-sell-ratio">${item.stats.buySignals}买/${item.stats.sellSignals}卖</span>
                    </div>
                </div>
                
                <div class="controls-section">
                    <div class="strategy-controls">
                        <select class="strategy-select" onchange="changeStockStrategy('${item.id}', this.value)" title="更换策略">
                            <option value="${item.strategyType}" selected>${this._getStrategyTypeLabel(item.strategyType)}</option>
                            <option value="rsi_oversold_overbought">RSI超买超卖</option>
                            <option value="macd_golden_cross">MACD金叉死叉</option>
                            <option value="double_ma_cross">双均线策略</option>
                            <option value="bollinger_bands">布林带策略</option>
                            <option value="kdj_oversold_overbought">KDJ超买超卖</option>
                            <option value="price_volume_breakout">价量突破</option>
                            <option value="mean_reversion">均值回归</option>
                            <option value="momentum_strategy">动量策略</option>
                        </select>
                        <button class="btn-config" onclick="configureStockStrategy('${item.id}')" title="配置策略参数">
                            ⚙️
                        </button>
                    </div>
                    <div class="status-toggle">
                        <label class="switch">
                            <input type="checkbox" ${item.isActive ? 'checked' : ''} 
                                   onchange="toggleStockStrategy('${item.id}')">
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>
            </div>
        `).join('');
    }
    
    /**
     * 获取策略类型标签
     */
    private _getStrategyTypeLabel(strategyType: string): string {
        const labels: Record<string, string> = {
            'rsi_oversold_overbought': 'RSI超买超卖',
            'macd_golden_cross': 'MACD金叉死叉',
            'double_ma_cross': '双均线策略',
            'bollinger_bands': '布林带策略',
            'kdj_oversold_overbought': 'KDJ超买超卖',
            'price_volume_breakout': '价量突破',
            'mean_reversion': '均值回归',
            'momentum_strategy': '动量策略',
            'simple': '简单策略',
            'script': '脚本策略'
        };
        return labels[strategyType] || strategyType;
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

            .btn-success {
                background-color: #28a745;
                color: white;
            }

            .btn-success:hover {
                background-color: #218838;
            }

            .btn-info {
                background-color: #17a2b8;
                color: white;
            }

            .btn-info:hover {
                background-color: #138496;
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

            .stock-strategies-list {
                background-color: var(--vscode-panel-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 8px;
                overflow: hidden;
            }

            .stock-strategy-item {
                display: grid;
                grid-template-columns: 2fr 1fr 1fr 1fr 1fr 120px 80px;
                gap: 15px;
                padding: 12px 16px;
                border-bottom: 1px solid var(--vscode-panel-border);
                align-items: center;
                font-size: 13px;
                transition: background-color 0.2s;
            }

            .stock-strategy-item:last-child {
                border-bottom: none;
            }

            .stock-strategy-item:hover {
                background-color: var(--vscode-list-hoverBackground);
            }

            .stock-strategy-item.inactive {
                opacity: 0.6;
            }

            .stock-strategy-header {
                display: grid;
                grid-template-columns: 2fr 1fr 1fr 1fr 1fr 120px 80px;
                gap: 15px;
                padding: 12px 16px;
                background-color: var(--vscode-editor-background);
                border-bottom: 2px solid var(--vscode-panel-border);
                font-weight: 600;
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
            }

            .btn-config {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 4px;
                padding: 4px 8px;
                cursor: pointer;
                font-size: 12px;
                transition: background-color 0.2s;
            }

            .stock-strategy-controls {
                display: flex;
                align-items: center;
                gap: 8px;
                margin: 4px 0;
            }

            .strategy-select {
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 12px;
                cursor: pointer;
                min-width: 120px;
                transition: border-color 0.2s;
            }

            .strategy-select:hover {
                border-color: var(--vscode-inputOption-hoverBackground);
            }

            .strategy-select:focus {
                outline: none;
                border-color: var(--vscode-focusBorder);
                box-shadow: 0 0 0 1px var(--vscode-focusBorder);
            }

            .btn-stock-config {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: none;
                border-radius: 4px;
                padding: 4px 8px;
                cursor: pointer;
                font-size: 12px;
                transition: background-color 0.2s;
                min-width: 28px;
                height: 28px;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .btn-stock-config:hover {
                background: var(--vscode-button-secondaryHoverBackground);
            }

            .btn-config:hover {
                background: var(--vscode-button-hoverBackground);
            }

            .btn-stock-config {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 3px;
                padding: 2px 6px;
                cursor: pointer;
                font-size: 10px;
                margin-left: 8px;
                transition: background-color 0.2s;
                opacity: 0.8;
            }

            .btn-stock-config:hover {
                background: var(--vscode-button-hoverBackground);
                opacity: 1;
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

            .stock-name {
                font-weight: 600;
                color: var(--vscode-editor-foreground);
            }

            .stock-code {
                color: var(--vscode-descriptionForeground);
                font-size: 11px;
                margin-top: 2px;
            }

            .strategy-name {
                font-weight: 500;
                color: var(--vscode-textLink-foreground);
            }

            .strategy-type {
                font-size: 11px;
                color: var(--vscode-descriptionForeground);
                margin-top: 2px;
            }

            .stock-price {
                font-weight: 600;
                font-size: 13px;
                text-align: right;
            }

            .stock-change {
                font-weight: 600;
                font-size: 12px;
                padding: 2px 6px;
                border-radius: 4px;
                text-align: center;
            }

            .stock-change.positive {
                color: #ffffff;
                background-color: #4CAF50;
            }

            .stock-change.negative {
                color: #ffffff;
                background-color: #F44336;
            }

            .stock-change.neutral {
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-input-background);
            }

            .signal-status {
                font-size: 11px;
                padding: 2px 6px;
                border-radius: 3px;
                text-align: center;
                font-weight: 500;
            }

            .signal-status.buy {
                background-color: #4CAF50;
                color: white;
            }

            .signal-status.sell {
                background-color: #F44336;
                color: white;
            }

            .signal-status.hold {
                background-color: var(--vscode-input-background);
                color: var(--vscode-editor-foreground);
            }

            .stock-strategy-controls {
                display: flex;
                align-items: center;
                gap: 8px;
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
                
                .stock-strategy-item {
                    grid-template-columns: 1fr;
                    gap: 8px;
                }
                
                .stock-strategy-header {
                    display: none;
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

            function toggleStockStrategy(stockSymbol, strategyId) {
                vscode.postMessage({ 
                    command: 'toggleStockStrategy', 
                    stockSymbol: stockSymbol,
                    strategyId: strategyId 
                });
            }

            function clearHistory() {
                if (confirm('确定要清空所有信号历史记录吗？')) {
                    vscode.postMessage({ command: 'clearHistory' });
                }
            }

            function configureStockStrategy(stockSymbol, strategyId) {
                vscode.postMessage({ 
                    command: 'configureStockStrategy', 
                    stockSymbol: stockSymbol,
                    strategyId: strategyId
                });
            }

            function onStrategySelect(stockSymbol, currentStrategyId, selectedStrategyType) {
                if (selectedStrategyType === '') return;
                
                // 发送消息给扩展，更换策略类型
                vscode.postMessage({
                    command: 'changeStockStrategy',
                    stockSymbol: stockSymbol,
                    currentStrategyId: currentStrategyId,
                    newStrategyType: selectedStrategyType
                });
            }

            function createPineScript() {
                vscode.postMessage({ command: 'createPineScript' });
            }

            function managePineScripts() {
                vscode.postMessage({ command: 'managePineScripts' });
            }

            function configurePineScript(scriptName) {
                vscode.postMessage({ 
                    command: 'configurePineScript',
                    scriptName: scriptName
                });
            }

            // 获取可用的策略类型列表
            function getAvailableStrategies() {
                return [
                    { value: 'ma_cross', label: '均线交叉' },
                    { value: 'rsi_oversold', label: 'RSI超卖' },
                    { value: 'bollinger_bands', label: '布林带' },
                    { value: 'macd_signal', label: 'MACD信号' },
                    { value: 'volume_breakout', label: '成交量突破' },
                    { value: 'support_resistance', label: '支撑阻力' }
                ];
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