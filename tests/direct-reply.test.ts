import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Правило отправки в Direct: бот не повторяет сам себя, но на просьбу отвечает
 * всегда. Обе половины взяты из живых проверок, и обе ломались по очереди —
 * поэтому проверяются вместе.
 */

/** Поддельная база: одна строка bot_users, состояние живёт в объекте. */
const row: { state: Record<string, unknown> } = { state: {} };

vi.mock("../src/integrations-supabase/client.server", () => {
  const table = () => ({
    select: () => ({
      eq: () => ({ maybeSingle: () => Promise.resolve({ data: { state: row.state } }) }),
    }),
    update: (patch: { state?: Record<string, unknown> }) => ({
      eq: () => {
        if (patch.state) row.state = patch.state;
        return Promise.resolve({ data: null, error: null });
      },
    }),
  });
  return { supabaseAdmin: { from: table } };
});

const sent: string[] = [];
vi.mock("../src/lib/zernio.server", () => ({
  sendZernioInboxMessage: (_c: string, _a: string, message: string) => {
    sent.push(message);
    return Promise.resolve({ ok: true });
  },
}));

const { sendDirectReply } = await import("../src/lib/direct-purchase.server");
const { runWithZernioEvent, markExplicitRequest } = await import(
  "../src/lib/zernio-event-context.server"
);

const say = (text: string) =>
  sendDirectReply({ conversationId: "c1", accountId: "a1", userKey: "u1", text });

beforeEach(() => {
  row.state = {};
  sent.length = 0;
});

describe("sendDirectReply", () => {
  it("не повторяет дословно то, что бот сказал сам", async () => {
    await runWithZernioEvent("event-1", () => say("Передал ваш вопрос продавцу."));
    await runWithZernioEvent("event-2", () => say("Передал ваш вопрос продавцу."));

    expect(sent).toEqual(["Передал ваш вопрос продавцу."]);
  });

  /**
   * Тот случай, на котором подавление повторов оказалось слишком жадным: человек
   * отправил «/start», получил меню, отправил «/start» и «Купить» — и не получил
   * ничего. Молчание в ответ на прямую просьбу читается как сломавшийся бот.
   */
  it("на просьбу отвечает, даже если ответ совпадает с прошлым", async () => {
    await runWithZernioEvent("event-1", async () => {
      markExplicitRequest();
      await say("Здесь можно оформить заказ по номеру материала.");
    });
    await runWithZernioEvent("event-2", async () => {
      markExplicitRequest();
      await say("Здесь можно оформить заказ по номеру материала.");
    });

    expect(sent).toHaveLength(2);
  });

  it("разные сообщения подряд уходят все", async () => {
    await runWithZernioEvent("event-1", () => say("Первое"));
    await runWithZernioEvent("event-2", () => say("Второе"));

    expect(sent).toEqual(["Первое", "Второе"]);
  });

  it("повтор гасится только пока разговор тот же", async () => {
    await runWithZernioEvent("event-1", () => say("Жду чек об оплате."));
    // Через полчаса тот же текст — это уже новый разговор, а не повтор.
    row.state = {
      ...row.state,
      last_reply_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    };
    await runWithZernioEvent("event-2", () => say("Жду чек об оплате."));

    expect(sent).toHaveLength(2);
  });

  it("вне обработки события ничего не подавляет — отправка из админки осмысленна", async () => {
    await say("Ответ продавца");
    await say("Ответ продавца");

    expect(sent).toHaveLength(2);
  });

  it("отпечаток не затирает шаг сценария", async () => {
    row.state = { mode: "awaiting_proof", country_code: "KZ" };
    await runWithZernioEvent("event-1", () => say("Жду чек."));

    expect(row.state.mode).toBe("awaiting_proof");
    expect(row.state.country_code).toBe("KZ");
    expect(row.state.last_reply).toBeTruthy();
  });
});
