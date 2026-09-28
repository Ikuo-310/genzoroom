import { registerHooks } from 'node:module';
import { extname } from 'node:path';

// Node strips TS natively; preserve ESM boundaries and resolve the app's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
