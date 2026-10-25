/** Anonymous SpacetimeDB identity token, shared by every connection this app opens. */
export const TOKEN_KEY = 'articulate.stdb.token';

export function readToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable; identity is just not remembered */
  }
}
