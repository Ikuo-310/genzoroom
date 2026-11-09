import { useEffect, useState } from 'react';
import { getDevelopmentEngine, type DevelopmentEngine } from './developmentPolicyApi';

export type DevelopmentEngineState = { engine: DevelopmentEngine | null; loading: boolean };

export function useDevelopmentEngine(): DevelopmentEngineState {
  const [state, setState] = useState<DevelopmentEngineState>({ engine: null, loading: true });
  useEffect(() => {
    const controller = new AbortController();
    void getDevelopmentEngine(controller.signal).then(
      engine => setState({ engine, loading: false }),
      () => { if (!controller.signal.aborted) setState({ engine: null, loading: false }); },
    );
    return () => controller.abort();
  }, []);
  return state;
}
