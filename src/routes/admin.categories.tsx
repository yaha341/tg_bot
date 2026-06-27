import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from "@/lib/categories.functions";

export const Route = createFileRoute("/admin/categories")({
  component: CategoriesPage,
});

type Cat = { id: string; name: string; parent_id: string | null; sort_order: number };

function CategoriesPage() {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => listCategories() });
  const list = (cats.data ?? []) as Cat[];
  const [editing, setEditing] = useState<Cat | null>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string>("");

  function reset() {
    setEditing(null);
    setName("");
    setParentId("");
  }

  async function onSave() {
    if (!name.trim()) return;
    if (editing) {
      await updateCategory({ data: { id: editing.id, name, parent_id: parentId || null } });
    } else {
      await createCategory({ data: { name, parent_id: parentId || null } });
    }
    reset();
    qc.invalidateQueries({ queryKey: ["categories"] });
  }

  async function onDelete(id: string) {
    if (!confirm("Удалить категорию? Подкатегории тоже удалятся.")) return;
    await deleteCategory({ data: { id } });
    qc.invalidateQueries({ queryKey: ["categories"] });
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Категории</h1>
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-card border rounded-lg p-4 space-y-3">
          <h2 className="font-medium">{editing ? "Редактирование" : "Новая категория"}</h2>
          <div className="space-y-2">
            <Label>Название</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Математика" />
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
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
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
          <h2 className="font-medium mb-3">Список</h2>
          {list.length === 0 && <p className="text-sm text-muted-foreground">Пока пусто.</p>}
          <ul className="divide-y">
            {list.map((c) => {
              const parent = list.find((p) => p.id === c.parent_id);
              return (
                <li key={c.id} className="py-2 flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{c.name}</div>
                    {parent && (
                      <div className="text-xs text-muted-foreground">в «{parent.name}»</div>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(c);
                        setName(c.name);
                        setParentId(c.parent_id ?? "");
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