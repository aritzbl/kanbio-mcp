import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KanbioApiError, NETWORK_ERROR, readConfig } from './client.js';
import { describeError } from './errors.js';
import { readableText, withMentions } from './format.js';
import { matchPeople, Member, ToolInputError } from './kanbio.js';

const ana: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ana@example.test',
  firstName: 'Ana',
  lastName: 'Pérez',
  displayName: 'Ana Pérez',
  role: 'dev',
};
const andres: Member = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'andres@example.test',
  firstName: 'Andrés',
  lastName: 'Gómez',
  displayName: '',
  role: 'qa',
};

describe('API errors as messages for the AI', () => {
  it('names the missing permission and says not to retry', () => {
    const message = describeError(
      new KanbioApiError(403, 'This API token lacks the permission: tickets:status'),
    );
    assert.match(message, /tickets:status \(change the status\)/);
    assert.match(message, /Do not retry/);
    assert.match(message, /Conectar con IA/);
  });

  it('explains an invalid transition with the allowed next statuses', () => {
    const message = describeError(
      new KanbioApiError(400, 'Invalid status transition: todo → done'),
    );
    assert.match(message, /from To Do to Done/);
    assert.match(message, /it can go to: In Progress \(in_progress\)/);
  });

  it('covers expired tokens, missing tickets, rate limits and the network', () => {
    assert.match(describeError(new KanbioApiError(401, 'Invalid API token')), /expired or revoked/);
    assert.match(describeError(new KanbioApiError(404, 'Ticket not found')), /Not found \(404\)/);
    assert.match(describeError(new KanbioApiError(429, 'ThrottlerException')), /Wait a minute/);
    assert.match(
      describeError(new KanbioApiError(NETWORK_ERROR, 'Could not reach Kanbio at http://x/api (fetch failed)')),
      /Check KANBIO_API_URL/,
    );
    assert.match(
      describeError(new KanbioApiError(403, 'You need PM permissions in this project')),
      /only a PM/,
    );
    assert.match(
      describeError(new KanbioApiError(400, 'Validation failed', ['title: Required'])),
      /title: Required/,
    );
    assert.equal(describeError(new ToolInputError('No project "X".')), 'No project "X".');
  });
});

describe('Mentions', () => {
  it('turns @Name into a mention and mentions the rest at the start', () => {
    const content = withMentions('Hola @ana pérez, ¿lo revisás?', [ana, andres]);
    assert.equal(
      content,
      `@[Andrés Gómez](user:${andres.id}) Hola @[Ana Pérez](user:${ana.id}), ¿lo revisás?`,
    );
    assert.equal(readableText(content), '@Andrés Gómez Hola @Ana Pérez, ¿lo revisás?');
  });

  it('shows attachments as file names', () => {
    assert.equal(
      readableText('Ver ![log.txt](attachment:33333333-3333-4333-8333-333333333333)'),
      'Ver [file: log.txt]',
    );
  });

  it('finds people by email, full name or part of it, ignoring accents', () => {
    assert.deepEqual(matchPeople([ana, andres], 'ANA@example.test'), [ana]);
    assert.deepEqual(matchPeople([ana, andres], 'andres gomez'), [andres]);
    assert.deepEqual(matchPeople([ana, andres], '@Pérez'), [ana]);
    assert.equal(matchPeople([ana, andres], 'an').length, 2);
    assert.deepEqual(matchPeople([ana, andres], 'zoe'), []);
  });
});

describe('Configuration', () => {
  it('accepts the URL with or without /api', () => {
    const token = `kbn_${'a'.repeat(43)}`;
    const plain = readConfig({ KANBIO_API_URL: 'https://kanbio.example.com/', KANBIO_TOKEN: token });
    assert.equal(plain.config?.apiUrl, 'https://kanbio.example.com/api');
    const withApi = readConfig({ KANBIO_API_URL: 'http://localhost:4000/api', KANBIO_TOKEN: token });
    assert.equal(withApi.config?.apiUrl, 'http://localhost:4000/api');
  });

  it('explains what is missing instead of crashing', () => {
    const result = readConfig({ KANBIO_TOKEN: 'secret' });
    assert.equal(result.config, null);
    assert.equal(result.problems.length, 2);
    assert.match(result.problems.join(' '), /KANBIO_API_URL is not set/);
    assert.match(result.problems.join(' '), /start with "kbn_"/);
    assert.ok(!result.problems.join(' ').includes('secret'));
  });
});
