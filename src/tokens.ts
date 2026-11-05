/** Browser-safe, data-only token list. Addresses, not symbols, identify assets. */
export interface ListedToken {
  readonly chain_id: number
  readonly address: string
  readonly symbol: string
  readonly decimals: number
  readonly label: string
}

export const TOKENS: readonly ListedToken[] = [
  {
    "chain_id": 1,
    "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "symbol": "USDC",
    "decimals": 6,
    "label": "USDC"
  },
  {
    "chain_id": 1,
    "address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "symbol": "USDT",
    "decimals": 6,
    "label": "USDT"
  },
  {
    "chain_id": 1,
    "address": "0x6b175474e89094c44da98b954eedeac495271d0f",
    "symbol": "DAI",
    "decimals": 18,
    "label": "DAI"
  },
  {
    "chain_id": 1,
    "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "symbol": "WETH",
    "decimals": 18,
    "label": "WETH"
  },
  {
    "chain_id": 1,
    "address": "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
    "symbol": "WBTC",
    "decimals": 8,
    "label": "WBTC"
  },
  {
    "chain_id": 1,
    "address": "0x514910771af9ca656af840dff83e8264ecf986ca",
    "symbol": "LINK",
    "decimals": 18,
    "label": "LINK"
  },
  {
    "chain_id": 1,
    "address": "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
    "symbol": "UNI",
    "decimals": 18,
    "label": "UNI"
  },
  {
    "chain_id": 1,
    "address": "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9",
    "symbol": "AAVE",
    "decimals": 18,
    "label": "AAVE"
  },
  {
    "chain_id": 8453,
    "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "symbol": "USDC",
    "decimals": 6,
    "label": "USDC (Base)"
  },
  {
    "chain_id": 8453,
    "address": "0x4200000000000000000000000000000000000006",
    "symbol": "WETH",
    "decimals": 18,
    "label": "WETH (Base)"
  },
  {
    "chain_id": 84532,
    "address": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    "symbol": "USDC",
    "decimals": 6,
    "label": "USDC (Base Sepolia)"
  },
  {
    "chain_id": 84532,
    "address": "0x4200000000000000000000000000000000000006",
    "symbol": "WETH",
    "decimals": 18,
    "label": "WETH (Base Sepolia)"
  },
  {
    "chain_id": 42161,
    "address": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    "symbol": "USDC",
    "decimals": 6,
    "label": "USDC (Arbitrum)"
  },
  {
    "chain_id": 42161,
    "address": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    "symbol": "WETH",
    "decimals": 18,
    "label": "WETH (Arbitrum)"
  },
  {
    "chain_id": 137,
    "address": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    "symbol": "USDC",
    "decimals": 6,
    "label": "USDC (Polygon)"
  },
  {
    "chain_id": 137,
    "address": "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    "symbol": "WMATIC",
    "decimals": 18,
    "label": "WMATIC"
  },
  {
    "chain_id": 10,
    "address": "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    "symbol": "USDC",
    "decimals": 6,
    "label": "USDC (Optimism)"
  },
  {
    "chain_id": 10,
    "address": "0x4200000000000000000000000000000000000006",
    "symbol": "WETH",
    "decimals": 18,
    "label": "WETH (Optimism)"
  },
  {
    "chain_id": 1,
    "address": "0x4c36d2919e407f0cc2ee3c993ccf8ac26d9ce64e",
    "symbol": "wstETH",
    "decimals": 18,
    "label": "Lido wstETH"
  },
  {
    "chain_id": 1,
    "address": "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    "symbol": "stETH",
    "decimals": 18,
    "label": "Lido stETH"
  }
]
