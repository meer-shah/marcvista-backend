const crypto = require('crypto');

const getKey = () => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(key, 'hex');
};

/**
 * Encrypt a plaintext string using AES-256-CBC.
 * Returns a string in the format: <iv_hex>:<encrypted_hex>
 */
const encrypt = (text) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

const decrypt = (text) => {
  const parts = typeof text === 'string' ? text.split(':') : [];
  const looksEncrypted = parts.length === 2 && /^[0-9a-f]{32}$/i.test(parts[0]);

  if (!looksEncrypted) {
    throw new Error('Credential is not encrypted. Please delete and re-add your Bybit API connection.');
  }

  try {
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt API credential. Please delete and re-add your Bybit API connection.');
  }
};

module.exports = { encrypt, decrypt };
