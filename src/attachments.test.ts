import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { before, describe, it } from 'node:test';
import {
  AttachmentApi,
  AttachmentLimits,
  attachmentToken,
  checkLimits,
  countAttachments,
  keepFiles,
  localFiles,
  saveWithAttachments,
  withAttachments,
} from './attachments.js';
import { KanbioApiError } from './client.js';
import { describeError } from './errors.js';
import { readableText } from './format.js';
import { ToolInputError } from './kanbio.js';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MB = 1024 * 1024;
const LIMITS: AttachmentLimits = {
  maxBytes: { image: 20 * MB, video: 200 * MB, document: 25 * MB },
  maxFilesPerBody: 3,
  maxTotalBytesPerBody: 30 * MB,
  maxDraftsPerUser: 20,
};
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

let folder = '';
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'kanbio-mcp-'));
  await writeFile(join(folder, 'captura.PNG'), PNG);
  await writeFile(join(folder, 'log.csv'), 'fecha,error\n2026-11-04,500\n');
  await writeFile(join(folder, 'notas.txt'), 'texto');
  await writeFile(join(folder, 'vacio.pdf'), '');
});

describe('Attachment markdown', () => {
  it('writes the token Kanbio expects, with a name its pattern accepts', () => {
    assert.equal(
      attachmentToken(ID_A, 'captura [final] (1).png'),
      `![captura final 1.png](attachment:${ID_A})`,
    );
    const long = attachmentToken(ID_A, `${'x'.repeat(100)}.png`);
    assert.equal(long, `![${'x'.repeat(80)}](attachment:${ID_A})`);
  });

  it('puts the files at the end of the text, each on its own line', () => {
    const files = [
      { id: ID_A, name: 'antes.png' },
      { id: ID_B, name: 'log.csv' },
    ];
    assert.equal(
      withAttachments('Se rompe al guardar.\n', files),
      `Se rompe al guardar.\n\n![antes.png](attachment:${ID_A})\n![log.csv](attachment:${ID_B})`,
    );
    assert.equal(withAttachments(undefined, files.slice(0, 1)), `![antes.png](attachment:${ID_A})`);
    assert.equal(withAttachments('Sin archivos', []), 'Sin archivos');
    assert.equal(
      readableText(withAttachments('Ver', files)),
      'Ver\n\n[file: antes.png]\n[file: log.csv]',
    );
  });

  it('counts the files a text already has, once each', () => {
    const text = `a ![x.png](attachment:${ID_A}) b ![x.png](attachment:${ID_A.toUpperCase()}) ![y](attachment:${ID_B})`;
    assert.equal(countAttachments(text), 2);
    assert.equal(countAttachments(null), 0);
  });

  it('keeps the files of a description the AI rewrites', () => {
    const current = `Pasos:\n![antes.png](attachment:${ID_A})\nFin\n\n![log.csv](attachment:${ID_B})`;
    // get_ticket showed "[file: antes.png]": it becomes the file again, in place.
    assert.equal(
      keepFiles('Pasos nuevos:\n[file: antes.png]\nListo', current),
      `Pasos nuevos:\n![antes.png](attachment:${ID_A})\nListo\n\n![log.csv](attachment:${ID_B})`,
    );
    // A token already in the text stays once.
    const kept = `Todo ![antes.png](attachment:${ID_A}) ![log.csv](attachment:${ID_B})`;
    assert.equal(keepFiles(kept, current), kept);
    assert.equal(keepFiles('Nuevo texto', null), 'Nuevo texto');
  });
});

describe('Local files', () => {
  it('takes the type from the extension, in any case, and dedupes paths', async () => {
    const png = join(folder, 'captura.PNG');
    const files = await localFiles([png, pathToFileURL(png).href, join(folder, 'log.csv')]);
    assert.deepEqual(
      files.map((file) => [file.name, file.contentType, file.kind, file.size]),
      [
        ['captura.PNG', 'image/png', 'image', PNG.length],
        ['log.csv', 'text/csv', 'document', 27],
      ],
    );
  });

  it('explains a type Kanbio does not take, a missing file and an empty one', async () => {
    await assert.rejects(
      localFiles([join(folder, 'notas.txt')]),
      (error: unknown) =>
        error instanceof ToolInputError && /does not accept "notas\.txt".*PNG, JPEG/.test(error.message),
    );
    await assert.rejects(
      localFiles([join(folder, 'no-existe.png')]),
      (error: unknown) =>
        error instanceof ToolInputError && /File not found: .*no-existe\.png\. Give the absolute path/.test(error.message),
    );
    await assert.rejects(localFiles([join(folder, 'vacio.pdf')]), /"vacio\.pdf" is empty/);
  });

  it('checks size, count and total against the limits before uploading', () => {
    const image = { path: '/x.png', name: 'x.png', contentType: 'image/png', kind: 'image' as const, size: 21 * MB };
    assert.throws(() => checkLimits([image], LIMITS, 0), /"x\.png" weighs 21 MB; Kanbio takes image files of up to 20 MB/);
    const small = { ...image, size: MB };
    assert.throws(() => checkLimits([small, small], LIMITS, 2), /up to 3 files \(it already has 2\)/);
    const doc = { ...small, kind: 'document' as const, size: 16 * MB };
    assert.throws(() => checkLimits([doc, doc], LIMITS, 0), /add up to 32 MB; .* up to 30 MB/);
    assert.doesNotThrow(() => checkLimits([small, small, small], LIMITS, 0));
  });
});

/** Kanbio over fakes: records every call and fails where told to. */
function fakeApi(failAt: Partial<Record<'limits' | 'reserve' | 'put' | 'complete', unknown>> = {}) {
  const calls: string[] = [];
  const api: AttachmentApi = {
    get: <T>(path: string) => {
      calls.push(`GET ${path}`);
      return failAt.limits ? Promise.reject(failAt.limits) : Promise.resolve(LIMITS as T);
    },
    post: <T>(path: string, body: unknown) => {
      if (path.endsWith('/complete')) {
        calls.push(`POST ${path.replace(/[0-9a-f-]{36}/, ':id')}`);
        return failAt.complete ? Promise.reject(failAt.complete) : Promise.resolve({} as T);
      }
      const draft = body as { id: string; name: string; contentType: string; size: number };
      calls.push(`POST ${path} ${draft.name} ${draft.contentType} ${draft.size}`);
      return failAt.reserve
        ? Promise.reject(failAt.reserve)
        : Promise.resolve({ uploadUrl: `https://s3.test/${draft.id}` } as T);
    },
    delete: (path: string) => {
      calls.push(`DELETE ${path.replace(/[0-9a-f-]{36}/, ':id')}`);
      return Promise.resolve();
    },
    putFile: (url: string, body: Uint8Array, contentType: string) => {
      calls.push(`PUT ${url.replace(/[0-9a-f-]{36}/, ':id')} ${contentType} ${body.length}`);
      return failAt.put ? Promise.reject(failAt.put) : Promise.resolve();
    },
  };
  return { api, calls };
}

describe('Uploading and saving', () => {
  it('uploads, completes and saves the text with the files at its end', async () => {
    const { api, calls } = fakeApi();
    let saved = '';
    const { result, files } = await saveWithAttachments(
      api,
      {
        projectId: 'project-1',
        paths: [join(folder, 'captura.PNG'), join(folder, 'log.csv')],
        text: 'Evidencia del bug',
        scope: 'comments:write',
      },
      (text) => {
        saved = text;
        return Promise.resolve('comment-1');
      },
    );
    assert.equal(result, 'comment-1');
    assert.deepEqual(files.map((file) => file.name), ['captura.PNG', 'log.csv']);
    assert.equal(saved, withAttachments('Evidencia del bug', files));
    assert.deepEqual(calls, [
      'GET /attachments/limits',
      `POST /projects/project-1/attachments captura.PNG image/png ${PNG.length}`,
      `PUT https://s3.test/:id image/png ${PNG.length}`,
      'POST /attachments/:id/complete',
      'POST /projects/project-1/attachments log.csv text/csv 27',
      'PUT https://s3.test/:id text/csv 27',
      'POST /attachments/:id/complete',
    ]);
  });

  it('uploads nothing when a path is wrong', async () => {
    const { api, calls } = fakeApi();
    await assert.rejects(
      saveWithAttachments(
        api,
        { projectId: 'p', paths: [join(folder, 'notas.txt')], text: 'x', scope: 'tickets:edit' },
        () => Promise.resolve(null),
      ),
      ToolInputError,
    );
    assert.deepEqual(calls, []);
  });

  it('names the permission of the tool when the token cannot upload files', async () => {
    const { api, calls } = fakeApi({
      limits: new KanbioApiError(
        403,
        'This API token lacks one of the permissions: comments:write, tickets:create, tickets:edit',
      ),
    });
    const error = await saveWithAttachments(
      api,
      { projectId: 'p', paths: [join(folder, 'captura.PNG')], text: 'x', scope: 'comments:write' },
      () => Promise.resolve(null),
    ).catch((caught: unknown) => caught);
    assert.deepEqual(calls, ['GET /attachments/limits']);
    const message = describeError(error);
    assert.match(message, /Permission denied \(403\): this token lacks the permission comments:write \(comment\)/);
    assert.match(message, /Do not retry/);
  });

  it('discards the uploaded drafts when the save is not allowed, and says why', async () => {
    const { api, calls } = fakeApi();
    const error = await saveWithAttachments(
      api,
      { projectId: 'p', paths: [join(folder, 'captura.PNG')], text: null, scope: 'tickets:edit' },
      () => Promise.reject(new KanbioApiError(403, 'This API token lacks the permission: tickets:edit')),
    ).catch((caught: unknown) => caught);
    assert.equal(calls.at(-1), 'DELETE /attachments/:id');
    assert.match(describeError(error), /lacks the permission tickets:edit \(edit tickets\)\. Do not retry/);
  });

  it('discards what it uploaded when a later file fails', async () => {
    const { api, calls } = fakeApi({
      complete: new KanbioApiError(400, 'El contenido de “captura.PNG” no coincide con su tipo de archivo.'),
    });
    const error = await saveWithAttachments(
      api,
      { projectId: 'p', paths: [join(folder, 'captura.PNG')], text: 'x', scope: 'tickets:create' },
      () => Promise.resolve(null),
    ).catch((caught: unknown) => caught);
    assert.equal(calls.at(-1), 'DELETE /attachments/:id');
    assert.match(describeError(error), /no coincide con su tipo de archivo/);
  });
});
