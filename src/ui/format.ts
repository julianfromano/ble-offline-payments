/** Formateo de montos para la UI (los protocolos siguen usando unidades menores). */

const FORMATTERS = new Map<string, Intl.NumberFormat>();

/** Formatea centavos como moneda localizada, ej. 150000 → "$ 1.500,00". */
export function formatAmount(minorUnits: number, currency: string): string {
  let fmt = FORMATTERS.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    });
    FORMATTERS.set(currency, fmt);
  }
  return fmt.format(minorUnits / 100);
}

/**
 * Parsea un monto ingresado en pesos ("1500", "1.500,50", "1500.50") a centavos.
 * Devuelve null si no es un monto válido y positivo.
 */
export function parseAmountToMinor(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Normalizar: quitar separadores de miles y unificar coma decimal a punto.
  let normalized = trimmed.replace(/\s|\$/g, '');
  if (/,\d{1,2}$/.test(normalized)) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = normalized.replace(/,/g, '');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const minor = Math.round(parseFloat(normalized) * 100);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
