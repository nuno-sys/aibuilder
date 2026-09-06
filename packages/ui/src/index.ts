/**
 * `@aibuilder/ui` — the React layer the dashboard is built from.
 *
 * WHAT IT IS. The accessibility primitives the onboarding modal established (`LiveRegions`,
 * `ErrorSummary`, `FieldMessage`), the form wiring that keeps `aria-describedby` correct, the
 * editor's responsive panel, and the zero-round-trip theme applier. Every one of them exists here
 * rather than in an app because two implementations of an accessibility contract means one of them
 * is wrong and nobody knows which.
 *
 * WHAT IT IS NOT. It has no bindings, no data fetching, no router and no locale registry: the
 * boundary policy in `eslint.config.js` allows it exactly one workspace dependency,
 * `@aibuilder/site-schema`, and that is used only for the `ThemeDoc` token type. Copy arrives as
 * props, because a component that owns its own strings cannot be reused in the other language.
 *
 * THE STYLESHEET IS A SEPARATE EXPORT. `import '@aibuilder/ui/styles.css'` once, in the app's root
 * module. It is one plain stylesheet rather than per-component CSS modules so that the whole
 * dashboard palette — and every contrast ratio in it — is auditable in one file.
 *
 * `apps/marketing` does not consume this package yet. Its island ships its own copies, which are
 * the originals these were lifted from; folding it in is a separate change with its own bundle-size
 * budget to defend.
 */

export * from './a11y/ErrorSummary';
export * from './a11y/FieldMessage';
export * from './a11y/LiveRegions';

export * from './forms/Button';
export * from './forms/Field';
export * from './forms/TextControl';

export * from './overlay/EditSheet';

export * from './theme/live-theme';
