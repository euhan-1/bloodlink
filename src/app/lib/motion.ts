import { useEffect, useRef, useState } from "react";

// Briefly returns true when `value` changes after the component's first
// render — used to trigger a short highlight/fade on a piece of UI whose
// underlying data just changed (e.g. a status badge flipping). Deliberately
// suppressed on mount: the first value isn't a "change," it's just the
// initial paint, and flashing every card on load would be noise, not signal.
export function useFlashOnChange<T>(value: T, durationMs = 280): boolean {
  const [flashing, setFlashing] = useState(false);
  const prevRef = useRef(value);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevRef.current = value;
      return;
    }
    if (prevRef.current === value) return;
    prevRef.current = value;
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), durationMs);
    return () => clearTimeout(t);
  }, [value, durationMs]);

  return flashing;
}
