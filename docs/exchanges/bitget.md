# Connecting Bitget USDT-M Futures

Marcvista trades **USDT-margined perpetual futures** on Bitget (v2 API, productType `USDT-FUTURES`).

## 1. Create a Bitget account

- Real: https://www.bitget.com
- Demo: Bitget calls it **Paper Trading**. Toggle from your account menu; generate a separate key under Paper Trading API.

## 2. Create an API key

1. Log in → **Personal Center** → **API Management** → **Create API**.
2. **API Name**: `marcvista`. **Passphrase**: invent one and save it.
3. **Permissions**:
   - ✅ **Read**
   - ✅ **Trade** (futures)
   - ❌ Leave **Withdraw** OFF.
4. **IP whitelist**: recommended in real.
5. 2FA → copy API Key, Secret, Passphrase. **Secret is shown once.**

> Paper-trading and live keys are issued from the same API page but are bound to the active mode at creation time. Switch your account mode BEFORE creating the key.

## 3. Paste into Marcvista

1. **Exchange** → **Connect Bitget**.
2. Paste API Key, Secret, **and Passphrase**.
3. Pick **Demo** (paper) or **Real**.
4. Save.

## 4. Activate

Trading Panel → exchange selector → **Bitget**.

## 5. Fees

VIP-0 USDT-M futures rates:
- **Maker**: 0.02%
- **Taker**: 0.06%
- **TP/SL exits**: Taker (Bitget triggers them as market orders).

Reference: https://www.bitget.com/support/articles/12560603803999

## Common issues

- **"40009 sign signature error"** → Passphrase wrong, system clock skewed, or trying to use paper-trading keys in real mode (or vice versa).
- **"40912 Insufficient balance"** → fund your USDT-M Futures sub-wallet (not Spot).
- **"40034 Parameter symbol error"** → symbol must include the suffix on legacy v1 keys; Marcvista uses v2 which accepts plain `BTCUSDT`. If you see this, regenerate the key under v2.
- **Position not closing on TP** → Bitget's TP/SL plan orders sit on the position; if you cancel them manually in Bitget UI, the position is unprotected. Marcvista doesn't re-add them automatically.
