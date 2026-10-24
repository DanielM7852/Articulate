// Lets offline scripts import app modules written for the bundler: extensionless relative imports and
// TypeScript syntax that Node's strip-only mode rejects (e.g. constructor parameter properties).
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';

export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\.{1,2}\//.test(specifier) || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
    return next(`${specifier}.ts`, context);
  }
}

export async function load(url, context, next) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, context);
  const source = await readFile(new URL(url), 'utf8');
  return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true };
}
