import { useEffect, useRef, useState } from 'react';
import { fetchCalendarHeatmap } from './api';

export function useAdjacentCalendarDates(date: string | null, minYear: number, maxYear: number, refreshRevision = 0) {
  const years = useRef(new Map<number, string[]>());
  const cacheRevision = useRef(refreshRevision);
  const [result, setResult] = useState<{ date: string | null; revision: number; previous: string | null; next: string | null }>(
    { date: null, revision: refreshRevision, previous: null, next: null });

  useEffect(() => {
    if (cacheRevision.current !== refreshRevision) {
      // A manual refresh invalidates every cached year, including cross-year navigation candidates.
      years.current.clear();
      cacheRevision.current = refreshRevision;
    }
    if (!date) return;
    const selectedDate = date;
    const controller = new AbortController();
    let active = true;
    setResult({ date, revision: refreshRevision, previous: null, next: null });
    // Both directions share in-flight years; only successful, still-owned results enter the session cache.
    const requests = new Map<number, Promise<string[]>>();
    function loadYear(year: number): Promise<string[]> {
      const cached = years.current.get(year);
      if (cached) return Promise.resolve(cached);
      let request = requests.get(year);
      if (!request) {
        request = fetchCalendarHeatmap(year, null, controller.signal).then(data => {
          const days = data.days.filter(day => day.hasAssets === true).map(day => day.date).sort();
          if (active) years.current.set(year, days);
          return days;
        });
        requests.set(year, request);
      }
      return request;
    }
    async function find(direction: -1 | 1): Promise<string | null> {
      // A retained empty date may now precede Immich's minimum year after photos were removed.
      const selectedYear = Number(selectedDate.slice(0, 4));
      const firstYear = direction === -1 ? Math.min(selectedYear, maxYear) : Math.max(selectedYear, minYear);
      for (let year = firstYear; year >= minYear && year <= maxYear; year += direction) {
        const days = await loadYear(year);
        if (!active) return null;
        const candidate = direction === -1 ? days.filter(day => day < selectedDate).at(-1) : days.find(day => day > selectedDate);
        if (candidate) return candidate;
      }
      return null;
    }
    for (const [direction, field] of [[-1, 'previous'], [1, 'next']] as const) {
      void find(direction).then(candidate => {
        if (active) setResult(current => ({ ...current, [field]: candidate }));
      }).catch(() => {
        // A failed year cannot establish adjacency; keep that direction unavailable rather than skipping it.
      });
    }
    return () => { active = false; controller.abort(); };
  }, [date, minYear, maxYear, refreshRevision]);

  // Render-time ownership prevents old candidates from being actionable before effect cleanup runs.
  return result.date === date && result.revision === refreshRevision ? result : { date, previous: null, next: null };
}
