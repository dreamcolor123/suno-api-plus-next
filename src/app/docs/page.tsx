import Markdown from 'react-markdown';
import Section from '../components/Section';
import Swagger from '../components/Swagger';
import spec from './swagger-suno-api.json';

const overview = `
## Suno API Plus Next API reference

This page is generated from the checked-in OpenAPI contract. It covers native
Suno generation and reading routes, OpenAI-compatible endpoints, account-pool
affinity, CAPTCHA, uploads, Studio projects, Advanced Split, clip metadata and
administration.

### Important behavior

- Keep the opaque \`account_affinity\` returned for uploaded or private Studio
  material and send it unchanged to later operations on that source.
- Use a stable \`Idempotency-Key\` for long uploads. An ambiguous mutation is
  reconciled by a read-only endpoint and is never blindly replayed.
- Studio Advanced Split WAV/render legacy routes intentionally return HTTP 410;
  use Studio project and clip-download routes instead.
- \`/v1/images/generations\` and \`/v1/videos\` are explicitly unsupported
  and return HTTP 501.
- The desktop Runtime's automatic WAV/ZIP orchestration is outside this API
  Plus repository.
`;

export default function Docs() {
  return (
    <>
      <Section className="my-10">
        <article className="prose lg:prose-lg max-w-3xl pt-10">
          <Markdown>{overview}</Markdown>
        </article>
      </Section>
      <Section className="my-10">
        <div className="border p-4 rounded-2xl shadow-xl">
          <Swagger spec={spec} />
        </div>
      </Section>
    </>
  );
}
