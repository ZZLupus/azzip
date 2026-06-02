import { useState, useCallback } from "react";

export interface SavedPassword {
  id: string;
  label: string;
  value: string;
}

const STORAGE_KEY = "azzip_passwords";

function load(): SavedPassword[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(list: SavedPassword[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function usePasswordStore() {
  const [passwords, setPasswords] = useState<SavedPassword[]>(load);

  const add = useCallback((label: string, value: string) => {
    const entry: SavedPassword = { id: crypto.randomUUID(), label, value };
    setPasswords((prev) => {
      const next = [...prev, entry];
      save(next);
      return next;
    });
    return entry;
  }, []);

  const update = useCallback((id: string, label: string, value: string) => {
    setPasswords((prev) => {
      const next = prev.map((p) => (p.id === id ? { id, label, value } : p));
      save(next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setPasswords((prev) => {
      const next = prev.filter((p) => p.id !== id);
      save(next);
      return next;
    });
  }, []);

  return { passwords, add, update, remove };
}
