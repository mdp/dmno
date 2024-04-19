import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightBlog from 'starlight-blog';
import vue from "@astrojs/vue";
import robotsTxt from "astro-robots-txt";
import starlightLinksValidator from 'starlight-links-validator';
import partytown from "@astrojs/partytown";

// https://astro.build/config
export default defineConfig({
  site: 'https://dmno.dev',
  integrations: [starlight({
    title: "DMNO Docs",
    logo: {
      src: "./src/assets/square-logo.svg"
    },
    social: {
      github: "https://github.com/dmno-dev"
    },
    plugins: [starlightBlog(), starlightLinksValidator()],
    pagination: false,
    head: [
      {
        tag: "script", 
        attrs: {
          type: "text/partytown",
          async: true,
          src: "https://www.googletagmanager.com/gtag/js?id=G-361VY1ET7B"
        }
      }, 
      {
        tag: "script",
        attrs: {
          type: "text/partytown",
          innerHTML: `window.dataLayer = window.dataLayer || [];
          function gtag() {
            dataLayer.push(arguments);
          }
          gtag("js", new Date());
        
          gtag("config", "G-361VY1ET7B");`
        },
      }
    ],
    sidebar: [{
      label: "Get Started",
      items: [{
          label: "What is DMNO?",
          link: "/get-started/what-is-dmno"
      },{
        label: "Quickstart",
        link: "/get-started/quickstart"
      }, {
        label: "Concepts",
        link: "/get-started/concepts"
      }]
      }, {
      label: "Guides",
      items: [{
          label: "Schema",
          link: "/guides/schema"
        }, {
          label: "Repo structure",
          link: "/guides/repo"
        }]
      },{
        label: "Secrets",
        items: [{
          label: "Encrypted Vaults",
          link: "/guides/secrets/encrypted-vault",
          badge: {
            text: "WIP",
            variant: "caution"
          },
        }, {
          label: "1Password",
          link: "/guides/secrets/1password",   
          badge: {
            text: "WIP",
            variant: "caution"
          },
        }]
      }, {
        label: "Integrations",
        items: [{
          label: "Next.js",
          link: "/guides/frameworks/nextjs/"
        }, {
          label: "Vite",
          link: "/guides/frameworks/vite/"
        }, {
          label: "Astro",
          link: "/guides/frameworks/astro/"
        },
        {
          label: "Vercel",
          link: "/guides/deployment/vercel/"
        }, {
          label: "Netlify",
          link: "/guides/deployment/netlify/"
        }, {
          label: "Railway",
          link: "/guides/deployment/railway/"
        }, {
          label: "Render",
          link: "/guides/deployment/render/"
        }
      ]}, {
      label: "Reference",
      items: [{
        label: 'config-engine',
        items: [{
          label: 'Installation',
          link: '/reference/config-engine/installation/'
        }, {
          label: 'Base Types',
          link: '/reference/config-engine/base-types/'
        }, {
          label: 'Helper Methods',
          link: '/reference/config-engine/helper-methods/'
        }, {
          label: 'CLI',
          link: '/reference/config-engine/dmno-cli/'
        }]
      },]
    }]
  }), vue({
    // jsx: true,
  }), robotsTxt({
    sitemap: false,
    policy: [{
      userAgent: '*',
      // disable all crawling, except homepage (for now)
      allow: '/$',
      disallow: '/'
    }]
  }), partytown({
    config: {
      forward: ["dataLayer.push"],
    },
  })]
});
