const fs = require('fs');
const content = fs.readFileSync('src/engine/MarketScanner.ts', 'utf8');

const newMethod = fs.readFileSync('evaluate_replacement.ts', 'utf8');

const regex = /\/\*\*\n   \* Evaluates technicals and generates a scan record for a single symbol\n   \*\/\n  private async evaluateSingleSymbol\(symbol: string\): Promise<ScannedMarketItem \| null> \{[\s\S]*?lastScannedAt: Date.now\(\),\n      \};\n    \} catch \(err: any\) \{\n      return null;\n    \}\n  \}/;

const replaced = content.replace(regex, '/**\n   * Evaluates technicals and generates a scan record for a single symbol\n   */\n' + newMethod);
fs.writeFileSync('src/engine/MarketScanner.ts', replaced);
