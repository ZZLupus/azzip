import { useState, useCallback } from "react";

const STORAGE_KEY = "azzip_recent_files";
const MAX = 10;

export function useRecentFiles() {
  const [recents, setRecents] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); }
    catch { return []; }
  });

  const push = useCallback((path: string) => {
    setRecents((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, MAX);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setRecents([]);
  }, []);

  return { recents, push, clear };
}
