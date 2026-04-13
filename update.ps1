$src = Get-Content src/strategyEngine.ts -Raw -Encoding UTF8
$code = Get-Content replace.ts -Raw -Encoding UTF8
$src = $src -replace '(?s)export function evaluateMispricingOpportunity\(params: MispricingEvaluationParams\): MispricingEvaluation \{.*\}', $code
Set-Content src/strategyEngine.ts $src -Encoding UTF8
