# Connecting MEXC Contract

Marcvista trades **USDT-margined perpetual contracts** on MEXC.

> **Important**: MEXC contract uses a DIFFERENT API key from MEXC spot. Generate yours at https://contract.mexc.com/account/api — NOT the main MEXC API page.

## 1. Create a MEXC account

- Real: https://www.mexc.com
- Demo: MEXC's contract sandbox lives at https://contract-testnet.mexc.com. Availability varies by region — if the sandbox doesn't load for you, use small real-money tests instead.

## 2. Create a Contract API key

1. Sign in → visit https://contract.mexc.com/account/api (or **Account** → **API Management** → **Contract API**).
2. **Add API**.
3. **Memo / Name**: `marcvista`.
4. **Permissions**:
   - ✅ **Read**
   - ✅ **Trade**
   - ❌ Leave **Withdraw** OFF.
5. **IP whitelist**: optional in sandbox, recommended in real.
6. Copy **Access Key** and **Secret Key**. **Secret is shown once.**

## 3. Paste into Marcvista

1. **Exchange** → **Connect MEXC**.
2. Paste Access Key (apiKey) + Secret.
3. Pick **Demo** (sandbox) or **Real**.
4. Save.

## 4. Activate

Trading Panel → exchange selector → **MEXC**.

## 5. Symbol format

You type `BTCUSDT`; Marcvista translates internally to MEXC's native `BTC_USDT`.

## 6. Fees

Perpetual contract rates:
- **Maker**: 0.00%
- **Taker**: 0.01%
- **TP/SL exits**: Taker.

These rates are unusually low — MEXC's main marketing pitch. They've been stable for years but are technically promotional. Reference: https://www.mexc.com/fee/

## Common issues

- **"-401 Signature for this request is not valid"** → Wrong API key environment (sandbox vs real), or system clock drift. MEXC enforces strict timestamp recency.
- **"-2011 Order would not match any opposite order"** → using PostOnly with a price that would cross; switch to GTC or move the limit further from market.
- **No demo data shown** → MEXC sandbox is region-restricted and intermittently unavailable. If you see "no data", switch to Real with a tiny test amount or skip MEXC until they restore your region.
- **"Margin mode locked"** → MEXC sets margin mode per-symbol on the order itself (`openType: 1` isolated / `2` cross). Marcvista uses cross by default. Margin mode can't be changed while a position is open.
