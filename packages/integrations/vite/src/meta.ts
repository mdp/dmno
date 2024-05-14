export function getInstallationCodemods() {
  return {
    glob: 'vite.config.*',
    imports: [{
      moduleName: '@dmno/vite-integration',
      importVars: ['injectDmnoConfigVitePlugin'],
    }],
    updates: [{
      symbol: 'EXPORT',
      path: ['plugins'],
      action: {
        arrayContains: 'injectDmnoConfigVitePlugin()',
      },
    }],
  };
}

