import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-prose{ --stack-gap:var(--space-5) }
  .s-prose h2{ font-size:var(--step-3) }
}
`);
