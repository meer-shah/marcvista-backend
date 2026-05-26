# Connecting Binance USDT-M Futures

Marcvista trades USDT-margined **perpetual futures** on Binance (fapi).

## 1. Create a Binance account

- Real: https://www.binance.com
- Demo (testnet, recommended for first-time setup): https://testnet.binancefuture.com — **separate registration and separate API keys** from production.

## 2. Create an API key

1. Log in to Binance → click your avatar → **API Management**.
2. **Create API** → **System generated** → name it `marcvista`.
3. Complete the 2FA prompts.
4. **Permissions**:
   - ✅ **Enable Futures**
   - ❌ Leave **Enable Withdrawals** OFF. Marcvista never needs withdrawals.
   - ❌ Leave **Enable Spot & Margin Trading** OFF if you only trade perps.
5. **Restrict access to trusted IPs**: optional in demo, strongly recommended in real. Add your Marcvista host's outbound IP.
6. Copy the **API Key** and **Secret Key** immediately (the secret is shown once).

> Demo / testnet keys are generated separately at https://testnet.binancefuture.com → top-right user menu → **API Key**. They will NOT work against production and vice versa.

## 3. Paste into Marcvista

1. **Exchange** → click **Connect Binance**.
2. Paste API Key + Secret Key.
3. Pick **Demo** (testnet) or **Real** (production).
4. Save.

## 4. Choose Binance as your active exchange

Trading Panel → exchange selector → **Binance**. Risk profile, positions, balance, and chart switch to Binance.

## 5. Fees

USDT-M perpetual rates (VIP-0):
- **Maker**: 0.02%
- **Taker**: 0.05%
- Hold BNB and enable fee deduction in Binance settings for an additional 10% discount on perps.
- **TP/SL exits**: always Taker (Binance triggers them as market orders).

Reference: https://www.binance.com/en/fee/futureFee

## Behavior differences vs Bybit

- **TP/SL are separate orders**, not inline on the entry. Marcvista submits the entry, then immediately attaches a `STOP_MARKET` and `TAKE_PROFIT_MARKET` as `closePosition` triggers on your behalf. They appear in Binance's "Conditional Orders" list, not the regular open-orders list.
- **Leverage is set per-symbol per-account**, not on the order. Marcvista calls `/fapi/v1/leverage` when you click "Apply Leverage".

## Common issues

- **"APIError code=-2015"** → invalid API key for this environment. You're probably using testnet keys against production, or vice versa. Re-generate keys in the matching environment.
- **"Margin is insufficient"** → fund your USDT-M Futures wallet (Binance treats Spot and Futures wallets as separate).
- **"-4131 PERCENT_PRICE filter"** → your limit price is too far from mark. Move closer to live.
- **"APIError code=-1021"** → server-clock skew. Marcvista uses a 5000 ms `recvWindow`; if your machine clock drifts more than a few seconds, sync it.
