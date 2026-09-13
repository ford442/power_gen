/**
 * Formatters Utility Module
 * Number formatting and color utilities for scientific UI
 */

/**
 * Format a number with specified decimal places
 * @param value - Value to format
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted number
 */
export function formatNumber(value: number, decimals: number = 2): string {
  return value.toFixed(decimals);
}

/**
 * Format a large number with K/M suffix
 * @param value - Value to format
 * @returns Compact formatted number
 */
export function formatCompact(value: number): string {
  if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';
  return value.toString();
}

/**
 * Format current with sign and unit
 * @param mA - Current in milliamps
 * @returns Formatted current string
 */
export function formatCurrent(mA: number): string {
  const sign = mA >= 0 ? '+' : '';
  return `${sign}${mA.toFixed(0)}mA`;
}

/**
 * Interpolate between two hex colors
 * @param color1 - First color (hex format)
 * @param color2 - Second color (hex format)
 * @param factor - Interpolation factor (0-1)
 * @returns Interpolated hex color
 */
export function lerpColor(color1: string, color2: string, factor: number): string {
  const r1 = parseInt(color1.slice(1, 3), 16);
  const g1 = parseInt(color1.slice(3, 5), 16);
  const b1 = parseInt(color1.slice(5, 7), 16);

  const r2 = parseInt(color2.slice(1, 3), 16);
  const g2 = parseInt(color2.slice(3, 5), 16);
  const b2 = parseInt(color2.slice(5, 7), 16);

  const r = Math.round(r1 + (r2 - r1) * factor);
  const g = Math.round(g1 + (g2 - g1) * factor);
  const b = Math.round(b1 + (b2 - b1) * factor);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
