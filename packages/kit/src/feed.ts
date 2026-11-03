// Which change-feed messages reload a page's data (`useLoad` in client.ts), kept apart so it can be tested without React.

/** Default for `useLoad`: every `learning/` event. */
export const EVERY_CHANGE: readonly string[] = ['learning/']

/** Whether a feed message of `type` reloads data that follows `refreshOn` (type prefixes; `[]` follows nothing). */
export function reloadsOn(refreshOn: readonly string[], type: string): boolean {
  return refreshOn.some(prefix => prefix !== '' && type.startsWith(prefix))
}
