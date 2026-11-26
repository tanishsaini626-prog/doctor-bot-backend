'use strict';
/* ==========================================================================
 * phone.js - Phone number normalization utilities
 * ========================================================================== */

/**
 * Normalizes phone numbers to standard E.164 format.
 * Strips whitespace, dashes, dots, parens, and any 'whatsapp:' prefix.
 * Normalizes 10-digit Indian numbers (and 11-digit numbers with leading 0)
 * to '+91XXXXXXXXXX'.
 *
 * @param {string} raw - raw input phone number
 * @returns {string} - normalized E.164 string (e.g. '+919876543210') or empty string
 */
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let str = raw.trim().replace(/^whatsapp:/i, '');
  str = str.replace(/[\s\-\.\(\)]/g, '');
  if (!str) return '';
  if (str.startsWith('+')) {
    return '+' + str.slice(1).replace(/\D/g, '');
  }
  if (str.startsWith('00')) {
    return '+' + str.slice(2).replace(/\D/g, '');
  }
  const digits = str.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) {
    return '+91' + digits;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return '+91' + digits.slice(1);
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    return '+' + digits;
  }
  return '+' + digits;
}

/**
 * Masks patient phone numbers for sensitive logging (F-08).
 * Preserves the first 4 characters and last 2 characters, masking middle digits.
 *
 * @param {string} phone - raw or normalized phone number
 * @returns {string} - masked string (e.g. '+919*******10')
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '(none)';
  const s = phone.trim();
  if (s.length <= 4) return '***';
  const start = s.slice(0, 4);
  const end = s.slice(-2);
  const mask = '*'.repeat(Math.max(s.length - 6, 3));
  return `${start}${mask}${end}`;
}

module.exports = { normalizePhone, maskPhone };

