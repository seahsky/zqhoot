declare const __ZQ_VERSION__: string | undefined;

/** Injected from package.json by `scripts/build.mjs`; source runs (tests) report `dev`. */
export const VERSION: string = typeof __ZQ_VERSION__ === 'string' ? __ZQ_VERSION__ : 'dev';
