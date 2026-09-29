/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' keeps the screen gallery (and its fixtures) in a production build. */
  readonly VITE_ENABLE_GALLERY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
