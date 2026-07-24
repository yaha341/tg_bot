import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components-ui/button";
import { Input } from "@/components-ui/input";
import { Label } from "@/components-ui/label";
import {
  createCategory,
  deleteCategory,
  listCategories,
  setCategoryVisible,
  updateCategory,
} from "@/lib/categories.functions";
import { getCategoryPath, sortCategoriesTree } from "@/lib/category-tree";
import { EmojiInsertBar, insertAtCursor } from "@/components-ui/emoji-insert-bar";

export const Route = createFileRoute("/admin/categories")({
  component: CategoriesPage,
});

type Cat = {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  is_visible?: boolean;
};

function CategoriesPage() {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => listCategories() });
  const list = useMemo(() => sortCategoriesTree((cats.data ?? []) as Cat[]), [cats.data]);
  const [editing, setEditing] = useState<Cat | null>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string>("");
  const [isVisible, setIsVisible] = useState(true);
  const nameInputRef = useRef<HTMLInputElement>(null);

  function insertEmoji(emoji: string) {
    const el = nameInputRef.current;
    const { next, cursor } = insertAtCursor(name, emoji, el?.selectionStart ?? null, el?.selectionEnd ?? null);
    setName(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursor, cursor);
    });
  }

  function reset() {
    setEditing(null);
    setName("");
    setParentId("");
    setIsVisible(true);
  }

  async function onSave() {
    if (!name.trim()) return;
    if (editing) {
      await updateCategory({
        data: {
          id: editing.id,
          name,
          parent_id: parentId || null,
          is_visible: isVisible,
        },
      });
    } else {
      await createCategory({
        data: { name, parent_id: parentId || null, is_visible: isVisible },
      });
    }
    reset();
    qc.invalidateQueries({ queryKey: ["categories"] });
  }

  async function onDelete(id: string) {
    if (
      !confirm(
        "Удалить категорию? Подкатегории тоже удалятся. Товары и файлы останутся; связь с этой папкой снимется.",
      )
    )
      return;
    await deleteCategory({ data: { id } });
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["products"] });
  }

  async function onToggleVisible(c: Cat) {
    const next = !(c.is_visible !== false);
    await setCategoryVisible({ data: { id: c.id, is_visible: next } });
    qc.invalidateQueries({ queryKey: ["categories"] });
  }

  function depthPrefix(c: Cat): string {
    let d = 0;
    let pid = c.parent_id;
    const byId = new Map(list.map((x) => [x.id, x]));
    while (pid) {
      d++;
      pid = byId.get(pid)?.parent_id ?? null;
      if (d > 20) break;
    }
    return d > 0 ? `${"— ".repeat(d)}` : "";
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Категории</h1>
      <p className="text-sm text-muted-foreground">
        Скрытые категории не показываются в каталоге бота, но товары и файлы сохраняются. Удобно для сезонных
        папок (1 сентября, День учителя).
      </p>
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-card border rounded-lg p-4 space-y-3">
          <h2 className="font-medium">{editing ? "Редактирование" : "Новая категория"}</h2>
          <div className="space-y-2">
            <Label>Название</Label>
            <Input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например: 📐 Математика"
            />
            <p className="text-xs text-muted-foreground">
              Эмодзи в названии отображаются в кнопках каталога бота. На ПК — кликните ниже или Win+. /
              Ctrl+Cmd+Space.
            </p>
            <EmojiInsertBar onInsert={insertEmoji} />
          </div>
          <div className="space-y-2">
            <Label>Родительская категория</Label>
            <select
              className="w-full border rounded-md h-9 px-2 bg-background"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">— Корневая —</option>
              {list
                .filter((c) => c.id !== editing?.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {depthPrefix(c)}
                    {c.name}
                    {c.is_visible === false ? " (скрыта)" : ""}
                  </option>
                ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isVisible} onChange={(e) => setIsVisible(e.target.checked)} />
            Видна в каталоге бота
          </label>
          <div className="flex gap-2">
            <Button onClick={onSave}>{editing ? "Сохранить" : "Создать"}</Button>
            {editing && (
              <Button variant="outline" onClick={reset}>
                Отмена
              </Button>
            )}
          </div>
        </div>

        <div className="bg-card border rounded-lg p-4">
          <h2 className="font-medium mb-3">Список (дерево)</h2>
          {list.length === 0 && <p className="text-sm text-muted-foreground">Пока пусто.</p>}
          <ul className="divide-y">
            {list.map((c) => {
              const hidden = c.is_visible === false;
              return (
                <li key={c.id} className="py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className={`font-medium ${hidden ? "text-muted-foreground" : ""}`}>
                      {depthPrefix(c)}
                      {c.name}
                      {hidden && (
                        <span className="ml-2 text-xs font-normal text-amber-700">скрыта</span>
                      )}
                    </div>
                    {c.parent_id && (
                      <div className="text-xs text-muted-foreground truncate">
                        {getCategoryPath(c.id, list)}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="outline" onClick={() => onToggleVisible(c)}>
                      {hidden ? "Показать" : "Скрыть"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(c);
                        setName(c.name);
                        setParentId(c.parent_id ?? "");
                        setIsVisible(c.is_visible !== false);
                      }}
                    >
                      Изм.
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => onDelete(c.id)}>
                      Удал.
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
