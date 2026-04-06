import { loadAuditReport } from "./audit";

function printBreakdown(label: string, value: string | number | null): void {
  const shown = value == null ? "-" : String(value);
  process.stdout.write(`${label}: ${shown}\n`);
}

const report = loadAuditReport();

printBreakdown("fileExists", report.fileExists ? "yes" : "no");
printBreakdown("totalTrades", report.totalTrades);
printBreakdown("realizedProfit", `$${report.realizedProfit.toFixed(2)}`);
printBreakdown("winRate", `${report.winRatePct.toFixed(2)}%`);
printBreakdown("estimatedTradePct", `${report.estimatedTradePct.toFixed(2)}%`);
printBreakdown("avgProfit", `$${report.avgProfit.toFixed(2)}`);
printBreakdown("avgWin", `$${report.avgWin.toFixed(2)}`);
printBreakdown("avgLoss", `$${report.avgLoss.toFixed(2)}`);
printBreakdown("profitFactor", report.profitFactor == null ? "inf" : report.profitFactor.toFixed(2));
printBreakdown("maxDrawdown", `$${report.maxDrawdown.toFixed(2)}`);
printBreakdown("largestWin", `$${report.largestWin.toFixed(2)}`);
printBreakdown("largestLoss", `$${report.largestLoss.toFixed(2)}`);
printBreakdown("roiOnCost", report.roiPct == null ? "-" : `${report.roiPct.toFixed(2)}%`);
printBreakdown("exitTypeBreakdown", JSON.stringify(report.exitTypeBreakdown));

if (report.warnings.length > 0) {
  process.stdout.write("warnings:\n");
  for (const warning of report.warnings) {
    process.stdout.write(`- ${warning}\n`);
  }
}