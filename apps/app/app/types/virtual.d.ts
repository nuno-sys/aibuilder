/**
 * The React Router server build.
 *
 * `virtual:react-router/server-build` is materialised by the framework's Vite plugin at build time
 * and has no shipped declaration. A shorthand ambient module is the documented way to name such a
 * specifier: it types the import as `any`, which is exactly right here — the only consumer is
 * `createRequestHandler`, whose parameter is `ServerBuild`, so the shape is checked at the one call
 * site that cares and nowhere else has a reason to look inside it.
 *
 * Writing out `ServerBuild`'s members by hand instead would couple this file to a private shape
 * that changes between minor releases, and the failure mode of getting it wrong is a compile error
 * about a module nobody wrote.
 */
declare module 'virtual:react-router/server-build';
