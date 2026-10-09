import type { ApplicationContext } from "../application/context.js";
import type { ResultView } from "../infrastructure/d1/views.js";
import { button, keyboard } from "./options.js";

export const MAX_RESULT_TEXT = 3800;

/** Blocks contain complete HTML units. Never split tags, entities or links. */
export function resultPages(title: string, blocks: string[]): ResultView["pages"] {
  const bodies: string[] = [];
  let body = "";
  for (const block of blocks) {
    if (title.length + block.length + 80 > MAX_RESULT_TEXT)
      throw new Error("Result block exceeds Telegram limit");
    const candidate = body + (body ? "\n\n" : "") + block;
    if (title.length + candidate.length + 80 > MAX_RESULT_TEXT && body) {
      bodies.push(body);
      body = block;
    } else body = candidate;
  }
  bodies.push(body);
  return bodies.map((text, index) => ({
    text: title + (title && text ? "\n\n" : "") + text +
      (bodies.length > 1 ? `\n\nPagina ${index + 1} di ${bodies.length}` : ""),
  }));
}

export function viewPage(view: ResultView, id: string, index: number) {
  const page = view.pages[index];
  if (!page) return null;
  const rows = (page.replyMarkup as { inline_keyboard?: ReturnType<typeof button>[][] } | undefined)
    ?.inline_keyboard?.slice() ?? [];
  const navigation: ReturnType<typeof button>[] = [];
  if (index > 0) navigation.push(button("◀️ Indietro", `viewpage|${id}|${index - 1}`));
  if (index + 1 < view.pages.length)
    navigation.push(button("Avanti ▶️", `viewpage|${id}|${index + 1}`));
  if (navigation.length) rows.push(navigation);
  if (view.backId) rows.push([button("↩️ Torna ai titoli", `viewpage|${view.backId}|0`)]);
  return { text: page.text, replyMarkup: keyboard(rows), expiresAt: view.expiresAt };
}

export async function saveView(
  context: ApplicationContext,
  id: string,
  userId: string,
  chatId: string,
  pages: ResultView["pages"],
  backId?: string,
  expiresAt = context.now() + 86400000,
) {
  await context.views.save(id, {
    userId, chatId, pages, expiresAt: Math.min(expiresAt, context.now() + 86400000),
    ...(backId ? { backId } : {}),
  }, context.now());
  // Replay keeps the same snapshot even if a subsequent API response differs.
  return viewPage((await context.views.get(id))!, id, 0)!;
}
