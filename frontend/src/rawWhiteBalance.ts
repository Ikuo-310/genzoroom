const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function displayTemperature(value: number, scale: string): number {
  if (scale !== 'legacy') return value;
  const relative = (1e6 / 6500 - 1e6 / value) / 0.8;
  return Math.round(clamp(relative, -100, 100));
}

export function nativeTemperature(value: number, scale: string): number {
  if (scale !== 'legacy') return value;
  const relative = clamp(value, -100, 100);
  return 1e6 / (1e6 / 6500 - 0.8 * relative);
}

export function displayTint(value: number): number {
  return Math.round(clamp(value, -100, 100));
}
