import { injectDmnoGlobals } from 'dmno';
import { NextConfig } from 'next';

const { staticReplacements } = injectDmnoGlobals();

type DmnoPluginOptions = {
  redactSensitiveLogs?: boolean
};

// we make this a function becuase we'll likely end up adding some options
export function dmnoNextConfigPlugin(dmnoOptions?: DmnoPluginOptions) {
  // nextjs doesnt have a proper plugin system, so we write a function which takes in a config object and returns an augmented one
  return (nextConfig: NextConfig): NextConfig => {
    return {
      ...nextConfig,
      webpack: (webpackConfig, options) => {
        const { isServer } = options;

        // webpack itself  is passed in so we dont have to import it...
        const webpack = options.webpack;

        // apply existing user customizations if there are any
        if (nextConfig.webpack) {
          webpackConfig = nextConfig.webpack(webpackConfig, options);
        }

        // modify entry points to inject our dmno env shim
        // (currently it is only used to help with error handling / messages)
        const originalEntry = webpackConfig.entry;
        webpackConfig.entry = async () => {
          const entries = await originalEntry();

          function injectEntry(entryKey: string, injectedPath: string) {
            if (
              entries[entryKey] && !entries[entryKey].includes(injectedPath)
            ) {
              entries[entryKey].unshift(injectedPath);
            }
          }

          // injects into server - but unfortunately this doesn't work fully
          // it doesnt get run while next is doing a build and analyzing all the routes :(
          // so for now, we'll force users to import manually
          // if (isServer) {
          //   const injectDmnoServerFilePath = `${import.meta.dirname}/inject-dmno-server.js`;
          //   injectEntry('pages/_app', injectDmnoServerFilePath);
          //   injectEntry('pages/_document', injectDmnoServerFilePath);
          // }

          // injects our DMNO_CONFIG shims into the client
          // which gives us nicer errors and also support for dynamic public config
          if (!isServer) {
            const injectDmnoClientFilePath = `${import.meta.dirname}/inject-dmno-client.js`;
            injectEntry('main-app', injectDmnoClientFilePath);
          }

          return entries;
        };

        // Set up replacements / rewrites (using webpack DefinePlugin)
        webpackConfig.plugins.push(new webpack.DefinePlugin({
          ...staticReplacements,
        }));

        return webpackConfig; // must return the modified config
      },
    };
  };
}
