const fs = require('fs');
let code = fs.readFileSync('src/engine/TradingEngine.ts', 'utf8');
code = code.replace('import { dbRecordTrade } from "./db";', 'import { dbRecordTrade } from "../db";');
fs.writeFileSync('src/engine/TradingEngine.ts', code);
console.log("✅ Fixed import in TradingEngine.ts");
