import MagicString from 'magic-string';
import { relative } from 'node:path';
import type { SourceRegistry } from './source-registry.js';

export interface InstrumentOptions {
  root?: string;
}

/**
 * Instruments JSX/TSX files in development mode to add verified element-to-source mapping attributes.
 * Adds `data-summon-id="src_..."` and `data-summon-source="file:line:col"` to opening JSX tags.
 */
export function instrumentJsx(
  code: string,
  id: string,
  registry: SourceRegistry,
  options: InstrumentOptions = {}
): { code: string; map: any } | null {
  // Only instrument .tsx and .jsx files, never node_modules or dist
  if (!/\.[jt]sx$/.test(id) || id.includes('node_modules') || id.includes('/dist/')) {
    return null;
  }

  const root = options.root || process.cwd();
  const relativeFile = relative(root, id).replace(/\\/g, '/');

  const s = new MagicString(code);
  let changed = false;

  const len = code.length;
  let i = 0;
  let line = 1;
  let column = 1;

  // Track line/col lookup table
  const lineOffsets: number[] = [0];
  for (let idx = 0; idx < len; idx++) {
    if (code[idx] === '\n') {
      lineOffsets.push(idx + 1);
    }
  }

  function getLineAndCol(index: number): { line: number; column: number } {
    let low = 0;
    let high = lineOffsets.length - 1;
    let lineIdx = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (lineOffsets[mid] <= index) {
        lineIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return {
      line: lineIdx + 1,
      column: index - lineOffsets[lineIdx] + 1,
    };
  }

  while (i < len) {
    const char = code[i];

    // Single-line comment
    if (char === '/' && code[i + 1] === '/') {
      i += 2;
      while (i < len && code[i] !== '\n') i++;
      continue;
    }

    // Multi-line comment
    if (char === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Single quote string
    if (char === "'") {
      i++;
      while (i < len && code[i] !== "'") {
        if (code[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }

    // Double quote string
    if (char === '"') {
      i++;
      while (i < len && code[i] !== '"') {
        if (code[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }

    // Template literal
    if (char === '`') {
      i++;
      while (i < len && code[i] !== '`') {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === '$' && code[i + 1] === '{') {
          // Inside expression
          i += 2;
          let braceDepth = 1;
          while (i < len && braceDepth > 0) {
            if (code[i] === '{') braceDepth++;
            else if (code[i] === '}') braceDepth--;
            i++;
          }
          continue;
        }
        i++;
      }
      i++;
      continue;
    }

    // Check for JSX opening tag: `<` followed by [a-zA-Z]
    if (char === '<') {
      const next = code[i + 1];

      // Ignore closing tag `</` and fragment `<>`
      if (next === '/' || next === '>' || next === '!' || next === '?') {
        i++;
        continue;
      }

      // Check if tag starts with letter
      if (/[a-zA-Z]/.test(next)) {
        const tagStartIndex = i + 1;
        let tagEndIndex = tagStartIndex;

        while (tagEndIndex < len && /[a-zA-Z0-9_.-]/.test(code[tagEndIndex])) {
          tagEndIndex++;
        }

        const tagName = code.slice(tagStartIndex, tagEndIndex);
        const postTagChar = code[tagEndIndex];

        // Ensure followed by whitespace, `>`, or `/>`
        if (/\s|>|\//.test(postTagChar)) {
          // Check preceding character to ensure it's not a generic type: e.g. `React.FC<Props>`
          // Preceding should typically be whitespace, `(`, `{`, return, or JSX parent
          let isValidJsx = true;
          let prevNonWs = i - 1;
          while (prevNonWs >= 0 && /\s/.test(code[prevNonWs])) {
            prevNonWs--;
          }
          if (prevNonWs >= 0) {
            const prevChar = code[prevNonWs];
            // If preceded by identifier or type keyword without operator/bracket, it might be a generic
            if (/[a-zA-Z0-9_]/.test(prevChar)) {
              // Check if preceded by keywords like 'return', 'yield', 'case', 'default'
              const textBefore = code.slice(Math.max(0, prevNonWs - 10), prevNonWs + 1);
              if (
                !/(return|yield|case|default|export)$/.test(textBefore) &&
                !/[=:(,[?&|]/.test(prevChar)
              ) {
                isValidJsx = false;
              }
            }
          }

          if (isValidJsx) {
            const { line: tagLine, column: tagCol } = getLineAndCol(i);
            const sourceId = registry.register(relativeFile, tagLine, tagCol, tagName, code);

            // Append data attributes immediately after the tag name
            const attrInjection = ` data-summon-id="${sourceId}" data-summon-source="${relativeFile}:${tagLine}:${tagCol}"`;
            s.appendLeft(tagEndIndex, attrInjection);
            changed = true;

            i = tagEndIndex;
            continue;
          }
        }
      }
    }

    i++;
  }

  if (!changed) {
    return null;
  }

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true }),
  };
}
