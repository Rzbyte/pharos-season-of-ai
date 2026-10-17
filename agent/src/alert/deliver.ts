// Task 22: delivering alerts. Every alert is printed; with a webhook, each is also POSTed as JSON, one
// request per alert, in order. One that fails stays pending in the store and is tried again on the next
// run, so an alert is never lost to a delivery that did not go through.
import type { Alert } from "./store.js";

export interface Delivery {
  channel: "stdout" | "webhook";
  delivered: string[];
  failed: { id: string; error: string }[];
}

/** The body POSTed for one alert: the alert, and its one line as `text` and `content`, the fields Slack's and Discord's incoming webhooks display. */
export function webhookBody(bot: string, alert: Alert): string {
  const line = `${bot}: ${alert.label}: ${alert.message}`;
  return JSON.stringify({ text: line, content: line, bot, alert });
}

/** Deliver `alerts` to the webhook (or only to stdout, where every alert counts as delivered). */
export async function deliver(bot: string, alerts: readonly Alert[], webhook: string | null, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<Delivery> {
  if (!webhook) return { channel: "stdout", delivered: alerts.map((a) => a.id), failed: [] };
  const delivered: string[] = [];
  const failed: Delivery["failed"] = [];
  for (const alert of alerts) {
    try {
      const response = await fetchImpl(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: webhookBody(bot, alert), signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) delivered.push(alert.id);
      else failed.push({ id: alert.id, error: `HTTP ${response.status}` });
    } catch (error) {
      failed.push({ id: alert.id, error: (error as Error).message.split("\n")[0]! });
    }
  }
  return { channel: "webhook", delivered, failed };
}
