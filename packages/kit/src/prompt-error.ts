// Why a message did not go into a session, in words. DSH's remote errors are Error objects whose message is not
// an own property, so `JSON.stringify` of one leaves `{"code":…,"isDSHRemoteError":true,"name":"RemoteError"}` for the learner to read.

/** The refusal DSH's `session.prompt` returned, as one line. */
export function promptError(error: unknown): string {
  if (typeof error === 'string' && error) return error
  const record = error as { code?: unknown; message?: unknown } | null | undefined
  const code = typeof record?.code === 'string' && record.code ? record.code : undefined
  if (typeof record?.message === 'string' && record.message) return code ? `${record.message}（${code}）` : record.message
  return code ? `没有发出去（${code}）` : '没有发出去'
}
