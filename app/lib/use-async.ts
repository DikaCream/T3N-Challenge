"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Async } from "./types.ts";

/**
 * Run an async task and expose it as an `Async<T>`.
 *
 * Deliberately minimal: no caching, no dedupe, no retry. Every panel here is
 * triggered by a person pressing a button or loading the page, so the only thing
 * that must be right is not setting state after unmount — which is what the
 * `cancelled` flag and the ref guard handle.
 */
export function useAsync<T>(
  task: () => Promise<T>,
  options: { auto?: boolean } = {},
): { value: Async<T>; run: () => Promise<void>; reset: () => void } {
  const [value, setValue] = useState<Async<T>>({ state: "idle" });

  // The task identity changes every render if a caller passes an inline arrow,
  // so it is held in a ref rather than listed as a dependency — otherwise
  // `auto` would re-fire on every render.
  const taskRef = useRef(task);
  taskRef.current = task;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setValue({ state: "loading" });
    try {
      const data = await taskRef.current();
      if (mounted.current) setValue({ state: "ready", data });
    } catch (error) {
      if (mounted.current) {
        setValue({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, []);

  const reset = useCallback(() => setValue({ state: "idle" }), []);

  const auto = options.auto === true;
  useEffect(() => {
    if (auto) void run();
    // Intentionally run once: `auto` is a mount-time decision, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  return { value, run, reset };
}
