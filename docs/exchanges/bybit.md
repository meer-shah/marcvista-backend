# Connecting Bybit

Marcvista trades **USDT-margined linear perpetual futures** on Bybit.

## 1. Create a Bybit account

- Real: https://www.bybit.com
- Demo (recommended for first-time setup): https://demo.bybit.com — same UI, fake money.

## 2. Create an API key

1. Log in → click your avatar → **Profile** → **API**.
2. Click **Create New Key** → **System-generated API Keys**.
3. **Key Type**: select **API Transaction**.
4. **API Key Permissions**:
   - ✅ Contract — **Orders, Positions**
   - ✅ Unified Trading — **Trade**
   - ✅ Wallet — **Account Transfer** (optional, only if you want Marcvista to read your balance)
   - ❌ Leave **Withdraw** disabled. Marcvista never needs withdraw permission.
5. **IP Restriction**: optional but strongly recommended in production. Leave blank for demo.
6. Click **Submit** → solve the 2FA prompt → copy the **API Key** and **API Secret** immediately (the secret is shown only once).

## 3. Paste into Marcvista

1. Marcvista → **Exchange** → click **Connect Bybit**.
2. Paste your API Key and API Secret.
3. Pick **Demo** or **Real** to match the keys you generated.
4. Save.

## 4. Choose Bybit as your active exchange

Trading Panel → top-right exchange selector → **Bybit**.

From now on:
- All orders go to Bybit.
- Positions / pending orders / balance shown are from Bybit.
- Your risk-profile streak (currentrisk, daily SL counter) evolves from Bybit trades only.
- The chart switches to the Bybit price feed.

## 5. Fees

USDT linear perpetual rates (VIP-0):

- **Maker**: 0.02% — your limit price rests on the book without crossing the spread.
- **Taker**: 0.055% — your limit price crosses the spread and fills immediately.
- **TP/SL exits**: always Taker (Bybit triggers them as market orders).

Bybit reduces fees at higher 30-day volume and when holding their native token — see [Bybit Trading Fees](https://www.bybit.com/en/help-center/article/Trading-Fee-Structure).

## Common issues

- **"No API credentials configured"** → you saved the keys for the wrong mode (Demo vs Real). Re-paste under the right mode.
- **"Bybit API error: position mode mismatch"** → switch your Bybit account to **One-Way Mode** in Settings → Position Mode.
- **"TakeProfit too high"** → you typed extra zeros. TP/SL are absolute prices, not multipliers.
- **"Portfolio Margin mode"** → switch to Cross or Isolated Margin on Bybit; PM mode disables per-symbol leverage which Marcvista relies on.

## Withdrawal safety

Marcvista never asks for withdraw permission. If your key has withdraw permission and is compromised, your funds can be drained. **Do not enable Withdraw on the key you give Marcvista.**
