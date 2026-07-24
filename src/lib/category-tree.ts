/** Shared helpers for category trees in admin UI. */

export type CategoryNode = {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order?: number;
  is_visible?: boolean;
};

export function getCategoryPath(id: string, all: CategoryNode[]): string {
  const c = all.find((x) => x.id === id);
  if (!c) return id;
  if (!c.parent_id) return c.name;
  return getCategoryPath(c.parent_id, all) + " → " + c.name;
}

/** Roots first, then children nested under parents (DFS). Stable within level. */
export function sortCategoriesTree<T extends CategoryNode>(cats: T[]): T[] {
  const byParent = new Map<string | null, T[]>();
  for (const c of cats) {
    const key = c.parent_id ?? null;
    const arr = byParent.get(key) ?? [];
    arr.push(c);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => {
      const so = (a.sort_order ?? 0) - (b.sort_order ?? 0);
      if (so !== 0) return so;
      return a.name.localeCompare(b.name, "ru");
    });
  }
  const out: T[] = [];
  function walk(parentId: string | null) {
    for (const c of byParent.get(parentId) ?? []) {
      out.push(c);
      walk(c.id);
    }
  }
  walk(null);
  return out;
}

export function filterCategoriesByQuery<T extends CategoryNode>(cats: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return cats;
  return cats.filter((c) => {
    const path = getCategoryPath(c.id, cats).toLowerCase();
    return path.includes(q) || c.name.toLowerCase().includes(q);
  });
}
