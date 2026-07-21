const QUICK_EMOJIS = [
  "📚", "📖", "📝", "✏️", "📐", "🔢", "🧮", "🎓",
  "👶", "🧒", "🗓️", "📅", "🌸", "🍂", "❄️", "🎄",
  "⭐", "✅", "💡", "🎯", "🔤", "🗣️", "🌍", "🎨",
  "🎵", "🧪", "⚽", "📎", "📋", "🧩", "🖍️", "🏫",
];

type EmojiInsertBarProps = {
  onInsert: (emoji: string) => void;
};

export function EmojiInsertBar({ onInsert }: EmojiInsertBarProps) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">Быстрая вставка эмодзи:</p>
      <div className="flex flex-wrap gap-1">
        {QUICK_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="h-8 w-8 rounded-md border bg-background text-base hover:bg-accent"
            onClick={() => onInsert(emoji)}
            title={`Вставить ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}

export function insertAtCursor(
  value: string,
  insert: string,
  selectionStart: number | null,
  selectionEnd: number | null,
): { next: string; cursor: number } {
  const start = selectionStart ?? value.length;
  const end = selectionEnd ?? value.length;
  const next = value.slice(0, start) + insert + value.slice(end);
  return { next, cursor: start + insert.length };
}
