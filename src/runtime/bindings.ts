export interface Env {
  DB: D1Database;
  WORK_QUEUE: Queue<QueueJob>;
  INTERACTION_QUEUE?: Queue<QueueJob>;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ITAD_API_KEY: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_CHAT_GROUP?: string;
  GGDEALS_API_KEY?: string;
  SCANS_ENABLED?: string;
  REVIEW_CONCURRENCY?: string;
}

export type QueueJob =
  | {
      kind: "tick";
      part: "prices" | "giveaways" | "recover";
      scheduledAt: number;
      initialize: boolean;
    }
  | { kind: "probe"; scenario: "deals" | "prices"; reviewConcurrency?: 1 | 2 }
  | { kind: "scan"; id: string }
  | { kind: "delivery"; id: string }
  | { kind: "update"; id: number };
