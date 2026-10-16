// react-dom comes from DSH at runtime (an external of the build, as for dockview, which imports it the same
// way); only what the shell uses is typed here.
declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react'
  const ReactDOM: {
    createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): ReactPortal
  }
  export default ReactDOM
}
