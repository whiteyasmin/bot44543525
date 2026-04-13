const fs = require('fs');

let c = fs.readFileSync('src/bot.ts', 'utf-8');

// 1. Restore specific parameter optimizations
c = c.replace('MIN_ENTRY_SECS  = 240', 'MIN_ENTRY_SECS  = 120');
c = c.replace('MIN_ENTRY_ASK   = 0.18', 'MIN_ENTRY_ASK   = 0.10');
c = c.replace('MIN_NET_EDGE = 0.08', 'MIN_NET_EDGE = 0.05');
c = c.replace('NON_FLAT_MIN_NET_EDGE = 0.10', 'NON_FLAT_MIN_NET_EDGE = 0.08');
c = c.replace('FLAT_MIN_NET_EDGE = 0.12', 'FLAT_MIN_NET_EDGE = 0.10');
c = c.replace('CONSECUTIVE_LOSS_PAUSE = 5', 'CONSECUTIVE_LOSS_PAUSE = 3');

// 2. Add Dynamic price floor directly at the right place
const startMatch = "if (candidate.askPrice < MIN_ENTRY_ASK) {";
const startIdx = c.indexOf(startMatch);

if (startIdx !== -1) {
  let braces = 0;
  let endIdx = -1;
  for (let i = startIdx; i < c.length; i++) {
    if (c[i] === '{') braces++;
    else if (c[i] === '}') {
      braces--;
      if (braces === 0) { endIdx = i + 1; break; }
    }
  }
  
  if (endIdx !== -1) {
    const newCode = `const dynamicMinAsk = elapsed > 660 ? 0.20 : elapsed > 480 ? 0.15 : MIN_ENTRY_ASK;
                  if (candidate.askPrice < dynamicMinAsk) {
                    const skipKey = \`minask:\${candidate.dir}:\${candidate.askPrice.toFixed(2)}\`;
                    if (skipKey !== this.lastEntrySkipKey) {
                      this.lastEntrySkipKey = skipKey;
                      logger.warn(\`Hedge15m Leg1 skipped (dynamic floor): ask=\${candidate.askPrice.toFixed(2)} < floor=\${dynamicMinAsk} (elapsed=\${Math.floor(elapsed)}s)\`);
                    }
                  }`;
    c = c.substring(0, startIdx) + newCode + c.substring(endIdx);
  }
}

// 3. Update executionPlanner.ts minEntryAsk property correctly!
c = c.replace("minEntryAsk: MIN_ENTRY_ASK,", "minEntryAsk: (typeof dynamicMinAsk !== 'undefined' ? dynamicMinAsk : MIN_ENTRY_ASK),");

fs.writeFileSync('src/bot.ts', c, 'utf-8');
console.log('Done padding!');