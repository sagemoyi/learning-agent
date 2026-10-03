// Shell, host half. The shell lives in the browser (src/client.tsx); DSH still imports a host face for
// every profile row and discovers client modules by scanning those rows, so this face does nothing.
export const name = 'learning-shell'

export function apply(): void {}
