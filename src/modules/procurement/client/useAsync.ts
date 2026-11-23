"use client";

import { type DependencyList, useEffect, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let active = true;
    setState((previous) => ({ data: previous.data, error: null, loading: true }));
    load()
      .then((data) => active && setState({ data, error: null, loading: false }))
      .catch((error: unknown) =>
        active && setState({ data: null, error: error instanceof Error ? error.message : "Request failed", loading: false }),
      );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
