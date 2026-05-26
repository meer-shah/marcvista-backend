# Connecting OKX Perpetual Swap

Marcvista trades **USDT-margined perpetual SWAP** contracts on OKX (v5 API).

## 1. Create an OKX account

- Real: https://www.okx.com
- Demo: same site → **Demo Trading** (top-right menu). Demo uses the SAME API host with a special header; you generate keys specifically under Demo Trading.

## 2. Create an API key

1. Log in → **Account** → **API**.
2. **Create V5 API Key**.
3. **Name**: `marcvista`. **Passphrase**: pick any string and save it — **you'll need to paste it into Marcvista alongside the key**.
4. **Permissions**:
   - ✅ **Trade** (covers reading positions and placing/cancelling orders)
   - ❌ Leave **Withdraw** OFF.
5. **IP whitelist**: optional in Demo, strongly recommended in Real. Add Marcvista's outbound IP.
6. Solve 2FA → copy the **API Key**, **Secret Key**, and **Passphrase**. The secret is shown once.

> Demo keys are generated under the same API page after you switch to Demo Trading mode. **Demo keys will NOT work against the real environment** — make sure you generate the right kind.

## 3. Paste into Marcvista

1. **Exchange** → click **Connect OKX**.
2. Paste API Key, Secret Key, **and Passphrase**.
3. Pick **Demo** or **Real**.
4. Save.

## 4. Choose OKX as your active exchange

Trading Panel → exchange selector → **OKX**. The chart switches to OKX feeds.

## 5. Symbol format

You type `BTCUSDT`; Marcvista translates internally to OKX's native `BTC-USDT-SWAP`. The symbol dropdown shows the canonical form.

## 6. Fees

VIP-0 perpetual rates:
- **Maker**: 0.02%
- **Taker**: 0.05%
- **TP/SL exits**: Taker (OKX triggers them as market orders).

Reference: https://www.okx.com/fees

## Common issues

- **"Invalid sign"** → Passphrase is wrong, OR you used demo keys against real, OR your system clock drifts more than 30 s.
- **"50004 Sub-account does not have permission"** → API key not granted Trade.
- **"51000 Parameter mismatch"** → instId mismatch — usually a symbol that doesn't exist as a SWAP (e.g. you typed something that's only listed as spot). Pick from the dropdown.
- **Positions show in wrong direction** → OKX has `long`/`short` posSide. Marcvista uses single-side mode; switch your OKX account to **Net Mode** in Trading Settings.
