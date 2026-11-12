/** Ambient browser globals the hand-written client artifact needs; never emitted to `lib/`. */

export {}

declare global {
  /** Browser module table every plugin client artifact registers itself into. */
  interface ModuleLoaderTable {
    /**
     * Declare one plugin module.
     * @param entry - the module id, which must equal the package name, and its factory.
     */
    load(entry: { id: string; factory: (require: (specifier: string) => any) => any }): void
  }

  /** The browser window, declared narrowly because this build targets no DOM library. */
  const window: { __ModuleLoader__: ModuleLoaderTable }

  /** The browser document, read only to move tab focus with the selection. */
  const document: { readonly activeElement: unknown } | undefined

  /** The browser clipboard, used for the copied probe diagnostics. */
  const navigator: { clipboard?: { writeText(value: string): Promise<void> } } | undefined
}
