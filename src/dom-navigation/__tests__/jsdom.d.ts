// jsdom ships no types and @types/jsdom is not a dependency here. This is the
// sliver of the API inject-script.test.ts uses.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { runScripts?: "dangerously" | "outside-only"; url?: string });
    readonly window: Window & typeof globalThis;
  }
}
