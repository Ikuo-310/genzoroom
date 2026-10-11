import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCalendarHeatmap } from './api';

type AdjacentDates = { previous: string | null; next: string | null };
type AdjacentResult = AdjacentDates & { date: string | null; revision: number };

export function useAdjacentCalendarDates(date: string | null, minYear: number, maxYear: number, refreshRevision = 0) {
  const years = useRef(new Map<number, string[]>());
  const cacheRevision = useRef(refreshRevision);
  const manualRefreshContext = useRef<{ date: string; revision: number; minYear: number } | null>(null);
  const latestDate = useRef(date);
  latestDate.current = date;
  const [result, setResult] = useState<AdjacentResult>({ date: null, revision: refreshRevision, previous: null, next: null });

  useEffect(() => {
    if (cacheRevision.current !== refreshRevision) {
      // Calendar refreshes invalidate candidates across dates, including cross-year navigation.
      years.current.clear();
      cacheRevision.current = refreshRevision;
    }
  }, [refreshRevision]);

  const loadAdjacent = useCallback(async (selectedDate: string, firstYear: number, min: number, max: number,
    signal: AbortSignal, cache: Map<number, string[]>, isCurrent: () => boolean,
    onCandidate?: (direction: keyof AdjacentDates, date: string | null) => void): Promise<AdjacentDates> => {
    const requests = new Map<number, Promise<string[]>>();
    function loadYear(year: number): Promise<string[]> {
      const cached = cache.get(year);
      if (cached) return Promise.resolve(cached);
      let request = requests.get(year);
      if (!request) {
        request = fetchCalendarHeatmap(year, null, signal).then(data => {
          const days = data.days.filter(day => day.hasAssets === true).map(day => day.date).sort();
          if (!signal.aborted && isCurrent()) cache.set(year, days);
          return days;
        });
        requests.set(year, request);
      }
      return request;
    }
    async function find(direction: -1 | 1): Promise<string | null> {
      // A retained empty date may now precede Immich's minimum year after photos were removed.
      const year = Number(selectedDate.slice(0, 4));
      const start = direction === -1 ? Math.min(year, max) : Math.max(year, min);
      for (let candidateYear = start; candidateYear >= min && candidateYear <= max; candidateYear += direction) {
        const days = await loadYear(candidateYear);
        if (signal.aborted || !isCurrent()) return null;
        const candidate = direction === -1 ? days.filter(day => day < selectedDate).at(-1) : days.find(day => day > selectedDate);
        if (candidate) return candidate;
      }
      return null;
    }
    const lookup = (direction: -1 | 1, field: keyof AdjacentDates) => find(direction).then(candidate => {
      if (isCurrent()) onCandidate?.(field, candidate);
      return candidate;
    });
    const settled = await Promise.allSettled([lookup(-1, 'previous'), lookup(1, 'next')]);
    const failure = settled.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return { previous: (settled[0] as PromiseFulfilledResult<string | null>).value,
      next: (settled[1] as PromiseFulfilledResult<string | null>).value };
  }, []);

  const refresh = useCallback(async (selectedDate: string, revision: number, refreshedMinYear: number, signal: AbortSignal) => {
    manualRefreshContext.current = { date: selectedDate, revision, minYear: refreshedMinYear };
    cacheRevision.current = revision;
    years.current.clear();
    setResult({ date: selectedDate, revision, previous: null, next: null });
    const result = await loadAdjacent(selectedDate, Number(selectedDate.slice(0, 4)), refreshedMinYear, maxYear,
      signal, years.current, () => latestDate.current === selectedDate);
    if (!signal.aborted && latestDate.current === selectedDate) setResult({ date: selectedDate, revision, ...result });
  }, [loadAdjacent, maxYear]);

  useEffect(() => {
    const manual = manualRefreshContext.current;
    if (manual?.date === date && manual.revision === refreshRevision && manual.minYear === minYear) return;
    if (manual && (manual.date !== date || manual.revision !== refreshRevision)) manualRefreshContext.current = null;
    if (!date) return;
    const selectedDate = date;
    const revision = refreshRevision;
    const controller = new AbortController();
    let active = true;
    setResult({ date, revision, previous: null, next: null });
    void loadAdjacent(selectedDate, Number(selectedDate.slice(0, 4)), minYear, maxYear, controller.signal,
      years.current, () => active && latestDate.current === selectedDate && cacheRevision.current === revision,
      (direction, candidate) => setResult(current => current.date === selectedDate && current.revision === revision
        ? { ...current, [direction]: candidate } : current))
      .then(adjacent => {
        if (active) setResult({ date: selectedDate, revision, ...adjacent });
      }).catch(() => {
        // Ordinary navigation keeps the existing unavailable-candidate behavior on a failed lookup.
      });
    return () => { active = false; controller.abort(); };
  }, [date, minYear, maxYear, loadAdjacent]);

  // Render-time ownership prevents old candidates from being actionable before effect cleanup runs.
  const dates = result.date === date && result.revision === refreshRevision
    ? result : { date, revision: refreshRevision, previous: null, next: null };
  return { ...dates, refresh };
}
