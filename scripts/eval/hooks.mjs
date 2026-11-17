// Lets plain Node (22.18+ or 23.6+, which strip TypeScript types) load the app's own src/*.ts files, so the
// eval builds prompts with exactly the code the app uses. Extensionless imports get ".ts", and the few modules
// that need a phone (Expo, React Native, the hub's private link) are swapped for small stand-ins.
import { registerHooks } from 'node:module';

const stub = (name) => new URL(`./stubs/${name}.mjs`, import.meta.url).href;
const PACKAGES = { expo: stub('expo'), 'react-native': stub('react-native'), 'expo-crypto': stub('expo') };
const SRC_STUBS = { '/src/hub.ts': stub('hub'), '/src/net.ts': stub('net') };

registerHooks({
  resolve(specifier, context, next) {
    if (PACKAGES[specifier]) return { url: PACKAGES[specifier], shortCircuit: true };
    let result;
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.includes('/src/')) {
      for (const ext of ['.ts', '.tsx']) {
        try {
          result = next(specifier + ext, context);
          break;
        } catch {
          // try the next extension
        }
      }
    }
    result ??= next(specifier, context);
    for (const [end, url] of Object.entries(SRC_STUBS)) {
      if (result.url.endsWith(end)) return { url, shortCircuit: true };
    }
    return result;
  },
  load(url, context, next) {
    // The app's .ts files are ES modules; saying so up front saves Node guessing (and warning).
    if (url.endsWith('.ts') && url.includes('/src/')) return next(url, { ...context, format: 'module-typescript' });
    return next(url, context);
  },
});
