import "dotenv/config";

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

/** 服务器配置 (仅从环境变量, 不可改) */
export const ServerConfig = {
  PORT: parseInt(env("PORT", "3001")),
  ADMIN_PASSWORD: env("ADMIN_PASSWORD", "admin"),
};

/** 15分钟对冲机器人配置 */
export const Config = {
  // Polymarket API
  CLOB_HOST: "https://clob.polymarket.com",
  GAMMA_HOST: "https://gamma-api.polymarket.com",
  CHAIN_ID: 137,

  // 钱包
  PRIVATE_KEY: env("PRIVATE_KEY", ""),
  FUNDER_ADDRESS: env("FUNDER_ADDRESS", ""),
  SIGNATURE_TYPE: parseInt(env("SIGNATURE_TYPE", env("FUNDER_ADDRESS", "") ? "1" : "0")),

  // Polygon RPC (链上余额查询)
  POLYGON_RPC: env("POLYGON_RPC", "https://1rpc.io/matic"),
};

export function updateConfig(updates: Partial<typeof Config>): void {
  Object.assign(Config, updates);
}
