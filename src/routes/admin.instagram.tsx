import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCapabilitiesFn } from "@/lib/capabilities.functions";
import { useState } from "react";
import { Button } from "@/components-ui/button";
import { Input } from "@/components-ui/input";
import { Label } from "@/components-ui/label";
import { Textarea } from "@/components-ui/textarea";
import { Checkbox } from "@/components-ui/checkbox";
import {
  getInstagramConnectUrlFn,
  getInstagramAccountsFn,
  registerInstagramWebhookFn,
  getAutomationsFn,
  saveAutomationFn,
  deleteAutomationFn,
  toggleAutomationFn,
  getInstagramLogsFn,
  getZernioPostsFn,
  disconnectInstagramAccountFn,
} from "@/lib/instagram.functions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components-ui/select";
import { 
  ImageIcon, 
  X, 
  Settings2, 
  MessageSquare, 
  Zap, 
  Plus, 
  RefreshCcw, 
  Trash2, 
  Play, 
  Pause,
  ExternalLink,
  History,
  Eye,
  Info
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components-ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components-ui/card";
import { Badge } from "@/components-ui/badge";

export const Route = createFileRoute("/admin/instagram")({
  beforeLoad: async () => {
    const modules = await getCapabilitiesFn();
    if (!modules.instagram) throw redirect({ to: "/admin" });
  },
  head: () => ({ meta: [{ title: "Instagram Automation — Zernio" }] }),
  component: AdminInstagramPage,
});

function AdminInstagramPage() {
  const qc = useQueryClient();

  const accountsQuery = useQuery({ queryKey: ["ig_accounts"], queryFn: () => getInstagramAccountsFn() });
  const automationsQuery = useQuery({ queryKey: ["ig_automations"], queryFn: () => getAutomationsFn() });
  const logsQuery = useQuery({ queryKey: ["ig_logs"], queryFn: () => getInstagramLogsFn() });
  
  const accounts = accountsQuery.data?.accounts || [];
  const acc = accounts[0];
  const displayProfile = (profile: any) => {
    if (!profile) return "default";
    if (typeof profile === "string") return profile;
    return profile.name || profile._id || "default";
  };
  
  const postsQuery = useQuery({ 
    queryKey: ["ig_posts", acc?._id], 
    queryFn: () => getZernioPostsFn({ data: { accountId: acc?._id } }), 
    enabled: !!acc?._id 
  });

  const [connecting, setConnecting] = useState(false);
  const [registeringWebhook, setRegisteringWebhook] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const handleDisconnectAccount = async (accountId: string, accountName: string) => {
    if (!confirm(`Отключить аккаунт "${accountName}"? Все автоматизации для этого аккаунта перестанут работать.`)) return;
    setDisconnecting(accountId);
    setStatusMsg(null);
    try {
      const res = await disconnectInstagramAccountFn({ data: { accountId } });
      if (res?.ok) {
        setStatusMsg("✅ Аккаунт успешно отключён.");
        qc.invalidateQueries({ queryKey: ["ig_accounts"] });
        qc.invalidateQueries({ queryKey: ["ig_posts"] });
      } else {
        setStatusMsg("❌ Не удалось отключить аккаунт.");
      }
    } catch (e: any) {
      setStatusMsg(`Ошибка отключения: ${e.message}`);
    } finally {
      setDisconnecting(null);
    }
  };

  // Form state
  const [title, setTitle] = useState("");
  const [keywordsStr, setKeywordsStr] = useState("");
  const [replyToAll, setReplyToAll] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [dmText, setDmText] = useState("");
  const [postId, setPostId] = useState("ALL_POSTS");
  const [isActive, setIsActive] = useState(true);
  const [trigger, setTrigger] = useState<"comment" | "story_reply">("comment");
  const [buttons, setButtons] = useState<any[]>([]);
  const [dmVariations, setDmVariations] = useState<string[]>([]);
  const [replyVariations, setReplyVariations] = useState<string[]>([]);
  const [linkTracking, setLinkTracking] = useState(true);
  const [clickTag, setClickTag] = useState("");
  const [savingAuto, setSavingAuto] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [originalPlatformPostId, setOriginalPlatformPostId] = useState<string | null>(null);
  const [originalTrigger, setOriginalTrigger] = useState<"comment" | "story_reply">("comment");

  const handleRefreshPosts = () => {
    qc.invalidateQueries({ queryKey: ["ig_posts"] });
  };

  const handleConnect = async () => {
    setConnecting(true);
    setStatusMsg(null);
    try {
      const res = await getInstagramConnectUrlFn();
      if (res?.authUrl) {
        window.open(res.authUrl, "_blank");
        setStatusMsg("Ссылка авторизации открыта в новой вкладке.");
      } else {
        setStatusMsg("Ошибка: не удалось получить ссылку авторизации.");
      }
    } catch (e: any) {
      setStatusMsg(`Ошибка подключения: ${e.message}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleRegisterWebhook = async () => {
    setRegisteringWebhook(true);
    setStatusMsg(null);
    try {
      const res = await registerInstagramWebhookFn();
      if (res?.ok) {
        setStatusMsg("✅ Соединение успешно обновлено!");
      } else {
        setStatusMsg("❌ Ошибка при обновлении соединения.");
      }
    } catch (e: any) {
      setStatusMsg(`Ошибка: ${e.message}`);
    } finally {
      setRegisteringWebhook(false);
    }
  };

  const handleSaveAutomation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    if (!accountsQuery.data?.accounts || accountsQuery.data.accounts.length === 0) {
      alert("Нет подключенных аккаунтов Instagram!");
      return;
    }
    const acc = accountsQuery.data.accounts[0];
    
    setSavingAuto(true);
    try {
      const keywords = keywordsStr
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);

      const posts = postsQuery.data?.posts || [];
      const selectedPost = posts.find((p: any) => (p.platformPostId || p._id || p.id) === postId);

      const automationData = {
        id: editingId || undefined,
        originalPlatformPostId,
        originalTrigger,
        accountId: acc._id,
        profileId: typeof acc.profileId === "string" ? acc.profileId : acc.profileId?._id || "",
        name: title,
        trigger,
        keywords,
        replyToAll,
        matchMode: "contains" as const,
        dmMessage: dmText,
        commentReply: replyText,
        platformPostId: (postId && postId !== "ALL_POSTS") ? (selectedPost?.platformPostId || postId.trim()) : null,
        postId: (postId && postId !== "ALL_POSTS") ? (selectedPost?._zernioPostId || selectedPost?._id || selectedPost?.id || null) : null,
        postTitle: selectedPost ? String(selectedPost.caption || selectedPost.content || "").slice(0, 500) : undefined,
        buttons: buttons.length > 0 ? buttons : undefined,
        dmMessageVariations: dmVariations.filter(Boolean),
        commentReplyVariations: replyVariations.filter(Boolean),
        linkTracking,
        clickTag: clickTag || undefined,
        isActive,
      };

      const result = await saveAutomationFn({ data: automationData });
      if (!result?.ok) throw new Error("Zernio отклонил создание правила. Старое правило сохранено.");

      handleResetForm();
      qc.invalidateQueries({ queryKey: ["ig_automations"] });
    } catch (e: any) {
      alert(`Ошибка сохранения: ${e.message}`);
    } finally {
      setSavingAuto(false);
    }
  };

  const handleResetForm = () => {
    setTitle("");
    setKeywordsStr("");
    setReplyToAll(false);
    setReplyText("");
    setDmText("");
    setPostId("ALL_POSTS");
    setIsActive(true);
    setTrigger("comment");
    setButtons([]);
    setDmVariations([]);
    setReplyVariations([]);
    setLinkTracking(true);
    setClickTag("");
    setEditingId(null);
    setOriginalPlatformPostId(null);
    setOriginalTrigger("comment");
  };

  const handleEditAutomation = (auto: any) => {
    setEditingId(auto.id);
    setOriginalPlatformPostId(auto.platformPostId || null);
    setOriginalTrigger(auto.trigger || "comment");
    setTitle(auto.name || "");
    setKeywordsStr(auto.keywords?.join(", ") || "");
    setReplyToAll(!!auto.replyToAll);
    setReplyText(auto.commentReply || "");
    setDmText(auto.dmMessage || "");
    setPostId(auto.platformPostId || auto.postId || "ALL_POSTS");
    setIsActive(auto.isActive);
    setTrigger(auto.trigger || "comment");
    setButtons(auto.buttons || []);
    setDmVariations(auto.dmMessageVariations || []);
    setReplyVariations(auto.commentReplyVariations || []);
    setLinkTracking(auto.linkTracking !== false);
    setClickTag(auto.clickTag || "");
    
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleAddButton = () => {
    if (buttons.length >= 3) return;
    setButtons([...buttons, { type: "url", title: "Купить", url: "" }]);
  };

  const handleRemoveButton = (index: number) => {
    setButtons(buttons.filter((_, i) => i !== index));
  };

  const handleUpdateButton = (index: number, field: string, value: string) => {
    const newButtons = [...buttons];
    newButtons[index] = { ...newButtons[index], [field]: value };
    setButtons(newButtons);
  };

  const handleToggleAutomation = async (id: string, currentIsActive: boolean) => {
    try {
      await toggleAutomationFn({ data: { id, isActive: !currentIsActive } });
      qc.invalidateQueries({ queryKey: ["ig_automations"] });
    } catch (e: any) {
      alert(`Ошибка переключения: ${e.message}`);
    }
  };

  const handleDeleteAutomation = async (id: string) => {
    if (!confirm("Удалить эту автоматизацию?")) return;
    try {
      await deleteAutomationFn({ data: { id } });
      qc.invalidateQueries({ queryKey: ["ig_automations"] });
    } catch (e: any) {
      alert(`Ошибка удаления: ${e.message}`);
    }
  };

  const automations = automationsQuery.data?.automations || [];
  const logs = logsQuery.data?.logs || [];
  const posts = postsQuery.data?.posts || [];

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-8 pb-20">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-6">
        <div className="space-y-1">
          <h1 className="text-3xl font-extrabold tracking-tight">Instagram Automation</h1>
          <p className="text-muted-foreground flex items-center gap-2">
            <Badge variant="outline" className="bg-green-500/5 text-green-600 border-green-500/20">Zernio API v1</Badge>
            Управление автоответами, Direct и CRM-лидами
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleRegisterWebhook} disabled={registeringWebhook} size="sm">
            {registeringWebhook ? <RefreshCcw className="w-4 h-4 mr-2 animate-spin" /> : <Zap className="w-4 h-4 mr-2" />}
            Обновить Webhook
          </Button>
          <Button onClick={handleConnect} disabled={connecting} size="sm">
            <Plus className="w-4 h-4 mr-2" />
            Подключить аккаунт
          </Button>
        </div>
      </header>

      {statusMsg && (
        <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-lg text-sm flex items-center gap-3">
          <Info className="w-5 h-5 shrink-0" />
          {statusMsg}
        </div>
      )}

      <Tabs defaultValue="automations" className="space-y-6">
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          <TabsTrigger value="automations" className="gap-2">
            <Settings2 className="w-4 h-4" /> Автоматизации
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <History className="w-4 h-4" /> Журнал
          </TabsTrigger>
          <TabsTrigger value="accounts" className="gap-2">
            <MessageSquare className="w-4 h-4" /> Аккаунты
          </TabsTrigger>
        </TabsList>

        {/* AUTOMATIONS TAB */}
        <TabsContent value="automations" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Editor Side */}
            <div className="lg:col-span-5 space-y-6">
              <Card className="shadow-sm border-primary/10">
                <CardHeader>
                  <CardTitle className="text-xl flex items-center gap-2">
                    {editingId ? <Settings2 className="w-5 h-5 text-primary" /> : <Plus className="w-5 h-5 text-primary" />}
                    {editingId ? "Редактировать правило" : "Новая автоматизация"}
                  </CardTitle>
                  <CardDescription>
                    Настройте триггер и автоматический ответ
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleSaveAutomation} className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="auto_title">Название</Label>
                      <Input 
                        id="auto_title" 
                        value={title} 
                        onChange={(e) => setTitle(e.target.value)} 
                        placeholder="Напр: Рассылка чек-листа"
                        required 
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Триггер</Label>
                        <Select value={trigger} onValueChange={(v: any) => { setTrigger(v); setPostId("ALL_POSTS"); }}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="comment">💬 Комментарий</SelectItem>
                            <SelectItem value="story_reply">📱 Ответ на Story</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Ключевые слова</Label>
                        <Input 
                          value={keywordsStr} 
                          onChange={(e) => setKeywordsStr(e.target.value)} 
                          placeholder={replyToAll ? "Отвечает на все" : "хочу, инфо, +"}
                          disabled={replyToAll}
                        />
                      </div>
                    </div>

                    <div className="flex items-center space-x-2 py-1">
                      <Checkbox 
                        id="reply_to_all" 
                        checked={replyToAll} 
                        disabled={!postId || postId === "ALL_POSTS"}
                        onCheckedChange={(v: boolean) => setReplyToAll(v)} 
                      />
                      <Label 
                        htmlFor="reply_to_all" 
                        className={`text-sm font-medium leading-none cursor-pointer ${(!postId || postId === "ALL_POSTS") ? "opacity-50" : ""}`}
                      >
                        Отвечать на все комментарии (без ключевых слов)
                        {(!postId || postId === "ALL_POSTS") && (
                          <span className="block text-[10px] text-muted-foreground font-normal mt-1">
                            Доступно только при выборе конкретного поста
                          </span>
                        )}
                      </Label>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>{trigger === "story_reply" ? "Целевая Story" : "Целевой пост"}</Label>
                        <Button type="button" variant="ghost" size="sm" onClick={handleRefreshPosts} className="h-6 text-[10px] px-2">
                          <RefreshCcw className="w-3 h-3 mr-1" /> Обновить список
                        </Button>
                      </div>
                      <Select value={postId} onValueChange={setPostId}>
                        <SelectTrigger className="h-auto py-2">
                          <SelectValue placeholder="Выберите объект" />
                        </SelectTrigger>
                        <SelectContent className="max-h-[300px]">
                          <SelectItem value="ALL_POSTS">
                            {trigger === "story_reply" ? "✨ Любая Story" : "✨ Любой пост"}
                          </SelectItem>
                          {posts
                            .filter((p: any) => trigger === "story_reply" ? p._isStory : !p._isStory)
                            .map((p: any) => (
                              <SelectItem key={p.platformPostId || p._id || p.id} value={p.platformPostId || p._id || p.id}>
                                <div className="flex items-center gap-3 py-1 max-w-[300px]">
                                  {p._thumbnail ? (
                                    <img src={p._thumbnail} className="w-8 h-8 object-cover rounded shrink-0 bg-muted" alt="" />
                                  ) : (
                                    <div className="w-8 h-8 bg-muted rounded flex items-center justify-center shrink-0">
                                      <ImageIcon className="w-4 h-4 opacity-40" />
                                    </div>
                                  )}
                                  <div className="flex flex-col min-w-0 text-left">
                                    <span className="text-[9px] text-muted-foreground font-bold uppercase">
                                      {p._date ? new Date(p._date).toLocaleDateString("ru-RU") : "Нет даты"}
                                    </span>
                                    <span className="text-xs truncate font-medium">
                                      {p.caption || p.content || (p._isStory ? "Story без текста" : "Без текста")}
                                    </span>
                                  </div>
                                </div>
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-4 border-t pt-4">
                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <MessageSquare className="w-4 h-4 text-primary" /> Публичный ответ
                        </Label>
                        <Textarea 
                          value={replyText} 
                          onChange={(e) => setReplyText(e.target.value)} 
                          placeholder="Ответили вам в Директ! 📩"
                          rows={2}
                        />
                        <div className="bg-muted/30 p-2 rounded text-[10px] space-y-1">
                          <span className="text-muted-foreground font-semibold uppercase">Вариации для анти-спама:</span>
                          <Textarea 
                            className="text-[11px] min-h-[40px] bg-transparent border-none focus-visible:ring-0 p-0"
                            placeholder="Одна вариация на строку..."
                            value={replyVariations.join("\n")}
                            onChange={(e) => setReplyVariations(e.target.value.split("\n"))}
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <Zap className="w-4 h-4 text-primary" /> Личное сообщение (DM)
                        </Label>
                        <Textarea 
                          value={dmText} 
                          onChange={(e) => setDmText(e.target.value)} 
                          placeholder="Привет! Вот ссылка на материал..."
                          rows={3}
                        />
                        
                        {/* Buttons inside DM */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold uppercase text-muted-foreground">Кнопки в DM ({buttons.length}/3)</span>
                                            <Button type="button" variant="outline" size="sm" onClick={handleAddButton} disabled={buttons.length >= 3} className="h-7 text-[10px]">
                  + Добавить
                </Button>

                          </div>
                          <div className="grid grid-cols-1 gap-2">
                            {buttons.map((btn, i) => (
                              <div key={i} className="flex items-start gap-2 p-2 border rounded-md bg-muted/20 relative group">
                                <div className="flex-1 grid grid-cols-2 gap-2">
                                  <Input 
                                    value={btn.title} 
                                    onChange={(e) => handleUpdateButton(i, "title", e.target.value)} 
                                    placeholder="Текст" 
                                    className="h-7 text-[11px]"
                                  />
                                  <Select value={btn.type} onValueChange={(v) => handleUpdateButton(i, "type", v)}>
                                    <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="url">🔗 URL</SelectItem>
                                      <SelectItem value="postback">🤖 CMD</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  {btn.type === "url" && (
                                    <Input 
                                      value={btn.url} 
                                      onChange={(e) => handleUpdateButton(i, "url", e.target.value)} 
                                      placeholder="https://..." 
                                      className="h-7 text-[11px] col-span-2"
                                    />
                                  )}
                                </div>
                                <Button type="button" variant="ghost" size="sm" onClick={() => handleRemoveButton(i)} className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100">
                                  <X className="w-3 h-3" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        </div>

                      </div>
                    </div>

                    <div className="pt-4 border-t space-y-4">
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <Checkbox id="trk" checked={linkTracking} onCheckedChange={(v) => setLinkTracking(!!v)} />
                          <Label htmlFor="trk" className="cursor-pointer">Трекинг ссылок</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox id="act" checked={isActive} onCheckedChange={(v) => setIsActive(!!v)} />
                          <Label htmlFor="act" className="cursor-pointer">Активно</Label>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button type="submit" className="flex-1" disabled={savingAuto}>
                          {savingAuto ? "Сохранение..." : editingId ? "Сохранить изменения" : "Создать автоматизацию"}
                        </Button>
                        {editingId && (
                          <Button variant="ghost" onClick={handleResetForm}>Отмена</Button>
                        )}
                      </div>
                    </div>
                  </form>
                </CardContent>
              </Card>
            </div>

            {/* List Side */}
            <div className="lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-lg">Активные правила ({automations.length})</h3>
              </div>

              {automations.length === 0 ? (
                <div className="border-2 border-dashed rounded-xl p-12 text-center space-y-3 bg-muted/10">
                  <div className="bg-muted w-12 h-12 rounded-full flex items-center justify-center mx-auto">
                    <Zap className="w-6 h-6 text-muted-foreground" />
                  </div>
                  <div className="text-sm font-medium">Нет активных автоматизаций</div>
                  <p className="text-xs text-muted-foreground max-w-[200px] mx-auto">
                    Создайте свое первое правило в панели слева
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {automations.map((auto: any) => (
                    <Card key={auto.id} className={`transition-all ${auto.isActive ? 'border-l-4 border-l-primary' : 'opacity-70'}`}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-bold truncate">{auto.name}</span>
                              {!auto.isActive && <Badge variant="secondary" className="text-[9px] h-4">Пауза</Badge>}
                              {auto.trigger === "story_reply" && <Badge variant="outline" className="text-[9px] h-4 bg-purple-50 text-purple-600 border-purple-200">Story</Badge>}
                            </div>
                            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Zap className="w-3 h-3" /> {auto.stats?.triggered || 0}
                              </span>
                              {auto.stats?.linkClicks > 0 && (
                                <span className="flex items-center gap-1 text-blue-600 font-medium">
                                  <ExternalLink className="w-3 h-3" /> {auto.stats.linkClicks} кликов
                                </span>
                              )}
                              <span className="truncate flex items-center gap-1">
                                • {auto.replyToAll ? (
                                  <Badge variant="outline" className="text-[9px] h-4 bg-primary/5 text-primary border-primary/20">Отвечать всем</Badge>
                                ) : (
                                  <>Ключи: {auto.keywords?.length ? auto.keywords.join(", ") : "Любые"}</>
                                )}
                              </span>
                            </div>
                            {auto.platformPostId && (
                              <div className="text-[10px] bg-muted/50 px-2 py-1 rounded inline-block mt-1 truncate max-w-full">
                                Target: {auto.platformPostId}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEditAutomation(auto)}>
                              <Settings2 className="w-4 h-4" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleToggleAutomation(auto.id, auto.isActive)}>
                              {auto.isActive ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50" onClick={() => handleDeleteAutomation(auto.id)}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* LOGS TAB */}
        <TabsContent value="logs">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Журнал событий</CardTitle>
                <CardDescription>Последние действия автоматизации</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["ig_logs"] })}>
                <RefreshCcw className="w-4 h-4 mr-2" /> Обновить
              </Button>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="p-3 text-left font-medium">Время</th>
                      <th className="p-3 text-left font-medium">Событие</th>
                      <th className="p-3 text-left font-medium">Статус</th>
                      <th className="p-3 text-right font-medium">Действие</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {logs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="p-8 text-center text-muted-foreground">Логов пока нет</td>
                      </tr>
                    ) : (
                      logs.map((log: any) => (
                        <tr key={log.id} className="hover:bg-muted/20 transition-colors">
                          <td className="p-3 text-xs whitespace-nowrap">
                            {new Date(log.created_at).toLocaleString("ru-RU", { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="p-3">
                            <div className="flex flex-col">
                              <span className="font-mono text-[11px] uppercase">{log.event_type}</span>
                              {log.payload?.data?.senderUsername && (
                                <span className="text-[10px] text-primary">@{log.payload.data.senderUsername}</span>
                              )}
                              {log.payload?.data?.commentText && (
                                <span className="text-[10px] italic text-muted-foreground truncate max-w-[200px]">
                                  "{log.payload.data.commentText}"
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-3">
                            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-[10px]">
                              {log.status}
                            </Badge>
                          </td>
                          <td className="p-3 text-right">
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => alert(JSON.stringify(log.payload, null, 2))}>
                              <Eye className="w-3 h-3" />
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ACCOUNTS TAB */}
        <TabsContent value="accounts">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {Array.isArray(accounts) && accounts.length > 0 ? (
              accounts.map((account: any) => (
                <Card key={account._id || Math.random().toString()}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg">{account.name || account.username || "Instagram Account"}</CardTitle>
                      <Badge className="bg-green-600 text-white border-none">Активен</Badge>
                    </div>
                    <CardDescription>ID: {account._id || "N/A"}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div className="p-3 bg-muted rounded-lg">
                        <div className="text-muted-foreground mb-1">Платформа</div>
                        <div className="font-bold uppercase">{account.platform || "instagram"}</div>
                      </div>
                      <div className="p-3 bg-muted rounded-lg">
                        <div className="text-muted-foreground mb-1">Профиль Zernio</div>
                        <div className="font-bold truncate">{displayProfile(account.profileId)}</div>
                      </div>
                    </div>
                  </CardContent>
                  <CardFooter className="border-t pt-4">
                    <Button 
                      variant="destructive" 
                      size="sm" 
                      className="w-full" 
                      disabled={disconnecting === account._id}
                      onClick={() => handleDisconnectAccount(account._id, account.name || account.username || "Account")}
                    >
                      {disconnecting === account._id ? "Отключение..." : "🔓 Отключить аккаунт"}
                    </Button>
                  </CardFooter>
                </Card>
              ))
            ) : (
              <div className="col-span-2 text-center py-12 border-2 border-dashed rounded-xl bg-muted/10">
                <p className="text-muted-foreground">Нет подключенных аккаунтов</p>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
