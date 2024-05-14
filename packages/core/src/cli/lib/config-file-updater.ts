import _ from 'lodash-es';
import * as acorn from 'acorn';
import tsPlugin from 'acorn-typescript';
import { fdir } from 'fdir';
import { stringInsert } from './string-utils';


type ConfigFileUpdateActions =
  { arrayContains: string }
  | { wrapWithFn: string };


export async function findConfigFile(baseDir: string, glob: string) {
  const expandedPathsFromGlobs = await (
    new fdir() // eslint-disable-line new-cap
      .withRelativePaths()
      .glob(glob)
      .crawl(baseDir)
      .withPromise()
  );
  if (!expandedPathsFromGlobs.length) {
    throw new Error(`failed to find matching config file in ${baseDir} with glob "${glob}"`);
  } else if (expandedPathsFromGlobs.length > 1) {
    throw new Error(`found multiple matching config files in ${baseDir} with glob "${glob}"`);
  }
  return `${baseDir}/${expandedPathsFromGlobs[0]}`;
}

export async function updateConfigFile(
  originalSrc: string,
  opts: {
    imports?: Array<{
      moduleName: string,
      importDefaultAs?: string,
      importVars?: Array<string>;
    }>,
    updates?: Array<{
      // so far, we only need to modify the default export, but we may need other options
      symbol: 'EXPORT',
      path?: Array<string>,
      action: ConfigFileUpdateActions,
    }>
  },
) {
  const mods: Array<{ insertAt: number, text: string }> = [];

  // @ts-ignore
  const parser = acorn.Parser.extend(tsPlugin());
  const ast = parser.parse(originalSrc, { sourceType: 'module', ecmaVersion: 'latest', locations: true });
  // console.dir(ast, { depth: null });

  const importNodes: Array<acorn.ImportDeclaration> = ast.body.filter((n) => n.type === 'ImportDeclaration') as any;

  // determine existing style of quotes / semicolons
  const q = importNodes?.[0]?.source.raw?.endsWith('"') ? '"' : "'";
  const semi = (!importNodes.length || originalSrc.substr(importNodes[0].end - 1, 1) === ';') ? ';' : '';

  for (const singleImport of opts.imports || []) {
    const { moduleName, importDefaultAs, importVars } = singleImport;
    // first see if the file is already imported
    const existingImportNode = importNodes.find((n) => n.source.value === moduleName);
    if (existingImportNode) {
      // here we could edit the exiting import, but for now we'll assume that if the import exists
      // then the user already knows what they are doing

      // we may also need to know what vars/names they imported
    } else {
      /* eslint-disable no-nested-ternary, prefer-template */
      const importStr = 'import '
        + (importDefaultAs || '')
        + ((importDefaultAs && importVars?.length) ? ', ' : '')
        + (importVars?.length ? `{ ${importVars?.join(', ')} }` : '')
        + ((importDefaultAs || importVars?.length) ? ' from ' : '')
        + `${q}${moduleName}${q}${semi}`;


      mods.push({
        insertAt: importNodes[0]?.start || 0,
        text: `${importStr}\n`,
      });

      // logic to import last - we could add this as an _option_ if useful
      // // we'll insert our import as the last one before any local files
      // const lastModuleImportNode = importNodes.findLast((n) => {
      //   const importedStr = n.source.value as string;
      //   return !importedStr.startsWith('./') && !importedStr.startsWith('../');
      // });
      // mods.push({
      //   // if no imports, we could potentially find the last comment or something?
      //   insertAt: lastModuleImportNode?.end || 0,
      //   text: `\n${importStr}`,
      // });
    }
  }

  for (const singleUpdate of opts.updates || []) {
    // currently we're always updating the default export
    // as we encounter more use cases, we can expand all our options here
    if (singleUpdate.symbol === 'EXPORT') {
      let nodeToUpdate: acorn.AnyNode | undefined;
      for (const n of ast.body) {
        // matches `export default ...`
        if (n.type === 'ExportDefaultDeclaration') {
          nodeToUpdate = n.declaration;
        // matches `module.exports = ...`
        } else if (
          n.type === 'ExpressionStatement'
          && n.expression.type === 'AssignmentExpression' && n.expression.operator === '='
          && originalSrc.substring(n.expression.left.start, n.expression.left.end) === 'module.exports'
        ) {
          nodeToUpdate = n.expression.right;
        }
        if (nodeToUpdate) break;
      }
      if (!nodeToUpdate) throw new Error('Unable to find `export default` or `module.exports = `');

      // if a path was passed in, we'll try to find it in an object
      if (singleUpdate.path) {
        // if the node is a function call we'll dive into it and assume we want the first arg
        // (this matches the `export default defineConfig({...})` pattern that many config files use)
        if (nodeToUpdate.type === 'CallExpression' && nodeToUpdate.arguments.length) {
          nodeToUpdate = nodeToUpdate.arguments[0];
        }
        if (nodeToUpdate.type !== 'ObjectExpression') {
          throw new Error('Expected to find an object node to use apply the path selector');
        }
        // currently only supports path of depth 1, but should support going deeper
        nodeToUpdate = nodeToUpdate.properties.find((n) => n.type === 'Property' && (n.key as any).name === singleUpdate.path![0]);
        if (!nodeToUpdate) {
          throw new Error('Could not find path -' + singleUpdate.path.join('.'));
        }
        if (nodeToUpdate.type !== 'Property') {
          throw new Error('Node is not a property');
        }
      }

      if (!nodeToUpdate) {
        throw new Error('unable to find AST node to update');
      }

      // this action will ensure an array contains an item matching some code
      if ('arrayContains' in singleUpdate.action) {
        if (nodeToUpdate.type !== 'Property') {
          throw new Error('node to update is not an object property');
        } else if (nodeToUpdate.value.type !== 'ArrayExpression') {
          throw new Error('node property value is not an array');
        }

        const arrayItems = nodeToUpdate.value.elements;
        let itemFound = false;
        for (const arrayItem of nodeToUpdate.value.elements) {
          if (!arrayItem) continue;
          const itemStr = originalSrc.substring(arrayItem.start, arrayItem.end);

          // we use startWith instead of === so that it handles things like `somePlugin() as AstroPlugin`
          // not at all perfect, but an edge case we are seeing internally... will make it more robust eventually
          if (itemStr.startsWith(singleUpdate.action.arrayContains)) {
            itemFound = true;
            break;
          }
        }

        if (itemFound) {
          break;
        } else {
          mods.push({
            insertAt: nodeToUpdate.value.start + 1,
            text:
              // TODO: would be nice to figure out indents / line breaks too
              '\n    '
              + singleUpdate.action.arrayContains
              + (arrayItems.length ? ',' : ''),
          });
        }

      // this action will wrap the node with a function call ex: `wrapWithCode(NODE)`
      } else if ('wrapWithFn' in singleUpdate.action) {
        // naively just check if the fn is anywhere within the code
        // eventually we'll want to be smarter but we'll potentially need to walk a tree of wrapped fn calls
        if (originalSrc.substring(nodeToUpdate.start, nodeToUpdate.end).includes(singleUpdate.action.wrapWithFn)) {
          break;
        }
        mods.push(
          {
            insertAt: nodeToUpdate.start,
            text: `${singleUpdate.action.wrapWithFn}(`,
          },
          {
            insertAt: nodeToUpdate.end,
            text: ')',
          },
        );
      }
    }
  }

  let updatedSrc = originalSrc;
  let insertedChars = 0;
  for (const singleMod of mods) {
    updatedSrc = stringInsert(insertedChars + singleMod.insertAt, updatedSrc, singleMod.text);
    insertedChars += singleMod.text.length;
  }

  return updatedSrc;
}


