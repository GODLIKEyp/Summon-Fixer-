import MagicString from 'magic-string';
import ts from 'typescript';
import { relative } from 'node:path';
import type { SourceRegistry } from './source-registry.js';

export interface InstrumentOptions { root?: string }

/** Instrument syntax nodes, never TypeScript generics, strings or comments. */
export function instrumentJsx(code: string, id: string, registry: SourceRegistry, options: InstrumentOptions = {}) {
  if (!/\.[jt]sx$/.test(id) || id.includes('node_modules') || id.includes('/dist/')) return null;
  const file = relative(options.root || process.cwd(), id).replace(/\\/g, '/');
  const ast = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const output = new MagicString(code);
  let changed = false;
  registry.invalidateFile(id);
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      // Component props are not necessarily forwarded to the corresponding DOM node.
      if (/^[a-z][a-z0-9-]*$/.test(tag)) {
        const position = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        const line = position.line + 1;
        const column = position.character + 1;
        const sourceId = registry.register(file, line, column, tag, code, id);
        const revision = registry.resolve(sourceId)!.revision!;
        // Append after spreads so they cannot override mapping; remove explicit reserved attributes.
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && ['data-summon-id', 'data-summon-source', 'data-summon-rev'].includes(attribute.name.getText(ast))) {
            output.remove(attribute.getStart(ast), attribute.end);
          }
        }
        const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const end = node.end - (ts.isJsxSelfClosingElement(node) ? 2 : 1);
        output.appendLeft(end, ` data-summon-id="${sourceId}" data-summon-rev="${revision}" data-summon-source="${escape(file)}:${line}:${column}"`);
        changed = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return changed ? { code: output.toString(), map: output.generateMap({ hires: true, source: id, includeContent: true }) } : null;
}
