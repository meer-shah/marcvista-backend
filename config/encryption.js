const crypto = require('crypto');

const getKey = () => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(key, 'hex');
};

/**
 * Encrypt a plaintext string using AES-256-GCM (authenticated encryption).
 *
 * GCM replaces the previous AES-256-CBC scheme: CBC provides confidentiality
 * only and is malleable — an attacker with DB write access could tamper with
 * stored ciphertext undetected. GCM adds an authentication tag so any
 * modification is caught at decrypt time. For exchange API secret keys this
 * integrity guarantee matters.
 *
 * Returns: <iv_hex>:<authTag_hex>:<ciphertext_hex>
 *   - iv      = 12 bytes (24 hex chars)  — GCM standard nonce length
 *   - authTag = 16 bytes (32 hex chars)
 *
 * Backward compatibility: decrypt() still reads the legacy 2-part CBC format
 * (<iv_hex>:<ciphertext_hex>, 16-byte IV) so credentials saved before this
 * change keep working without a migration. New writes are always GCM.
 */
const encrypt = (text) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
};

// New GCM format: iv(12B=24hex) : tag(16B=32hex) : ciphertext
const isGcmFormat = (parts) =>
  parts.length === 3 && /^[0-9a-f]{24}$/i.test(parts[0]) && /^[0-9a-f]{32}$/i.test(parts[1]);

// Legacy CBC format: iv(16B=32hex) : ciphertext
const isCbcFormat = (parts) =>
  parts.length === 2 && /^[0-9a-f]{32}$/i.test(parts[0]);

const decrypt = (text) => {
  const parts = typeof text === 'string' ? text.split(':') : [];

  if (!isGcmFormat(parts) && !isCbcFormat(parts)) {
    throw new Error('Credential is not encrypted. Please delete and re-add your Bybit API connection.');
  }

  try {
    if (isGcmFormat(parts)) {
      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encryptedText = Buffer.from(parts[2], 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
    }
    // Legacy AES-256-CBC path
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt API credential. Please delete and re-add your Bybit API connection.');
  }
};

module.exports = { encrypt, decrypt };