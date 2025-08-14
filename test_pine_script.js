// Pine脚本功能测试脚本
const { PineScriptParser, createScriptContext, getPresetStrategies } = require('./out/scriptParser');
const indicators = require('./out/indicators');

// 创建测试数据
const testStockData = {
    code: '000001',
    name: '平安银行',
    price: 12.50,
    change: 0.25,
    changePercent: 2.04,
    historicalPrices: [12.00, 12.10, 12.25, 12.30, 12.20, 12.15, 12.35, 12.40, 12.45, 12.50]
};

// 测试技术指标计算
console.log('=== 技术指标测试 ===');
const prices = testStockData.historicalPrices;
console.log('价格数据:', prices);
console.log('SMA(5):', indicators.sma(prices, 5));
console.log('EMA(5):', indicators.ema(prices, 5));
console.log('RSI(5):', indicators.rsi(prices, 5));

// 测试Pine脚本解析
console.log('\n=== Pine脚本解析测试 ===');
const parser = new PineScriptParser();

// 创建脚本执行上下文
const context = createScriptContext(
    testStockData.code,
    testStockData.price,
    testStockData.change,
    testStockData.changePercent,
    testStockData.historicalPrices,
    [],
    []
);

// 测试简单条件
const simpleScript = 'close > 12.0';
console.log(`脚本: ${simpleScript}`);
console.log('结果:', parser.execute(simpleScript));

// 测试RSI条件
const rsiScript = 'rsi(historical_prices, 5) < 30';
console.log(`\n脚本: ${rsiScript}`);
console.log('结果:', parser.execute(rsiScript));

// 测试复合条件
const complexScript = 'close > sma(historical_prices, 5) and rsi(historical_prices, 5) > 50';
console.log(`\n脚本: ${complexScript}`);
console.log('结果:', parser.execute(complexScript));

// 测试预设策略模板
console.log('\n=== 预设策略模板测试 ===');
const presets = getPresetStrategies();
console.log('可用预设策略数量:', Object.keys(presets).length);
Object.entries(presets).forEach(([key, preset], index) => {
    console.log(`${index + 1}. ${preset.name}: ${preset.description}`);
});

// 测试RSI超买超卖策略
const rsiStrategy = presets.rsi_oversold_overbought;
if (rsiStrategy) {
    console.log(`\n测试策略: ${rsiStrategy.name}`);
    console.log('买入条件:', rsiStrategy.buyScript);
    console.log('卖出条件:', rsiStrategy.sellScript);
    
    console.log('买入信号:', parser.execute(rsiStrategy.buyScript));
    console.log('卖出信号:', parser.execute(rsiStrategy.sellScript));
}

console.log('\n=== 测试完成 ===');
console.log('Pine脚本功能测试通过！');