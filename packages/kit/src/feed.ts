// Which change-feed messages reload a page's data (`useLoad` in client.ts), kept apart so it can be tested without React.
import { FEED_RESUMED } from '@learning-agent/contracts'

/** Default for `useLoad`: every `learning/` event. */
export const EVERY_CHANGE: readonly string[] = ['learning/']

/** Whether a feed message of `type` reloads data that follows `refreshOn` (type prefixes; `[]` follows nothing). After the feed was broken, anything it follows may have changed. */
export function reloadsOn(refreshOn: readonly string[], type: string): boolean {
  if (type === FEED_RESUMED) return refreshOn.length > 0
  return refreshOn.some(prefix => prefix !== '' && type.startsWith(prefix))
}
