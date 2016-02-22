import * as fs from 'fs'

import { createHash } from 'crypto'

import parse from './parse'
import resolve from './resolve'
import isIgnored from './ignore'

// map from settings sha1 => path => export map objects
const exportCaches = new Map()

export default class ExportMap {
  constructor(context) {
    this.context = context
    this.named = new Set()

    this.errors = []
  }

  get settings() { return this.context && this.context.settings }

  get hasDefault() { return this.named.has('default') }
  get hasNamed() { return this.named.size > (this.hasDefault ? 1 : 0) }

  static get(source, context) {

    var path = resolve(source, context)
    if (path == null) return null

    return ExportMap.for(path, context)
  }

  static for(path, context) {
    let exportMap

    const cacheKey = hashObject({
      settings: context.settings,
      parserPath: context.parserPath,
      parserOptions: context.parserOptions,
    })
    let exportCache = exportCaches.get(cacheKey)
    if (exportCache === undefined) {
      exportCache = new Map()
      exportCaches.set(cacheKey, exportCache)
    }

    exportMap = exportCache.get(path)
    // return cached ignore
    if (exportMap === null) return null

    const stats = fs.statSync(path)
    if (exportMap != null) {
      // date equality check
      if (exportMap.mtime - stats.mtime === 0) {
        return exportMap
      }
      // future: check content equality?
    }

    exportMap = ExportMap.parse(path, context)
    exportMap.mtime = stats.mtime

    // ignore empties, optionally
    if (exportMap.named.size === 0 && isIgnored(path, context)) {
      exportMap = null
    }

    exportCache.set(path, exportMap)

    return exportMap
  }

  static parse(path, context) {
    var m = new ExportMap(context)

    try {
      var ast = parse(path, context)
    } catch (err) {
      m.errors.push(err)
      return m // can't continue
    }

    ast.body.forEach(function (n) {
      if (n.type === 'ExportDefaultDeclaration') {
        m.named.add('default')
        return
      }

      if (n.type === 'ExportAllDeclaration') {
        let remoteMap = m.resolveReExport(n, path)
        if (remoteMap == null) return

        remoteMap.named.forEach((name) => { m.named.add(name) })
        return
      }

      if (n.type === 'ExportNamedDeclaration'){

        // capture declaration
        if (n.declaration != null) {
          switch (n.declaration.type) {
            case 'FunctionDeclaration':
            case 'ClassDeclaration':
            case 'TypeAlias': // flowtype with babel-eslint parser
              m.named.add(n.declaration.id.name)
              break
            case 'VariableDeclaration':
              n.declaration.declarations.forEach((d) =>
                recursivePatternCapture(d.id, id => m.named.add(id.name)))
              break
          }
        }

        // capture specifiers
        let remoteMap
        if (n.source) remoteMap = m.resolveReExport(n, path)

        n.specifiers.forEach(function (s) {
          if (s.type === 'ExportDefaultSpecifier') {
            // don't add it if it is not present in the exported module
            if (!remoteMap || !remoteMap.hasDefault) return
          }

          m.named.add(s.exported.name)
        })
      }

    })

    return m
  }

  resolveReExport(node, base) {
    var remotePath = resolve.relative(node.source.value, base, this.settings)
    if (remotePath == null) return null

    return ExportMap.for(remotePath, this.context)
  }

  reportErrors(context, declaration) {
    context.report({
      node: declaration.source,
      message: `Parse errors in imported module '${declaration.source.value}': ` +
                  `${this.errors
                        .map(e => `${e.message} (${e.lineNumber}:${e.column})`)
                        .join(', ')}`,
    })
  }
}


/**
 * Traverse a patter/identifier node, calling 'callback'
 * for each leaf identifier.
 * @param  {node}   pattern
 * @param  {Function} callback
 * @return {void}
 */
export function recursivePatternCapture(pattern, callback) {
  switch (pattern.type) {
    case 'Identifier': // base case
      callback(pattern)
      break

    case 'ObjectPattern':
      pattern.properties.forEach(({ value }) => {
        recursivePatternCapture(value, callback)
      })
      break

    case 'ArrayPattern':
      pattern.elements.forEach((element) => {
        if (element == null) return
        recursivePatternCapture(element, callback)
      })
      break
  }
}

function hashObject(object) {
  const settingsShasum = createHash('sha1')
  settingsShasum.update(JSON.stringify(object))
  return settingsShasum.digest('hex')
}
