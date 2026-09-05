import Link from 'next/link';
import Section from './components/Section';

const repositoryUrl = 'https://github.com/dreamcolor123/suno-api-plus-next';

export default function Home() {
  return (
    <>
      <Section>
        <div className="flex flex-col m-auto py-20 text-center items-center justify-center gap-5 my-8 lg:px-20 px-6 bg-indigo-900/90 rounded-2xl border shadow-2xl">
          <span className="px-5 py-1 text-xs font-light border rounded-full border-white/20 uppercase text-white/60">
            Unofficial · LGPL-3.0-or-later
          </span>
          <h1 className="font-bold text-5xl lg:text-7xl text-white/95">Suno API Plus Next</h1>
          <p className="text-white/80 text-lg max-w-2xl">
            A self-hosted Suno API gateway with account affinity, CAPTCHA providers,
            OpenAI-compatible endpoints, Studio uploads, and Studio stem workflows.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link className="rounded-full bg-white px-5 py-3 text-indigo-900 font-medium" href="/docs">
              API documentation
            </Link>
            <a className="rounded-full border border-white/30 px-5 py-3 text-white" href={repositoryUrl} target="_blank" rel="noreferrer">
              View on GitHub
            </a>
          </div>
        </div>
      </Section>

      <Section className="my-10">
        <article className="prose lg:prose-lg max-w-3xl">
          <h2>What is included</h2>
          <ul>
            <li>Native Suno generation, custom mode, Cover, Extend, lyrics and clip APIs.</li>
            <li>OpenAI-compatible <code>/v1/models</code>, <code>/v1/chat/completions</code>, <code>/v1/responses</code> and billing endpoints.</li>
            <li>Account pools with explicit affinity, concurrency limits, CAPTCHA providers and admin controls.</li>
            <li>Direct upload and Studio Fast Upload with idempotency and recovery checkpoints.</li>
            <li>Studio Advanced Split APIs, project persistence, clip download and legacy-download safeguards.</li>
          </ul>
          <h2>Start safely</h2>
          <p>
            Configure credentials only at runtime. Never commit cookies, tokens, account data,
            CAPTCHA keys, administrator passwords, browser profiles or generated audio.
          </p>
          <p>
            Read the <Link href="/docs">OpenAPI reference</Link> and the English or Chinese
            README before deploying. This project is unofficial and must be used in accordance
            with Suno&apos;s terms and applicable law.
          </p>
          <h2>Project lineage</h2>
          <p>
            This repository is a clean-history continuation of the public
            <a href="https://github.com/ShowSnowBlood/suno-api-plus" target="_blank" rel="noreferrer"> ShowSnowBlood/suno-api-plus</a>
            project and retains attribution to
            <a href="https://github.com/gcui-art/suno-api" target="_blank" rel="noreferrer"> gcui-art/suno-api</a>.
            See <code>NOTICE</code> and <code>LICENSE</code> for details.
          </p>
        </article>
      </Section>
    </>
  );
}
