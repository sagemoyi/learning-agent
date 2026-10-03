// esbuild loads CSS as text (scripts/build.mjs); the shell injects it into a <style> element.
declare module '*.css' {
  const text: string
  export default text
}
