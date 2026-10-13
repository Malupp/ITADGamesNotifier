import { PreferencesRepository } from "../../src/infrastructure/d1/preferences.js";
export async function enrollPrivateUsers(db: D1Database, ids: string[], now: number, recent = false) {
  const prefs = new PreferencesRepository(db);
  for (const id of ids) {
    await prefs.registerPrivateUser(id, now);
    if (recent) await prefs.setRecentDeals(id, true, now, 1);
  }
}
