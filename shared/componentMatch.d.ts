/** Type shim so TypeScript can import the shared JS matcher. */
export function normalizeModelId(id: unknown): string;
export function modelAliasesOf(component: object | null | undefined): string[];
export function nameAliasesOf(component: object | null | undefined): string[];
export function isPlaceholderPort(component: object | null | undefined): boolean;
export function matchServiceToComponent(
  components: object[] | null | undefined,
  service: object | null | undefined
): object | null;
