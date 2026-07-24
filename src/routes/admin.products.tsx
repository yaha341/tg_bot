import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components-ui/button";
import { Input } from "@/components-ui/input";
import { Label } from "@/components-ui/label";
import { Textarea } from "@/components-ui/textarea";
import {
  deleteProduct,
  getSignedUploadUrl,
  listCategoriesForProducts,
  listProducts,
  saveProduct,
} from "@/lib/products.functions";
import { listPaymentMethods } from "@/lib/payment-methods.functions";
import { filterCategoriesByQuery, getCategoryPath, sortCategoriesTree } from "@/lib/category-tree";

export const Route = createFileRoute("/admin/products")({
  component: ProductsPage,
});

type Img = { id?: string; image_path: string; sort_order: number };
type Product = {
  id?: string;
  category_id: string | null;
  category_ids: string[];
  name: string;
  description: string;
  keywords: string;
  price: number;
  currency: string;
  is_active: boolean;
  sort_order: number;
  file_path: string | null;
  file_name: string | null;
  file_path_kz?: string | null;
  file_name_kz?: string | null;
  product_images?: Img[];
  country_prices?: Record<string, number>;
};

const empty: Product = {
  category_id: null,
  category_ids: [],
  name: "",
  description: "",
  keywords: "",
  price: 0,
  currency: "KZT",
  is_active: true,
  sort_order: 0,
  file_path: null,
  file_name: null,
  file_path_kz: null,
  file_name_kz: null,
  product_images: [],
  country_prices: {},
};

// Карта расширений → MIME. Браузеры не знают тип для .7z и некоторых других
// архивов (отдают application/octet-stream), из-за чего Supabase с whitelist
// отклонял загрузку. Определяем тип по расширению файла.
const MIME_BY_EXT: Record<string, string> = {
  ".7z": "application/x-7z-compressed",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function mimeForFile(filename: string, fallback?: string): string {
  const ext = (filename.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  return MIME_BY_EXT[ext] || fallback || "application/octet-stream";
}

async function uploadFile(file: File, bucket: "product-images" | "product-files") {
  // 1. Получаем одноразовую ссылку для прямой загрузки от сервера
  const { path, name, signedUrl } = await getSignedUploadUrl({ data: { bucket, filename: file.name } });

  // 2. Грузим файл напрямую в Supabase в обход лимитов Vercel.
  // Для файлов товаров определяем Content-Type по расширению (надёжнее, чем
  // file.type, который пуст для .7z). Для картинок доверяем типу браузера.
  const contentType =
    bucket === "product-files" ? mimeForFile(file.name, file.type) : file.type || "application/octet-stream";

  const resUpload = await fetch(signedUrl, {
    method: "PUT",
    body: file,
    headers: {
      "Content-Type": contentType,
    },
  });
  if (!resUpload.ok) throw new Error(await resUpload.text());

  return { path, name };
}

function ProductsPage() {
  const qc = useQueryClient();
  const products = useQuery({ queryKey: ["products"], queryFn: () => listProducts() });
  const cats = useQuery({ queryKey: ["cats-flat"], queryFn: () => listCategoriesForProducts() });
  
  const pMethods = useQuery({
    queryKey: ["payment-methods-admin"],
    queryFn: () => listPaymentMethods(),
  });

  const list = (products.data ?? []) as any[];
  const [search, setSearch] = useState("");
  const [catQuery, setCatQuery] = useState("");
  const [editing, setEditing] = useState<Product | null>(null);
  const [images, setImages] = useState<Img[]>([]);
  const [saving, setSaving] = useState(false);

  const catsTree = useMemo(() => sortCategoriesTree((cats.data ?? []) as any[]), [cats.data]);
  const catsFiltered = useMemo(
    () => filterCategoriesByQuery(catsTree, catQuery),
    [catsTree, catQuery],
  );

  // Клиентская фильтрация по названию / ключевым словам / описанию.
  // 300+ товаров обрабатываются мгновенно, бэкенд-поиск не требуется.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => {
      const hay = [p.name, p.keywords, p.description].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [list, search]);

  function startNew() {
    setEditing({ ...empty });
    setImages([]);
  }
  function startEdit(p: any) {
    setEditing({
      id: p.id,
      category_id: p.category_id,
      category_ids: p.category_ids || (p.category_id ? [p.category_id] : []),
      name: p.name,
      description: p.description ?? "",
      keywords: p.keywords ?? "",
      price: Number(p.price),
      currency: p.currency,
      is_active: p.is_active,
      sort_order: p.sort_order,
      file_path: p.file_path,
      file_name: p.file_name,
      file_path_kz: p.file_path_kz,
      file_name_kz: p.file_name_kz,
      country_prices: p.country_prices || {},
    });
    const imgs = (p.product_images ?? []).slice().sort((a: Img, b: Img) => a.sort_order - b.sort_order);
    setImages(imgs);
  }

  async function onImagesChange(files: FileList | null) {
    if (!files) return;
    const uploaded: Img[] = [];
    try {
      for (const f of Array.from(files)) {
        const r = await uploadFile(f, "product-images");
        uploaded.push({ image_path: r.path, sort_order: images.length + uploaded.length });
      }
      setImages([...images, ...uploaded]);
    } catch (e: any) {
      alert("Ошибка загрузки фото: " + e.message);
    }
  }

  async function onFileChange(file: File | null) {
    if (!file) return;
    try {
      const r = await uploadFile(file, "product-files");
      setEditing((prev) => prev ? { ...prev, file_path: r.path, file_name: r.name } : prev);
    } catch (e: any) {
      alert("Ошибка загрузки файла: " + e.message);
    }
  }

  async function onFileChangeKz(file: File | null) {
    if (!file) return;
    try {
      const r = await uploadFile(file, "product-files");
      setEditing((prev) => prev ? { ...prev, file_path_kz: r.path, file_name_kz: r.name } : prev);
    } catch (e: any) {
      alert("Ошибка загрузки файла (KZ): " + e.message);
    }
  }

  async function onSave() {
    if (!editing) return;
    setSaving(true);
    try {
      await saveProduct({
        data: {
          id: editing.id,
          category_id: editing.category_id,
          category_ids: editing.category_ids,
          name: editing.name,
          description: editing.description,
          keywords: editing.keywords,
          price: Number(editing.price),
          currency: editing.currency,
          is_active: editing.is_active,
          sort_order: Number(editing.sort_order),
          file_path: editing.file_path,
          file_name: editing.file_name,
          file_path_kz: editing.file_path_kz,
          file_name_kz: editing.file_name_kz,
          image_paths: images.map((i) => i.image_path),
          country_prices: editing.country_prices,
        },
      });
      setEditing(null);
      setImages([]);
      qc.invalidateQueries({ queryKey: ["products"] });
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Удалить товар?")) return;
    await deleteProduct({ data: { id } });
    qc.invalidateQueries({ queryKey: ["products"] });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Товары</h1>
        {!editing && <Button onClick={startNew}>+ Новый товар</Button>}
      </div>

      {editing ? (
        <div className="bg-card border rounded-lg p-4 space-y-4">
          <h2 className="font-medium">{editing.id ? "Редактирование товара" : "Новый товар"}</h2>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Название</Label>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Категории (можно выбрать несколько)</Label>
              <Input
                value={catQuery}
                onChange={(e) => setCatQuery(e.target.value)}
                placeholder="Поиск категории…"
              />
              <div className="border rounded-md p-2 max-h-56 overflow-y-auto space-y-1 bg-background text-sm">
                {catsFiltered.map((c: any) => (
                  <label key={c.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={editing.category_ids.includes(c.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setEditing({ ...editing, category_ids: [...editing.category_ids, c.id] });
                        } else {
                          setEditing({
                            ...editing,
                            category_ids: editing.category_ids.filter((id) => id !== c.id),
                          });
                        }
                      }}
                    />
                    <span>
                      {getCategoryPath(c.id, catsTree)}
                      {c.is_visible === false ? (
                        <span className="text-xs text-amber-700"> (скрыта в боте)</span>
                      ) : null}
                    </span>
                  </label>
                ))}
                {catsFiltered.length === 0 && (
                  <div className="text-muted-foreground text-xs">
                    {catsTree.length === 0 ? "Нет доступных категорий" : "Ничего не найдено"}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Описание (обязательно для модерации Robokassa)</Label>
            <Textarea
              rows={4}
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              placeholder="Подробное описание материала для покупателя"
            />
            {!editing.description.trim() && (
              <p className="text-xs text-amber-600">Рекомендуется заполнить подробное описание товара/услуги.</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Ключевые слова (для поиска, через пробел или запятую)</Label>
            <Input
              value={editing.keywords}
              onChange={(e) => setEditing({ ...editing, keywords: e.target.value })}
            />
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Цена</Label>
              <Input
                type="number"
                value={editing.price}
                onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label>Валюта</Label>
              <Input
                value={editing.currency}
                onChange={(e) => setEditing({ ...editing, currency: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Порядок</Label>
              <Input
                type="number"
                value={editing.sort_order}
                onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Фото (можно несколько)</Label>
            <Input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => onImagesChange(e.target.files)}
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {images.map((im, idx) => (
                <div key={im.image_path} className="relative">
                  <img
                    src={`/api/public/img/${im.image_path}`}
                    alt=""
                    className="w-20 h-20 object-cover rounded border"
                  />
                  <button
                    type="button"
                    onClick={() => setImages(images.filter((_, i) => i !== idx))}
                    className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full w-5 h-5 text-xs"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          {pMethods.data && pMethods.data.length > 0 && (
            <div className="space-y-4 pt-4 border-t">
              <h3 className="font-medium">Цены для разных стран (вручную)</h3>
              <p className="text-xs text-muted-foreground">Если оставить поле пустым — будет работать автоматическая конвертация базовой цены.</p>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {pMethods.data.map((m) => (
                  <div key={m.country_code} className="space-y-2">
                    <Label>{m.country_name} ({m.currency})</Label>
                    <Input
                      type="number"
                      placeholder="Авто (по курсу)"
                      value={editing.country_prices?.[m.country_code] ?? ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        const newPrices = { ...editing.country_prices };
                        if (val === "") {
                          delete newPrices[m.country_code];
                        } else {
                          newPrices[m.country_code] = Number(val);
                        }
                        setEditing({ ...editing, country_prices: newPrices });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2 pt-4 border-t">
            <Label htmlFor="file-ru">📄 Файл товара (Русский)</Label>
            <Input id="file-ru" type="file" onChange={(e) => onFileChange(e.target.files?.[0] ?? null)} />
            {editing.file_name && (
              <p className="text-sm text-muted-foreground">📎 {editing.file_name}</p>
            )}
          </div>

          <div className="space-y-2 pt-4 border-t">
            <Label htmlFor="file-kz">📄 Файл товара (Қазақша)</Label>
            <Input id="file-kz" type="file" onChange={(e) => onFileChangeKz(e.target.files?.[0] ?? null)} />
            {editing.file_name_kz && (
              <p className="text-sm text-muted-foreground">📎 {editing.file_name_kz}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Если загрузить только Русский файл, бот не будет спрашивать язык при выдаче заказа.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editing.is_active}
              onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })}
            />
            Показывать в боте
          </label>

          <div className="flex gap-2">
            <Button onClick={onSave} disabled={saving}>
              {saving ? "Сохранение..." : "Сохранить"}
            </Button>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Отмена
            </Button>
          </div>
        </div>
      ) : (
        <>
        <div className="bg-card border rounded-lg p-4 space-y-3">
          <Label>🔍 Поиск по материалам</Label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Название, ключевое слово или описание…"
          />
          <p className="text-xs text-muted-foreground">
            Найдено: {filtered.length} из {list.length}
          </p>
        </div>
        <div className="bg-card border rounded-lg divide-y">
          {filtered.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">
              {list.length === 0 ? "Пока нет товаров." : "Ничего не найдено."}
            </div>
          )}
          {filtered.map((p) => (
            <div key={p.id} className="p-3 flex items-center gap-3">
              {p.product_images?.[0] ? (
                <img
                  src={`/api/public/img/${p.product_images[0].image_path}`}
                  className="w-12 h-12 object-cover rounded border shrink-0"
                  alt=""
                />
              ) : (
                <div className="w-12 h-12 bg-muted rounded shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {p.name} {!p.is_active && <span className="text-xs text-muted-foreground">(скрыт)</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {p.category_ids && p.category_ids.length > 0
                    ? p.category_ids
                        .map((id: string) => getCategoryPath(id, catsTree))
                        .filter(Boolean)
                        .join(", ") || "без категории"
                    : p.categories?.name || "без категории"} · {p.price} {p.currency}
                  {!p.file_path && !p.file_path_kz && <span className="text-destructive"> · нет файла</span>}
                  {p.file_path && p.file_path_kz && <span className="text-green-500"> · 🇷🇺🇰🇿</span>}
                  {p.file_path && !p.file_path_kz && <span className="text-muted-foreground"> · 🇷🇺</span>}
                  {!p.file_path && p.file_path_kz && <span className="text-muted-foreground"> · 🇰🇿</span>}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="outline" onClick={() => startEdit(p)}>
                  Изм.
                </Button>
                <Button size="sm" variant="destructive" onClick={() => onDelete(p.id)}>
                  Удал.
                </Button>
              </div>
            </div>
          ))}
        </div>
        </>
      )}
    </div>
  );
}