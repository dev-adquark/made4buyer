"use client";

import { createContext, useCallback, useContext } from "react";

/**
 * Category slug → display name, provided once by the root layout. Client components (search
 * combobox, command palette) read names from here instead of importing lib/taxonomy/definitions,
 * which would pull the whole ~54 KB taxonomy into the shared client chunk.
 */
const CategoryNamesContext = createContext<Readonly<Record<string, string>>>({});

export function CategoryNamesProvider({ names, children }: { names: Readonly<Record<string, string>>; children: React.ReactNode }) {
  return <CategoryNamesContext.Provider value={names}>{children}</CategoryNamesContext.Provider>;
}

/** Returns a lookup `(slug) => name | undefined` (undefined for unknown or empty slugs). */
export function useCategoryName(): (slug: string | null | undefined) => string | undefined {
  const names = useContext(CategoryNamesContext);
  return useCallback((slug: string | null | undefined) => (slug ? names[slug] : undefined), [names]);
}
